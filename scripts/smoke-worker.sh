#!/usr/bin/env bash

# e - the script will exit and run the trap if a command fails
# u - prevent accessing variables that don't exist
# o - if any side of a `|` fails, then the whole thing fails
set -euo pipefail

usage() {
    printf 'Usage: %s [assets|auth|two-factor-settings|two-factor-d1]\n' "$0" >&2
    exit 2
}
# Accept at most one positional argument. Show usage if the count ($#) is higher.
(($# <= 1)) || usage
# Only read $1 when it exists, since set -u rejects unset arguments.
# Ensure the arg is within the white-list
# No arg is okay, just run ALL suites
if (($# == 1)); then
    case "$1" in
    assets | auth | two-factor-settings | two-factor-d1) ;;
    *) usage ;;
    esac
fi
# Default to an empty selector so Compose runs all suites when no argument is given.
export WORKER_SMOKE_SUITE="${1:-}"

cd "$(dirname "$0")/.."

compose=(docker compose -f compose.smoke.yml -p "superstamps-smoke-$$")
cleanup() {
    "${compose[@]}" down --volumes >/dev/null 2>&1 || return 1
}
trap cleanup EXIT
"${compose[@]}" up --build --abort-on-container-exit --exit-code-from smoke
