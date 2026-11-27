# HANDOFF (2026-11-27)

Read this first, then SECURITY.md, README.md and docs/ARCHITECTURE.md.

## State

- Branch `main`. `npm run lint`, `npm run build` and `npx vitest run` pass: 278 passed, 20 skipped
  (opt-in Firefox, live-vault and Android-device tests).
- Version `0.1.0`, published to npm by `release.yml` (tag `v0.1.0`). Releases run only when a push to
  `main` changes the `package.json` version (`.github/workflows/release.yml`, see
  `docs/RELEASING.md`; it tags and creates the GitHub Release itself; pre-releases go to `next`).
  The owner authorises version bumps. Do not tag or publish by hand.
- Website: https://mics8128.github.io/blindfill/, built from `site/` on branch `site/landing`
  (`git subtree split --prefix site site/landing` → `gh-pages`, normal push).
- `ego-cli` (Ego Lite attach) is merged and supported (owner decision 2026-11-28); a real-site sign-in
  through it is pending until the owner's Mac has the agent's Vault key.

## Verified vs not

- Verified: unit, contract, leak and e2e tests on local fake sites with Chromium. Firefox: 10/10 passed
  against a real Camoufox build started with `-marionette` and the softtoken prefs (opt-in:
  `BLINDFILL_TEST_FIREFOX=1`), on the owner's Mac; two of them use a persistent context published with
  `browser.bind` (like `camoufox-desktop`): blindfill reuses it, opens its own tab for `--url` and never
  navigates or closes existing tabs (docs/browsers.md, "Contexts"). Ollie's running shared Camoufox:
  read-only `session attach` + `page list` only (2026-11-27); no fill or login there yet.
- `bw` backend: mock `bw` and fixtures in CI. `tests/live-bw.test.ts` (`BLINDFILL_TEST_LIVE_BW=1`
  plus an unlocked `BW_SESSION`) passed on 2026-11-27 against the live Vault
  (`https://vault.esapp.net`, Bitwarden CLI 2026.11.1) with throw-away items on local fake pages:
  password + TOTP fill, `item generate` + register; items removed afterwards. Not yet used on real
  websites. Passkey data shape was checked by hand with `bw` (create and read back of a fake item,
  since deleted); real-client-created passkeys unverified.
- Passkeys: web sign-in through a Chromium virtual authenticator and Android host signing, with the
  counter written back to the vault (no terminal) and BE=BS=1 like Bitwarden clients; Android app
  registration through the companion (`android passkey-register --rp-id`, add only; fake app on the
  emulator and the Xperia, create then sign in); web
  registration in Chromium (`passkey register`, add only, any bound item without a passkey); Firefox/Camoufox sign-in and
  registration over Marionette (`BLINDFILL_MARIONETTE`, BE=0 recorded as `blindfill.passkey_be=0`;
  Bitwarden-made BE=1 passkeys are signed there with BE=0, so BE-checking sites reject them). Tested against a strict fake relying party (Firefox: opt-in
  suite) and, with the live Vault in Chromium, on webauthn.io: three sign-ins in a row, a registration
  then a sign-in (item `webauthn-io-interop`, kept), Mics's Bitwarden extension signed in with it, and
  blindfill signed in again after the extension (counter accepted). GitHub (`github-ollie`, 2026-11-28,
  Chromium on ollie-ubuntu): password login once, passkey added from Settings, signed out, two passkey
  sign-ins in fresh sessions (counter 2, 3 written back), Mics's Bitwarden extension signed in with it,
  then blindfill again (counter 5, after a `bw sync` fix). Not tested: passkeys made by
  Bitwarden clients used by blindfill; Firefox passkeys on a real site or in the shared Camoufox.
- `op`, `rbw`, `pass`, `gopass`, `keepassxc`, `secret-service`: blind-written, unverified.
- Android: companion APK (`android/`), passwords via autofill (login, sign-up with `android register`,
  WebViews bound by https domain) and Credential Manager (`GetPasswordOption`), passkeys via the credential
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
  Owner decisions 2026-11-27 (design `docs/design/android-app-registration-webview.md`): apps bound by
  package like Bitwarden, `blindfill.signers` optional (SECURITY 21); WebViews by domain alone
  (SECURITY 22); Credential Manager passwords built. Sign-up, WebView and Credential Manager
  passwords tested with the fake app only (emulator and Xperia, 8/8, 2026-11-28).
- Not supported: WebKit, Firefox on an already-running browser. The owner's running Ego Lite (no
  CDP) is reached through `ego-cli` (supported); a separately launched, empty-profile instance works
  via `chromium-launch --executable` / `BLINDFILL_CHROMIUM`.

## Rules to keep

- Passwords only go straight from the backend into the target field. Never print, log, return,
  screenshot, write to files, or put them in messages. Secret-class fields (password, Hidden custom
  fields, card number) are fill-only. Keys (TOTP seed, SSH and passkey private keys) are never read
  and never filled: the seed only yields codes, a passkey only signs. TOTP codes are readable like
  text. Notes are unreadable by default.
- README and website claims must match the code. Do not claim unverified support.
- `ego-cli` passes filled values through Ego's Node runtime (SECURITY 24). Re-run the outbound-traffic
  check (docs/browsers.md, Ego Lite) after Ego updates; TLS interception needs the user's consent.
- Before pushing: `git pull --rebase`, no force-push (including `--force-with-lease`), only push
  lint/build/test green state.
- Do not touch the shared Camoufox profile (`/home/ollie/.camoufox/default`) from tests.
- Device tests use fake data only and restore `autofill_service`, `credential_service` and
  `credential_service_primary`, then uninstall the companion.

## Next steps

1. Done 2026-11-27: end-to-end `bw` run against the real Vault and Ollie's real-use round, recorded
   in `docs/TESTED.md`; README x5, SECURITY.md, this file and the website aligned with it.
2. Done 2026-11-27 (Mics approved): the earlier internal tool's items migrated. 15 items in the
   `agent-ollie` collection (Estiginto org), values compared in-process with the old store (all
   match, never shown); `brightbean-ollie` deleted (unused, in the Vault trash); `linejs-pilot`
   handoff not migrated (no equivalent by design; LINE re-login keeps using the old tool). `blindfill.rules` set by Mics at a
   terminal on 11 items. Rules rejected by `parseRulesValue` (`:has()` and value/state selectors) for
   qbo-ollie, line-ollie, walmart-ollie, walmart-ollie-setup, and one rule each of gmail and
   ig-dj.mikechen, wait in `ollie-ubuntu:~/projects/blindfill-migration-rules/needs-rewrite/`;
   rewrite one against the live page only when generic fill fails there. The `blindfill.registration`
   opt-in was removed on 2026-11-28 (item 10). Communicate with Ollie (OpenClaw agent on ollie-ubuntu)
   with `openclaw agent --agent ollie --session-key agent:ollie:blindfill --message-file <f>` over
   `ssh ollie@ollie-ubuntu`, without `--deliver`; Ollie writes `docs/TESTED.md` rows, the owner
   commits.
3. Remote commands for Mics need absolute paths and a login shell:
   `ssh -t ollie@ollie-ubuntu bash -l /home/ollie/...` (`bw` lives in `~/.local/bin`).
4. Owner decisions (2026-11-27): migrate the ~15 old-tool items only after Ollie's real-Vault test
   round (ask Mics and Ollie before touching real data); `agent-ollie` collection is **writable** (the
   agent may store accounts it registers; set in the Vault, not in this repo); default web match stays
   Host; rules live in the custom field `blindfill.rules`; MCP `list_credentials` stays (agents see
   item names, origins and field names, never values).
5. Owner decisions on passkeys (Mics, 2026-11-27; docs/design/passkey-feasibility.md §9):
   1. The shared Camoufox may be restarted with `-marionette` and the softtoken prefs, but only after
      Phase 0 spike 2 passed (it did, 2026-11-27, on a separate throw-away Camoufox). Applied
      2026-11-27 by Ollie: `~/.local/bin/camoufox-desktop` starts with `-marionette` (127.0.0.1:2828).
   2. The agent may add a passkey without a terminal: add only, never replace or
      delete (same footing as `item generate`).
   3. Counter write-back to the Vault needs no terminal.
   4. Phase 5 real site: GitHub (`github-ollie`); passkey registered 2026-11-28 (see `docs/TESTED.md`).
   5. Firefox/Camoufox also use BE=1 (Bitwarden-made) passkeys: signed with BE=0 (Firefox cannot set
      BE), no POLICY refusal; if the relying party rejects it, that is an ordinary failure and the
      caller uses Chromium. `blindfill.passkey_be` is still recorded. Marionette has no W3C
      `WebAuthn:SetCredentialProperties` yet; when it lands, BE can be set.
6. Owner decision on TOTP (Mics, 2026-11-27): an agent may add a TOTP seed without a terminal
   (`totp enroll`), add only: an item that already has a seed is refused (same footing as
   `item generate` and add-only passkeys).
7. Owner decision on rules (Mics, 2026-11-27): an agent may add or change `blindfill.rules` with
   `item edit --set` without a terminal, password fields included; Mics accepts that a misled agent
   could map a secret into a public field on a bound origin. Origins, secrets and every other
   `blindfill.*` control field still need a terminal.
8. Real-site state (2026-11-27, rows in `docs/TESTED.md`): Fastmail (`fastmail-milu`) and
   eccang (`eccang-ollie`, rule with `submit.outside_form`) log in; QBO is ambiguous (fields in an
   iframe); iCHEF (`ichef-main`) not retested since `store_id` was added. Walmart Seller
   (`walmart-ollie-setup`; the old `walmart-ollie` is in the Vault trash) now uses an authenticator
   app: seed added with `totp enroll`. Its two rules share one origin, so pass
   `--rule walmart_official_login` to log in and `totp --fill --rule walmart_totp` for the code.
   Real-site tests use a throw-away Camoufox profile, accept cookie banners, submit once, and stop
   at CAPTCHA, consent or any MFA the item has no TOTP for. Shared Camoufox on ollie-ubuntu: one window, new pages as tabs
   (`open_newwindow=3`), at most 12 tabs (`camoufox-idle-tabs`), windows fitted once by
   `camoufox-window-fit`; backups `*.bak-*` next to each file. blindfill attaches to it with
   `session attach --browser firefox-connect --endpoint-file /run/user/$(id -u)/camoufox-desktop/connection.json`
   and uses its profile (logged-in sites stay logged in); read-only so far.
9. Owner decision on host isolation (Mics, 2026-11-27; docs/design/line-gateway-login.md §5): on
   ollie-ubuntu, Ollie and the `bw` agent API key stay the same Unix user (`ollie`, NOPASSWD sudo);
   no separate user for the key, blindfill or the LINE gateway. Ollie can therefore read any vault
   password with `bwu`; blindfill's no-read guarantee there is a convention, accepted.
10. Owner decision on registration (Mics, 2026-11-28): the `blindfill.registration` opt-in is gone.
    `passkey register`, `android passkey-register`, `android register` and `register --rule` need only
    an item bound to the page or app (and, for passkeys, no passkey yet; nothing replaces or deletes
    one); `item generate` no longer writes the field and `--no-registration` is gone; items that still
    carry it are ignored. `item generate --no-password` makes a username-only item for passkey-only
    sites; password login, fill, `register` and `android fill` refuse it ("no password").
11. Owner decision on Windows (Mics, 2026-11-28): support Windows. Windows tests do not run on every
    push; the `test-windows` job in `release.yml` runs them before a release. ACL checks in place of mode bits
    (`src/core/acl.ts`, SECURITY.md), Node-script backends run under `process.execPath` (Windows cannot
    exec a shebang file), `ego-cli` refused on Windows. Full suite passed on mics-i7 (Windows 11,
    Node 24). Not yet done: a real-site run on Windows (webauthn.io with `webauthn-io-interop`) waits
    for Mics to put the agent `bw` API key on mics-i7; `bw` 2026.6.0 (scoop) is installed there.
