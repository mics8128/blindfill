# Releasing

Publishing is done **only** by `.github/workflows/release.yml`, triggered by pushing a tag
`vX.Y.Z`. No token is stored in the repository. Maintainers do not run `npm publish` by hand.

## One-time owner setup (npm Trusted Publishing)

1. Make sure the repository exists on GitHub and the `repository` URL in `package.json` points to it
   (it must match the GitHub repo URL, because provenance checks it).
2. Publish access: the first release of a new package name must be possible for your npm account.
   If Trusted Publishing cannot be configured before the package exists, do a one-time bootstrap
   (see fallback below), then switch.
3. On npmjs.com: package → **Settings** → **Trusted Publisher** → GitHub Actions, and enter:
   organization/user, repository `blindfill`, workflow filename `release.yml`
   (leave environment empty unless you add one to the workflow).
4. Optionally restrict publishing to the tag workflow and enable 2FA on the npm account.

### Fallback: long-lived token

Only if Trusted Publishing is unavailable: create a granular publish-only token for this package,
store it as the repository secret `NPM_TOKEN`, and uncomment the `env: NODE_AUTH_TOKEN` block in
`release.yml`. Rotate it, and remove it as soon as Trusted Publishing works.

## Cutting a release

```bash
# 1. bump the version (also creates the commit and the tag)
npm version 0.1.0 -m "release: %s"        # or: npm version prerelease --preid alpha
# 2. review, then (owner only) push the commit and the tag
git push origin main
git push origin v0.1.0
```

The workflow fails if the tag does not equal `v` + the `package.json` version, then runs
`npm ci`, build, lint and tests, and finally `npm publish --provenance --access public`.

## Dry run (safe, publishes nothing)

```bash
npm ci && npm run build && npm run lint && npm test
npm publish --dry-run          # lists the tarball contents, does not upload
npm pack --dry-run             # same check without the registry
```

For a pre-release version such as `0.1.0-alpha.0`, publish with `--tag next` if you do not want it
to become `latest` (edit the publish step accordingly).
