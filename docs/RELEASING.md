# Releasing

Publishing is done **only** by `.github/workflows/release.yml`. It runs when a push to `main`
changes `package.json`, or when started by hand on `main`, and publishes only if the `package.json`
version is not on npm yet. No token is stored in the repository. Maintainers do not run
`npm publish` or push release tags by hand: the workflow creates the tag `v<version>` and the
GitHub Release after a successful publish.

## One-time owner setup (npm Trusted Publishing) — done

The npm package `blindfill` trusts GitHub Actions workflow `release.yml` in `mics8128/blindfill`
(no environment). Check with `npm trust list blindfill`. Only the npm package owner can change it.

### Fallback: long-lived token

Only if Trusted Publishing is unavailable: create a granular publish-only token for this package,
store it as the repository secret `NPM_TOKEN`, and uncomment the `env: NODE_AUTH_TOKEN` block in
`release.yml`. Rotate it, and remove it as soon as Trusted Publishing works.

## Cutting a release

```bash
# bump the version without a local tag, then push it to main (directly or through a merged PR)
npm version 0.1.0 --no-git-tag-version   # or: npm version prerelease --preid alpha --no-git-tag-version
git commit -am "release: 0.1.0"
git push origin main
```

The workflow then runs the full test suite on Windows (`test-windows`) and, on Linux, `npm ci`,
build, the signed Android companion (`android/release-apk.sh` with the `ANDROID_KEYSTORE_*`
secrets; fails unless `apksigner` shows the pinned certificate), lint and tests, checks that the
tarball contains `dist/android/blindfill-companion.apk`, runs
`npm publish --provenance --access public`, and finally tags `v<version>` and creates the GitHub
Release with generated notes (marked pre-release for `-alpha`/`-rc` versions).
Versions with a pre-release suffix (`-alpha.0`, `-rc.1`, …) are published under the `next`
dist-tag (`npm i blindfill@next`); plain `X.Y.Z` versions become `latest`.

If a release run fails (for example `test-windows`), nothing is published. Fix the cause on `main`,
then start the workflow again without changing the version:
`gh workflow run release.yml --ref main` (or Actions → Release → Run workflow). A run on any other
branch publishes nothing.

## Dry run (safe, publishes nothing)

```bash
npm ci && npm run build && npm run lint && npm test
npm publish --dry-run          # lists the tarball contents, does not upload
npm pack --dry-run             # same check without the registry
```

`npm publish --dry-run` fails for pre-release versions unless you add `--tag next`.
