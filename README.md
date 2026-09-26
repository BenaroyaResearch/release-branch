# @benaroyaresearch/release-branch

Releases for BRI Node apps whose `main` is branch-protected. `pnpm version`
can no longer push its bump commit straight to `main`, so this puts the bump on
a `release/vX.Y.Z` branch, opens the PR, and then, once that PR is merged,
publishes the GitHub release that deploys to production.

Written by Robyn for LiteratureDB, and packaged so every swcore app runs the
same copy.

## Releasing

1. `git checkout main && git pull`
2. `pnpm version patch` (or `minor` / `major`). This:
   - refuses unless you are on `main`, the working tree is clean (untracked files included,
     since the `version` script's `git add -A` would commit them), and `main` matches
     `origin/main` (it fetches first);
   - runs the app's build, then commits the bump and tags `vX.Y.Z` on a new
     `release/vX.Y.Z` branch, leaving local `main` untouched;
   - pushes the branch and tag and opens a "Release vX.Y.Z" PR with `gh`
     (without `gh`, it prints a link to open the PR yourself).
3. When the PR's checks pass, merge it with a **merge commit**, not squash or
   rebase, so the tagged commit is on `main`. The prod workflow refuses a
   release whose commit is not.
4. `pnpm run release`. You can start it before merging; it waits. It:
   - waits for the PR to merge, checking every 30 seconds (Ctrl-C and rerun
     any time);
   - checks the tagged commit is on `main`, and stops with the fix if the PR
     was squashed, rebased or closed instead;
   - warns if `main` got changes the release branch never had (for example
     after an "Update branch" click), because the release image will not
     contain them;
   - **asks before publishing**, because from there on it is a production
     deploy, then creates the GitHub release from the existing tag with
     generated notes and prints the prod workflow run.

Pass a tag to release one from another branch: `pnpm run release v1.13.0`.

If `main` moves while the release PR is open, GitHub marks it out of date.
Do not click "Update branch": that adds a commit after the tag, so production
would get an image without it. Instead, close the PR, delete its tag and
branch, and cut the release again from the new `main`:

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
swcore app installs `@benaroyaresearch/bri-react-components`. The one new step
per app: in this package's settings on GitHub, under **Manage Actions access**,
give the app's repository read access, so its CI and image build can install it.

`publish` and `release` need the [GitHub CLI](https://cli.github.com/),
signed in (`gh auth login`).

## Changing this package

`npm test` runs every mode against a throwaway origin repo and a fake `gh`, so
nothing touches GitHub. The interactive confirmation is not covered by the
tests: with no terminal, `release` must never publish, and that is what they
check.

To publish a new version: bump `version` in `package.json` in a PR, merge it,
then publish a GitHub release tagged `v<that version>`. The publish workflow
refuses a tag that does not match `package.json`.
