#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

smoke_dir=$(mktemp -d)
wrangler_pid=
cleanup() {
  if [[ -n "$wrangler_pid" ]]; then
    kill "$wrangler_pid" 2>/dev/null || true
    wait "$wrangler_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

export PUBLIC_BASE_URL=http://localhost:8787
export BETTER_AUTH_URL="$PUBLIC_BASE_URL"
export DATABASE_URL=https://database.example.invalid
export BETTER_AUTH_SECRET=superstamps-local-runtime-verification-only

sed -e "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$PUBLIC_BASE_URL|" \
    -e "s|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=$BETTER_AUTH_URL|" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" \
    -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET|" \
    .env.example > "$smoke_dir/worker.env"

node --input-type=module - "$smoke_dir/worker.env" <<'JS'
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const env = { ...process.env, ...parseEnv(readFileSync(process.argv[2], 'utf8')) };
const build = spawnSync('pnpm', ['build'], { env, stdio: 'inherit' });
if (build.error) throw build.error;
process.exitCode = build.status ?? 1;
JS
pnpm exec wrangler dev --local --env-file "$smoke_dir/worker.env" --ip 127.0.0.1 --port 8787 \
  > "$smoke_dir/wrangler.log" 2>&1 &
wrangler_pid=$!

node --input-type=module <<'JS' || { cat "$smoke_dir/wrangler.log"; exit 1; }
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

let response;
for (let attempt = 0; attempt < 30; attempt++) {
  response = await fetch('http://127.0.0.1:8787/login', {
    signal: AbortSignal.timeout(1000)
  }).catch(() => null);
  if (response) break;
  await setTimeout(1000);
}

assert.equal(response?.status, 200);
const html = await response.text();
assert.match(html, /<form\b/);
assert.match(html, /Sign in/);
assert.ok(!html.includes(process.env.BETTER_AUTH_SECRET));
console.log('Local Worker rendered the sign-in form.');
JS
