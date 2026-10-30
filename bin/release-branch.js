#!/usr/bin/env node

// Releases a BRI app by tagging a commit that main has already built, never by
// committing to main. The tag is the version: the app reads it at runtime from
// APP_VERSION, which Flux keeps equal to the deployment's image tag, so a
// release needs no bump commit, no branch, no PR and no new image.
//
//   release-branch release <patch|minor|major|X.Y.Z> [--target <sha>] [--dry-run] [--yes]
//     (`pnpm run release patch`)
//     Take origin/main's head, or --target, which must be on main. Name it
//     after the highest vX.Y.Z tag on origin, bumped. Wait for every workflow
//     its push to main started, stg's retag and rollout check included, and
//     refuse if one did not pass. Then ask before publishing the GitHub
//     release, because publishing starts the prod workflow, which promotes the
//     image built for that commit and deploys it to production. --dry-run
//     stops before the question; --yes skips it, for a caller that has already
//     confirmed, such as an agent. Nothing is written before the release is
//     created, so stopping at any point before that is safe.
//
// The name is from 1.x, which committed the bump to a release/vX.Y.Z branch and
// merged it through a PR. Its check, branch and publish modes now fail with the
// steps to move an app over.

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const BASE = 'main';
const POLL_MS = 30_000;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
// Any other conclusion (failure, cancelled, timed_out, ...) means the commit's
// image was not built, or not verified in staging.
const PASSED = new Set(['success', 'skipped', 'neutral']);
const USAGE = 'usage: release-branch release <patch|minor|major|X.Y.Z> [--target <sha>] [--dry-run] [--yes]';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const git = (...args) => run('git', args);
const passthrough = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const succeeds = (cmd, args) => {
	try {
		execFileSync(cmd, args, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};
const short = sha => sha.slice(0, 7);

/* eslint-disable no-console */
function fail(message) {
	console.error(`\n❌ ${message}\n`);
	process.exit(1);
}

function repoSlug() {
	const remote = git('remote', 'get-url', 'origin');
	return remote.replace(/^git@github\.com:|^https:\/\/github\.com\//, '').replace(/\.git$/, '');
}

const hasGh = () => succeeds('gh', ['--version']);

const parseVersion = name => SEMVER.exec(name).slice(1).map(Number);
const compareVersions = (a, b) => {
	const [x, y] = [parseVersion(a), parseVersion(b)];
	return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

function nextVersion(latest, wanted) {
	const [major, minor, patch] = latest ? parseVersion(latest) : [0, 0, 0];
	if (wanted === 'major') return `v${major + 1}.0.0`;
	if (wanted === 'minor') return `v${major}.${minor + 1}.0`;
	if (wanted === 'patch') return `v${major}.${minor}.${patch + 1}`;
	if (SEMVER.test(wanted)) return `v${wanted.replace(/^v/, '')}`;
	return null;
}

// Every vX.Y.Z tag on origin and the commit it points at. Annotated tags (1.x
// made them with `npm version`) are listed as the tag object and then the
// commit, as <tag>^{}; the tags `gh release create --target` makes are
// lightweight and point at the commit directly.
function releaseTags() {
	const tags = new Map();
	git('ls-remote', '--tags', 'origin', 'refs/tags/v*')
		.split('\n')
		.filter(Boolean)
		.map(line => line.split('\t'))
		.forEach(([sha, ref]) => {
			const peeled = ref.endsWith('^{}');
			const name = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
			if (SEMVER.test(name) && (peeled || !tags.has(name))) tags.set(name, sha);
		});
	return tags;
}

const hasCommit = sha => succeeds('git', ['cat-file', '-e', `${sha}^{commit}`]);

// origin/main's head, or the commit the caller names, which must be on main:
// the prod workflow refuses anything else.
function resolveTarget(target) {
	const ref = target ?? `origin/${BASE}`;
	if (!succeeds('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
		fail(`${ref} is not a commit in this clone. Pass a SHA from ${BASE}.`);
	}
	const sha = git('rev-parse', `${ref}^{commit}`);
	if (!succeeds('git', ['merge-base', '--is-ancestor', sha, `origin/${BASE}`])) {
		fail(`${short(sha)} is not on ${BASE}, and the prod workflow only releases commits on ${BASE}.`);
	}
	return sha;
}

// The workflow runs that pushing this commit to main started: stg, whose retag
// gave it the sha-<commit> image the prod workflow promotes and whose rollout
// check verified that image in staging, and whatever else runs on main. Pull
// request, scheduled and Dependabot runs say nothing about this commit's image.
const pushRuns = sha => JSON.parse(run('gh', [
	'run', 'list',
	'--commit', sha,
	'--branch', BASE,
	'--event', 'push',
	'--limit', '100',
	'--json', 'workflowName,status,conclusion,url',
]) || '[]');

async function waitForRuns(sha) {
	let announced = false;
	let emptyPolls = 0;
	for (;;) {
		const runs = pushRuns(sha);
		const pending = runs.filter(r => r.status !== 'completed');
		if (runs.length && !pending.length) {
			const failed = runs.filter(r => !PASSED.has(r.conclusion));
			if (failed.length) {
				fail(`Not releasing ${short(sha)}: ${failed.map(r => `${r.workflowName} ended ${r.conclusion} (${r.url})`).join('; ')}. Re-run it, or fix ${BASE} and release a later commit.`);
			}
			return runs;
		}
		if (!runs.length && ++emptyPolls > 10) {
			fail(`No workflow has run on ${short(sha)} after ${(10 * POLL_MS) / 60_000} minutes, so nothing built or verified its image. Check that its push to ${BASE} ran stg.`);
		}
		if (!announced) {
			const names = pending.map(r => r.workflowName).join(', ') || 'its workflows';
			console.log(`\nWaiting for ${names} on ${short(sha)} (checking every ${POLL_MS / 1000}s; Ctrl-C is safe, nothing is released yet).`);
			announced = true;
		}
		await sleep(POLL_MS); // eslint-disable-line no-await-in-loop
	}
}

// One line per first-parent commit on main, which on a main that merges PRs is
// one line per PR.
function changesSince(from, sha) {
	const lines = git('log', '--first-parent', '--format=%h %s', `${from}..${sha}`).split('\n').filter(Boolean);
	const shown = lines.slice(0, 20).map(line => `            ${line}`).join('\n');
	return lines.length > 20 ? `${shown}\n            … and ${lines.length - 20} more` : shown;
}

// Anything but y/yes is a no, including Ctrl-D, Ctrl-C and having no terminal.
// pnpm 12 runs scripts with stdin on the terminal but stdout piped through its
// reporter, which shows only whole lines, so there the question ends in a
// newline. Without it nothing shows until Enter, which answers no.
async function confirm(question) {
	if (!process.stdin.isTTY) {
		console.log('No terminal to confirm on, so not publishing.');
		return false;
	}
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const asked = process.stdout.isTTY ? question : `${question.trimEnd()}\n`;
		return /^y(es)?$/i.test((await prompt.question(asked)).trim());
	} catch {
		return false;
	} finally {
		prompt.close();
	}
}

async function findProdRun(sha) {
	for (let attempt = 0; attempt < 6; attempt++) {
		await sleep(5_000); // eslint-disable-line no-await-in-loop
		const url = run('gh', [
			'run', 'list',
			'--workflow', 'prod.yaml',
			'--event', 'release',
			'--commit', sha,
			'--limit', '1',
			'--json', 'url',
			'--jq', '.[0].url // ""',
		]);
		if (url) return url;
	}
	return `https://github.com/${repoSlug()}/actions/workflows/prod.yaml`;
}

async function release(args) {
	let parsed;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			options: {
				target: { type: 'string' },
				'dry-run': { type: 'boolean', default: false },
				yes: { type: 'boolean', default: false },
			},
		});
	} catch (error) {
		fail(`${error.message}\n\n${USAGE}`);
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1) fail(USAGE);
	const [wanted] = positionals;
	if (!hasGh()) fail('The GitHub CLI (gh) is required. Install it and sign in with `gh auth login`.');

	// main only: every release tag's commit is on it, so this brings their
	// objects too, without touching the clone's own tags.
	git('fetch', '--quiet', 'origin', BASE);
	const tags = releaseTags();
	const latest = [...tags.keys()].sort(compareVersions).at(-1);
	const name = nextVersion(latest, wanted);
	if (!name) fail(`"${wanted}" is not patch, minor, major or a version such as 1.14.0.`);
	if (latest && compareVersions(name, latest) <= 0) fail(`${name} is not after the latest release, ${latest}.`);

	const sha = resolveTarget(values.target);
	const released = [...tags].find(([, commit]) => commit === sha);
	if (released) fail(`${short(sha)} is already released, as ${released[0]}.`);
	const latestSha = latest && hasCommit(tags.get(latest)) ? tags.get(latest) : null;
	if (latestSha && git('rev-parse', `${sha}^{tree}`) === git('rev-parse', `${latestSha}^{tree}`)) {
		fail(`Nothing to release: ${short(sha)} holds exactly the files ${latest} does.`);
	}

	const runs = await waitForRuns(sha);

	console.log(`\nRelease ${name} → production\n`);
	console.log(`  commit    ${short(sha)}  ${git('log', '-1', '--format=%s', sha)}`);
	if (latestSha && succeeds('git', ['merge-base', '--is-ancestor', latestSha, sha])) {
		console.log(`  since     ${latest}:\n${changesSince(latestSha, sha)}`);
	}
	console.log(`  passed    ${runs.map(r => r.workflowName).join(', ')}, on its push to ${BASE}`);
	if (latestSha && !succeeds('git', ['merge-base', '--is-ancestor', latestSha, sha])) {
		console.log(`\n⚠️  ${short(sha)} does not contain ${latest} (${short(latestSha)}): releasing it takes production back to older code.`);
	}
	console.log(`\nPublishing ${name} creates the GitHub release, which starts the prod workflow: it backs up`);
	console.log(`production, promotes the image built for ${short(sha)} to ${name.slice(1)}, and deploys it to production.\n`);

	if (values['dry-run']) {
		console.log('Dry run: nothing published.\n');
		return;
	}
	if (!values.yes && !await confirm(`Publish ${name} and deploy it to production? [y/N] `)) {
		console.log(`\nNot published. Rerun \`pnpm run release ${wanted}\` when you are ready.\n`);
		return;
	}
	// gh ignores --target for a tag that already exists and releases whatever it
	// points at, so look once more right before creating it.
	if (releaseTags().has(name)) fail(`${name} appeared on origin while this ran. Nothing was published; rerun to take the next version.`);

	passthrough('gh', ['release', 'create', name, '--target', sha, '--title', name, '--generate-notes']);
	console.log(`\nProduction deploy: ${await findProdRun(sha)}\n`);
}

// 1.x's pnpm version hooks, in an app that has not moved over. Failing in
// `check`, the preversion hook, stops pnpm version before it bumps anything.
const MOVED = [
	`release-branch 2 releases by tagging a commit ${BASE} already built: no version bump, branch or PR.`,
	'   In package.json, remove the preversion, version and postversion scripts and keep',
	'   "release": "release-branch release". Then release with `pnpm run release patch` (or minor,',
	'   major, or a version). See https://github.com/BenaroyaResearch/release-branch#moving-from-1x',
].join('\n');

const mode = process.argv[2];
if (mode === 'release') await release(process.argv.slice(3));
else if (['check', 'branch', 'publish'].includes(mode)) fail(MOVED);
else fail(USAGE);
/* eslint-enable no-console */
