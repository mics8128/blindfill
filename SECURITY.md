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
- Changing secret values, origins, `blindfill.*` control fields or a password policy needs a
  person at a terminal. There is no command that reveals a stored secret.
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
7. **Passkeys** are web sign-in in Chromium and Android app sign-in; new passkeys cannot be
   registered. Assertions set the user-verified flag without a biometric: the vault unlock and the
   item binding stand in for it. They also set backup-eligible and backed-up, as Bitwarden clients do.
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
15. **Rule-less fills are still looser than olliepm in one way.** Without a rule, the form must be a
    single login form in the top document and submit goes only through its one native POST button
    (see [docs/MIGRATING-FROM-OLLIEPM.md](docs/MIGRATING-FROM-OLLIEPM.md)), but olliepm's page-text
    heuristics for newsletter and password-reset forms are not ported. Use `blindfill.rules` for
    sites that matter, for forms without a `<form>` element and for fields inside frames.
16. **Android companion trust.** Passwords pass through the companion's memory into the autofill
    framework and then the app, which receives them by design. The arm token travels as an `adb`
    argument (visible to the host user's processes for a moment). Any app on the phone can connect
    to the loopback port; without the token it gets nothing, but its connection ends the arm (fails
    closed, the agent re-arms). The companion trusts the system's package and signer report; a rooted
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

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on the repository once it is public. A dedicated
contact address will be added here before the first public release.

Useful reports include: any path that returns a Secret-class value, any bypass of origin
binding or the post-fill lock, and any leak of a secret or `BW_SESSION` into logs, audit
files or error messages.
