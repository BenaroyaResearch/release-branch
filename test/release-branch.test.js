// Runs bin/release-branch.js against a throwaway origin (a bare repo on disk)
// and a fake gh on PATH, so nothing here touches GitHub. The fake's `pr merge`
// does a real --no-ff merge into the throwaway main. The interactive
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
  "pr view")
    case "$*" in
      *mergeStateStatus*) cat "$GH_STATE/view.json" ;;
      *) exit 1 ;;
    esac ;;
  "pr create") exit 0 ;;
  "pr checks") cat "$GH_STATE/checks.json"; exit "$(cat "$GH_STATE/checks.exit" 2>/dev/null || echo 0)" ;;
  "pr merge")
    cd "$GH_WORK" && git checkout --quiet main \
      && git merge --quiet --no-ff -m "Merge pull request #1" release/v1.13.0 \
      && git push --quiet origin main 2>/dev/null || exit 1
    head=$(git rev-parse HEAD)
    git checkout --quiet release/v1.13.0
    printf '[{"number":1,"url":"https://example.test/pull/1","state":"MERGED","mergeCommit":{"oid":"%s"}}]' "$head" > "$GH_STATE/pr.json"
    printf '{"state":"MERGED"}' > "$GH_STATE/view.json" ;;
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
	const bump = git('rev-parse', 'HEAD');
	const setView = (fields = {}) => writeFileSync(join(state, 'view.json'), JSON.stringify({
		state: 'OPEN', mergeStateStatus: 'CLEAN', headRefOid: bump, url: 'https://example.test/pull/1', ...fields,
	}));
	setView();
	const setChecks = (checks, exitCode = 0) => {
		writeFileSync(join(state, 'checks.json'), JSON.stringify(checks));
		writeFileSync(join(state, 'checks.exit'), String(exitCode));
	};
	setChecks([{ name: 'ci / build', bucket: 'pass' }, { name: 'ci / warm-cache', bucket: 'skipping' }]);

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

	const env = { GH_STATE: state, GH_WORK: work, PATH: `${bin}:${process.env.PATH}` };
	const runWith = (options, ...args) => spawnSync('node', [SCRIPT, ...args], {
		cwd: work,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, ...env },
		...options,
	});
	const run = (...args) => runWith({}, ...args);
	const onMain = sha => {
		git('fetch', '--quiet', 'origin', 'main');
		return spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: work }).status === 0;
	};
	const published = () => existsSync(join(state, 'released'));
	const calls = () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8') : '');

	return { git, setPr, setView, setChecks, mergeToMain, run, runWith, published, calls, onMain, bump, env, work };
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

test('check passes on a clean main that matches origin/main', () => {
	const f = fixture();
	f.git('checkout', '--quiet', 'main');
	const r = f.run('check');
	assert.equal(r.status, 0, r.stderr);
});

test('check refuses an untracked file, which `git add -A` would commit', () => {
	const f = fixture();
	f.git('checkout', '--quiet', 'main');
	execFileSync('mkdir', ['-p', join(f.work, 'notes')]);
	writeFileSync(join(f.work, 'notes', 'scratch.txt'), 'wip\n');
	const r = f.run('check');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /working tree is not clean/);
	assert.match(r.stderr, /\?\? notes\/scratch\.txt/); // the file, not just its directory
});

test('check refuses a modified tracked file', () => {
	const f = fixture();
	f.git('checkout', '--quiet', 'main');
	writeFileSync(join(f.work, 'package.json'), '{"version":"1.12.0","edited":true}\n');
	const r = f.run('check');
	assert.equal(r.status, 1);
	assert.match(r.stderr, / M package\.json/);
});

test('check ignores gitignored files, such as build output', () => {
	const f = fixture();
	f.git('checkout', '--quiet', 'main');
	writeFileSync(join(f.work, '.gitignore'), 'dist/\n');
	f.git('add', '.gitignore');
	f.git('commit', '--quiet', '-m', 'ignore dist');
	f.git('push', '--quiet', 'origin', 'main');
	execFileSync('mkdir', ['-p', join(f.work, 'dist')]);
	writeFileSync(join(f.work, 'dist', 'bundle.js'), '\n');
	const r = f.run('check');
	assert.equal(r.status, 0, r.stderr);
});

test('release merges the PR with a merge commit once every check passes', () => {
	const f = fixture();
	const r = f.run('release');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /All 2 checks on \S+ passed/);
	assert.ok(f.calls().includes(`gh pr merge 1 --merge --match-head-commit ${f.bump}`));
	assert.ok(f.onMain(f.bump), 'the tagged commit is on main');
	assert.match(r.stdout, /No terminal to confirm on/);
	assert.equal(f.published(), false);
});

test('release does not merge while a check has failed', () => {
	const f = fixture();
	f.setChecks([{ name: 'ci / build', bucket: 'pass' }, { name: 'test / Jest', bucket: 'fail' }], 1);
	const r = f.run('release');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Not merging \S+: test \/ Jest did not pass/);
	assert.doesNotMatch(f.calls(), /pr merge/);
	assert.equal(f.onMain(f.bump), false);
});

test('release does not merge a PR that is behind main, and says how to re-cut', () => {
	const f = fixture();
	f.setView({ mergeStateStatus: 'BEHIND' });
	const r = f.run('release');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /is behind it/);
	assert.match(r.stderr, /git tag -d v1\.13\.0 && git push origin :refs\/tags\/v1\.13\.0/);
	assert.doesNotMatch(f.calls(), /pr merge/);
});

test('release does not merge a PR with a commit after the bump', () => {
	const f = fixture();
	f.setView({ headRefOid: '0123456789abcdef0123456789abcdef01234567' });
	const r = f.run('release');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /has a commit after the v1\.13\.0 bump/);
	assert.doesNotMatch(f.calls(), /pr merge/);
});

test('release --no-merge leaves an open PR for a person to merge', () => {
	const f = fixture();
	const r = f.runWith({ timeout: 3000 }, 'release', '--no-merge');
	assert.equal(r.status, null, 'still waiting when the timeout stopped it');
	assert.match(r.stdout, /Waiting for \S+ to merge into main/);
	assert.doesNotMatch(f.calls(), /pr merge/);
});

test('publish opens the PR and carries on into release', () => {
	const f = fixture();
	const r = f.run('publish');
	assert.equal(r.status, 0, r.stderr);
	const calls = f.calls();
	assert.ok(calls.indexOf('gh pr create') !== -1, 'opened the PR');
	assert.ok(calls.indexOf('gh pr merge') > calls.indexOf('gh pr create'), 'merged after opening it');
	assert.ok(f.onMain(f.bump));
	assert.equal(f.published(), false);
});

test('RELEASE_BRANCH_NO_MERGE=1 makes publish stop once the PR is open', () => {
	const f = fixture();
	const r = f.runWith({ env: { ...process.env, ...f.env, RELEASE_BRANCH_NO_MERGE: '1' } }, 'publish');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /RELEASE_BRANCH_NO_MERGE is set/);
	assert.match(f.calls(), /gh pr create/);
	assert.doesNotMatch(f.calls(), /pr merge|pr checks/);
	assert.equal(f.onMain(f.bump), false);
});
