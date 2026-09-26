// Runs bin/release-branch.js against a throwaway origin (a bare repo on disk)
// and a fake gh on PATH, so nothing here touches GitHub. The interactive
// confirmation is not exercised: with no terminal, `release` must never publish,
// and that is what these tests check.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = new URL('../bin/release-branch.js', import.meta.url).pathname;

const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$GH_STATE/calls"
case "$1 $2" in
  "--version "*) exit 0 ;;
  "release view") [ -f "$GH_STATE/released" ] ;;
  "release create") touch "$GH_STATE/released" ;;
  "pr list") cat "$GH_STATE/pr.json" ;;
  "pr view") exit 1 ;;
  "pr create") exit 0 ;;
  "run list") echo "https://example.test/runs/1" ;;
  *) echo "unexpected: gh $*" >&2; exit 2 ;;
esac
`;

// origin with main at 1.12.0, and a pushed release/v1.13.0 branch carrying the
// bump commit and its annotated tag, as `pnpm version minor` leaves them.
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
	writeFileSync(join(work, 'package.json'), '{"version":"1.12.0"}\n');
	git('add', '.');
	git('commit', '--quiet', '-m', 'init');
	git('push', '--quiet', 'origin', 'main');
	git('checkout', '--quiet', '-b', 'release/v1.13.0');
	writeFileSync(join(work, 'package.json'), '{"version":"1.13.0"}\n');
	git('commit', '--quiet', '-am', '1.13.0');
	git('tag', '-a', 'v1.13.0', '-m', 'v1.13.0');
	git('push', '--quiet', 'origin', 'release/v1.13.0', 'refs/tags/v1.13.0');

	const setPr = (prState, mergeCommit = null) => writeFileSync(join(state, 'pr.json'), JSON.stringify([{
		number: 1, url: 'https://example.test/pull/1', state: prState, mergeCommit: mergeCommit && { oid: mergeCommit },
	}]));
	setPr('OPEN');

	const mergeToMain = (...mergeArgs) => {
		git('checkout', '--quiet', 'main');
		git('merge', '--quiet', ...mergeArgs, 'release/v1.13.0');
		if (mergeArgs.includes('--squash')) git('commit', '--quiet', '-m', '1.13.0 (#1)');
		git('push', '--quiet', 'origin', 'main');
		const head = git('rev-parse', 'HEAD');
		git('checkout', '--quiet', 'release/v1.13.0');
		setPr('MERGED', head);
		return head;
	};

	const run = (...args) => spawnSync('node', [SCRIPT, ...args], {
		cwd: work,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, GH_STATE: state, PATH: `${bin}:${process.env.PATH}` },
	});
	const published = () => existsSync(join(state, 'released'));
	const calls = () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8') : '');

	return { git, setPr, mergeToMain, run, published, calls, work };
}

test('release refuses a tag that is not on origin', () => {
	const f = fixture();
	const r = f.run('release', 'v9.9.9');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /v9\.9\.9 is not on origin/);
});

test('release refuses a tag that already has a GitHub release', () => {
	const f = fixture();
	f.mergeToMain('--no-ff', '-m', 'Merge PR');
	writeFileSync(join(f.work, '..', 'state', 'released'), '');
	const r = f.run('release');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /already has a GitHub release/);
});

test('release stops when the PR was closed without merging', () => {
	const f = fixture();
	f.setPr('CLOSED');
	const r = f.run('release');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /closed without merging/);
	assert.equal(f.published(), false);
});

test('release stops, with the re-tag command, when the PR was squashed', () => {
	const f = fixture();
	const squash = f.mergeToMain('--squash');
	const r = f.run('release');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /squashed or rebased/);
	assert.ok(r.stderr.includes(`git tag -f v1.13.0 ${squash}`));
	assert.equal(f.published(), false);
});

test('release never publishes without a terminal to confirm on', () => {
	const f = fixture();
	f.mergeToMain('--no-ff', '-m', 'Merge PR');
	const r = f.run('release');
	assert.equal(r.status, 0);
	assert.match(r.stdout, /v1\.13\.0 \([0-9a-f]{7}\) is on main/);
	assert.match(r.stdout, /No terminal to confirm on/);
	assert.doesNotMatch(r.stdout, /NOT in the v1\.13\.0 image/);
	assert.equal(f.published(), false);
	assert.doesNotMatch(f.calls(), /release create/);
});

test('release warns when main holds changes the tagged image does not', () => {
	const f = fixture();
	f.git('checkout', '--quiet', 'main');
	writeFileSync(join(f.work, 'other.js'), '\n');
	f.git('add', 'other.js');
	f.git('commit', '--quiet', '-m', "someone else's PR");
	f.git('push', '--quiet', 'origin', 'main');
	f.git('checkout', '--quiet', 'release/v1.13.0');
	f.git('merge', '--quiet', '--no-edit', 'main'); // the "Update branch" click
	f.mergeToMain('--no-ff', '-m', 'Merge PR');
	const r = f.run('release');
	assert.match(r.stdout, /contains changes that are NOT in the v1\.13\.0 image/);
	assert.equal(f.published(), false);
});

test('check refuses to cut a release off main', () => {
	const f = fixture();
	const r = f.run('check');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Releases are cut from main only/);
});

test('check refuses a main that is behind origin/main', () => {
	const f = fixture();
	f.mergeToMain('--no-ff', '-m', 'Merge PR');
	f.git('checkout', '--quiet', 'main');
	f.git('reset', '--quiet', '--hard', 'HEAD~1');
	const r = f.run('check');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /does not match origin\/main/);
});
