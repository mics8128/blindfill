#!/usr/bin/env bash
# Build the release companion APK, check it is signed by exactly the pinned certificate
# (COMPANION_SIGNER in src/actuators/android/index.ts) and copy it to dist/android/.
# Needs BLINDFILL_KEYSTORE (PKCS12 path) and BLINDFILL_KEYSTORE_PASSWORD, ANDROID_HOME, JDK 17+.
set -euo pipefail
cd "$(dirname "$0")"
: "${BLINDFILL_KEYSTORE:?set BLINDFILL_KEYSTORE}" "${BLINDFILL_KEYSTORE_PASSWORD:?set BLINDFILL_KEYSTORE_PASSWORD}"
./gradlew --no-daemon -q :companion:assembleRelease
apk=companion/build/outputs/apk/release/companion-release.apk
want=$(sed -nE "s/^export const COMPANION_SIGNER = '([0-9A-F]{64})';$/\1/p" ../src/actuators/android/index.ts)
apksigner="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner"
certs=$("$apksigner" verify --print-certs "$apk")
# "Signer #1 certificate SHA-256 digest:" (build-tools <= 36) or "V2 Signer: certificate SHA-256 digest:" (37+);
# every signer line of every scheme must carry the one pinned certificate
got=$(sed -nE 's/^.*Signer.*certificate SHA-256 digest: ([0-9a-f]{64})$/\1/p' <<<"$certs" | tr a-f A-F | sort -u)
if [ -z "$want" ] || [ "$got" != "$want" ]; then
  printf '%s\n' "$apksigner:" "$certs" >&2 # certificate digests are public
  echo "companion APK signer ${got:-none} is not the pinned ${want:-?}" >&2
  exit 1
fi
mkdir -p ../dist/android
cp "$apk" ../dist/android/blindfill-companion.apk
echo "dist/android/blindfill-companion.apk signer $got"
