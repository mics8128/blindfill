# Releasing

Publishing is done **only** by `.github/workflows/release.yml`, triggered by pushing a tag
`vX.Y.Z` (or a pre-release tag such as `v0.1.0-alpha.0`). No token is stored in the repository.
Maintainers do not run `npm publish` by hand. Anyone with push access to the repo may push a
release tag.

## One-time owner setup (npm Trusted Publishing) — done

The npm package `blindfill` trusts GitHub Actions workflow `release.yml` in `mics8128/blindfill`
(no environment). Check with `npm trust list blindfill`. Only the npm package owner can change it.

### Fallback: long-lived token

Only if Trusted Publishing is unavailable: create a granular publish-only token for this package,
store it as the repository secret `NPM_TOKEN`, and uncomment the `env: NODE_AUTH_TOKEN` block in
`release.yml`. Rotate it, and remove it as soon as Trusted Publishing works.

## Cutting a release

```bash
# 1. bump the version (also creates the commit and the tag)
npm version 0.1.0 -m "release: %s"        # or: npm version prerelease --preid alpha
# 2. review, then push the commit and the tag
git push origin main
git push origin v0.1.0
```

If `package.json` already holds the version to release (e.g. the first release
`0.1.0-alpha.0`), just tag it: `git tag v0.1.0-alpha.0 && git push origin v0.1.0-alpha.0`.

The workflow fails if the tag does not equal `v` + the `package.json` version, then runs
`npm ci`, build, the signed Android companion (`android/release-apk.sh` with the
`ANDROID_KEYSTORE_*` secrets; fails unless `apksigner` shows the pinned certificate), lint and
tests, checks that the tarball contains `dist/android/blindfill-companion.apk`, and finally
`npm publish --provenance --access public`.
Versions with a pre-release suffix (`-alpha.0`, `-rc.1`, …) are published under the `next`
dist-tag (`npm i blindfill@next`); plain `X.Y.Z` versions become `latest`.

## Dry run (safe, publishes nothing)

```bash
npm ci && npm run build && npm run lint && npm test
npm publish --dry-run          # lists the tarball contents, does not upload
npm pack --dry-run             # same check without the registry
```

`npm publish --dry-run` fails for pre-release versions unless you add `--tag next`.
