#!/usr/bin/env node

// Lifecycle helper for `pnpm version`. main is branch-protected, so the bump
// commit cannot be pushed there directly; it goes up on a branch and lands
// through a PR (merge commit, so the tagged commit stays on main's history).
//
//   release-branch check     (from the "preversion" hook)
//     Releases are cut from main only, from a clean working tree (untracked
//     files included), and only from a main that matches origin/main after a
//     fetch. Fail before anything is bumped otherwise.
//
//   release-branch branch    (from the "version" hook)
//     Move from main onto release/v<new version> before pnpm commits, so the
//     bump commit and tag never land on local main.
//
//   release-branch publish   (from the "postversion" hook)
//     Push the branch and its tag, open a PR into main with the GitHub CLI
//     (or print the compare URL if gh is missing), then carry straight on into
//     `release`, so one `pnpm version` takes the release all the way.
//
//   release-branch release [vX.Y.Z] [--no-merge]   (`pnpm run release`)
//     Wait for every check on the release PR, merge it with a merge commit
//     once they all pass, check the tagged commit landed on main, then ask
//     before publishing the GitHub release, because publishing starts the prod
//     workflow and deploys to production. It refuses to merge a PR that is
//     behind main, has a failed check, or holds anything after the bump.
//     --no-merge waits for someone else to merge instead. Stopping it at any
//     point is safe, and running it again picks up where it left off. The tag
//     defaults to the version in package.json, the new one on the branch.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'main';
const POLL_MS = 30_000;

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

// The app's package.json (lifecycle and run scripts start in the package root),
// not one next to this file.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;
const current = git('rev-parse', '--abbrev-ref', 'HEAD');

/* eslint-disable no-console */
function requireBase() {
	if (current === BASE) return;
	console.error(`\n❌ Releases are cut from ${BASE} only (on ${current}). Check out ${BASE} and pull first.\n`);
	process.exit(1);
}

// The "version" hook ends in `git add -A`, which commits anything lying around
// into the bump, untracked files included. Refuse before anything is bumped.
function requireCleanTree() {
	const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	if (dirty.length === 0) return;
	const shown = dirty.slice(0, 10).map(line => `   ${line}`).join('\n');
	const more = dirty.length > 10 ? `\n   … and ${dirty.length - 10} more` : '';
	console.error(`\n❌ The working tree is not clean, and the version script's \`git add -A\` would commit this into the release:\n${shown}${more}\n\n   Commit, stash, remove or gitignore it, then run the release again.\n`);
	process.exit(1);
}

function check() {
	requireBase();
	requireCleanTree();
	passthrough('git', ['fetch', 'origin', BASE]);
	const local = git('rev-parse', 'HEAD');
	const remote = git('rev-parse', `origin/${BASE}`);
	if (local === remote) return;
	console.error(`\n❌ Local ${BASE} (${local.slice(0, 7)}) does not match origin/${BASE} (${remote.slice(0, 7)}). Pull or reset ${BASE} first.\n`);
	process.exit(1);
}

function branch() {
	requireBase();
	const target = `release/${tag}`;
	console.log(`\n→ ${current} is protected; committing ${tag} on ${target}\n`);
	passthrough('git', ['checkout', '-b', target]);
}

function repoSlug() {
	const remote = git('remote', 'get-url', 'origin');
	return remote.replace(/^git@github\.com:|^https:\/\/github\.com\//, '').replace(/\.git$/, '');
}

function compareUrl() {
	return `https://github.com/${repoSlug()}/compare/${BASE}...${encodeURIComponent(current)}?expand=1`;
}

const hasGh = () => succeeds('gh', ['--version']);

async function publish() {
	if (current === BASE) {
		console.error(`\n❌ Still on ${BASE}; refusing to push the bump there.\n`);
		process.exit(1);
	}

	passthrough('git', ['push', '-u', 'origin', current]);
	passthrough('git', ['push', 'origin', `refs/tags/${tag}`]);

	if (!hasGh()) {
		console.log(`\nGitHub CLI not found. Open the PR here, merge it with a merge commit, then publish the\nGitHub release from the existing ${tag} tag:\n  ${compareUrl()}\n`);
		return;
	}

	try {
		const existing = run('gh', ['pr', 'view', current, '--json', 'url', '--jq', '.url']);
		console.log(`\nPR already open for ${current}: ${existing}\n`);
	} catch {
		passthrough('gh', [
			'pr', 'create',
			'--base', BASE,
			'--head', current,
			'--title', `Release ${tag}`,
			'--body', `Version bump to ${tag}, opened by \`pnpm version\`. It merges this PR with a **merge commit** once every check passes (so the ${tag} tag stays on ${BASE}), then asks before publishing the GitHub release. If you merge it by hand, use a merge commit, not squash or rebase.`,
		]);
	}
	await release([tag]);
}

function fail(message) {
	console.error(`\n❌ ${message}\n`);
	process.exit(1);
}

// The commit a tag on origin points at. `npm version` makes annotated tags, so
// ls-remote lists the tag object and then the commit, as <tag>^{}.
function remoteTagCommit(name) {
	const refs = new Map(git('ls-remote', '--tags', 'origin', `refs/tags/${name}*`)
		.split('\n')
		.filter(Boolean)
		.map(line => line.split('\t').reverse()));
	return refs.get(`refs/tags/${name}^{}`) ?? refs.get(`refs/tags/${name}`);
}

function recut(name) {
	return [
		`   git switch ${BASE} && git pull`,
		`   git tag -d ${name} && git push origin :refs/tags/${name}`,
		`   git branch -D release/${name} && git push origin :release/${name}`,
		'   pnpm version <the same bump>',
	].join('\n');
}

function releasePr(name) {
	const [pr] = JSON.parse(run('gh', [
		'pr', 'list',
		'--head', `release/${name}`,
		'--state', 'all',
		'--limit', '1',
		'--json', 'number,url,state,mergeCommit',
	]));
	return pr;
}

// Poll until the tagged commit is on origin/main. The PR is read before the
// fetch, so a PR that shows MERGED while the commit is still missing from main
// really was squashed or rebased, not merged between the two calls.
async function waitForMerge(name, sha) {
	let announced = false;
	for (;;) {
		const pr = releasePr(name);
		git('fetch', '--quiet', 'origin', BASE);
		if (succeeds('git', ['merge-base', '--is-ancestor', sha, `origin/${BASE}`])) return pr;

		if (pr?.state === 'CLOSED') {
			fail(`${pr.url} was closed without merging, so ${name} was never released. Delete the tag (git push origin :refs/tags/${name}) and cut a new release.`);
		}
		if (pr?.state === 'MERGED') {
			const landed = pr.mergeCommit.oid;
			fail(`${pr.url} was squashed or rebased, so the ${name} commit is not on ${BASE} and the prod workflow would refuse it. Point the tag at the commit it landed as, wait for the stg workflow on ${BASE} to finish, then rerun:\n   git tag -f ${name} ${landed} && git push -f origin refs/tags/${name}`);
		}
		if (!announced) {
			console.log(`\nWaiting for ${pr ? pr.url : `a PR from release/${name}`} to merge into ${BASE} (checking every ${POLL_MS / 1000}s; Ctrl-C to stop and rerun later).`);
			announced = true;
		}
		await sleep(POLL_MS); // eslint-disable-line no-await-in-loop
	}
}

// gh exits 8 while checks are pending and 1 when one has failed; the JSON is on
// stdout either way. No checks at all prints a message instead, read as none.
function prChecks(number) {
	let out;
	try {
		out = run('gh', ['pr', 'checks', String(number), '--json', 'name,bucket']);
	} catch (error) {
		out = String(error.stdout ?? '').trim();
	}
	try {
		return JSON.parse(out || '[]');
	} catch {
		return [];
	}
}

const prView = number => JSON.parse(run('gh', [
	'pr', 'view', String(number), '--json', 'state,mergeStateStatus,headRefOid,url',
]));

// Merge the release PR once every check on it has passed, the staging deploy
// included. Anything that would make the merged commit differ from the tagged
// one stops it instead. If gh cannot merge (a review requirement, say), fall
// back to waiting for a person to.
async function mergeWhenGreen(number, sha, name) {
	let announced = false;
	let emptyPolls = 0;
	for (;;) {
		const view = prView(number);
		if (view.state !== 'OPEN') return;
		if (view.headRefOid !== sha) {
			fail(`${view.url} has a commit after the ${name} bump (head ${view.headRefOid.slice(0, 7)}, tag ${sha.slice(0, 7)}), so the image for ${name} is not what the PR holds. Not merging. Close it and cut the release again:\n${recut(name)}`);
		}
		if (view.mergeStateStatus === 'BEHIND') {
			fail(`${BASE} moved after ${name} was cut, so ${view.url} is behind it. Updating the branch would put commits after the tag, so it is not merged. Close it and cut the release again:\n${recut(name)}`);
		}
		const checks = prChecks(number);
		const failed = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel');
		if (failed.length) {
			fail(`Not merging ${view.url}: ${failed.map(check => check.name).join(', ')} did not pass. Re-run it and then \`pnpm run release\`, or fix it on ${BASE} and cut the release again.`);
		}
		if (checks.length && !checks.some(check => check.bucket === 'pending')) {
			console.log(`\nAll ${checks.length} checks on ${view.url} passed. Merging it with a merge commit.`);
			try {
				passthrough('gh', ['pr', 'merge', String(number), '--merge', '--match-head-commit', sha]);
			} catch {
				console.log(`\ngh could not merge it. Merge ${view.url} with a merge commit on GitHub; this waits for that.`);
			}
			return;
		}
		if (!checks.length && ++emptyPolls > 10) {
			fail(`No checks have reported on ${view.url} after ${(10 * POLL_MS) / 60_000} minutes. Make sure its workflows ran, then \`pnpm run release\`.`);
		}
		if (!announced) {
			console.log(`\nWaiting for the checks on ${view.url}, which include the staging deploy (every ${POLL_MS / 1000}s; Ctrl-C to stop, \`pnpm run release\` picks up again).`);
			announced = true;
		}
		await sleep(POLL_MS); // eslint-disable-line no-await-in-loop
	}
}

// Anything but y/yes is a no, including Ctrl-D, Ctrl-C and having no terminal.
async function confirm(question) {
	if (!process.stdin.isTTY) {
		console.log('No terminal to confirm on, so not publishing.');
		return false;
	}
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await prompt.question(question)).trim());
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
	const noMerge = args.includes('--no-merge');
	const name = args.find(arg => !arg.startsWith('--')) ?? tag;
	if (!hasGh()) fail('The GitHub CLI (gh) is required to publish the release. Install it, or publish from the existing tag on GitHub.');

	const sha = remoteTagCommit(name);
	if (!sha) fail(`${name} is not on origin. Run \`pnpm version\` from ${BASE} first, or pass the tag: pnpm run release vX.Y.Z`);
	if (succeeds('gh', ['release', 'view', name])) fail(`${name} already has a GitHub release; there is nothing to publish.`);

	const open = releasePr(name);
	if (open?.state === 'OPEN' && !noMerge) await mergeWhenGreen(open.number, sha, name);

	const pr = await waitForMerge(name, sha);

	// A merge commit whose tree differs from the tagged commit's means main got
	// changes the release branch never had (an "Update branch" click, or a merge
	// without the up-to-date check). The release image is the tagged commit's,
	// so production would not get them.
	const merge = pr?.mergeCommit?.oid;
	const drift = merge && git('rev-parse', `${merge}^{tree}`) !== git('rev-parse', `${sha}^{tree}`);

	console.log(`\n✅ ${name} (${sha.slice(0, 7)}) is on ${BASE}${pr ? ` via ${pr.url}` : ''}.`);
	if (drift) {
		console.log(`\n⚠️  ${BASE} at that merge (${merge.slice(0, 7)}) contains changes that are NOT in the ${name} image; production will not get them.`);
	}
	console.log(`\nPublishing ${name} creates the GitHub release, which starts the prod workflow: it backs up`);
	console.log(`production, promotes the image built for ${sha.slice(0, 7)} to ${name.replace(/^v/, '')}, and deploys it to production.\n`);

	if (!await confirm(`Publish ${name} and deploy it to production? [y/N] `)) {
		console.log('\nNot published. Rerun `pnpm run release` when you are ready.\n');
		return;
	}

	passthrough('gh', ['release', 'create', name, '--verify-tag', '--title', name, '--generate-notes']);
	console.log(`\nProduction deploy: ${await findProdRun(sha)}\n`);
}
/* eslint-enable no-console */

const mode = process.argv[2];
if (mode === 'check') check();
else if (mode === 'branch') branch();
else if (mode === 'publish') await publish();
else if (mode === 'release') await release(process.argv.slice(3));
else {
	console.error('usage: release-branch check|branch|publish|release [vX.Y.Z] [--no-merge]'); // eslint-disable-line no-console
	process.exit(1);
}
