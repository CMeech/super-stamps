#!/usr/bin/env bash

# e - the script will exit and run the trap if a command fails
# u - prevent accessing variables that don't exist
# o - if any side of a `|` fails, then the whole thing fails
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose -f compose.smoke.yml -p "superstamps-smoke-$$")
cleanup() {
    "${compose[@]}" down --volumes >/dev/null 2>&1 || return 1
}
trap cleanup EXIT
"${compose[@]}" up --build --abort-on-container-exit --exit-code-from smoke
