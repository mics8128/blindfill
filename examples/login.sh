#!/usr/bin/env bash
# Sign in to a site without the password ever reaching this script's output.
set -euo pipefail
blindfill session start --headless
blindfill fill --item "$1" --url "$2" --submit --expect-url "${3:-/}" --fail-selector '[role=alert]'
blindfill session stop
