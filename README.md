<div align="center">

# blindfill

**Let AI agents sign in to websites without ever seeing the password.**

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

## What works (verified by the test suite)

- Web actuator (Playwright + Chromium) with origin binding, cross-origin-iframe refusal, honeypot
  skipping, SPA waits, key-event fallback, one-shot submit, post-fill lock.
- Bitwarden `bw` backend (against a mock CLI and fixtures), plus six other backends that are
  **blind-written and unverified** (see `docs/backends/`).
- CLI and MCP server (stdio). A leak test greps all output and state files for a canary password.

## Not done

- Android actuator (stub that throws). No live-vault verification of any backend. Not published.
  Passkeys are not supported.

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
