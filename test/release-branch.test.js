// Runs bin/release-branch.js against a throwaway origin (a bare repo on disk)
// and a fake gh on PATH, so nothing here touches GitHub. The fake's `release
// create` makes the tag on the throwaway origin at --target, as GitHub does.
// pnpmVersion stands in for pnpm 12 running the version hooks. The interactive
// confirmation is not exercised: with no terminal and no --yes, `release` must
// never publish, and that is what these tests check.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = new URL('../bin/release-branch.js', import.meta.url).pathname;

const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$GH_STATE/calls"
case "$1 $2" in
  "--version "*) exit 0 ;;
  "run list")
    case "$*" in
      *"--event push"*) cat "$GH_STATE/runs.json" ;;
      *) echo "https://example.test/runs/prod" ;;
    esac ;;
  "release create")
    tag="$3"
    target=""
    while [ $# -gt 0 ]; do
      [ "$1" = "--target" ] && target="$2"
      shift
    done
    git -C "$GH_ORIGIN" tag "$tag" "$target" ;;
  *) echo "unexpected: gh $*" >&2; exit 2 ;;
esac
`;

const short = sha => sha.slice(0, 7);

// origin's main: v1.12.0 (annotated, as 1.x's `npm version` made it), feature
// A, feature B tagged v1.13.0 (lightweight, as `gh release create --target`
// makes it), and feature C, not yet released. Every push run passed.
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'release-branch-'));
	const origin = join(root, 'origin.git');
	const work = join(root, 'work');
	const state = join(root, 'state');
	const bin = join(root, 'bin');
	execFileSync('mkdir', ['-p', state, bin]);
	writeFileSync(join(bin, 'gh'), FAKE_GH);
	chmodSync(join(bin, 'gh'), 0o755);

	const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch', 'main', origin]);
	execFileSync('git', ['clone', '--quiet', origin, work], { stdio: 'ignore' });
	git('config', 'user.email', 'test@example.test');
	git('config', 'user.name', 'test');
	const commit = (file, message) => {
		writeFileSync(join(work, file), `${message}\n`);
		git('add', file);
		git('commit', '--quiet', '-m', message);
		return git('rev-parse', 'HEAD');
	};
	const pushMain = () => git('push', '--quiet', 'origin', 'main');

	const manifest = join(work, 'package.json');
	writeFileSync(manifest, '{\n\t"name": "app",\n\t"version": "0.0.0"\n}\n');
	git('add', 'package.json');
	commit('README.md', 'init');
	git('tag', '-a', 'v1.12.0', '-m', 'v1.12.0');
	const featureA = commit('a.js', 'feature A');
	const featureB = commit('b.js', 'feature B');
	git('tag', 'v1.13.0');
	const head = commit('c.js', 'feature C');
	pushMain();
	git('push', '--quiet', 'origin', 'refs/tags/v1.12.0', 'refs/tags/v1.13.0');

	const setRuns = runs => writeFileSync(join(state, 'runs.json'), JSON.stringify(runs));
	const passed = (workflowName, n) => ({ workflowName, status: 'completed', conclusion: 'success', url: `https://example.test/runs/${n}` });
	setRuns([passed('stg', 1), passed('CodeQL', 2)]);

	const env = { GH_STATE: state, GH_ORIGIN: origin, PATH: `${bin}:${process.env.PATH}` };
	const runWith = (options, ...args) => spawnSync('node', [SCRIPT, ...args], {
		cwd: work,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...env },
		...options,
	});
	const run = (...args) => runWith({}, ...args);
	const calls = () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8') : '');
	const originTag = name => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`], { cwd: origin, encoding: 'utf8' }).stdout.trim();
	const localRef = ref => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: work, encoding: 'utf8' }).stdout.trim();
	const manifestVersion = () => JSON.parse(readFileSync(manifest, 'utf8')).version;

	// What pnpm 12's `pnpm version` does around the hooks: write the new
	// version, run "version", commit and tag it (not with --no-git-tag-version),
	// then run "postversion".
	const pnpmVersion = (version, { gitTagVersion = true, versionHook = true } = {}) => {
		writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`));
		if (versionHook) {
			const hook = run('version');
			if (hook.status !== 0) return hook;
		}
		if (gitTagVersion) {
			git('add', 'package.json');
			git('commit', '--quiet', '-m', version);
			git('tag', '-a', `v${version}`, '-m', version);
		}
		return run('publish');
	};

	return { git, commit, pushMain, setRuns, passed, run, runWith, calls, originTag, localRef, manifestVersion, pnpmVersion, featureA, featureB, head, work };
}

test('a dry run names the next patch release of origin/main and publishes nothing', () => {
	const f = fixture();
	const r = f.run('release', 'patch', '--dry-run');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /Release v1\.13\.1 → production/);
	assert.ok(r.stdout.includes(`commit    ${short(f.head)}  feature C`));
	assert.match(r.stdout, /passed {4}stg, CodeQL, on its push to main/);
	assert.match(r.stdout, /Dry run: nothing published/);
	assert.doesNotMatch(f.calls(), /release create/);
});

test('minor, major and an explicit version count on from the highest tag', () => {
	const f = fixture();
	assert.match(f.run('release', 'minor', '--dry-run').stdout, /Release v1\.14\.0 /);
	assert.match(f.run('release', 'major', '--dry-run').stdout, /Release v2\.0\.0 /);
	assert.match(f.run('release', '1.20.0', '--dry-run').stdout, /Release v1\.20\.0 /);
	assert.match(f.run('release', 'v1.20.1', '--dry-run').stdout, /Release v1\.20\.1 /);
});

test('refuses a version that is not after the latest release', () => {
	const f = fixture();
	const r = f.run('release', '1.13.0', '--dry-run');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /v1\.13\.0 is not after the latest release, v1\.13\.0/);
});

test('refuses a bump it does not know, and an option it does not know', () => {
	const f = fixture();
	const word = f.run('release', 'hotfix');
	assert.equal(word.status, 1);
	assert.match(word.stderr, /"hotfix" is not patch, minor, major or a version/);
	const option = f.run('release', 'patch', '--no-merge');
	assert.equal(option.status, 1);
	assert.match(option.stderr, /Unknown option '--no-merge'/);
});

test('lists the commits on main since the latest release', () => {
	const f = fixture();
	f.commit('d.js', 'feature D');
	f.pushMain();
	const r = f.run('release', 'patch', '--dry-run');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /since {5}v1\.13\.0:\n {12}\w+ feature D\n {12}\w+ feature C\n/);
	assert.doesNotMatch(r.stdout, /feature B/);
});

test('refuses a commit that is already released', () => {
	const f = fixture();
	const r = f.run('release', 'patch', '--target', f.featureB, '--dry-run');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /already released, as v1\.13\.0/);
});

test('refuses a commit with exactly the files of the latest release', () => {
	const f = fixture();
	f.git('revert', '--no-edit', 'HEAD');
	f.pushMain();
	const r = f.run('release', 'patch', '--dry-run');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Nothing to release: \w+ holds exactly the files v1\.13\.0 does/);
});

test('refuses a commit that is not on main', () => {
	const f = fixture();
	f.git('switch', '--quiet', '-c', 'side');
	const side = f.commit('side.js', 'side work');
	const r = f.run('release', 'patch', '--target', side, '--dry-run');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /is not on main, and the prod workflow only releases commits on main/);
});

test('warns when the commit is older than the latest release', () => {
	const f = fixture();
	const r = f.run('release', 'patch', '--target', f.featureA, '--dry-run');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /does not contain v1\.13\.0 \(\w+\): releasing it takes production back to older code/);
});

test('refuses when a workflow on that push did not pass', () => {
	const f = fixture();
	f.setRuns([f.passed('CodeQL', 2), { workflowName: 'stg', status: 'completed', conclusion: 'failure', url: 'https://example.test/runs/1' }]);
	const r = f.run('release', 'patch', '--yes');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Not releasing \w+: stg ended failure \(https:\/\/example\.test\/runs\/1\)/);
	assert.doesNotMatch(f.calls(), /release create/);
});

test('waits while a workflow on that push is still running', () => {
	const f = fixture();
	f.setRuns([{ workflowName: 'stg', status: 'in_progress', conclusion: '', url: 'https://example.test/runs/1' }]);
	const r = f.runWith({ timeout: 3000 }, 'release', 'patch', '--yes');
	assert.equal(r.status, null, 'still waiting when the timeout stopped it');
	assert.match(r.stdout, /Waiting for stg on \w{7}/);
	assert.doesNotMatch(f.calls(), /release create/);
});

test('never publishes without a terminal to confirm on', () => {
	const f = fixture();
	const r = f.run('release', 'patch');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /No terminal to confirm on/);
	assert.doesNotMatch(f.calls(), /release create/);
	assert.equal(f.originTag('v1.13.1'), '');
});

test('--yes publishes the release on that commit and prints the prod run', () => {
	const f = fixture();
	const r = f.run('release', 'patch', '--yes');
	assert.equal(r.status, 0, r.stderr);
	assert.ok(f.calls().includes(`gh release create v1.13.1 --target ${f.head} --title v1.13.1 --generate-notes`));
	assert.equal(f.originTag('v1.13.1'), f.head);
	assert.match(r.stdout, /Production deploy: https:\/\/example\.test\/runs\/prod/);

	const again = f.run('release', 'patch', '--yes');
	assert.equal(again.status, 1);
	assert.match(again.stderr, /already released, as v1\.13\.1/);
});

test('pnpm version patch releases the next patch and leaves no bump behind', () => {
	const f = fixture();
	const r = f.pnpmVersion('0.0.1');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /Release v1\.13\.1 → production/);
	assert.match(r.stdout, /No terminal to confirm on/);
	assert.match(r.stdout, /Rerun `pnpm version patch`/);
	assert.match(r.stdout, /Ignore pnpm's "0\.0\.0 → 0\.0\.1" below: that bump was local and is undone,\nand package\.json is still 0\.0\.0\.\n+$/);
	assert.doesNotMatch(f.calls(), /release create/);
	assert.equal(f.git('rev-parse', 'HEAD'), f.head);
	assert.equal(f.git('status', '--porcelain'), '');
	assert.equal(f.manifestVersion(), '0.0.0');
	assert.equal(f.localRef('refs/tags/v0.0.1'), '');
	assert.equal(f.git('for-each-ref', 'refs/release-branch'), '');
});

test('pnpm version minor, major and a version count on from the highest tag on origin', () => {
	const f = fixture();
	assert.match(f.pnpmVersion('0.1.0').stdout, /Release v1\.14\.0 /);
	assert.match(f.pnpmVersion('1.0.0').stdout, /Release v2\.0\.0 /);
	const explicit = f.pnpmVersion('1.20.0');
	assert.match(explicit.stdout, /Release v1\.20\.0 /);
	assert.match(explicit.stdout, /Rerun `pnpm version 1\.20\.0`/);
	assert.equal(f.git('rev-parse', 'HEAD'), f.head);
});

test("pnpm version major moves the clone's own v1.0.0 out of pnpm's way and puts it back", () => {
	const f = fixture();
	f.git('tag', '-a', 'v1.0.0', '-m', 'the real 1.0.0', f.featureA);
	const real = f.localRef('refs/tags/v1.0.0');
	const r = f.pnpmVersion('1.0.0');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /Release v2\.0\.0 /);
	assert.equal(f.localRef('refs/tags/v1.0.0'), real);
	assert.equal(f.git('rev-parse', 'HEAD'), f.head);
	assert.equal(f.git('for-each-ref', 'refs/release-branch'), '');
});

test('a tag moved aside by a pnpm version that stopped early is put back by the next one', () => {
	const f = fixture();
	f.git('tag', '-a', 'v1.0.0', '-m', 'the real 1.0.0', f.featureA);
	const real = f.localRef('refs/tags/v1.0.0');
	f.git('update-ref', 'refs/release-branch/aside/v1.0.0', real);
	f.git('tag', '-d', 'v1.0.0');
	const r = f.pnpmVersion('0.0.1');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(f.localRef('refs/tags/v1.0.0'), real);
	assert.equal(f.git('for-each-ref', 'refs/release-branch'), '');
});

test('pnpm version --no-git-tag-version leaves package.json as it was', () => {
	const f = fixture();
	const r = f.pnpmVersion('0.0.1', { gitTagVersion: false });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /Release v1\.13\.1 /);
	assert.equal(f.git('status', '--porcelain'), '');
	assert.equal(f.manifestVersion(), '0.0.0');
});

test('publish without the version hook releases nothing and says how to undo the bump', () => {
	const f = fixture();
	const r = f.pnpmVersion('0.0.1', { versionHook: false });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /needs "version": "release-branch version" beside it/);
	assert.match(r.stderr, /git tag -d v0\.0\.1 && git reset --keep HEAD\^/);
	assert.doesNotMatch(f.calls(), /gh run list/);
});

test("1.x's pnpm version hooks stop it before anything is bumped, with the steps to move over", () => {
	const f = fixture();
	['check', 'branch'].forEach(mode => {
		const r = f.run(mode);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /release-branch 2 releases by tagging a commit main already built/);
		assert.match(r.stderr, /remove the preversion script/);
	});
});
