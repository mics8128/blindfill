# Android: app sign-up, WebView logins and Credential Manager passwords through the companion

Status: built (2026-11-28) after the owner decisions in §6; test results in
[TESTED.md](../TESTED.md). Owner decision (Mics, 2026-11-27): the phone path replaces olliepm's
scrcpy control completely and goes through the companion APK. This page covers the gaps left in
[MIGRATING-FROM-OLLIEPM.md](../MIGRATING-FROM-OLLIEPM.md) §3 row 12: **mobile registration** and
**WebView logins**, plus Credential Manager password sign-in. Android passkey registration was built
earlier (Phase 4, ARCHITECTURE §3.2).

## 1. What olliepm did

- `olliepm profile phone NAME --device SERIAL --package PKG [--user N] --authorize [--submit]`: one-time
  binding of a saved item to a native app (device serial, Android user, package; APK path fingerprint,
  publisher checked), saved in a private profile; `olliepm login NAME --target phone` then typed the
  stored username and password through scrcpy's control channel.
- `olliepm register-phone ITEM --device --package --password-selector XPATH --confirm-selector XPATH
[--submit-selector XPATH] (--check | --authorize) [--submit]`: the item's stored (already generated)
  password, read once, typed into the new-password and confirm fields that restricted UI-XML XPaths
  select; refuses extra password fields or overlapping bounds; never retries, never clears input
  unless `--replace-existing`; no Autofill, package-only identity.
- WebViews: refused ("never trust a WebView's self-reported origin").

What changes: the Android system, not blindfill, names the app (AssistStructure package) and its
signer (PackageManager), and the fields (AutofillId, autofill hints, input type, HTML attributes),
so no XPath, scrcpy, focus or geometry checks and no typing. The value goes only into an autofill
Dataset or a Credential Manager response.

## 2. Binding (D1)

As in Bitwarden, an app is bound by its package: `androidapp://<pkg>` on the item. A
`blindfill.signers` pin is optional; when the item has one, the signer must match. This applies to
password fills, sign-up, Credential Manager passwords, passkey sign-in and passkey registration.
Risk (SECURITY 21): a fake app with the same package name, installed where the real one is absent,
gets the password.

## 3. App sign-up (password registration)

Two steps, as on the web (`item generate`, then fill): the vault holds the password before any app
sees it, so a crash between the steps never leaves an account whose password is not in the vault.

1. **Item.** An existing item that binds the app (no opt-in since 2026-11-28),
   or a new one: `blindfill item generate <name> --android <pkg> --username <u> [--origin https://…]
[--length n] [--policy-file f]`. The password is generated on the host (CSPRNG, item policy) and
   never printed.
2. **Fill.** `blindfill android register --item <id> --serial <s>` (MCP `android_offer` with
   `kind: "password-new"`) arms kind `password-new`. The companion's FillService reports package,
   signer, the number of password fields and whether one carries a new-password hint (`newPassword`
   autofill hint or `autocomplete=new-password`). The host checks the binding and the sign-up shape
   (two password fields, or one with the hint; more than two refused) before reading the password.
   The Dataset fills the username field (if found) and the same password into both password fields.
3. **Submit.** Not done by blindfill: the agent taps the app's button; the result carries
   `registration_outcome: "unknown"`. One arm answers one fill; no retry. If the app rejects the
   password, the item keeps a password the account does not have.

The companion never saves (`onSaveRequest` stays a no-op). Credential Manager has no "fill a sign-up
form" call (`CreatePasswordRequest` is an app saving a password the user typed), so sign-up goes
through autofill.

## 4. WebView logins and sign-up (D3)

Each `ViewNode` inside a WebView carries `getWebDomain()` and `getWebScheme()` of its document. The
companion reports the first scheme and domain and the number of distinct ones. The host accepts a
WebView when the screen shows exactly one domain, the scheme is `https`, and the item binds
`https://<domain>` (`checkWebBinding`, host match by default). The app itself need not be bound
(owner decision: one item serves the site and the apps that embed it). The domain is reported from
the app's own process, so any app can claim any domain (SECURITY 22). Passkeys are not offered to
WebViews.

## 5. Credential Manager password sign-in (D2)

Apps that call Credential Manager with `GetPasswordOption` instead of relying on autofill: while
armed as `password`, the provider (`PasskeyProvider`, capability `TYPE_PASSWORD_CREDENTIAL`) offers
one `PasswordCredentialEntry` "blindfill: <item>"; picking it starts `PasswordActivity`, which reports
the caller (package and signer from `CallingAppInfo`, `cm: true`) and returns a `PasswordCredential`.
The host applies the app binding (no form shape to check). A privileged caller (a browser passing an
origin) is reported as `web` without a domain and refused. One arm serves whichever comes first:
autofill or Credential Manager.

## 6. Owner decisions (Mics)

- **D1** (2026-11-27): package-only binding like Bitwarden; a signer pin, when present, is checked.
- **D2** (2026-11-27): Credential Manager password sign-in built now.
- **D3** (2026-11-27): WebViews bound by the domain alone.

## 7. Not covered

- Android user / work profile (olliepm's `--user`): the companion answers for the user it runs as;
  not tested with a second profile.
- Asset Links (`assetlinks.json`) checks.
- Apps that block autofill (`importantForAutofill=no`, custom views): refused by absence; there is
  no scrcpy fallback.
- Frames of another domain inside a WebView (refused: more than one domain), OTP fields in apps.
