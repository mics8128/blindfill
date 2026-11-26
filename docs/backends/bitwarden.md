# Bitwarden / Vaultwarden backend (`bw`)

Tier: **verified** against the _recorded `bw` JSON shapes and a mock CLI_ (`tests/fixtures/mock-bw.mjs`).
It has **not** been exercised against a live Bitwarden account by this repository's tests; run
`blindfill backend selftest bw` against a throwaway vault to verify for yourself. Treat the
"verified" tier as "most carefully built", not "proven on your vault".

## Setup

1. Install the official `bw` CLI and log in: `bw login`.
2. Unlock and export the session **in the environment** (never as an argument):
   `export BW_SESSION="$(bw unlock --raw)"`. blindfill passes it to `bw` via env only.
3. `~/.config/blindfill/config.json`: `{ "backend": "bw" }` (optionally `"backends": {"bw": {"bin": "/path/to/bw"}}`).

## Item conventions

- Bind an item to sites with its login URIs. Match types: domain (default), host, startsWith, exact, regex, never.
- Custom fields named `blindfill.submit` (`once`|`none`) control submission. Hidden-type custom fields are secret-class: fillable by name, never shown.
- Android apps: `androidapp://com.example.app` URIs (Android actuator not implemented yet).

## Try it safely

`blindfill backend selftest bw --fixture` (offline, mock runner), then against a throwaway vault: `blindfill backend selftest bw`.
