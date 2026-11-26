# Browsers and providers

blindfill drives a Playwright `Page`. How that page is obtained is a **BrowserProvider**
(`src/actuators/web/providers/`, one file per provider, registered in `registry.ts`).

| id                | file                 | what it does                                                                                            | attach to a running browser |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------- |
| `chromium-launch` | `chromium-launch.ts` | Playwright launches Chromium (bundled, or `--executable` / `BLINDFILL_CHROMIUM` / `web.executablePath`) | no (owns its browser)       |
| `chromium-cdp`    | `chromium-cdp.ts`    | `connectOverCDP`, loopback only                                                                         | yes                         |
| `firefox-connect` | `firefox-connect.ts` | Playwright browser-server websocket (Firefox / Camoufox), loopback only                                 | yes                         |
| `borrowed-page`   | `borrowed-page.ts`   | library use: caller passes its own `Page` (`withPage(page, …)`); never closed by blindfill              | n/a                         |

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

## Ego Lite

Chromium-based (0.6.3.17, Chrome/156), checked on the owner's Mac on 2026-11-27.

- Works via `chromium-launch` with a custom executable: `BLINDFILL_CHROMIUM='/Applications/ego lite.app/Contents/MacOS/ego lite'`
  (or `--executable`). e2e 17/17 and session start/status/stop passed. It is a separate instance with an **empty profile**.
- **Cannot attach to the already-running instance**: it exposes no CDP and no Playwright server.
- A borrowed-page provider via `ego-browser` is deliberately **not built**: secrets would pass through Ego's Node runtime and
  logging there is unverified. A leak test through `ego-browser nodejs` (random fake password, `page.fill` and CDP
  `Input.insertText`, both fields confirmed filled) did not find the password in `~/Library/Application Support/Citro Labs` (~1 GB),
  `~/Library/Caches` or `~/Library/Logs`, searched immediately and after 45 s. **Not covered**: process memory, outbound network
  traffic (Ego has Sentry error reporting and usage stats), the Ego UI showing operation parameters, future versions.
- If ever needed: first capture Ego's outbound traffic and check its operation log for filled values; ship only as an
  opt-in provider, not labelled "supported".

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
