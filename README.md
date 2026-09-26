# @benaroyaresearch/release-branch

Releases for BRI Node apps whose `main` is branch-protected. `pnpm version`
can no longer push its bump commit straight to `main`, so this puts the bump on
a `release/vX.Y.Z` branch, opens the PR, merges it with a merge commit once
every check passes, and then asks before publishing the GitHub release that
deploys to production.

Written by Robyn for LiteratureDB, and packaged so every swcore app runs the
same copy.

## Releasing

One command takes a release from `main` to the production prompt:

1. `git checkout main && git pull`
2. `pnpm version patch` (or `minor` / `major`). This:
   - refuses unless you are on `main`, the working tree is clean (untracked files included,
     since the `version` script's `git add -A` would commit them), and `main` matches
     `origin/main` (it fetches first);
   - runs the app's build, then commits the bump and tags `vX.Y.Z` on a new
     `release/vX.Y.Z` branch, leaving local `main` untouched;
   - pushes the branch and tag and opens a "Release vX.Y.Z" PR with `gh`;
   - waits for **every** check on that PR, the staging deploy of the release
     image included, checking every 30 seconds;
   - **merges it with a merge commit** once they all pass (`gh pr merge --merge
     --match-head-commit`), so the tagged commit lands on `main`. It does not
     merge if a check failed, if `main` moved since the release was cut, or if
     anything was pushed on top of the bump; it stops and says what to do;
   - checks the tagged commit is on `main`, and warns if `main` holds changes
     the release image lacks;
   - **asks before publishing**, because from there on it is a production
     deploy, then creates the GitHub release from the existing tag with
     generated notes and prints the prod workflow run.

Stopping it is safe at any point, Ctrl-C included, and so is answering no at
the prompt. `pnpm run release` picks up from wherever it stopped: waiting for
checks, merging, or publishing.

If `gh` cannot merge the PR (a required review, say), it says so and waits for
you to merge it on GitHub, with a merge commit, then carries on. To have it
never merge, and only wait for someone else to, use
`pnpm run release --no-merge`.

Pass a tag to release one from another branch: `pnpm run release v1.13.0`.

If `main` moves while the release PR is open, GitHub marks it out of date and
`pnpm version` stops rather than merge. Do not click "Update branch": that adds
a commit after the tag, so production would get an image without it. Instead,
close the PR, delete its tag and branch, and cut the release again from the new
`main`:

```bash
git checkout main && git pull
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git branch -D release/vX.Y.Z && git push origin :release/vX.Y.Z
pnpm version minor   # the same bump as before
```

## Adding it to an app

```bash
pnpm add -D @benaroyaresearch/release-branch
```

Then wire the hooks in the app's `package.json`, keeping whatever build its
`version` script already runs:

```json
"scripts": {
  "preversion": "release-branch check",
  "version": "pnpm run build && release-branch branch && git add -A",
  "postversion": "release-branch publish",
  "release": "release-branch release"
}
```

The app's committed `.npmrc` already routes `@benaroyaresearch` to GitHub
Packages, and developers' `~/.npmrc` already carries the token, because every
swcore app installs `@benaroyaresearch/bri-react-components`. The package is
public, so an app's CI and image build can install it with no access grant.

`publish` and `release` need the [GitHub CLI](https://cli.github.com/),
signed in (`gh auth login`). Without it, `pnpm version` pushes the branch and
tag, prints a link to open the PR, and stops; merge it with a merge commit and
publish the release from the existing tag on GitHub.

## Changing this package

`npm test` runs every mode against a throwaway origin repo and a fake `gh`, so
nothing touches GitHub. The fake's `pr merge` does a real `--no-ff` merge into
the throwaway `main`. The interactive confirmation is not covered by the
tests: with no terminal, `release` must never publish, and that is what they
check.

To publish a new version: bump `version` in `package.json` in a PR, merge it,
then publish a GitHub release tagged `v<that version>`. The publish workflow
refuses a tag that does not match `package.json`.
