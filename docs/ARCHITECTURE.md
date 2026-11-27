# Blindfill — architecture (v0.2, 2026-11-27)

> Let AI agents sign in to anything without ever seeing the password.

Status: alpha. M0 and M1 are implemented (see section 9 for what is built, stubbed and
unverified); passkeys, Android and several olliepm features are not built yet. Parts marked
**[from olliepm]** were ported or are being ported from the Python prototype
`ollie-password-management`. Code samples below are language-neutral sketches; the real
interfaces are TypeScript (`src/backends/spi.ts`, `src/actuators/web/providers/types.ts`).

## 1. Problem and non-goals

Agents that drive browsers or phones need to sign in. Today the options are bad:
paste the password into the prompt, hand the agent a password-manager CLI (`bw get password`
returns plaintext to the agent), or keep a bespoke credential store.

Blindfill is a **credential actuator**: it resolves a secret from a password manager and
writes it straight into the target field. The agent chooses _which account and which page_;
it never receives the value.

Non-goals: not a password manager, not a login state machine, not a captcha/2FA-by-SMS
solver, not a general remote-control tool. Multi-step flows stay with the caller (the LLM).

## 2. Security invariants (the product)

1. **Secrets are write-only; everything else is readable.** Fields are classed (see 2a).
   No API, CLI flag or MCP tool returns a _secret-class_ field to the caller; those can only
   be filled (secret -> sink). Non-secret fields (username, URIs, text custom fields, field
   names, the current TOTP code) are returned normally so the agent can reason and act.
2. **Origin/app binding.** A fill is allowed only if the item is bound to the _actual_
   target identity (web origin, or Android package + signer). Binding comes from the vault
   item, never from the caller.
3. **One shot.** Fill and submit once; unknown outcome is reported, never retried.
4. **Post-fill lock.** After a fill, the session refuses page text, DOM, screenshots and
   console output until the session is stopped. Outputs are also scrubbed (raw, URL-encoded,
   Base64 forms of any secret handled).
5. **Fail closed.** Missing signer tool, ambiguous field, origin mismatch, focus change:
   stop before the secret is read from the backend.
6. **Honest limits, documented.** The secret still exists in the page DOM / app memory.
   Blindfill defends against the _model and its logs_, not against a malicious page or a
   compromised host. `SECURITY.md` states this up front.

### 2a. Field classes

| Class         | Examples                                                                                  | Agent can read?                                                                   | Agent can fill?                                                       |
| ------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Secret**    | password, Bitwarden _Hidden_ custom fields, card number/CVV                               | **never**                                                                         | yes (via fill)                                                        |
| **Key**       | TOTP seed/otpauth URI, SSH private keys, passkey private keys                             | **never**                                                                         | **never** (a passkey only signs; `fill` refuses with `SECRET_ACCESS`) |
| **Ephemeral** | the current TOTP code (6-8 digits, ~30 s)                                                 | **yes** (owner's decision)                                                        | yes                                                                   |
| **Readable**  | username, item name, URIs, _Text_/_Boolean_ custom fields, field names, folder/collection | yes                                                                               | yes                                                                   |
| **Notes**     | free-form notes                                                                           | no by default (may hold secrets); opt in per item with `blindfill.notes=readable` | no                                                                    |

Notes:

- Class comes from the vault's own type (Bitwarden field type Hidden vs Text), so the owner
  controls it in the normal vault UI. Unknown or untyped data defaults to Secret.
- The current TOTP code is treated exactly like a text field: readable and fillable, no
  special switch (owner's decision, 2026-11-27). Only the TOTP seed is Secret. The code is
  short-lived, but readability means its safety rests on target binding.
- Scrubbing (invariant 4) applies to Secret-class values only; Ephemeral codes are not
  scrubbed since they are returned on purpose.

## 3. Layers

```
            agent / human
   CLI (blindfill)   MCP server   TS library
              \         |         /
               +-- Core engine --+       policy, matching, grants, scrubbing, audit log
              /        |          \
   Backend SPI    Actuator SPI     Rule store
   (secrets)      (where to type)  (how to type)
```

### 3.1 Backend SPI (where secrets live)

```python
class Backend(Protocol):
    id: str
    capabilities: set[Cap]            # SEARCH, TOTP, ANDROID_APPS, CUSTOM_FIELDS, WRITE
    def unlock(self, ctx) -> None: ...                       # no interactive prompts in agent mode
    def find(self, target: Target) -> list[ItemRef]: ...     # metadata only
    def meta(self, ref: ItemRef) -> ItemMeta: ...            # name, username, uris, readable fields + values, secret fields' NAMES only
    def read(self, ref, field) -> str: ...                   # only for Readable-class fields; raises for Secret
    def open_secret(self, ref, field) -> SecretHandle: ...   # handle, not str
    def totp_code(self, ref) -> str: ...                     # Ephemeral; seed never leaves the backend
```

- `SecretHandle` is write-once, `repr()`/`str()` raise, and offers only
  `handle.into(sink)`. It zeroes its buffer after use (Buffer.fill(0) after use; a
  Rust core could be stricter, see section 8).
- A backend never learns the target page content; the engine never learns more than the
  handle exposes.
- Backends declare capabilities; the engine degrades gracefully (e.g. no `ANDROID_APPS` ->
  phone actuator disabled for that backend).

Planned backends and support tiers:

| Tier                   | Meaning                                                                                         | Backends                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Verified**           | maintainers run CI against it                                                                   | `bw` (Bitwarden/Vaultwarden), `secret-service`                                                                        |
| **Blind-written**      | coded from the vendor docs, contract tests pass against recorded fixtures, **no live test yet** | `op` (1Password), `keepassxc-cli`, `pass`/`gopass`, `rbw`, Proton Pass CLI, `lpass`, Dashlane CLI, HashiCorp Vault KV |
| **Community-verified** | a user reported a successful live run (issue template + date + version)                         | promoted from blind-written                                                                                           |

The README carries a live **backend matrix** (tier, version tested, last confirmed). Blind
backends print a one-line "unverified backend" notice on first use and have a
`blindfill backend selftest` command that runs a _fake item_ round trip, so a volunteer can
confirm in two minutes and paste the output into an issue.

### 3.2 Actuator SPI (where secrets are typed)

```ts
interface Actuator {
  kind: 'web' | 'android'; // later 'desktop'
  identify(): Target; // observed identity, never self-reported
  probe(): FieldCandidate[]; // structure only, no values
  sink(field: FieldCandidate): Sink;
  submit(): Outcome; // at most once
}
```

- **Web actuator** (implemented, Playwright): the browser is obtained from a pluggable
  **BrowserProvider** (`src/actuators/web/providers/`, contract in `docs/browsers.md`):
  `chromium-launch` (also any Chromium-based build via `--executable` / `BLINDFILL_CHROMIUM`,
  e.g. Ego Lite with an empty profile), `chromium-cdp` (loopback only), `firefox-connect`
  (Playwright browser server, e.g. Camoufox; endpoint or `--endpoint-file`), and
  `borrowed-page` (library API `withPage`). Providers declare capabilities such as an isolated
  evaluate world, so heuristics use DOM evidence, never page globals. Observed origin comes
  from the page URL and frame URL, not from the caller. Adding a browser = adding one provider
  file plus its tests. A provider that cannot be attached to an already-running browser (no CDP,
  no Playwright server) is not faked; Ego Lite's running instance is explicitly unsupported
  until a traffic and operation-log review is done (`docs/browsers.md`).
- **Android actuator** (companion APK, `android/`; host side `src/actuators/android/`): chosen
  over scrcpy text injection because the system, not blindfill, attests which app is asking.
  Flow: `android fill|passkey --item --serial` arms the companion with a one-time token over
  `adb shell am broadcast` (the receiver requires `DUMP`, which only the shell holds) and listens
  on a loopback port the phone reaches through `adb reverse`. When an app asks, the companion
  reports its package (AssistStructure / CallingAppInfo) and the SHA-256 of its single signing
  certificate (PackageManager); the host checks both against `androidapp://` + `blindfill.signers`
  before reading any secret, answers once, closes the port and disarms. Passwords go into an
  autofill Dataset the user or agent selects; WebViews, sign-up screens (two passwords,
  `new` hints) and multi-signer apps are refused. Passkeys: the companion builds clientDataJSON
  for the calling app (`android:apk-key-hash:` origin) and sends only its hash; the host signs
  `authData || hash` (flags UP+UV, counter 0), so the private key never reaches the phone.
  Tested on a real phone with a fake relying-party app (`tests/android-device.test.ts`), which
  switches the autofill and credential provider for the run and restores them exactly.
- Later: desktop (accessibility APIs), iOS (probably impossible without an Autofill extension).

### 3.3 Target model

```
web:https://accounts.example.com
android:com.instagram.android#sha256=5F:3E:...      # signer pinned
```

A `Target` is what the actuator _observed_. Matching reuses the vault's own rules:

### 3.4 Vault item contract (no sidecar files)

Blindfill stores its metadata **inside the vault item**, following each manager's native
model, so the vault stays the single source of truth.

Bitwarden/Vaultwarden mapping:

| Need                                          | Where in the item                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web binding                                   | `login.uris[]` with Bitwarden match types (base domain, host, starts-with, exact, regex). Default **Host** or stricter; Base-domain only if the user chose it. |
| Android app binding                           | extra URI `androidapp://com.instagram.android` (Bitwarden's own convention) + custom field `blindfill.signers` = comma-separated SHA-256                       |
| Username / password / TOTP                    | `login.username`, `login.password`, `login.totp`                                                                                                               |
| Extra fields (e.g. store ID, display name)    | custom fields; names prefixed `blindfill.` are control fields, others are fillable by explicit name                                                            |
| Per-site selector overrides, multi-step hints | custom field `blindfill.rules` (small JSON, version-tagged) or Notes block fenced as ```blindfill                                                              |
| Submit policy                                 | `blindfill.submit` = `once` (default) / `none`                                                                                                                 |
| Agent visibility                              | put items in a dedicated collection; membership + read-only permission is the grant                                                                            |

Other managers get an equivalent mapping documented in `docs/backends/<id>.md`. Where a
backend cannot hold custom fields, rules fall back to a local `rules.d/` file keyed by item id.

### 3.5 Rules and generality

Order of attempts, cheapest first, all one-shot and logged:

1. Heuristic form detection (autocomplete attributes, input types, labels, ARIA) with a
   confidence score; below threshold -> stop and report candidates (names only).
2. Item-level `blindfill.rules` override.
3. Community rule packs (`rules/sites/*.json`), reviewed and signed in the repo; always
   lower priority than item rules.

No per-site state machines. Multi-page logins (username then password) are exposed as
separate `fill --fields username` / `fill --fields password` calls, so the LLM drives the
flow.

### 3.6 Interfaces

- CLI: `blindfill login <target>`, `blindfill fill`, `blindfill item show` (readable fields only),
  `blindfill totp [--fill]`, `blindfill probe`,
  `blindfill backend list|selftest`, `blindfill session stop`. JSON on stdout, prompts on
  stderr.
- MCP server (stdio only): `probe`, `candidates`, `item_show` (readable fields), `totp_code`,
  `fill`, `fill_totp`, `session_stop`. No tool returns Secret-class values. Tool descriptions state the no-read contract so agents plan for it.
- TypeScript library for in-process Playwright owners.

### 3.7 Audit and grants

- Local append-only log: time, backend, item id (not name if configured), target, fields
  filled, outcome. Never values.
- Grants: for phones and for sensitive items, `blindfill grant add <item> <target>`
  creates a digest (as olliepm does) the engine checks at fill time.

### 3.8 Passkeys (web sign-in built; Chromium only)

Checked against a live Vaultwarden on 2026-11-27: `bw` returns `login.fido2Credentials`
(`credentialId`, `rpId`, `keyAlgorithm` ECDSA, `keyCurve` P-256, `keyValue` PKCS8 base64url,
`userHandle`, `counter`, `discoverable`) and accepts them on `bw create item`. The data was
inserted by script, not created by a Bitwarden client, so real-client encoding is unverified.

- Built: `Engine.passkey` (CLI `passkey`, MCP `passkey_sign`). Order: item binding checked
  against the page, then the item's `passkey.rpId` must equal the page host or a parent of it,
  then one-shot per session+origin, then the key is read. `WebActuator.passkeyAssert` loads it into a
  per-page Chromium virtual authenticator over CDP (`WebAuthn.addCredential`), clicks the
  caller's structural `click` selector, waits for the first `credentialAsserted`, and removes the
  authenticator. The page runs its own `navigator.credentials.get`; Chromium signs. Tested
  against a fake relying party that verifies the signature (`tests/passkey.test.ts`).
- Why CDP and not page-script interception: the key stays in the browser process, never in page
  JS. Cost: Chromium providers only (`capabilities.cdp`); Firefox/Camoufox and borrowed pages get
  `UNSUPPORTED`.
- While armed (up to 15 s), any frame of that page whose origin WebAuthn accepts for the rpId could
  request the assertion; blindfill does not see which frame asked.
- Open: `counter` write-back (the result reports `sign_count`, `counter_written_back: false`),
  registration (`create`), and credentials created by real Bitwarden clients.
- Android: Credential Manager prompts need biometric/device unlock; not promised.

## 4. Threat model (short)

| Threat                              | Handled by                                                 |
| ----------------------------------- | ---------------------------------------------------------- |
| Model asks for password             | no read API                                                |
| Prompt injection from the page      | origin binding from vault; caller cannot choose the target |
| Secret echoed in logs / tool output | scrubber (raw, URL-encoded, Base64), post-fill lock        |
| Wrong site (phishing, redirect)     | observed origin vs item URIs, Host match by default        |
| Rogue app on phone                  | package + signer pin, fail closed                          |
| Malicious page reads DOM            | **not handled**, documented                                |
| Compromised host                    | out of scope                                               |

## 5. Repo layout

```
blindfill/
  src/
    core/        types, field classes, SecretHandle, scrubber, audit, policy
    backends/    bw, op, rbw, pass, gopass, keepassxc, secret-service, registry, selftest
      _contract/ contract suite every backend must pass
    actuators/
      web/       dom, heuristics, session, web.ts, providers/ (browser providers)
      android/   stub
    engine.ts  config.ts  library.ts (withPage)  cli.ts  mcp.ts  harden.ts
    rules.ts  profiles.ts  password.ts        (in progress: field rules, login recipes, generator)
  tests/         unit, contract, e2e on local fake sites, leak test, opt-in Firefox tests
  docs/          ARCHITECTURE.md  RELEASING.md  browsers.md  backends/
  examples/      MCP config, login script
```

## 6. Testing strategy

- **Backend contract suite**: one test file every backend must pass against fixtures
  (find, meta, open_secret->into, totp, missing item, locked vault, no secret in repr/log).
  This is what makes blind-writing credible.
- **Fake sites**: local pages with traps (hidden honeypot fields, cross-origin iframe,
  lookalike domain) -> must refuse.
- **Leak tests**: run fills with a canary password and grep every output, log and artifact.
- **Android**: emulator + synthetic app; real-device runs stay manual.

## 7. Adoption plan

- Name, one-sentence promise, 20-second demo GIF (agent logs in, transcript shows no secret).
- README first screen: the no-read guarantee, install in one command (`npx -y <package>`),
  the backend matrix.
- `good first backend` issues; backend template + selftest make contributions small.
- SECURITY.md with honest limits; responsible-disclosure address.
- License: MIT or Apache-2.0 (decision needed).
- Publish only after an internal run of a week on our own accounts.

## 8. Language decision (revised 2026-11-27: TypeScript / Node)

Goal: install in one command, no toolchain explanation.

- **TypeScript on Node 20+ (chosen).** `npx -y <pkg>` is the de-facto way agents launch MCP
  servers; Playwright is first class in Node; the Bitwarden CLI is itself an npm package, so
  the main user already has Node. `Buffer` secrets can be zero-filled, which is better than
  Python's immutable strings. The Android side needs only `adb`/`scrcpy` as external binaries.
- Python (olliepm's language): `uvx` is also one command, but it needs `uv` and a Python
  runtime, which most MCP users do not have. The olliepm engine is ported, not reused.
- Go/Rust single binary: easiest install and best secrecy guarantees, but Playwright is not
  first class there. Revisit only if a CDP-only core is wanted.
- Keep the `SecretHandle` boundary clean so the core can later move to Rust/Go.

## 9. Roadmap and status

- **M0 done** repo, invariants, SECURITY.md, backend/actuator SPI, contract tests, CI,
  tag-triggered release workflow (npm Trusted Publishing).
- **M1 done (alpha)**: `bw` backend (mock CLI and fixtures; JSON shape checked by hand on a live
  Vaultwarden; no end-to-end run on a live vault yet), web actuator, CLI + MCP, leak test.
  Blind-written and unverified: `op`, `rbw`, `pass`, `gopass`, `keepassxc`, `secret-service`.
- **M1.5 in progress** olliepm parity for web: browser providers (done, Firefox/Camoufox passed
  against a real Camoufox build, owner's running instance untested), field rules and profiles,
  discover/diagnose/verify, registration with generated passwords, human handoff.
  Tracked in `docs/MIGRATING-FROM-OLLIEPM.md` once written.
- **M2** passkeys (`sign`, section 3.8) for web; Android companion APK (autofill + passkey
  provider) with signer pinning, tested on one device with a fake app.
- **M3** community verification of the blind-written backends, public release and backend matrix.
- **M4** community rule packs; desktop actuator exploration; Android saving new logins and WebView logins.
- Optional: an attach provider for the already-running Ego Lite, only after an outbound-traffic
  capture and an operation-log check show filled values do not leak; never labelled "supported".

## 10. Open questions

Decided: name `blindfill`; license MIT; TypeScript/Node; TOTP code is readable like text.

1. Rules location: item custom field vs notes vs both (validate on a real Vaultwarden item;
   Bitwarden clients may truncate or hide hidden-type fields).
2. Does Vaultwarden return `androidapp://` URIs intact for items created by the real clients?
   (Created by script: returned intact; real-client check pending.)
3. How strict the default web match should be (Host vs Base domain). Current default: Host.
4. Passkey encoding written by real Bitwarden clients, counter write-back, and registration.
5. Ego Lite attach provider: needs the traffic and operation-log review first.
