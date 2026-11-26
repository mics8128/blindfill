# HANDOFF (2026-11-27, written by Ollie)

Work was paused by the owner and is handed to another agent ("omp"). Read this first.

## State at handoff

- Branch `main`. `npm run lint`, `npm run build`, `npx tsc --noEmit` and `npm test` pass on HEAD:
  189 passed, 6 skipped (opt-in Firefox tests).
- Version `0.1.0-alpha.0`. Nothing is tagged or published to npm. Releases only run from a pushed
  `v*.*.*` tag (`.github/workflows/release.yml`; pre-releases go to the `next` dist-tag).
  The owner authorises tags and npm publishing. Do not tag.
- Website WIP lives on branch `site/landing` (see `site/HANDOFF.md` on that branch). Not on main.

## Done (commits, oldest first)

- `1a100f1` pluggable BrowserProvider layer: `chromium-launch`, `chromium-cdp`, `firefox-connect`,
  `borrowed-page`, registry, `--browser <id>`, `withPage`, `docs/browsers.md`. `probe`/`candidates`
  honour `--url` (CLI and MCP).
- `1ddd831`, `1f8141e` ARCHITECTURE.md synced with the code.
- `bc346ae` explicit field rules, login profiles, `page discover|diagnose|verify|list`, registration.
- `749c816` `item generate|create|password-policy`, CSPRNG password generation, Backend
  `createItem`/`updateSecret`/`updateItem` for `bw` (bodies via stdin; mock-verified only).
- `c13526b` human handoff (pause/resume for CAPTCHA, consent, MFA); agent actions refused while
  paused; CLI + MCP `human_handoff`.
- `210bc77` item admin CLI (`list`, `status`, `rename`, `edit`); no `item reveal`.

## NOT done (original 7-item brief)

Item 7 is not done:

- README (all five languages) does not yet describe items 2-6 or the Firefox/Camoufox row.
- `SECURITY.md` known-gaps update.
- `docs/MIGRATING-FROM-OLLIEPM.md` is not written.
- The worker was killed before it reported. I did not verify that the leak test
  (`tests/` leak test with a canary password) covers every new path (generate, create, rules,
  profiles, handoff, discover/diagnose/verify, item admin). Check this first and extend it.
- I did not read the new code in review. Check that no new path prints, logs, screenshots or
  returns a Secret-class value (including generated passwords, error messages and `DEBUG=pw:api`).
- olliepm files the worker may not have fully ported for safety semantics:
  `~/services/security/olliepm` and `~/projects/ollie-password-management`
  (server.py, session.py, share.py, policy.py, engine.py, cli.py, tests/, docs/).

## Verified vs not

- Verified: unit, contract and e2e tests on local fake sites with Chromium. Firefox: 6/6 passed
  once against a real Camoufox build (opt-in: `BLINDFILL_TEST_FIREFOX=1`); the owner's running
  Camoufox and its contexts were not tested.
- `bw` backend: tested with a mock `bw` and fixtures only. Not run end to end against the live
  Vault (`https://vault.esapp.net`). Passkey data shape was checked by hand with `bw` (create and
  read back of a fake item, since deleted); real-client-created passkeys unverified.
- `op`, `rbw`, `pass`, `gopass`, `keepassxc`, `secret-service`: blind-written, unverified.
- Not supported: Android, passkey signing, WebKit, Firefox on an already-running browser,
  the owner's running Ego Lite (no CDP). Ego Lite works only as a separately launched,
  empty-profile instance via `chromium-launch --executable` / `BLINDFILL_CHROMIUM`.

## Rules to keep

- Passwords only go straight from the backend into the target field. Never print, log, return,
  screenshot, write to files, or put them in messages. Only Secret-class fields (password, TOTP
  seed, Hidden custom fields, card number, private keys, passkey private keys) are fill-only.
  TOTP codes are readable like text. Notes are unreadable by default.
- README and website claims must match the code. Do not claim unverified support.
- Do not build an attach provider for the running Ego Lite until an outbound-traffic capture and an
  operation-log check show filled values do not leak. Even then, never label it "supported".
- Before pushing: `git pull --rebase`, no force-push, only push lint/build/test green state.
- Do not touch the shared Camoufox profile (`/home/ollie/.camoufox/default`) from tests.

## Next steps, in order

1. Review the new code and extend the leak test to every new path.
2. Finish item 7: README x5 languages, SECURITY.md gaps, `docs/MIGRATING-FROM-OLLIEPM.md`.
3. Run an end-to-end test of `bw` against the real Vault (allowed by the owner; the Vault holds no
   production data), including `item create|generate`.
4. Passkey `sign` for web (ARCHITECTURE.md section 3.8), then the Android actuator.
5. Review and fix the website on `site/landing`, then ask the owner before deploying.
6. Owner decisions still open: migrate ~15 olliepm items into the Vault, `agent-ollie` collection
   permission (read-only suggested), default web match strictness (Host vs Base domain), where
   rules live (custom field vs Notes), accept the `blindfill` GitHub org admin invitation.
