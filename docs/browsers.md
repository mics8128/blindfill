# Browsers and providers

blindfill drives a Playwright `Page`. How that page is obtained is a **BrowserProvider**
(`src/actuators/web/providers/`, one file per provider, registered in `registry.ts`).

| id                | file                 | what it does                                                                                                   | attach to a running browser |
| ----------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `chromium-launch` | `chromium-launch.ts` | Playwright launches Chromium (bundled, or `--executable` / `BLINDFILL_CHROMIUM` / `web.executablePath`)        | no (owns its browser)       |
| `chromium-cdp`    | `chromium-cdp.ts`    | `connectOverCDP`, loopback only                                                                                | yes                         |
| `firefox-connect` | `firefox-connect.ts` | Playwright browser-server websocket (Firefox / Camoufox), loopback only                                        | yes                         |
| `ego-cli`         | `ego-cli.ts`         | **opt-in, not supported**: the running Ego Lite via `ego-browser nodejs` (`ego://new`, `ego://<space>/<page>`) | yes (Ego task spaces)       |
| `borrowed-page`   | `borrowed-page.ts`   | library use: caller passes its own `Page` (`withPage(page, …)`); never closed by blindfill                     | n/a                         |

## Connecting a browser

**Nothing configured.** `blindfill session start` launches its own Chromium (Playwright's bundled build, or any
Chromium-based browser via `--executable`, `BLINDFILL_CHROMIUM` or `web.executablePath`; headless unless `--headed` or
`web.headless: false`). It starts with an empty profile and `session stop` closes it.

**Your own running browser, set once.** Put the endpoint in `~/.config/blindfill/config.json` (or the file named by
`BLINDFILL_CONFIG`), for example one of:

```
{ "backend": "bw", "web": { "endpoint": "http://127.0.0.1:9222" } }
{ "backend": "bw", "web": { "endpointFile": "/path/to/endpoint.json", "browser": "firefox-connect" } }
```

Then `blindfill session attach` needs no arguments, and the other commands (`fill`, `page list`, …) connect to it
directly. Order: flags (`--endpoint`/`--cdp`, `--endpoint-file`, `--browser`) > environment (`BLINDFILL_ENDPOINT`,
`BLINDFILL_ENDPOINT_FILE`, `BLINDFILL_BROWSER`) > config (`web.endpoint` or its alias `web.cdp`, `web.endpointFile`,
`web.browser`). Any endpoint flag replaces all configured endpoints; an endpoint wins over an endpoint file.
Without `browser`, the provider is inferred: `http(s)://` or a `/devtools/` path is `chromium-cdp`, any other `ws://`
is `firefox-connect`. Endpoints must be loopback.

**Endpoint file.** JSON `{"endpoint": "ws://127.0.0.1:PORT/TOKEN"}`; other keys are ignored. Any launcher can write it
(keep it mode 0600: the token gives full control of the browser). blindfill re-reads it on every connect, so a
launcher may rewrite it with a new port or token on each start.

| Browser                  | How to make it attachable                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome / Chromium / Edge | start it with `--remote-debugging-port=9222`; endpoint `http://127.0.0.1:9222`. Chrome 136+ ignores that flag on the default profile directory, so also pass `--user-data-dir=<separate directory>`: a separate profile (log in there once). Never expose the port beyond loopback.                                                                                                                             |
| Firefox                  | stock Firefox cannot be driven by Playwright. Run a Playwright-compatible Firefox (Playwright's own build, or Camoufox) as a **Playwright browser server** from a small launcher (`firefox.launchServer()`, or a persistent context published with `browser.bind`) and write its `wsEndpoint` to an endpoint file. Client and server Playwright versions must match ([Firefox / Camoufox](#firefox--camoufox)). |
| Camoufox                 | the same, via `camoufox.server.launch_server` (no contexts: blindfill creates an empty one) or a launcher that publishes a persistent context. Example: Ollie's launcher on ollie-ubuntu writes `/run/user/$UID/camoufox-desktop/connection.json` (see below).                                                                                                                                                  |
| Ego Lite                 | no CDP and no Playwright server. Either a separate instance that blindfill launches itself, `session start --executable '/Applications/ego lite.app/Contents/MacOS/ego lite'`, with an empty profile; or, opt-in and not supported, the running app through `ego-cli` with endpoint `ego://new` (values pass through Ego's Node runtime) ([Ego Lite](#ego-lite)).                                               |

## Using them

```
blindfill session start [--executable /path/to/chromium-based-browser]
blindfill session attach --endpoint http://127.0.0.1:9222                       # chromium-cdp (inferred)
blindfill session attach --endpoint ws://127.0.0.1:PORT/TOKEN --browser firefox-connect
blindfill session attach --endpoint-file ~/.cache/x/endpoint.json --browser firefox-connect   # JSON {"endpoint": "..."}
blindfill fill --item ID --url https://… --browser firefox-connect --endpoint …
```

Endpoints must be loopback (`localhost`, `127.0.0.1`, `[::1]`). Playwright-server URLs contain a token:
it is redacted in errors, `session status` and `session attach` output. `--endpoint-file` is re-read on
every connect, so a rotating token works.

Library: `import { withPage } from 'blindfill'; await withPage(page, { backend }, (bf) => bf.fill({ item, submit: true }))`.

## Firefox / Camoufox

Playwright requires the client and the server to be the same version. blindfill bundles playwright-core 1.65.1;
Camoufox 0.5.9 ships Playwright 1.62.0, and connecting with the bundled client fails with
`428 Precondition Required`. `firefox-connect` therefore tries, in order: `opts.playwrightModule`, env
`BLINDFILL_PLAYWRIGHT_CORE`, the bundled client, then the optional dependency `playwright-core-compat`
(= playwright-core@1.62.0). Also: the `[::1]` spelling does not work with 1.62.0, so it is retried as `localhost`.
Page JS runs in an isolated world: heuristics rely on DOM evidence, never on window globals.

**Contexts.** `camoufox.server.launch_server` starts a browser with **no** contexts: blindfill creates a new one
(empty profile; it ends when blindfill disconnects). A server that publishes a persistent context (Playwright
`browser.bind`, like Ollie's `~/.local/bin/camoufox-desktop`) already has one: blindfill reuses it (the profile's
cookies and logins) and treats it as shared:

- `--url` never navigates an existing tab. A tab already at the same origin + path is reused; otherwise blindfill
  opens a tab with `window.open(url, '_blank', 'noopener')` from an open tab (with `browser.link.open_newwindow=3`
  that is a tab, not a window; Playwright `newPage` would open a window).
- Without `--url`, the page is chosen as usual: `--page`, `--url-includes`, else the last http(s) tab.
- Disconnecting (end of a command, `session stop`) never closes the context or any tab, including the tab
  blindfill opened. Origin binding, the one-shot submit and the post-fill lock are unchanged.
- Tabs that Firefox has not loaded (restored lazily, or unloaded) are not visible to Playwright until they load.

Ollie's shared Camoufox on ollie-ubuntu publishes its endpoint in `/run/user/$UID/camoufox-desktop/connection.json`
(`{"endpoint": "ws://127.0.0.1:PORT/TOKEN", ...}`, mode 0600, rewritten on every start):

```
blindfill session attach --browser firefox-connect --endpoint-file /run/user/$(id -u)/camoufox-desktop/connection.json
blindfill page list
blindfill fill --item ID --url https://… --submit      # opens its own tab next to Ollie's
BLINDFILL_MARIONETTE=127.0.0.1:2828 blindfill passkey --item ID --url https://… --click '#signin'   # passkeys
```

Tested (opt-in, `BLINDFILL_TEST_FIREFOX=1 npx vitest run tests/firefox.test.ts`): Camoufox 158.0.1-beta.41 from the
local install (`~/.local/share/camoufox-runtime`), throw-away HOME and profile, client playwright-core 1.62.0 via
`playwright-core-compat`, started two ways: `camoufox.server.launch_server`, and a persistent context published with
`browser.bind` with a user tab already open. Connect, probe, fill+submit once with post-fill lock, lookalike origin
refused, honeypot and SPA forms, `withPage`, CLI `session attach --endpoint-file`; on the persistent context: the user
tab is never navigated, blindfill's tab is reused for the same URL, both survive disconnect, and `page list` / `probe`
through the launcher's `connection.json`. The test skips cleanly when the flag or the Camoufox runtime is missing.
Read-only check on Ollie's running shared Camoufox (2026-11-27): `session attach` with its `connection.json`,
`page list` and `session stop` saw its tabs and left them; nothing was filled or logged in.

**Passkeys** (Phase 3): Juggler has no WebAuthn, so blindfill uses the browser's Marionette port next to it.
Start the browser with `-marionette` and the prefs `security.webauth.webauthn_enable_softtoken=true`,
`security.webauth.webauthn_enable_usbtoken=false` (real USB security keys stop working in that browser), then
give blindfill the port: `BLINDFILL_MARIONETTE=127.0.0.1:2828` (loopback only; library: `ProviderOptions.marionette`).
Each ceremony opens the single Marionette session, adds one authenticator, and ends both; it fails if another client
holds the session. The Firefox authenticator is browser-wide, not per tab. Firefox serves WebAuthn only to the
focused document, so blindfill brings the page to the front; in spike 2 a page in another context did not get a
signature while armed (it was not focused), which is a side effect of focus, not a boundary. Firefox cannot set the
backup-eligible flag: passkeys it registers are BE=0 and the item gets `blindfill.passkey_be=0`; Bitwarden-made
(BE=1) passkeys are signed with BE=0 as well (owner decision 2026-11-27), so a relying party that checks BE rejects
them: an ordinary failure, and the result's `note` says to use Chromium (which, like the Android host, signs with the
item's flag). Marionette lacks the W3C `WebAuthn:SetCredentialProperties` command; once Firefox adds it, BE can be set. Tested by the
same opt-in suite with Camoufox started with `-marionette`, the two prefs and `marionette.port=0`, on the owner's
Mac and on ollie-ubuntu (Linux); the shared Camoufox was not used.

## Ego Lite

Chromium-based (0.6.3.17, Chrome/156), checked on the owner's Mac on 2026-11-27.

- Works via `chromium-launch` with a custom executable: `BLINDFILL_CHROMIUM='/Applications/ego lite.app/Contents/MacOS/ego lite'`
  (or `--executable`). e2e 17/17 and session start/status/stop passed. It is a separate instance with an **empty profile**.
- **Cannot attach over CDP**: the running instance exposes no CDP and no Playwright server.
- `ego-cli` (opt-in, **not supported**) reaches the running instance through Ego's own `ego-browser nodejs`: a script inside
  Ego's Node runtime serves page operations over a private unix socket (0700 state dir, nonce, one client). It adapts the
  slice of Playwright's Page / Frame / handle API that `WebActuator` uses, so origin binding, document binding, lock,
  one-shot and scrubbing are unchanged. All page code runs in one blindfill isolated world per frame document; every text
  input re-checks, inside Ego and in the same call, that the element's document still has the scanned origin and that the
  element has focus.
  - Use: `blindfill session attach --endpoint ego://new` (a new task space; `ego://` selects `ego-cli`) or
    `--endpoint ego://72/p1` (a space this agent controls). A space blindfill creates keeps its page afterwards
    (`BLINDFILL_EGO_KEEP=0` closes it).
  - Limits: cross-origin (out-of-process) iframes are invisible, so their fields are refused even when the item binds that
    origin, and a rule-less refusal cannot mention them; a rule submit of kind `js` is refused (no request interception);
    no passkeys (no WebAuthn); each connect starts an `ego-browser` process (~1 s).
  - **Exception to the provider contract**: filled values pass through Ego's Node runtime (as CDP `Input.insertText`
    parameters). Everything below was checked for that reason.
  - Tested (`BLINDFILL_E2E_BROWSER=ego npx vitest run tests/e2e.test.ts`, owner's Mac, Ego Lite 0.6.3.17, 2026-11-28):
    30 passed, 1 skipped (the replaced cross-origin rule frame); the frames test asserts the refusal above.
- Disk leak test (2026-11-27, `ego-browser nodejs`, random fake password via `page.fill` and CDP `Input.insertText`): not
  found in `~/Library/Application Support/Citro Labs` (~1 GB), `~/Library/Caches` or `~/Library/Logs`, immediately and after 45 s.
- **Outbound traffic check** (2026-11-28, owner's Mac, Ego Lite 0.6.3.17, `ego-cli` at `dbfe53f`; the provider has since
  been adapted to the current `WebActuator`, typing path unchanged). Fake data only: a local
  login page on `localhost` and a new random password per run, in the user's running Ego (its normal profile, no proxy,
  no certificate, no restart).
  - Capture: Ego's own `chrome://net-export` in "Include raw bytes" mode (TLS plaintext of everything Chromium's network
    service sends, which is also where Ego's built-in Sentry envelope and PostHog batch endpoints live, both in the
    browser binary) for about 3 minutes around the runs; plus every 0.3 s `lsof` of every other Ego process, and `nettop`.
  - Runs: fill without submit; fill with submit; a script that typed a password, made failing CDP calls carrying it, crashed
    the page's renderer (`Page.crash`), and ended with an uncaught exception and an unhandled rejection (to provoke Sentry);
    the same error script again under `nettop` for 60 s.
  - Result: the passwords appear in the capture **only** in the form POST to the local page (searched raw, URL-encoded,
    hex, UTF-16 and base64 at all three alignments, in the whole log and in every decoded socket payload). No Sentry or
    PostHog request was made during the window, including after the errors. The `ego Helper (Node)` process (where the
    values pass) and the browser process opened no network sockets; all traffic was the network service's.
  - Crash reports: the renderer minidump written by the crash does not contain the password (it does contain the page's
    host); Crashpad uploads are disabled on this install (`settings.dat`: uploads off, never attempted).
  - Not blindfill-specific but worth knowing: after a submit, Ego's password manager runs Chromium's **leak check**
    (`passwordsleakcheck-pa.googleapis.com`, a hashed and encrypted lookup, over QUIC), as it does for a password a person
    types in that profile; no login was saved (no new entries in any profile's `Login Data`). The same applies to any
    user profile reached through `chromium-cdp`.
  - Disk after all runs: none of the passwords (ASCII or UTF-16) in `~/Library/Application Support/Citro Labs`, `~/.ego`,
    `~/.ego-browser`, `~/.local/share/ego` or `~/Library/Logs` (7,194 files, 1.46 GB).
  - **Not covered**: QUIC payloads (net-export does not log them; in the window they went only to Google endpoints:
    the leak check, the new-tab page and the optimization guide), telemetry that is batched and sent later than ~3
    minutes, process memory, a version with Crashpad uploads on, Ego's agent features (Ego's own AI sidebar), the Ego
    UI operation log, and future Ego versions.
- **Ego UI operation log: not checked** (omp has no macOS Accessibility permission to open the task-space panel). Mics
  accepted this risk on 2026-11-28 and decided to merge `ego-cli` as opt-in. Re-run this check after Ego updates.

## Adding a provider

A provider implements `BrowserProvider` (`types.ts`):

```ts
interface BrowserProvider {
  id: string; // /^[a-z][a-z0-9-]*$/
  title: string;
  attachable: boolean; // may a saved session reconnect to it?
  capabilities: ProviderCapabilities;
  connect(opts: ProviderOptions): Promise<ProviderConnection>;
}
interface ProviderConnection {
  page: Page;
  context: BrowserContext;
  browser: Browser | null;
  capabilities: ProviderCapabilities; // evaluateIsolatedWorld, cdp, ownsBrowser, pagesSurviveDisconnect
  close(): Promise<void>; // release OUR handle; close the browser only if ownsBrowser
}
```

Contract: loopback only (use `assertLoopbackEndpoint`); never log or return the endpoint raw (`redactEndpoint`);
no secrets ever pass through a provider; don't navigate; `close()` must not kill a browser you don't own.
Steps: add `providers/<id>.ts`, `registerProvider(...)` in `registry.ts`, extend `inferProviderId` if the endpoint
shape is distinctive, add a section here. Test: `tests/providers.test.ts` shows a fake provider; for a real browser,
copy `tests/firefox.test.ts` (opt-in env flag, skip cleanly, isolated profile, never touch a user's browser) and make sure the
fill/lock/origin/honeypot cases and the leak test pass.
