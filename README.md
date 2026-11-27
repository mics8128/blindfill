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

blindfill reads a login from your password manager, checks that it belongs to the page's site, types it into the real
form and tells the agent only the outcome. The password never enters the model's context.

> **Status: alpha.** Not independently reviewed. Read [SECURITY.md](SECURITY.md) before using it on accounts
> that matter.

## Quick start

You need Node 20+ and the Bitwarden CLI (`bw`), the default backend.

```bash
export BW_SESSION="$(bw unlock --raw)"     # unlock the vault (environment only)
npx -y blindfill session start             # launches its own headless Chromium
npx blindfill fill --item <id> --url https://example.com/login --submit
```

`<id>` is the vault item's id (`npx blindfill item list`). If `session start` reports that Chromium is missing, run
`npx playwright-core install chromium` once, or pass your own Chromium with `--executable <path>`.

For agents, run the MCP server: `npx -y blindfill mcp` ([example config](examples/mcp-config.json)). Using it every
day? `npm i -g blindfill`, then drop the `npx`.

## What it guarantees

- **Fill-only secrets.** No command, MCP tool or library call returns a password, TOTP seed or private key.
- **Bound to the right site.** The vault item decides where a secret may be typed. A lookalike domain or a
  cross-origin iframe is refused before any secret is read.
- **Locked after fill.** Page text, DOM and screenshots are refused afterwards, and all output is scrubbed.
- **Stops instead of guessing.** Ambiguous fields and unknown outcomes are reported, never retried.

## Supported

Bitwarden / Vaultwarden (tested on real sites; six other backends unverified) · Chromium, Firefox / Camoufox, Ego Lite
· passkeys · TOTP codes · Android 14+ companion app (experimental) · macOS and Linux (Windows: test suite only).
Every component's status and every test run: [docs/TESTED.md](docs/TESTED.md).

## Documentation

| Topic                                 | Document                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Threat model and known limits         | [SECURITY.md](SECURITY.md)                                                                            |
| Support status and test log           | [docs/TESTED.md](docs/TESTED.md)                                                                      |
| Connecting your own browser           | [docs/browsers.md](docs/browsers.md)                                                                  |
| Password manager setup                | [Bitwarden](docs/backends/bitwarden.md), [others](docs/backends/other.md)                             |
| Android companion app                 | [android/README.md](android/README.md)                                                                |
| Compared with other approaches        | [docs/COMPARISON.md](docs/COMPARISON.md)                                                              |
| Architecture, releasing, contributing | [ARCHITECTURE](docs/ARCHITECTURE.md), [RELEASING](docs/RELEASING.md), [CONTRIBUTING](CONTRIBUTING.md) |

## Develop

`npm ci && npm run lint && npm test && npm run build`, then `node dist/cli.js …`. MIT licensed.

## Translations

Translation PRs are welcome: improvements to [繁體中文](README.zh-TW.md), [简体中文](README.zh-CN.md),
[日本語](README.ja.md) and [한국어](README.ko.md), or new languages. The English README is the source of truth.
