# Contributing to blindfill

Thanks for helping. The product is a set of **security invariants**; most review effort goes
into making sure a change does not weaken them (see `SECURITY.md` and `docs/security-model.md`).

## Setup

```bash
npm ci
npx playwright-core install chromium   # needed for the e2e tests
npm run build && npm run lint && npm test
```

Node 20+ is required. Tests never touch a real vault: they use fake items, a mock `bw`
binary (`tests/fixtures/mock-bw.mjs`) and local fake login pages with canary passwords.
**Never put a real credential in a test, fixture, issue or PR.**

## Ground rules

- No API may return a Secret-class value. New output paths must go through the scrubber.
- Unknown field => Secret class. Fail closed when in doubt.
- Add a test for every new refusal path.
- The leak test (`tests/leak.test.ts`) must stay green.

## Verifying a backend ("I tested backend X")

```bash
npx -y blindfill backend selftest <id>
```

Create a *fake* item named `blindfill-selftest` first (see `docs/backends/`), then paste the
output into a *Backend report* issue. Verified reports promote a backend from
"Blind-written" to "Community-verified".

## Adding a backend

1. Implement the `Backend` interface in `src/backends/<id>.ts` (see `src/backends/spi.ts`).
2. Add a fixture runner and run it through `runBackendContract` (`src/backends/_contract`).
3. Document the item mapping in `docs/backends/<id>.md` and add a row to the README matrix.
   New backends start as tier `blind-written/unverified`.

## Translations

README translations are welcome as PRs (`README.<lang>.md`). The English README is canonical;
keep claims identical and do not add claims the code does not back.
