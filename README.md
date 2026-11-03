# @benaroyaresearch/release-branch

Releases for BRI Node apps that build their image once, on the pull request,
and promote it by retag. A release is a tag on a commit `main` has already
built and deployed to staging: `pnpm release patch` picks the next version,
checks that commit's pipelines passed, asks, and publishes the GitHub release
that deploys it to production. Nothing is committed, so there is no release
branch, no release PR, no new image, and `main` does not move.

The version is the tag, not `package.json`'s `version`. The image is built
before anyone has decided its release number, so the app reads the number at
runtime from `APP_VERSION`, which Flux keeps equal to the deployment's image
tag. See [What an app needs](#what-an-app-needs).

Written by Robyn for LiteratureDB, and packaged so every swcore app runs the
same copy. 1.x put the version bump on a `release/vX.Y.Z` branch and merged it
through a PR, hence the name.

## Releasing

```bash
pnpm release patch     # or minor, major, or a version such as 1.14.0
```

That is `pnpm run release patch`: pnpm runs a script without `run` when it has
no command of that name. It reads `origin`, not your working tree, so any
checkout on any branch will do. It:

- fetches `main` and takes its head, or the commit `--target <sha>` names,
  which must be on `main` because the prod workflow refuses anything else;
- names the release after the highest `vX.Y.Z` tag on `origin`, bumped, and
  refuses a version that is not after it;
- refuses a commit that is already released, or that holds exactly the files
  the latest release does;
- waits for every workflow that commit's push to `main` started, checking every
  30 seconds, and refuses if one did not pass. On a build-once app that is
  `stg`, whose retag made the `sha-<commit>` image the prod workflow promotes
  and whose rollout check verified it in staging. Pull request, scheduled and
  Dependabot runs do not count;
- lists the commits on `main` since the latest release, then **asks before
  publishing**, because from there on it is a production deploy;
- creates the GitHub release with generated notes (`gh release create vX.Y.Z
  --target <sha>`), which makes the tag, and prints the prod workflow run.

Nothing is written before the release is created, so Ctrl-C, or answering no,
leaves nothing to clean up.

`--dry-run` stops before the question. `--yes` publishes without asking, for a
caller that has already confirmed, such as an agent; pass it with
`--target <the SHA a dry run showed>`, so the commit cannot change in between.

`pnpm version` does not release, and the app's `preversion` hook stops it
before it bumps anything, saying to run `pnpm release` instead. pnpm version
always commits and tags a bump locally, takes no options, and folds its hooks'
output into a box, so 2.1, which released from its hooks, had to undo the bump
and work around the box.

Releasing a commit older than the latest release works, and is how to roll
production back: it warns that production goes back to older code.

## What an app needs

1. **The version from the deployment.** In each fluxcd overlay, an env var set
   by the same image policy as `image:`, through the `:tag` marker:

   ```yaml
   - name: myapp
     image: ghcr.io/benaroyaresearch/myapp:1.4.2 # {"$imagepolicy": "flux-system:myapp"}
     env:
       - name: APP_VERSION
         value: "1.4.2" # {"$imagepolicy": "flux-system:myapp:tag"}
   ```

   fluxcdbot then moves both in one commit: the release's semver in
   production, `staging-<sha>-<ts>` in staging. The app reads
   `process.env.APP_VERSION` wherever it showed `package.json`'s version. A
   client bundle cannot hold it, since the bundle is built with the image:
   serve it from the server.
2. **The package and two scripts**, with `version` left at `0.0.0` so nobody
   mistakes it for the release:

   ```bash
   pnpm add -D @benaroyaresearch/release-branch
   ```

   ```json
   "version": "0.0.0",
   "scripts": {
     "preversion": "release-branch check",
     "release": "release-branch release"
   }
   ```

   `preversion` is there for whoever types `pnpm version patch` from habit:
   without it, pnpm commits and tags a `0.0.1` bump locally and stops.

3. **"Require branches to be up to date before merging" on `main`**, which the
   ci-pipeline skill sets up. With no release PR, nothing re-tests `main`
   before production; that rule is what makes every commit on `main` a tree a
   pull request fully tested.

The app's committed `.npmrc` already routes `@benaroyaresearch` to GitHub
Packages, and developers' `~/.npmrc` already carries the token, because every
swcore app installs `@benaroyaresearch/bri-react-components`. The package is
public, so an app's CI and image build can install it with no access grant.

`release` needs the [GitHub CLI](https://cli.github.com/), signed in
(`gh auth login`).

## Moving from 1.x

1. Merge the fluxcd overlay change and the app's `APP_VERSION` change above,
   then check that staging's version reads `staging-<sha>-<ts>`. A 1.x release
   still works at this point, and production then reads its semver.
2. In `package.json`, set the scripts to the two above (keep `preversion`,
   remove `version` and `postversion`), set `version` to `0.0.0`, and
   upgrade: `pnpm add -D @benaroyaresearch/release-branch@^3`.

The first release after the move counts on from the last 1.x tag. Until step
2, 3.x's hooks stop `pnpm version` before it bumps anything and point here.

## Moving from 2.x

Upgrade (`pnpm add -D @benaroyaresearch/release-branch@^3`) and set the
scripts to the two above: a 2.1 app replaces its `version` and `postversion`
scripts with `preversion`, and a 2.0 app adds it. Then release with
`pnpm release patch`. Until the scripts change, 3.x stops `pnpm version` at
2.1's `version` hook, before it commits, puts `package.json` back, and says
which scripts to replace.

## Changing this package

`npm test` runs `release` and the hooks against a throwaway origin repo and a
fake `gh`, so nothing touches GitHub. The fake's `release create` makes the
tag on the throwaway origin at `--target`, as GitHub does. The interactive
confirmation is not covered by the tests: with no terminal and no `--yes`,
`release` must never publish, and that is what they check.

To publish a new version: bump `version` in `package.json` in a PR, merge it,
then publish a GitHub release tagged `v<that version>`. The publish workflow
refuses a tag that does not match `package.json`.
