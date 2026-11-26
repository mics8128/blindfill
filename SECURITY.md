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
  and JSON-escaped forms of the secrets handled in that process.
- Fill is one-shot: a Secret field is filled at most once per session and origin, and the
  form is submitted at most once per call. Unknown outcomes are reported, never retried.

## What blindfill does NOT defend against

1. **A malicious or compromised page.** The password is typed into the page's DOM. Scripts on
   a page you bound the item to can read it. Binding to the right origin is the only
   protection, so prefer the *Host* or *Exact* match type over *Base domain*.
2. **A compromised host or browser.** Anyone who can read process memory, the browser profile
   or the vault session (`BW_SESSION`) wins. Playwright needs the value as a JavaScript
   string for a moment; JS strings cannot be zeroed. Only the `Buffer` inside `SecretHandle`
   is zero-filled.
3. **The agent driving the browser itself.** If the agent has *another* tool attached to the
   same browser (a Playwright MCP, a CDP console), it can read the DOM (including a filled
   password field's value) through that tool. The post-fill lock only covers blindfill's own
   interfaces. Give the agent blindfill *instead of*, not next to, an unrestricted browser
   tool for the same session if this matters to you.
4. **The returned TOTP code.** By design the current code is Ephemeral and readable. Its
   safety rests on origin binding and its short lifetime.
5. **Scrubbing is best effort.** It handles exact raw, URL-encoded, form-encoded, Base64
   (including shifted alignments), hex and JSON-escaped forms. A page that transforms the
   secret (rot13, splitting, hashing) defeats it. Secrets shorter than 4 characters are
   not scrubbed.
6. **Shadow DOM, closed iframes and canvas inputs** are not supported by the field detector;
   blindfill stops (fail closed) rather than guessing.
7. **Android** is not implemented yet (stub only).
8. **Backends marked "blind-written/unverified"** have never touched a real vault. They pass
   contract tests against recorded fixtures only.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on the repository once it is public. A dedicated
contact address will be added here before the first public release.

Useful reports include: any path that returns a Secret-class value, any bypass of origin
binding or the post-fill lock, and any leak of a secret or `BW_SESSION` into logs, audit
files or error messages.
