# HANDOFF (2026-11-27)

Read this first, then SECURITY.md, README.md and docs/ARCHITECTURE.md.

## State

- Branch `main`. `npm run lint`, `npm run build` and `npx vitest run` pass: 228 passed, 11 skipped
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
- `bw` backend: mock `bw` and fixtures in CI. `tests/live-bw.test.ts` (`BLINDFILL_TEST_LIVE_BW=1`
  plus an unlocked `BW_SESSION`) passed on 2026-11-27 against the live Vault
  (`https://vault.esapp.net`, Bitwarden CLI 2026.11.1) with throw-away items on local fake pages:
  password + TOTP fill, `item generate` + register; items removed afterwards. Not yet used on real
  websites. Passkey data shape was checked by hand with `bw` (create and read back of a fake item,
  since deleted); real-client-created passkeys unverified.
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
  `cd android && ./gradlew assembleDebug` (android/README.md). Real apps on the same Xperia with a
  live `bw` item and the companion debug build (2026-11-27): Threads sign-in succeeded; Instagram
  partial (suggestion filled and login tapped, result not checked). Rows in `docs/TESTED.md`.
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

1. Done 2026-11-27: end-to-end `bw` run against the real Vault and Ollie's real-use round, recorded
   in `docs/TESTED.md`; README x5, SECURITY.md, this file and the website aligned with it.
2. Done 2026-11-27 (Mics approved): olliepm migrated. 15 items in the `agent-ollie` collection
   (Estiginto org), values compared in-process with olliepm (all match, never shown);
   `brightbean-ollie` deleted (unused, in the Vault trash); `linejs-pilot` handoff not migrated (no
   equivalent by design; LINE re-login keeps using olliepm). `blindfill.rules` set by Mics at a
   terminal on 11 items. Rules rejected by `parseRulesValue` (`:has()` and value/state selectors) for
   qbo-ollie, line-ollie, walmart-ollie, walmart-ollie-setup, and one rule each of gmail and
   ig-dj.mikechen, wait in `ollie-ubuntu:~/projects/blindfill-migration-rules/needs-rewrite/`;
   rewrite one against the live page only when generic fill fails there. `blindfill.registration`
   not enabled (Mics: login only for now). Communicate with Ollie (OpenClaw agent on ollie-ubuntu)
   with `openclaw agent --agent ollie --session-key agent:ollie:blindfill --message-file <f>` over
   `ssh ollie@ollie-ubuntu`, without `--deliver`; Ollie writes `docs/TESTED.md` rows, the owner
   commits.
3. Remote commands for Mics need absolute paths and a login shell:
   `ssh -t ollie@ollie-ubuntu bash -l /home/ollie/...` (`bw` lives in `~/.local/bin`).
4. Owner decisions (2026-11-27): migrate the ~15 olliepm items only after Ollie's real-Vault test
   round (ask Mics and Ollie before touching real data); `agent-ollie` collection is **writable** (the
   agent may store accounts it registers; set in the Vault, not in this repo); default web match stays
   Host; rules live in the custom field `blindfill.rules`; MCP `list_credentials` stays (agents see
   item names, origins and field names, never values).
5. Owner decisions on passkeys (Mics, 2026-11-27; docs/design/passkey-feasibility.md §9):
   1. The shared Camoufox may be restarted with `-marionette` and the softtoken prefs, but only after
      Phase 0 spike 2 passed (it did, 2026-11-27, on a separate throw-away Camoufox). Not applied yet.
   2. On opted-in items the agent may add a passkey without a terminal: add only, never replace or
      delete (same footing as `item generate`).
   3. Counter write-back to the Vault needs no terminal.
   4. Phase 5 real site: GitHub; Mics will put the account in the Vault (no passkey registered yet).
