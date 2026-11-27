# blindfill Android companion

`companion/` is the companion APK (`io.github.mics8128.blindfill`): an autofill service for
passwords (login and sign-up forms, in apps and their WebViews) and a credential provider for
passwords and passkeys (Android 14+). `testrp/` is a fake relying-party app used only by
`tests/android-device.test.ts` (login, sign-up and WebView screens; its WebView page is served
locally for `https://blindfill-test.invalid/`). How it works: `docs/ARCHITECTURE.md` §3.2; trust and
its limits: `SECURITY.md` items 16 and 21–23.

## Install (users)

Published npm packages ship the release APK at `dist/android/blindfill-companion.apk`, built from
the same `package.json` version as the host. With the phone (or emulator) attached over adb:

```sh
blindfill android install --serial <adb serial>                 # adb install -r, after checking the APK's signer
blindfill android install --serial <adb serial> --set-services  # also make it the autofill + credential provider
```

`--set-services` prints the previous values of `autofill_service`, `credential_service` and
`credential_service_primary` and the exact `adb shell settings …` commands that restore them;
`uninstall` is printed too. The install command is CLI-only on purpose (no MCP tool): installing
an app and switching a phone's autofill provider is a device-level change a person should start.

Before every `android fill|register|passkey|passkey-register` the host reads the installed APK back from the phone
(`pm path` + `adb exec-out cat`), parses its APK Signing Block and refuses (`status: refused`,
nothing armed, no secret read) unless its only signer is the release certificate:

```
SHA-256 C7EDE55AB64522DC9BC142F8F20B9BAABE5341D828210183D991157FE0EC45C8
```

## Build (developers)

Requirements: JDK 17+ (tested with 21), Android SDK with `ANDROID_HOME` set (platform 36; Gradle
fetches missing build tools).

```sh
cd android
./gradlew assembleDebug     # companion + testrp, signed with your local debug key
```

A debug companion has a different signer, so point the host at it explicitly:

```sh
export BLINDFILL_COMPANION_APK=$PWD/companion/build/outputs/apk/debug/companion-debug.apk
export BLINDFILL_COMPANION_SIGNER=<SHA-256 of your debug certificate>   # apksigner verify --print-certs
```

Release build (owner only; the key never leaves `~/.config/blindfill/` and the GitHub secrets):

```sh
BLINDFILL_KEYSTORE=~/.config/blindfill/android-release.p12 \
BLINDFILL_KEYSTORE_PASSWORD="$(cat ~/.config/blindfill/android-release.pass)" \
  android/release-apk.sh    # -> dist/android/blindfill-companion.apk, signer checked with apksigner
```

Without `BLINDFILL_KEYSTORE`, `assembleRelease` produces an unsigned APK and debug builds are
unaffected. CI (`.github/workflows/ci.yml`, job `android`) builds and checks the signed APK on
every push and uploads it as the `blindfill-companion-apk` artifact; `release.yml` puts it into
the npm package. Key custody: `SECURITY.md` item 16.

## Device test

```sh
BLINDFILL_TEST_ANDROID_SERIAL=<serial> BLINDFILL_COMPANION_APK=$PWD/dist/android/blindfill-companion.apk \
  npx vitest run tests/android-device.test.ts
```

It installs both apps, switches the providers for the run, restores the settings exactly and
uninstalls both apps (`BLINDFILL_ANDROID_KEEP=1` keeps them). Fake data only. A headless
emulator works (Apple Silicon, no root):

```sh
sdkmanager emulator "system-images;android-36;google_apis;arm64-v8a"
avdmanager create avd -n blindfill-api36 -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_7
emulator -avd blindfill-api36 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect
```
