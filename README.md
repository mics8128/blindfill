# blindfill

Let an AI agent sign in to websites **without ever seeing the password**. blindfill reads the
credential from your password manager, checks it is bound to the page's origin, types it into the
real form, and returns only structure and an outcome. Secret values are write-only
(`SecretHandle.into(sink)`), scrubbed from output, and the session locks after a fill.

> **Status: alpha (0.1.0-alpha.0).** Read [SECURITY.md](SECURITY.md) for the threat model and known gaps first.

## What works (verified by the test suite)

- Web actuator (Playwright + Chromium) with origin binding, cross-origin-iframe refusal, honeypot
  skipping, SPA waits, key-event fallback, one-shot submit, post-fill lock.
- Bitwarden `bw` backend (against a mock CLI and fixtures), plus six other backends that are
  **blind-written and unverified** (see `docs/backends/`).
- CLI and MCP server (stdio). A leak test greps all output and state files for a canary password.

## Not done

- Android actuator (stub that throws). No live-vault verification of any backend. Not published.

## Try it

```bash
npm ci && npm run build && npx playwright-core install chromium
export BW_SESSION="$(bw unlock --raw)"        # env only
echo '{"backend":"bw"}' > ~/.config/blindfill/config.json
node dist/cli.js backend list
node dist/cli.js session start --headless
node dist/cli.js fill --item <id> --url https://example.com/login --submit --expect-url /home
node dist/cli.js mcp                           # MCP server on stdio, see examples/mcp-config.json
```

## Develop

`npm run lint && npm test && npm run build`. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Releasing (tag-triggered, npm Trusted Publishing): [docs/RELEASING.md](docs/RELEASING.md). MIT licensed.
