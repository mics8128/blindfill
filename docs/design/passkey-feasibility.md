# Passkey registration and sign-in in every browser: feasibility

Status: research only (2026-11-27). Nothing here is built. Claims marked **[observed]** come from the
local experiments in §8; **[source]** from the cited specification or source code; **[inference]** were
not verified.

## 1. Verdict

**Partially feasible.** Registration and sign-in, with the private key never reaching the agent, can be
built for:

| Surface                          | Sign-in                           | Registration                    | How                                                | Verdict                                  |
| -------------------------------- | --------------------------------- | ------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| Chromium (launch, CDP attach)    | built, needs counter fix          | feasible                        | CDP `WebAuthn` virtual authenticator               | **feasible**                             |
| Firefox / Camoufox               | feasible                          | feasible                        | Marionette WebAuthn commands next to Juggler       | **feasible with conditions** (see below) |
| Android apps (companion)         | built, needs counter and flag fix | feasible                        | Credential Manager provider, host-side key         | **feasible**                             |
| WebKit                           | only through a page-script shim   | only through a page-script shim | no virtual authenticator reachable from Playwright | **not recommended**                      |
| Any browser via page-script shim | possible                          | possible                        | override `navigator.credentials` in the main world | **not recommended** (§5.3)               |

Why not "every browser": WebKit has no automation hook for WebAuthn that Playwright exposes, and the only
universal route (a page-script shim, including Playwright 1.61's `context.credentials`) moves origin and
rpId enforcement out of the browser and is detectable by pages; Playwright's own shim is a cross-origin
signing oracle **[observed]**.

Conditions for Camoufox: the browser must be **started** with `-marionette` and the global prefs
`security.webauth.webauthn_enable_softtoken=true` / `security.webauth.webauthn_enable_usbtoken=false`.
That means restarting Ollie's running Camoufox, disabling real USB security keys in it while the prefs are
set, and running an unauthenticated Marionette listener on loopback. It worked on Camoufox
158.0.1-beta.41 (macOS arm64) side by side with Juggler, and `navigator.webdriver` stayed `false`
**[observed]**; the Linux build Ollie runs is unverified.

Two bugs in today's sign-in surfaced on the way (fix before registration, §4):

- **Counter**: Chromium reports `storedCounter + 1` and blindfill never writes it back, so every Chromium
  sign-in after the first reports the same counter. RPs that reject a non-increasing counter (for example
  SimpleWebAuthn's default) will refuse the second sign-in **[source + observed]**.
- **Backup flags**: Bitwarden clients sign with BE=1, BS=1; blindfill's Android path and both virtual
  authenticators sign with BE=0. WebAuthn L3 tells RPs that track backup eligibility to reject a change
  **[source]**.

Effort: about 12–16 agent-days in five phases (§7). First step: the three spikes in Phase 0, all on fake
or test-only relying parties.

## 2. Current state (what exists)

- Web sign-in: `Engine.passkey` → `WebActuator.passkeyAssert` (`src/engine.ts`, `src/actuators/web/web.ts`).
  Checks item binding, then `passkey.rpId` covers the page host, then one-shot per session and origin, then
  loads `login.fido2Credentials[0]` into a per-page Chromium virtual authenticator, clicks, waits up to
  15 s for `WebAuthn.credentialAsserted`, removes the authenticator. Reports `counter_written_back: false`.
- Android sign-in: the companion builds `clientDataJSON` (`android:apk-key-hash:` origin) and sends its
  hash; the host signs `rpIdHash || 0x05 || counter 0 || hash` (`Engine.androidOffer`).
  `PasskeyProvider.onBeginCreateCredentialRequest` returns no entries.
- Vault shape: `bw` returns `login.fido2Credentials[]`; blindfill uses element 0 only (`bwmap.ts`,
  `rawitem.ts`). Credential ids are a GUID or `b64.<base64url>` (`credentialIdBase64`).
- Writes: `bw create item` / `bw edit item` with the JSON body on stdin (`src/backends/bw.ts`).
  Origins, `blindfill.*` fields and secret values need `human: true` (a TTY), except `item generate`, which
  creates a new item with a generated password bound to caller-named origins (SECURITY.md item 10).

## 3. Registration

### 3.1 Vault format (Bitwarden-compatible)

What Bitwarden's own authenticator writes on `makeCredential` (`createKeyView` in
[`fido2-authenticator.service.ts`][bw-auth]) **[source]**:

| field                         | value written by Bitwarden         | blindfill registration should write                                            |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `credentialId`                | new UUID (16 random bytes as GUID) | GUID if the id is 16 bytes, else `b64.<base64url>` (Chromium/Firefox use 32 B) |
| `keyType`                     | `public-key`                       | same                                                                           |
| `keyAlgorithm`                | `ECDSA`                            | same; refuse anything but ES256 (`alg -7`)                                     |
| `keyCurve`                    | `P-256`                            | same                                                                           |
| `keyValue`                    | PKCS#8 DER, base64url              | same                                                                           |
| `rpId`, `rpName`              | from the request                   | same                                                                           |
| `userHandle`                  | `user.id`, base64url               | same                                                                           |
| `userName`, `userDisplayName` | from the request                   | same (readable metadata)                                                       |
| `counter`                     | `0`                                | the authenticator's value after creation (§4.1)                                |
| `discoverable`                | `requireResidentKey`               | `true` (virtual authenticators create resident keys)                           |
| `creationDate`                | now                                | now                                                                            |

Bitwarden clients parse `b64.` ids (`parseCredentialId` in [`credential-id-utils.ts`][bw-credid]), which is
how imported passkeys are stored, so 32-byte ids from browser authenticators stay usable by the Bitwarden
extension and apps **[source]**; a real-client round trip is still unverified (Phase 0). Bitwarden clients
only ever use `fido2Credentials[0]` (`findCredentialsByRp`, `getAssertion`) **[source]**: one passkey per
item. blindfill must keep that rule: registration refuses an item that already has a passkey.

Other backends (`op`, `rbw`, KeePassXC, …) have their own passkey formats or none; registration is
`bw`-only until one of them is mapped and verified.

### 3.2 Where the key is generated and who sees it

| Route                         | Key generated in                          | Path of the private key                                               |
| ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| Chromium CDP                  | Chromium (virtual authenticator)          | Chromium → `WebAuthn.getCredentials` → blindfill → `bw` stdin → Vault |
| Firefox / Camoufox Marionette | Firefox (`authrs_bridge` test token)      | Firefox → `WebAuthn:GetCredentials` → blindfill → `bw` stdin → Vault  |
| Android                       | blindfill host (`crypto.generateKeyPair`) | host → `bw` stdin → Vault; the phone receives only public data        |

In every route the key passes through the blindfill process, as it already does for sign-in. It is never
returned, logged or printed: it goes into a `SecretHandle`, is registered with the scrubber, and the
result object carries only `credential_id`, `rp_id`, `counter`, `item`. The agent sees what it sees today
for a generated password (§3.3). Both browser `getCredentials` calls return private keys
**[observed]**, so the read must stay inside the actuator, like `addCredential` today.

Ordering risk: with browser-generated keys the relying party may have accepted the credential before
blindfill has written it to the vault. If the vault write then fails, the account holds a passkey nobody
has. Mitigation: create or pick the vault item **before** the ceremony (reuse `item generate`'s item, or
an opted-in existing item without a passkey), so the only write after the ceremony is one `bw edit item`;
on failure report `vault_write_failed` with the rp and credential id so a person can delete the passkey at
the RP. Android does better: the host generates the key and can write the vault before it returns the
attestation to the phone.

Attestation: `none` everywhere. Chromium and Firefox produce their own `none` attestation and AAGUID; RPs
that name passkeys by AAGUID will show "unknown" rather than "Bitwarden" **[inference]**. The Android path
should use Bitwarden's AAGUID only if Mics wants these passkeys to look Bitwarden-made; default: all-zero
AAGUID, like Playwright's.

### 3.3 The "person at a terminal" rule

Today a TTY is required to change secret values, origins and `blindfill.*` fields; `item generate` is the
deliberate exception (a new secret nobody knew, bound to the origins the caller names). Passkey
registration is the same kind of act: a new secret, generated by machine, bound to an origin. Proposed
rule, no TTY needed when **all** hold:

1. the item opted in (`blindfill.registration=allow`, set by a person or by `item generate`);
2. the item has no passkey yet (adding only; replacing or deleting a passkey needs a TTY);
3. the item binds the page (`checkWebBinding`) and the requested rpId equals the page host or a parent of
   it, the same checks as sign-in; for Android the item binds the calling package and signer;
4. one registration per session, item and origin;
5. the vault write touches only `login.fido2Credentials` (and fills an empty username).

This is a decision for Mics (§9): registering a passkey adds a sign-in method to a real account, which is
an account-security change on the RP side even though the key never leaves blindfill.

## 4. Counter, flags, selection, binding

### 4.1 Counter

WebAuthn L3 §7.2: if either the stored or the reported counter is non-zero and the reported one is not
greater, the RP gets a cloned-authenticator signal and applies its own policy [webauthn-verify]
**[source]**. SimpleWebAuthn throws in that case [simplewebauthn] **[source]**.

What each signer reports for a stored counter `n` **[observed]**:

| Signer                           | Reports                                      | Stored after                  |
| -------------------------------- | -------------------------------------------- | ----------------------------- |
| Bitwarden clients                | `0` if `n == 0`, else `n + 1` (written back) | unchanged if 0 [bw-auth]      |
| Chromium virtual authenticator   | `n + 1`                                      | `n + 1` (in the browser only) |
| Firefox virtual authenticator    | `n`, then `n + 1`                            | `n + 1` (in the browser only) |
| blindfill Android host           | always `0`                                   | —                             |
| Playwright `context.credentials` | `n + 1`                                      | `n + 1`                       |

Today Chromium therefore sends `1` on every sign-in of a Bitwarden-made passkey, and the second sign-in
fails at strict RPs. One rule for every path:

- If `n == 0` and the signer can report `0` (Firefox, Android host): report `0`, write nothing — exactly
  Bitwarden's behaviour.
- Otherwise report `n + 1` (Chromium: `addCredential signCount = n`; Firefox: `signCount = n + 1`;
  Android host: `n + 1`) and write `n + 1` back right after the assertion.

The write-back is a read-modify-write of the whole cipher (`#edit`). Proposed: a dedicated backend method
that only raises `counter` of the credential with the same id, and is allowed without a TTY (it changes no
secret and no binding). A failed write-back is reported (`counter_written_back: false`) and makes the next
sign-in repeat the counter; it is never retried silently. Concurrent use from a Bitwarden client can still
lose an update **[inference]**; whether `bw edit` rejects stale revisions is unverified.

### 4.2 Backup flags (BE/BS)

Bitwarden sets BE=1 and BS=1 on every assertion and creation [bw-auth] **[source]**. WebAuthn L3: an RP
that uses backup state must verify that BE matches the value stored at registration [webauthn-verify]
**[source]**. Today: Chromium virtual authenticator BE=0 by default (`defaultBackupEligibility` is opt-in)
**[source]**, Firefox BE=0 (flags `0x05`; its `AddCredential` has no BE/BS parameter) **[observed]**, Android
host flags `0x05` (BE=0) **[source]**.

- Chromium: set `backupEligibility`/`backupState` on `addCredential` and `defaultBackupEligibility`/
  `defaultBackupState` on `addVirtualAuthenticator` [cdp-webauthn] to 1, matching Bitwarden.
- Android host: flags `0x1D` (UP, UV, BE, BS).
- Firefox: cannot set BE **[source]**; a Bitwarden-made passkey used through Firefox may be rejected by RPs
  that check BE **[inference]**. Passkeys registered through Firefox would be BE=0 and break in Bitwarden
  clients at those RPs. Record the flag in the item (`blindfill.passkey_be`, readable) and refuse a
  mismatching path rather than fail at the RP.

### 4.3 Several passkeys

The Bitwarden model is one passkey per item, several items per RP. blindfill always loads exactly the one
item the caller selected (or the one item `resolveItem` finds for the origin), so the browser never chooses
between blindfill credentials. If the RP sends an `allowCredentials` list that does not contain it, the
ceremony fails and blindfill reports `not_used` (today's behaviour). Registration takes the RP's
`excludeCredentials` at face value: the virtual authenticator holds only the new credential, so nothing is
excluded; duplicates at the RP are the RP's call.

### 4.4 RP ID and origin binding

Keep today's two blindfill checks (item binds the page; rpId equals the page host or a parent) for both
ceremonies, then let the browser do the WebAuthn checks. With a virtual authenticator the browser enforces
"rpId is a registrable suffix of the caller's origin" itself: a page on another site asking for the armed
rpId was rejected in Chromium and got `SecurityError` in Firefox **[observed]**. Registration reads the
created credential's rpId back from the browser and refuses to write it unless it equals the rpId blindfill
checked. Android keeps the package + signer pin and refuses `origin`-populated (browser) callers, as now.

## 5. Per browser

### 5.1 Chromium (CDP `WebAuthn` domain)

`WebAuthn.addVirtualAuthenticator`, `addCredential`, `getCredentials`, events `credentialAdded` /
`credentialAsserted` [cdp-webauthn] **[source]**. Registration: add an empty authenticator, let the page
call `navigator.credentials.create()`, wait for `credentialAdded`, read it with `getCredentials` (private
key, rpId, 32-byte id, `signCount`) **[observed]**, remove the authenticator. The authenticator is scoped to
the tab: another tab of the same context got `NotSupportedError` **[observed]**. Works for `chromium-launch`
and `chromium-cdp`, not for providers without CDP (Ego Lite's running instance stays unsupported).

### 5.2 Firefox / Camoufox

| Option                                  | Status                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Juggler (Playwright's Firefox protocol) | no WebAuthn domain; nothing in Camoufox 158's `chrome/juggler/` mentions WebAuthn **[observed]**                                                                                                               |
| WebDriver BiDi                          | no WebAuthn module in the spec (umbrella issue open) [bidi-1154] or in Firefox's BiDi modules **[source]**                                                                                                     |
| WebDriver classic WebAuthn extension    | Marionette `WebAuthn:*` commands [ff-marionette]; geckodriver 0.34 added them, 0.36 warned they were unreliable, 0.37.0 (2026-06-03) "full support … Requires Firefox 152 or later" [geckodriver] **[source]** |
| Playwright 1.61+ `context.credentials`  | page-script shim, see §5.3                                                                                                                                                                                     |

Marionette works next to Juggler **[observed]**: Playwright-launched Firefox 159 and Camoufox
158.0.1-beta.41, both with `args: ['-marionette']` and the two prefs, accepted `WebDriver:NewSession`,
`WebAuthn:AddVirtualAuthenticator`, `WebAuthn:AddCredential` and `WebAuthn:GetCredentials` on port 2828; the
Juggler-driven page then signed with the added credential and created a new one; `GetCredentials` returned
it with its private key. (`marionette.port` set through `firefoxUserPrefs` was ignored; the listener used
the default 2828.)

Constraints **[source + observed]**:

- The softtoken pref is global: `WebAuthnService::DefaultService()` sends every WebAuthn request to the
  test token while it is set [ff-service], so **real USB keys stop working in that browser**. Pref changes
  could be scoped to the arm window through Marionette's chrome context **[inference]**.
- The virtual authenticator is browser-wide: a page in a **different context** used the armed credential
  **[observed]**. Wider than Chromium's per-tab scope; keep the arm short and remove the credential right
  after the first assertion.
- Firefox only serves WebAuthn to a focused document (`NotAllowedError: CredentialsContainer request is not
allowed` once another page took focus) **[observed]**.
- Marionette has no authentication; any local process that connects first gets full browser control,
  including chrome-privileged script. blindfill should open the single Marionette session at attach time
  and hold it, which locks others out (Marionette allows one session) **[inference]**. SECURITY.md treats
  the host as trusted, but this is a new local control port Ollie's setup does not have today.
- The running Camoufox must be **restarted** with the flag (Camoufox's `launch_server` passes `args` and
  `firefox_user_prefs` through to `launch_options` **[source]**). `navigator.webdriver` stayed `false` in
  Camoufox with Marionette on **[observed]**; other fingerprint effects are unmeasured.
- The provider needs a second endpoint (Marionette host:port, loopback only) next to the Playwright
  websocket; `firefox-connect` gains a `webauthn` capability.

### 5.3 Page-script shim (any browser, including Playwright's `context.credentials`)

Playwright 1.61 added `BrowserContext.credentials` [pw-credentials]: an init script replaces
`navigator.credentials.create/get` in the main world and calls an exposed binding; the Playwright server
builds `clientDataJSON` and signs in Node [pw-src] **[source]**. It runs on Chromium, Firefox and Camoufox
**[observed]** (Camoufox 158 launched directly, without the Python launcher; Camoufox documents init scripts
as isolated [camoufox-stealth], which did not hold in that setup).

Not usable as is **[observed]**:

- The binding `__pwWebAuthnBinding` is a main-world global. A page on `https://evil.example` called it with
  `origin: 'https://rp.example', rpId: 'rp.example'` and received a valid signature over a
  `clientDataJSON` claiming `https://rp.example`. The server takes `origin` and `rpId` from the page and
  checks neither. That is a cross-origin assertion oracle.
- `navigator.credentials.get.toString()` is not `[native code]`: any page can detect it, which defeats
  Camoufox's purpose.
- `credentials.get()` returns private keys to the client, and with `firefox-connect` the key would live in
  the remote Playwright server process.

A blindfill-owned shim could fix the first point (take the origin from the binding's source frame, which
the browser reports, check rpId against it, accept one call while armed, and sign on the host like the
Android path; the key would then never enter the browser). It still moves WebAuthn's origin and rpId rules
from the browser into blindfill, remains detectable, and can be raced or wrapped by page scripts that run
before it. Keep it as the last resort for WebKit only, if ever.

### 5.4 WebKit

Playwright WebKit has no virtual-authenticator API (feature request closed without one [pw-26621]); only
the shim above would work **[source + inference]**. Not planned.

### 5.5 Android (companion)

Registration maps onto the existing arm model [android-provider] **[source]**:

1. `blindfill android passkey-register --item --serial` arms the companion (kind `passkey-create`).
2. `onBeginCreateCredentialRequest` returns one `CreateEntry` ("blindfill: <item>") only while armed and
   only for a `BeginCreatePublicKeyCredentialRequest` whose `rp.id` equals the armed rpId.
3. The activity reads `ProviderCreateCredentialRequest` (`CreatePublicKeyCredentialRequest`: request JSON,
   optional `clientDataHash`, `CallingAppInfo`), builds `clientDataJSON` with `type: webauthn.create` for
   the app's `android:apk-key-hash:` origin, and sends rp, user, challenge hash, package and signer to the
   host.
4. The host checks package + signer binding and rpId, generates the P-256 key, writes the vault, builds
   `authData` (flags `0x5D`: UP, UV, BE, BS, AT; counter 0; AAGUID; credential id; COSE key) and a
   `none` attestation object, and returns them. The phone returns
   `CreatePublicKeyCredentialResponse(registrationResponseJson)`.

The key never reaches the phone. Browser callers (Chrome on Android with an `origin`) stay refused, as for
sign-in.

## 6. Threat-model differences

| Route                            | Who enforces origin/rpId          | Where the key lives during use        | Scope while armed                 | New exposure                                                                   |
| -------------------------------- | --------------------------------- | ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| Chromium CDP (today)             | browser + blindfill pre-checks    | blindfill → Chromium process          | one tab, 15 s, one-shot           | none new; registration adds a vault write                                      |
| Firefox Marionette               | browser + blindfill pre-checks    | blindfill → Firefox process           | **whole browser**, 15 s, one-shot | unauthenticated loopback Marionette; real security keys off while prefs set    |
| Android host signing (today)     | system package/signer + blindfill | blindfill host only                   | one armed request                 | registration adds a vault write                                                |
| blindfill shim (not recommended) | **blindfill only**                | blindfill host only                   | page, one call                    | page-detectable; WebAuthn origin rules reimplemented; page scripts can wrap it |
| Playwright `context.credentials` | **nobody** (page-supplied origin) | Playwright server, returned to client | whole context, unlimited          | cross-origin signing oracle **[observed]**; never use                          |

Weakened guarantees: Firefox's browser-wide authenticator widens SECURITY.md item 7 ("any frame of that
page") to "any page of that browser" during the arm; registration lets an agent add a sign-in method to an
account (§3.3); counter write-back adds an unattended vault write. Before `bw.#edit` sends an item back it
registers password, TOTP, card and Hidden-field values with the scrubber (in case `bw` echoes the body), but
not `fido2Credentials[].keyValue` or SSH keys; add them before any passkey write.

## 7. Phases, effort and acceptance

| Phase | Scope                                                                                         | Effort   | Acceptance                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Spikes (below)                                                                                | 2 days   | each spike answers its question with a recorded result in `docs/TESTED.md`                                                                                                            |
| 1     | Sign-in fixes: counter rule (§4.1), BE/BS (§4.2), scrubber for `keyValue`                     | 2 days   | fake RP verifying counter strictly (SimpleWebAuthn rules) and BE: three sign-ins in a row on Chromium and Android pass; vault counter matches                                         |
| 2     | Chromium registration: `Engine.passkeyRegister`, CLI `passkey register`, MCP tool, `bw` write | 3 days   | fake RP registers, then signs in from the vault in a fresh session; leak test finds no `keyValue` in outputs/audit; refused cases (no opt-in, existing passkey, rpId/origin mismatch) |
| 3     | Firefox/Camoufox: provider Marionette endpoint, sign-in + registration                        | 3–4 days | `BLINDFILL_TEST_FIREFOX=1` suite with a Camoufox started like Ollie's (Linux), both ceremonies against the fake RP; other-context and focus cases documented                          |
| 4     | Android registration (§5.5)                                                                   | 3 days   | `tests/android-device.test.ts` with the fake RP app on emulator and Xperia: create, then sign in                                                                                      |
| 5     | Real relying parties                                                                          | 1–2 days | webauthn.io (no account), then one throw-away account on a real site (e.g. GitHub) chosen by Mics: register, sign out, sign in twice, sign in with the Bitwarden extension            |

Phase 0 spikes, riskiest first:

1. **Bitwarden interop** (blocks the whole format plan): create a passkey with the Bitwarden browser
   extension on webauthn.io, sign in with blindfill (Chromium); then write a blindfill-made `b64.` credential
   with `bw` and sign in with the Bitwarden extension. Checks id encoding, `keyValue`, counter and BE.
2. **Camoufox on Linux with Marionette**: repeat §8's Firefox script against the Camoufox build and launcher
   Ollie uses (`launch_server` with `args`/`firefox_user_prefs`), in a throw-away profile; measure
   `navigator.webdriver` and a fingerprint test page with and without `-marionette`.
3. **Counter on a strict RP**: two sign-ins through today's Chromium path against a SimpleWebAuthn-style fake
   RP, expected to fail the second time; confirms the Phase 1 priority.

## 8. Experiments run (2026-11-27, owner's Mac, throw-away scripts, not committed)

Fake RPs served by `page.route` on `https://rp.example` / `https://evil.example`; fresh profiles; no vault.
Browsers: Chromium bundled with playwright-core 1.65.1; Playwright Firefox 159.0 (`firefox-1572`); Camoufox
158.0.1-beta.41 macOS arm64 (from `camoufox fetch`) driven by playwright-core 1.62.0, headless.

| Question                                                        | Result                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| Chromium: counter reported for stored 0                         | `1`                                                     |
| Chromium: `create()` then `getCredentials`                      | works; 32-byte id; private key returned                 |
| Chromium: other site asks for armed rpId                        | rejected                                                |
| Chromium: other tab of same context                             | `NotSupportedError` (authenticator is per tab)          |
| Firefox 159 / Camoufox 158: Marionette next to Juggler          | works on port 2828 with `-marionette` and the two prefs |
| Firefox / Camoufox: counter for stored 0, two assertions        | `0`, then `1`                                           |
| Firefox / Camoufox: `create()` then `WebAuthn:GetCredentials`   | works; 32-byte id; private key returned                 |
| Firefox / Camoufox: other site asks for armed rpId              | `SecurityError`                                         |
| Camoufox: page in another context uses armed credential         | **signed** (browser-wide)                               |
| Camoufox: `navigator.webdriver` with Marionette session         | `false`                                                 |
| Playwright `context.credentials` on Chromium, Firefox, Camoufox | works; binding visible to page; `toString` reveals shim |
| Playwright `context.credentials`: forged origin from evil page  | **valid signature for `https://rp.example`**            |

Reproduce: launch with Playwright, `firefoxUserPrefs` as in §5.2, connect a TCP client to `127.0.0.1:2828`
(Marionette framing `len:[0,id,"Command",{params}]`), `WebDriver:NewSession`, then
`WebAuthn:AddVirtualAuthenticator {protocol:"ctap2_1",transport:"internal",hasResidentKey:true,
hasUserVerification:true,isUserVerified:true}` and `WebAuthn:AddCredential {authenticatorId, credentials:{…}}`.

## 9. Decisions needed from Mics

1. **Camoufox**: allow restarting Ollie's Camoufox with `-marionette` and the softtoken prefs (real USB
   security keys off in that browser; local unauthenticated control port), or keep web passkeys
   Chromium-only. Recommendation: allow, after spike 2 passes, with blindfill holding the Marionette
   session.
2. **Registration without a terminal** on opted-in items, add-only, under the §3.3 rules. Recommendation:
   yes, same footing as `item generate`.
3. **Counter write-back without a terminal** (counter field only). Recommendation: yes.
4. **Real-site test account** for Phase 5 (which site, throw-away account, who owns it).

## Sources

- [webauthn-verify]: W3C, Web Authentication Level 3, §7.2 Verifying an Authentication Assertion (signature
  counter and BE steps), and §11 automation: https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion,
  https://www.w3.org/TR/webauthn-3/#sctn-automation
- [cdp-webauthn]: Chrome DevTools Protocol, WebAuthn domain: https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/
- [ff-marionette]: Firefox `remote/marionette/webauthn.sys.mjs` and `driver.sys.mjs` (`WebAuthn:*` commands):
  https://github.com/mozilla-firefox/firefox/blob/main/remote/marionette/webauthn.sys.mjs
- [ff-service]: Firefox `dom/webauthn/WebAuthnService.h` (`DefaultService`), `dom/webauthn/authrs_bridge/src/lib.rs`,
  `modules/libpref/init/StaticPrefList.yaml` (`security.webauth.webauthn_enable_softtoken`):
  https://github.com/mozilla-firefox/firefox/tree/main/dom/webauthn
- [geckodriver]: geckodriver release notes 0.34.0–0.37.0: https://github.com/mozilla/geckodriver/releases
- [bidi-1154]: WebDriver BiDi, "WebAuthn as an extension module": https://github.com/w3c/webdriver-bidi/issues/1154
- [pw-credentials]: Playwright `Credentials` API: https://playwright.dev/docs/api/class-credentials
- [pw-src]: Playwright `packages/playwright-core/src/server/credentials.ts` and `packages/injected/src/webAuthn.ts`
  (read from the installed playwright-core 1.65.1 bundle): https://github.com/microsoft/playwright
- [pw-26621]: Playwright, "Configure WebAuthn virtual authenticators in WebKit": https://github.com/microsoft/playwright/issues/26621
- [camoufox-stealth]: Camoufox stealth overview and main-world evaluation: https://camoufox.com/stealth,
  https://camoufox.com/python/main-world-eval
- [bw-auth]: Bitwarden `libs/common/src/platform/services/fido2/fido2-authenticator.service.ts`:
  https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts
- [bw-credid]: Bitwarden `credential-id-utils.ts`:
  https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/credential-id-utils.ts
- [simplewebauthn]: SimpleWebAuthn `verifyAuthenticationResponse.ts`:
  https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/authentication/verifyAuthenticationResponse.ts
- [android-provider]: Android, "Integrate Credential Manager with your credential provider":
  https://developer.android.com/identity/sign-in/credential-provider; `BeginCreatePublicKeyCredentialRequest`,
  `CreatePublicKeyCredentialResponse` API reference.

[bw-auth]: https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts
[bw-credid]: https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/credential-id-utils.ts
[webauthn-verify]: https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion
[simplewebauthn]: https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/authentication/verifyAuthenticationResponse.ts
[cdp-webauthn]: https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/
[ff-marionette]: https://github.com/mozilla-firefox/firefox/blob/main/remote/marionette/webauthn.sys.mjs
[ff-service]: https://github.com/mozilla-firefox/firefox/blob/main/dom/webauthn/WebAuthnService.h
[geckodriver]: https://github.com/mozilla/geckodriver/releases
[bidi-1154]: https://github.com/w3c/webdriver-bidi/issues/1154
[pw-credentials]: https://playwright.dev/docs/api/class-credentials
[pw-src]: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/credentials.ts
[pw-26621]: https://github.com/microsoft/playwright/issues/26621
[camoufox-stealth]: https://camoufox.com/stealth
[android-provider]: https://developer.android.com/identity/sign-in/credential-provider
