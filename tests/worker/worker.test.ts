import type { WorkerSmoke } from './worker-smoke.ts';
import type { TestHarness } from 'wrangler';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { createTestHarness } from 'wrangler';

import { registerAssets } from './assets.ts';
import { registerAuth } from './auth.ts';
import { registerTwoFactorD1 } from './two-factor-d1.ts';
import { registerTwoFactorSettings } from './two-factor-settings.ts';

const suites = {
  assets: registerAssets,
  auth: registerAuth,
  'two-factor-settings': registerTwoFactorSettings,
  'two-factor-d1': registerTwoFactorD1
};

const selection = process.env.WORKER_SMOKE_SUITE;
if (selection && !Object.hasOwn(suites, selection)) {
  throw new Error(`Valid Worker smoke suites: ${Object.keys(suites).join(', ')}`);
}
const selectedSuites = Object.entries(suites).filter(([name]) => !selection || name === selection);

const base = 'http://127.0.0.1:8787';
const secret = randomUUID();
const credentialMarkers = new Set([secret]);
let database: D1Database;
let harness: TestHarness | undefined;
let buildProcess: ReturnType<typeof spawn> | undefined;
let buildOutput = '';
let setupComplete = false;
let closing = false;

const smoke: WorkerSmoke = {
  base,
  secret,
  credentialMarkers,
  stage: 'prepare the isolated environment',
  get harness() {
    check(harness);
    return harness;
  },
  get database() {
    return database;
  },
  check
};

function check(condition: unknown): asserts condition {
  expect(Boolean(condition), `Worker check failed during the step to ${smoke.stage}.`).toBe(true);
}

async function buildWorker(env: NodeJS.ProcessEnv) {
  const child = spawn('pnpm', ['build'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  buildProcess = child;
  const capture = (chunk: string) => {
    buildOutput += chunk;
  };
  child.stdout.setEncoding('utf8').on('data', capture);
  child.stderr.setEncoding('utf8').on('data', capture);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  buildProcess = undefined;
  return exitCode;
}

beforeAll(async () => {
  const exampleEnv = await readFile('.env.example', 'utf8');
  if (closing) return;
  const env = {
    ...parseEnv(exampleEnv),
    PUBLIC_BASE_URL: base,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: secret
  };

  smoke.stage = 'build the Cloudflare Worker';
  const buildExitCode = await buildWorker({ ...process.env, ...env });
  if (closing) return;
  check(buildExitCode === 0);

  smoke.stage = 'start the built Worker';
  harness = createTestHarness({
    workers: [{ configPath: './wrangler.jsonc', secrets: env }]
  });
  await harness.listen();
  if (closing) return;

  smoke.stage = 'apply checked-in migrations to the isolated D1 binding';
  const worker = harness.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations('DB');
  ({ DB: database } = await worker.getEnv());
  setupComplete = true;
}, 120_000);

for (const [name, register] of selectedSuites) {
  describe(name, () => register(smoke));
}

afterAll(async () => {
  closing = true;
  buildProcess?.kill();
  try {
    const workerOutput = JSON.stringify(harness?.getLogs() ?? []);
    const diagnosticStreams = [
      ['build', buildOutput],
      ['workerd and application', workerOutput]
    ];

    const leakingStreams = diagnosticStreams.filter(([, output]) =>
      [...credentialMarkers].some((marker) => {
        const encodedMarker = encodeURIComponent(marker);
        return output.includes(marker) || output.includes(encodedMarker);
      })
    );
    expect(
      leakingStreams.map(([stream]) => stream),
      'Synthetic PII or credential markers in diagnostic output'
    ).toEqual([]);
    if (setupComplete && selectedSuites.some(([name]) => name === 'auth')) {
      expect(workerOutput.includes('Invalid password'), 'Expected the invalid-password warning').toBe(true);
    }
  } finally {
    await harness?.close();
  }
});
