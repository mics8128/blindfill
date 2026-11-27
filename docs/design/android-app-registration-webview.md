# Android: app sign-up and WebView logins through the companion

Status: design (2026-11-27), not built. Owner decision (Mics, 2026-11-27): the phone path replaces
olliepm's scrcpy control completely and goes through the companion APK. This page covers the two
gaps left in [MIGRATING-FROM-OLLIEPM.md](../MIGRATING-FROM-OLLIEPM.md) §3 row 12: **mobile
registration** and **WebView logins**. Android passkey registration is already built (Phase 4,
ARCHITECTURE §3.2).

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
signer (PackageManager), and the fields (AutofillId, autofill hints, input type), so no XPath, scrcpy,
focus or geometry checks and no typing. The value goes only into an autofill Dataset.

## 2. App sign-up (password registration)

Two steps, as on the web (`item generate`, then `register`): the vault holds the password before any
app sees it, so a crash between the steps never leaves an account whose password is not in the
vault.

1. **Item.** Either an existing item that has opted in (`blindfill.registration=allow`) and binds the
   app (`androidapp://<pkg>` + `blindfill.signers`), or a new one:
   `blindfill item generate <name> --android <pkg> --serial <s> --username <u> [--origin https://…]
[--length n] [--policy-file f]`. The host reads the signer of the installed package itself, as it
   does for the companion (`pm path` + `adb exec-out cat`, `apkSigners`), and writes it as
   `blindfill.signers`; it prints the package, signer and installer so a person can compare them
   (decision D1). The password is generated on the host (CSPRNG, item policy) and never printed.
2. **Fill.** `blindfill android register --item <id> --serial <s>` (MCP `android_register`) arms
   kind `password-new`. The companion's FillService, while armed for it, accepts a screen with one
   or two password fields where the screen looks like sign-up (a `newPassword` autofill hint, or two
   password fields), reports package, signer and the field counts, and the host checks the binding
   and the sign-up shape before reading the password. The Dataset fills the username field (if
   found) and the same password into both password fields. More than two password fields, a
   `web` screen that fails §3, or a one-password screen without a new-password hint: refused,
   nothing read.
3. **Submit.** Not done by blindfill (as `android fill`): the agent taps the app's button; the
   outcome is unknown unless the caller checks the app. One arm answers one fill; no retry. If the
   app rejects the password (its own policy), the item keeps a password the account does not have:
   the result says so and the next try uses a new item or `item generate`'s policy file.

The companion never saves (`onSaveRequest` stays a no-op): the vault is written only from the host.
Credential Manager has no "fill a sign-up form" call (`CreatePasswordRequest` is an app saving a
password the user typed), so sign-up goes through autofill. Credential Manager password sign-in
(`GetPasswordOption`, for apps that use it instead of autofill) is a separate, optional addition
(D2).

## 3. WebView logins (and WebView sign-up)

Android autofill covers WebViews: each `ViewNode` inside a WebView carries `getWebDomain()` and
`getWebScheme()` of its document (API 28+). Today the companion reports `web: true` and the host
refuses. New rule: a WebView inside a **bound app** is accepted when

- the app passes the usual check (package + signer pinned by the item), and
- every web node on the screen reports the same scheme and domain, the scheme is `https`, and the item
  also binds `https://<domain>` (`checkWebBinding`, host match by default, as for web pages).

The domain comes from the app's own process (WebView runs there), so it is only as trustworthy as
the app, which is why the app pin is required as well (D3). Browsers stay out: the item must name the
app, and browsers use the web actuator. Frames of other domains (a sign-in iframe inside the
WebView): refused in this version.

## 4. Changes

| Where                    | Change                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FillService.java`       | arm modes `password` and `password-new`; collect webScheme/webDomain per node; fill one value into up to two password fields                                                                                                                 |
| `ArmReceiver.java`       | accept `password-new`                                                                                                                                                                                                                        |
| `src/actuators/android/` | `PhoneRequest.webScheme`, `webDomain`, `webDomains` (count of distinct); `readSigner(serial, pkg)` from the existing APK reader                                                                                                              |
| `src/engine.ts`          | `androidOffer` accepts bound WebViews; new `androidRegister`; `itemGenerate` takes `android: {pkg, serial}`                                                                                                                                  |
| CLI / MCP                | `android register`, `item generate --android --serial`; MCP `android_register` (MCP `item_generate` gets the same fields)                                                                                                                    |
| `android/testrp`         | a sign-up screen (password + confirm, `newPassword` hints) and a WebView screen with a login form loaded through `WebViewAssetLoader` (`https://appassets.androidplatform.net/…`, no network)                                                |
| Tests                    | mock (`tests/android.test.ts`): sign-up fill, refusals (no opt-in, one password without hint, three passwords, unbound domain, mixed domains, http); device (`tests/android-device.test.ts`): native sign-up, WebView login, WebView sign-up |
| Docs                     | SECURITY (new item: agent fills generated passwords into app sign-up forms; WebView trust), ARCHITECTURE §3.2, README + 4 translations, MIGRATING row 12, TESTED                                                                             |

Acceptance as in Phase 4: emulator (Android 16) and Xperia 5 II (Android 17), fake app and fake data
only, autofill and credential-provider settings recorded and restored, apps uninstalled.

## 5. Not covered

- Android user / work profile (olliepm's `--user`): the companion answers for the user it runs as;
  not tested with a second profile.
- Asset Links (`assetlinks.json`) checks: the item's signer pin replaces them.
- Typing into apps that block autofill (`importantForAutofill=no`, custom views): refused by
  absence; there is no scrcpy fallback.
- OTP fields in apps.

## 6. Decisions needed (Mics)

- **D1** Signer pin for a new app item. (a) `item generate --android` pins the signer the host reads
  from the installed APK (trust on first use of what is installed; printed for comparison).
  (b) A person pins it at a terminal (`item edit --set blindfill.signers=…`). Recommendation: (a);
  the item is new and holds only the password just generated for this sign-up, and the companion check
  already works this way.
- **D2** Credential Manager password sign-in (`GetPasswordOption`) for apps that skip autofill: build
  now or later. Recommendation: later, only if a real app needs it.
- **D3** WebView trust: require both the app pin and the https domain (recommendation), or the domain
  alone.
