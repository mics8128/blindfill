<div align="center">

# blindfill

**Let AI agents sign in to websites without ever seeing the password.**

**[Website: mics8128.github.io/blindfill](https://mics8128.github.io/blindfill/)**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

Let an AI agent sign in to websites **without ever seeing the password**. blindfill reads the
credential from your password manager, checks it is bound to the page's origin, types it into the
real form, and returns only structure and an outcome. Secret values are write-only
(`SecretHandle.into(sink)`), scrubbed from output, and the session locks after a fill.

> **Status: alpha (0.1.0-alpha.0).** Read [SECURITY.md](SECURITY.md) for the threat model and known gaps first.

## Examples: the password never goes through the LLM

Output below is illustrative; field names may differ slightly.

1. **Sign in.** The agent calls `fill` with an item id and a login URL. blindfill reads the password from `bw`, types it into the form and returns `{"ok": true, "url": ".../home"}`. The model sees only the outcome, never the password.
2. **Phishing and prompt injection.** A lookalike page (`examp1e.com` instead of `example.com`) or a cross-origin iframe is refused **before any secret is read**. A malicious page cannot talk the agent into typing the password somewhere else.
3. **One-time codes.** `totp_code` returns the current 6-digit code (it is readable and fillable, like text). The TOTP seed never leaves the backend.
4. **Locked after fill.** After a fill, the session refuses page text, DOM and screenshots, so a page that echoes the password back cannot leak it to the model.

## Supported backends and browsers

| Backend                                                                                          | Tier                                               | Notes                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bitwarden / Vaultwarden (`bw`)                                                                   | verified (mock CLI + fixtures; one live-vault run) | 2026-11-27: `tests/live-bw.test.ts` passed against a live Vaultwarden (Bitwarden CLI 2026.11.1) with throw-away items on local fake pages (password + TOTP fill, generate + register). Real websites with `bw`: not yet. |
| 1Password (`op`), rbw, pass, gopass, KeePassXC (`keepassxc-cli`), Secret Service (`secret-tool`) | blind-written, unverified                          | Pass the shared contract tests on fixtures only. Run `blindfill backend selftest <id>` and open a backend report.                                                                                                        |

| Browser                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium: Playwright bundled, any Chromium build (`--executable`), or loopback CDP | supported, tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Firefox / Camoufox via a loopback Playwright server (`--browser firefox-connect`)  | tested (opt-in suite) against Camoufox 158.0.1-beta.41 and 159.0-beta.43. A server with a persistent profile (e.g. a shared Camoufox) is reused as is: its cookies and logins, `--url` opens its own tab, existing tabs are never navigated or closed ([docs/browsers.md](docs/browsers.md)); checked read-only against a long-running instance                                                                                                                                                                                                                                                                                           |
| Ego Lite                                                                           | only as a separate, empty-profile instance (`--executable`); attaching to the running app is unsupported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| WebKit / Safari                                                                    | not supported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Android (14+) | companion APK: autofill for passwords (login, and sign-up forms filled with a password from `item generate`), Credential Manager for passwords and passkeys (sign-in, and add-only passkey registration on opted-in items; keys made and used on the host); apps bound by package name like Bitwarden, a `blindfill.signers` pin checked when the item has one; WebViews bound by their https domain alone (see SECURITY.md 21–23); release-signed, and the host checks the installed companion's signer before every fill; install with `blindfill android install --serial <s>` ([android/README.md](android/README.md)); tested with a fake app on one phone (Xperia 5 II, Android 17) and an emulator (Android 16): password, sign-up, WebView login and sign-up, Credential Manager password, passkey registration then sign-in. Real apps on that phone with a live `bw` vault (2026-11-27): Threads sign-in succeeded; Instagram partial (suggestion filled, login result not checked) |
| Passkeys                                                                           | web sign-in and registration (add only, opted-in items) in Chromium, and in Firefox/Camoufox through Marionette (`BLINDFILL_MARIONETTE`; Firefox signs with BE=0, so a site that checks BE may reject Bitwarden-made passkeys there: use Chromium). Tested against a fake strict relying party (Firefox: opt-in suite, Camoufox on Mac and Linux); on webauthn.io with a `bw` vault on 2026-11-27 in Chromium: three sign-ins in a row, a registration then a sign-in, and the Bitwarden extension signed in with that blindfill-made passkey; the sign counter is written back to the vault                                              |

Browser providers and their contract: [docs/browsers.md](docs/browsers.md). Every test run, including failures: [docs/TESTED.md](docs/TESTED.md).

## What works (verified by the test suite)

- **Web fill**: origin binding from the vault item, frames only through an explicit rule, refusal if the
  page navigates between planning and typing, honeypot skipping, SPA waits, one-shot submit, post-fill lock.
- **Field rules and login profiles**: exact selectors per site in the item (`blindfill.rules`) or a local
  profile, for forms heuristics cannot read. Rule selectors are plain CSS without value or state probes.
- **Page tools**: `page discover|diagnose|verify|list` report structure and booleans, never values, and are
  refused while the session is locked.
- **Registration**: `item generate` creates an item with a CSPRNG password that is never shown;
  `register` types it into a sign-up form (password and confirmation) on a bound origin.
- **Authenticator setup**: `totp enroll --item <id> --selector <css>` reads the setup key (or
  `otpauth://totp` URI) from one element of a bound page and saves it to an item that has no TOTP seed;
  the key is never printed, and an existing seed is never replaced. Then `totp --fill` types the code.
- **Item admin**: `item list|status|rename|edit`. Secret values, origins and `blindfill.*` fields change only
  at a terminal, except `blindfill.rules`, which an agent may edit (see SECURITY.md). There is no `item reveal`.
- **Human handoff**: `handoff pause|resume` hands the browser to a person for a CAPTCHA, consent or MFA;
  agent actions are refused meanwhile, and the lock survives resume.
- **Interfaces**: CLI, MCP server (stdio) and a library API (`withPage(page, …)`).
- **Leak test**: fill, rules, profiles, page tools, registration, item admin and handoff run through the CLI
  and MCP with a canary password and a generated one; all output, errors, `DEBUG=pw:api` logs and state
  files are searched in raw, URL, Base64 and hex forms.

## Not done

- Android: saving logins typed by hand, sign-up, WebView and Credential Manager passwords in a real app, passkey registration in a real app. WebKit. Firefox passkeys on a real site or in a long-running Camoufox.
- `bw` on real websites: the live-vault runs used local fake pages, and webauthn.io (no account) for passkeys. The other six backends are blind-written and unverified.
- Not published to npm (`latest` is an empty placeholder).
- Moving from olliepm: [docs/MIGRATING-FROM-OLLIEPM.md](docs/MIGRATING-FROM-OLLIEPM.md).

## Try it

```bash
npm ci && npm run build && npx playwright-core install chromium
export BW_SESSION="$(bw unlock --raw)"        # env only
mkdir -p ~/.config/blindfill && echo '{"backend":"bw"}' > ~/.config/blindfill/config.json
node dist/cli.js backend list
node dist/cli.js session start --headless
node dist/cli.js fill --item <id> --url https://example.com/login --submit --expect-url /home
node dist/cli.js mcp                           # MCP server on stdio, see examples/mcp-config.json
```

## Develop

`npm run lint && npm test && npm run build`. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Releasing (tag-triggered, npm Trusted Publishing): [docs/RELEASING.md](docs/RELEASING.md). MIT licensed.

## Translations

Translation PRs are welcome: improvements to [繁體中文](README.zh-TW.md), [简体中文](README.zh-CN.md),
[日本語](README.ja.md) and [한국어](README.ko.md), or new languages. The English README is the source of truth.
