# Security policy

blindfill is **alpha software**. It has not had an independent security review. Read the limits
below before trusting it with accounts you cannot afford to lose.

## What blindfill defends against

blindfill defends against **the model and its logs**:

- The agent is never handed a Secret-class value (password, TOTP seed, Hidden custom fields,
  card number/CVV, private keys). No CLI command, MCP tool or library function returns one;
  they can only be written into a field (`SecretHandle.into(sink)`).
- The agent cannot choose where a secret goes. The binding comes from the vault item's URIs
  (Bitwarden match types) and is compared with the origin the browser actually reports.
- After a Secret has been filled, the session refuses page text, DOM and screenshots to the
  caller, and every string leaving blindfill is scrubbed for the raw, URL-encoded, Base64
  and JSON-escaped forms of the secrets handled in that process. If any output would match a
  secret, the whole output is withheld, so a scrubbed echo cannot confirm a guess.
- Errors never echo caller input (rule ids, field and profile names), and evidence and rule
  selectors cannot probe values or input state (no `[value…]`, substring attribute matches,
  text selectors or state pseudo-classes). MCP schema-validation and unknown-tool errors return one
  fixed code with no message.
- A fill types only into the documents it was planned on: a navigation (same-origin included) or a
  replaced frame between planning and a write fails the fill, and nothing is re-bound. Without a
  rule, only the top document is searched; a field inside a frame needs a `blindfill.rules` rule.
- Session state (`session.json`: post-fill lock and one-shot records) lives in a state directory
  that must be owned by you with mode 0700 (otherwise refused). It is written atomically under a
  lock file, and the lock and one-shot records only grow until `session stop`, so a CLI and an MCP
  process running at once cannot clear each other's.
- Windows has no owner/mode bits, so the same checks (state directory, profiles directory, local
  rules and profile files and their directory) read the owner and DACL by SID through the built-in
  Windows PowerShell (`Get-Acl`): the owner and every allow entry, inherit-only ones included, must
  be you, SYSTEM or Administrators (plus the CREATOR OWNER / OWNER RIGHTS placeholders); anything
  else (Users, Everyone, another account, an AppContainer capability), a symlink or junction, or a
  failed read is refused. A directory blindfill creates gets that DACL with inheritance removed
  (`icacls /inheritance:r`), as `mkdir -m 0700` would; one that already exists is checked, not
  changed. Administrators and SYSTEM are trusted as root is on POSIX. Windows has no `O_NOFOLLOW`,
  so a rules or profile file is opened, then checked to be the same non-symlink file (file index)
  at its path before the ACL check. `%TEMP%` and `%LOCALAPPDATA%` can carry extra entries (on the
  test machine: sandbox accounts), so keep these directories under your profile (the defaults
  `~/.local/state/blindfill` and `~/.config/blindfill` are).
- Changing secret values, origins, `blindfill.*` control fields or a password policy needs a
  person at a terminal. There is no command that reveals a stored secret. The exceptions only add
  or are field maps: adding a TOTP seed (`totp enroll`, point 18), adding a passkey (point 19) and
  editing `blindfill.rules` (point 20). Adding a passkey or filling a sign-up password needs no
  per-item opt-in (owner decision 2026-11-28): any item that binds the site or app, and for a passkey
  holds none yet, can be used.
- Fill is one-shot: a Secret field is filled at most once per session and origin, and the
  form is submitted at most once per call. Unknown outcomes are reported, never retried.
  The submit control is checked before any secret is read; a control that is merely disabled
  (`disabled` or under `aria-disabled="true"`) passes that check, because many sites enable it
  only after the fields hold values. After filling, blindfill waits up to 3 s for it to enable,
  checks it again in full and clicks once; if it stays disabled the submit is refused with the
  fields already filled. A control under `[inert]` is refused before filling.
- A rule submit of kind `js` blocks, from just before the click until 1.5 s after it, the
  form's `submit` event and any GET navigation of the rule's frame to the form's action with a
  query (a native GET submission), so filled values cannot reach a URL that way. A native
  submission the page fires later (after a slow request) is not covered. With
  `"outside_form": true` the control may sit outside every form (a button, `role=button` or
  `<a>` with no form owner and no `form*` attributes); it is looked up only in the rule's own
  origin-bound frame, must be unique and visible, and is checked before any secret is read.
- Secrets are typed over https only; plain http is accepted for loopback dev hosts alone. Malformed
  `blindfill.*` control data fails the operation instead of being skipped.
- A passkey's private key goes from the vault to a temporary Chromium virtual authenticator over
  CDP; the page and the agent never receive it. It is used only when the item binds the page and
  its rpId covers the host, at most once per session and origin. Before any item is written back
  to `bw`, every key in it (passkey `keyValue`, SSH private key) is registered with the scrubber too.

## What blindfill does NOT defend against

1. **A malicious or compromised page.** The password is typed into the page's DOM. Scripts on
   a page you bound the item to can read it. Binding to the right origin is the only
   protection, so prefer the _Host_ or _Exact_ match type over _Base domain_.
2. **A compromised host or browser.** Anyone who can read process memory, the browser profile
   or the vault session (`BW_SESSION`) wins. Playwright needs the value as a JavaScript
   string for a moment; JS strings cannot be zeroed. Only the `Buffer` inside `SecretHandle`
   is zero-filled.
3. **The agent driving the browser itself.** If the agent has _another_ tool attached to the
   same browser (a Playwright MCP, a CDP console), it can read the DOM (including a filled
   password field's value) through that tool. The post-fill lock only covers blindfill's own
   interfaces. Give the agent blindfill _instead of_, not next to, an unrestricted browser
   tool for the same session if this matters to you.
4. **The returned TOTP code.** By design the current code is Ephemeral and readable. Its
   safety rests on origin binding and its short lifetime.
5. **Scrubbing is best effort.** It handles exact raw, URL-encoded, form-encoded, Base64
   (including shifted alignments), hex and JSON-escaped forms. A page that transforms the
   secret (rot13, splitting, hashing) defeats it. Secrets shorter than 4 characters are
   not scrubbed.
6. **Shadow DOM, closed iframes and canvas inputs** are not supported by the field detector;
   blindfill stops (fail closed) rather than guessing.
7. **Passkeys** are web sign-in and registration in Chromium and Firefox/Camoufox, and Android app
   sign-in and registration. Assertions set the user-verified flag without a biometric: the vault unlock and the item
   binding stand in for it. Chromium and Android set backup-eligible and backed-up as Bitwarden clients
   do, unless the item says `blindfill.passkey_be=0`. Firefox cannot set that flag: its passkeys are
   BE=0, and Bitwarden-made (BE=1) ones are signed there with BE=0 too (owner decision 2026-11-27); a
   relying party that checks BE rejects that sign-in, an ordinary failure (use Chromium). Marionette
   has no W3C `WebAuthn:SetCredentialProperties` yet; once it does, Firefox can set BE. Firefox needs its Marionette port (`-marionette`),
   an unauthenticated loopback control port that any local process can use to drive the browser, and
   the softtoken pref, which turns real USB security keys off in that browser. Its authenticator is
   browser-wide while armed (up to 15 s): any focused page of that browser that WebAuthn allows for
   the rpId could get the signature, not only blindfill's page.
   After a signature the sign counter is raised in the vault without a person at a terminal (owner
   decision): that write changes only the counter and never lowers it. A stored counter of 0 stays 0
   on Android; Chromium always counts up. A failed write is reported (`counter_written_back: false`,
   `counter_error`), not retried, and the next sign-in repeats the counter, which strict relying
   parties refuse. While a web passkey is armed (up to 15 s), any frame of that page that WebAuthn
   allows for the rpId may trigger the signature.
8. **Backends marked "blind-written/unverified"** have never touched a real vault. They pass
   contract tests against recorded fixtures only. `bw` runs in CI against a mock CLI; it passed one
   live run against a Vaultwarden instance on 2026-11-27, with throw-away items on local fake pages
   ([docs/TESTED.md](docs/TESTED.md)).
9. **"A person at a terminal" means a TTY.** An agent that runs blindfill inside a
   pseudo-terminal passes that check. Do not give an agent a PTY if item edits matter.
10. **Generated passwords go where the agent registers.** `item generate` binds a new item to
    origins the caller names, and `register` types the generated password there. That is the
    purpose; it gives the agent no access to existing items.
11. **Local rules and profiles are trusted.** Anyone who can write the config directory can
    define selectors for an item's bound origin (selectors are still restricted, see above).
12. **Navigation is not locked.** After a fill, `fill --url` may still navigate; reads stay
    refused until `session stop`.
13. **Human handoff is unobserved.** While paused, blindfill neither watches nor limits what the
    person does in the browser; it only refuses agent actions.
14. **Outcome reporting is a small channel by design.** `verify` and `--expect-*` return
    booleans for caller-chosen structural selectors; they cannot select on values.
15. **Rule-less fills have one gap.** Without a rule, the form must be a single login form in the
    top document and submit goes only through its one native POST button, but there are no
    page-text heuristics for newsletter and password-reset forms. Use `blindfill.rules` for
    sites that matter, for forms without a `<form>` element and for fields inside frames.
16. **Android companion trust.** Passwords pass through the companion's memory into the autofill
    framework and then the app, which receives them by design. The arm token travels as an `adb`
    argument (visible to the host user's processes for a moment). Any app on the phone can connect
    to the loopback port; without the token it gets nothing, but its connection ends the arm (fails
    closed, the agent re-arms). The companion trusts the system's package and signer report (and a
    WebView's own domain report, item 22); a rooted
    or compromised phone defeats it. Before every arm the host reads the installed companion APK back
    from the phone (`pm path`, `adb exec-out cat`), parses its APK Signing Block and refuses unless
    its only signer certificate has SHA-256
    `C7EDE55AB64522DC9BC142F8F20B9BAABE5341D828210183D991157FE0EC45C8` (an app that merely reuses the
    package name is not armed). This trusts `adb` and PackageManager, which verified the signature at
    install; it does not re-verify the signature bytes. `BLINDFILL_COMPANION_SIGNER` overrides the pin
    for development builds; anyone who controls the host's environment can set it. The release key
    (PKCS12, RSA 4096) lives in the owner's `~/.config/blindfill/` (0600), in the GitHub Actions
    secrets `ANDROID_KEYSTORE_B64`/`ANDROID_KEYSTORE_PASSWORD`, and as an age-encrypted backup; it is
    never committed. CI and the release workflow check the built APK's signer with `apksigner`.
17. **A key stored in a Hidden custom field is treated as a password.** blindfill recognises keys
    only in their dedicated places (the item's TOTP field, SSH-key items, passkeys). A private key,
    seed or recovery code pasted into a Hidden custom field is an ordinary Secret: it cannot be read,
    but it can be filled into a page the item binds. Keep keys in their dedicated fields.
18. **An agent can add a TOTP seed to an item that has none** (`totp enroll`, owner decision
    2026-11-27). blindfill reads the setup key or `otpauth://totp` URI from one element of the top
    document on a page the item binds and writes it to the item's TOTP field; the agent gets only the
    item id. An item that already has a seed is refused (the `bw` backend refuses too), so an agent
    cannot swap a working seed for one it controls. It can still give a seedless item a seed from any
    page that item binds, which is the purpose. No QR decoding; a key inside an iframe is unreachable.
19. **An agent can add a passkey to an item that has none** (`passkey register`, owner decision
    2026-11-27, no terminal; no opt-in since 2026-11-28). Any item that binds the page qualifies;
    an item that already holds a passkey is refused, so an agent cannot replace a working one. The
    page's own `create()` is answered once by an empty Chromium virtual authenticator, offered ES256
    only; the new private key goes from the browser into the vault in one `bw edit` and the agent
    gets the rpId and credential id. If the vault write fails (`vault_write_failed`) or the key is
    unusable (`not_stored`), the relying party may keep a passkey the vault does not have; a person
    must delete it there. On Android (`android passkey-register --rp-id`) the item must also bind the
    app (`androidapp://`, plus its `blindfill.signers` pin if it has one; see 21) and `https://<rpId>`, which stands in for the Digital
    Asset Links check a credential provider owes native apps; the host makes the key and stores it
    before the phone gets the attestation, so a failed vault write leaves no passkey at the app.
20. **An agent can rewrite an item's rules** (`item edit --set blindfill.rules=…` without a terminal,
    owner decision 2026-11-27). Rules still parse strictly and a rule naming an origin the item does
    not bind is refused at fill time, but
    an agent misled by page text could map the password field to a visible input on a bound origin
    (a comment box, a profile field) and so publish the password there. Origin binding does not stop
    that; review rule changes in the audit log (`event: item`, field `blindfill.rules`).
21. **Android apps are bound by package name; a signer pin is optional** (owner decision
    2026-11-27, as Bitwarden does). An item with `androidapp://<package>` and no `blindfill.signers`
    gives its password (autofill or Credential Manager), passkey sign-in and passkey registration (no
    opt-in, any item without a passkey) to
    whatever app has that package name. **If a fake app with the same package name replaces the real
    one** (sideloaded after the real app is removed, or installed on a phone that never had it), it
    gets the password. Android refuses to install a differently signed APK over an installed one, so
    the risk is an app that was absent or uninstalled. Add `blindfill.signers` (SHA-256 of the
    signing certificate) to an item to close it; with a pin, the signer must match.
22. **WebViews are bound by the domain alone** (owner decision 2026-11-27). A login or sign-up form
    inside any app's WebView gets an item's password when every web node on the screen reports the
    same `https` domain and the item binds `https://<that domain>` (host match by default); the app
    itself need not be bound, so one item serves the site and the apps that show it. The domain is
    reported by the WebView in the app's own process: **an app can claim any domain** (load its own
    page with that base URL) and so receive the password of any item that binds that domain. Only
    arm WebView fills for apps you trust, as with a browser. Passkeys are not offered to WebViews.
23. **App sign-up fills a generated password** (`android register`, `password-new`). The item must
    bind the app (item 21) or the
    WebView's domain (item 22); the screen must look like sign-up (two password fields, or one with a
    new-password hint; more than two is refused). The same password goes into the password and its
    confirmation. blindfill does not submit and cannot tell whether the account was created; if the
    app rejects the password, the item keeps a password the account does not have. Since 2026-11-28
    there is no opt-in: an agent can fill any bound item's password into any sign-up form of that
    site or app (web `register`, `android register`). An item made with `item generate --no-password`
    (passkey-only sites) has no password; password login, fill, `register` and `android fill` refuse
    it with "no password" rather than fill a blank.
24. **`ego-cli` passes filled values through Ego Lite's Node runtime** (supported provider; owner
    decision 2026-11-28). Values travel as CDP `Input.insertText` parameters through Ego's own
    closed-source agent runtime, outside blindfill's control. Cross-origin (out-of-process) iframes
    are invisible to it, so their fields are refused. After a submit, Ego's password manager runs
    Google's password leak check, as for a password typed by hand. Checked once on Ego Lite 0.6.3.17
    (2026-11-28, about 3 minutes, fake login page and fake passwords): outbound traffic (net-export
    with raw bytes, per-process sockets) carried the value only to the page it was typed into; no
    Sentry or PostHog report was sent, also after forced errors; a renderer crash dump did not
    contain it and Crashpad uploads are off; nothing on disk. **Not checked**, accepted by the owner
    on 2026-11-28: longer traffic captures (telemetry sent later), the Ego UI operation log, QUIC
    payloads, process memory, and later Ego versions. Details:
    [docs/browsers.md](docs/browsers.md#ego-lite).

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on the repository once it is public. A dedicated
contact address will be added here before the first public release.

Useful reports include: any path that returns a Secret-class value, any bypass of origin
binding or the post-fill lock, and any leak of a secret or `BW_SESSION` into logs, audit
files or error messages.
