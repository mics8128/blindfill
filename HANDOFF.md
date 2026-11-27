# HANDOFF (2026-11-27)

Read this first, then SECURITY.md, README.md and docs/ARCHITECTURE.md.

## State

- Branch `main`. `npm run lint`, `npm run build` and `npx vitest run` pass: 221 passed, 11 skipped
  (opt-in Firefox, live-vault and Android-device tests).
- Version `0.1.0-alpha.0`. Nothing is tagged or published to npm. Releases only run from a pushed
  `v*.*.*` tag (`.github/workflows/release.yml`; pre-releases go to the `next` dist-tag).
  The owner authorises tags and npm publishing. Do not tag.
- Website: https://mics8128.github.io/blindfill/, built from `site/` on branch `site/landing`
  (`git subtree split --prefix site site/landing` → `gh-pages`, normal push).
- Branch `feature/ego-cli` (Ego Lite attach) stays unmerged; keep it in sync with `main` by merge.

## Verified vs not

- Verified: unit, contract, leak and e2e tests on local fake sites with Chromium. Firefox: 6/6 passed
  once against a real Camoufox build (opt-in: `BLINDFILL_TEST_FIREFOX=1`); the owner's running
  Camoufox and its contexts were not tested.
- `bw` backend: tested with a mock `bw` and fixtures only. Not run end to end against the live
  Vault (`https://vault.esapp.net`); the opt-in `tests/live-bw.test.ts` (`BLINDFILL_TEST_LIVE_BW=1`
  plus an unlocked `BW_SESSION`) does that with throw-away items. Passkey data shape was checked by
  hand with `bw` (create and read back of a fake item, since deleted); real-client-created passkeys unverified.
- Passkeys: web sign-in through a Chromium virtual authenticator, tested against a fake relying
  party that verifies the signature. No counter write-back, no registration, no Firefox.
- `op`, `rbw`, `pass`, `gopass`, `keepassxc`, `secret-service`: blind-written, unverified.
- Android: companion APK (`android/`), passwords via autofill and passkeys via the credential
  provider, signed on the host. Release-signed (certificate SHA-256
  `C7EDE55AB64522DC9BC142F8F20B9BAABE5341D828210183D991157FE0EC45C8`; key custody in SECURITY.md
  item 16); the host checks the installed APK's signer before every arm; `blindfill android
install --serial <s> [--set-services]`. CI job `android` builds and checks the signed APK;
  `release.yml` ships it in the npm package. Tested with the release APK and a fake app on the
  Xperia 5 II (Android 17) on ollie-ubuntu and on a headless arm64 emulator on the owner's Mac
  (Android 16, API 36): `BLINDFILL_TEST_ANDROID_SERIAL=<serial>
BLINDFILL_COMPANION_APK=<release apk> npx vitest run tests/android-device.test.ts` after
  `cd android && ./gradlew assembleDebug` (android/README.md); not with real apps.
- Not supported: passkey registration, WebKit, Firefox on an already-running browser,
  the owner's running Ego Lite (no CDP). Ego Lite works only as a separately launched,
  empty-profile instance via `chromium-launch --executable` / `BLINDFILL_CHROMIUM`.

## Rules to keep

- Passwords only go straight from the backend into the target field. Never print, log, return,
  screenshot, write to files, or put them in messages. Secret-class fields (password, Hidden custom
  fields, card number) are fill-only. Keys (TOTP seed, SSH and passkey private keys) are never read
  and never filled: the seed only yields codes, a passkey only signs. TOTP codes are readable like
  text. Notes are unreadable by default.
- README and website claims must match the code. Do not claim unverified support.
- Do not build an attach provider for the running Ego Lite until an outbound-traffic capture and an
  operation-log check show filled values do not leak, and TLS interception needs the user's consent.
  Even then, never label it "supported".
- Before pushing: `git pull --rebase`, no force-push (including `--force-with-lease`), only push
  lint/build/test green state.
- Do not touch the shared Camoufox profile (`/home/ollie/.camoufox/default`) from tests.
- Device tests use fake data only and restore `autofill_service`, `credential_service` and
  `credential_service_primary`, then uninstall the companion.

## Next steps

1. End-to-end `bw` run against the real Vault (`tests/live-bw.test.ts`, needs an unlocked Vault on
   ollie-ubuntu), including `item create|generate`.
2. Ollie's real-use test round, recorded in `docs/TESTED.md`; then align README x5, SECURITY.md,
   this file and the website with it.
3. Remaining partial rows in docs/MIGRATING-FROM-OLLIEPM.md section 3 (MCP `profile_login`/`list_credentials`).
4. Owner decisions still open: migrate ~15 olliepm items into the Vault, `agent-ollie` collection
   permission (read-only suggested), default web match strictness (Host vs Base domain), where rules
   live (custom field vs Notes).
