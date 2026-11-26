# Browsers and providers

blindfill drives a Playwright `Page`. How that page is obtained is a **BrowserProvider**
(`src/actuators/web/providers/`, one file per provider, registered in `registry.ts`).

| id                | file                 | what it does                                                                                                   | attach to a running browser |
| ----------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `chromium-launch` | `chromium-launch.ts` | Playwright launches Chromium (bundled, or `--executable` / `BLINDFILL_CHROMIUM` / `web.executablePath`)        | no (owns its browser)       |
| `chromium-cdp`    | `chromium-cdp.ts`    | `connectOverCDP`, loopback only                                                                                | yes                         |
| `firefox-connect` | `firefox-connect.ts` | Playwright browser-server websocket (Firefox / Camoufox), loopback only                                        | yes                         |
| `borrowed-page`   | `borrowed-page.ts`   | library use: caller passes its own `Page` (`withPage(page, …)`); never closed by blindfill                     | n/a                         |
| `ego-cli`         | `ego-cli.ts`         | **opt-in, not supported**: the running Ego Lite via `ego-browser nodejs` (`ego://new`, `ego://<space>/<page>`) | yes (Ego task spaces)       |

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
A Camoufox server starts a browser with **no** contexts, so blindfill creates a new context (the existing profile and tabs are
not reachable this way). Page JS runs in an isolated world: heuristics rely on DOM evidence, never on window globals.

Tested (opt-in, `BLINDFILL_TEST_FIREFOX=1 npx vitest run tests/firefox.test.ts`): Camoufox 158.0.1-beta.41 started by
`camoufox.server.launch_server` from the local install (`~/.local/share/camoufox-runtime`), throw-away HOME and profile,
client playwright-core 1.62.0 via `playwright-core-compat`. 6 tests pass: connect, probe, fill+submit once with
post-fill lock, lookalike origin refused, honeypot and SPA forms, `withPage`, CLI `session attach --endpoint-file`.
The test skips cleanly when the flag or the Camoufox runtime is missing. Not tested: the owner's own long-running Camoufox.
Also passed 6/6 on the owner's Mac (macOS arm64, 2026-11-27) with 158.0.1-beta.41 and, after
`python -m camoufox set official/stable && python -m camoufox fetch`, with **159.0-beta.43** (latest stable; package
camoufox 0.5.9 / Playwright 1.62.0 unchanged, so `playwright-core-compat` stays 1.62.0). Layout:
`uv venv --python 3.12 ~/.local/share/camoufox-runtime`, `uv pip install 'camoufox[geoip]==0.5.9'`,
`XDG_CACHE_HOME=~/.local/share/camoufox-data python -m camoufox fetch`, then `npm ci` (for `playwright-core-compat`).

## Ego Lite

Chromium-based (0.6.3.17, Chrome/156), checked on the owner's Mac on 2026-11-27.

- Works via `chromium-launch` with a custom executable: `BLINDFILL_CHROMIUM='/Applications/ego lite.app/Contents/MacOS/ego lite'`
  (or `--executable`). e2e 17/17 and session start/status/stop passed. It is a separate instance with an **empty profile**.
- **Cannot attach to the already-running instance over CDP**: it exposes no CDP and no Playwright server.
- `ego-cli` (opt-in, **not supported**) reaches the running instance through Ego's own `ego-browser nodejs`: a script inside
  Ego's Node runtime serves page operations over a private unix socket (0700 state dir, nonce, one client). It adapts the
  slice of Playwright's Page API that `WebActuator` uses, so origin binding, lock, one-shot and scrubbing are unchanged.
  Element scans run in an isolated world; every text input re-checks, inside Ego and in the same call, that the element's
  document still has the scanned origin and that the element has focus.
  - Use: `blindfill session attach --endpoint ego://72/p1` (a task space this agent controls) or `--endpoint ego://new`.
    A space blindfill creates keeps its page afterwards (`BLINDFILL_EGO_KEEP=0` closes it).
  - Limits: cross-origin out-of-process iframes are invisible, so fields inside them are refused even when the item binds
    that origin. Each connect starts an `ego-browser` process (~1 s).
  - **Exception to the provider contract**: filled values pass through Ego's Node runtime.
  - Tested (`BLINDFILL_E2E_BROWSER=ego npx vitest run tests/e2e.test.ts`, owner's Mac): 18/18, with the iframe case
    asserting the refusal above.
- Leak checks for `ego-cli` (owner's Mac, 2026-11-27), the gate before it may be merged or recommended:
  - Disk: the e2e canary and a separate random value were not found in `~/Library/Application Support/Citro Labs`,
    `~/Library/Caches` or `~/Library/Logs` (also not after 20–45 s).
  - Network: during a 17-test e2e run the `ego Helper (Node)` process (where the bridge runs) opened **no** internet
    sockets. All traffic goes through Chromium's network service (`ego Helper (Aperitif)`): loopback test sites plus
    Fastly, Google, GitHub and Cloudflare addresses that also serve the user's other tabs. Payloads are TLS and were
    **not inspected**, so "the value is never sent out" is not proven.
  - Ego UI / operation log: **not checked** (the screen was locked during the run).
  - Until the last two are closed, keep `ego-cli` opt-in and out of the support matrix.

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
