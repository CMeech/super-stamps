import type { TestHarness } from 'wrangler';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { createClient } from '@libsql/client/http';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

const base = 'http://127.0.0.1:8787';
// Disposable sqld lets the built Worker use the same libSQL HTTP driver it uses with Turso.
const databaseUrl = 'http://database:8080';
const databaseToken = randomUUID();
const secret = randomUUID();
const account = {
  name: `Smoke ${randomUUID()}`,
  email: `smoke-${randomUUID()}@example.test`,
  password: `Smoke-${randomUUID()}`
};
const wrongPassword = randomUUID();
const queryMarker = randomUUID();
const headerMarker = randomUUID();
const credentialMarkers = new Set([
  ...Object.values(account),
  databaseToken,
  secret,
  wrongPassword,
  queryMarker,
  headerMarker
]);
const cookies = new Map<string, string>();
const database = createClient({ url: databaseUrl, authToken: databaseToken });
let harness: TestHarness | undefined;
let buildOutput = '';
let stage = 'prepare the isolated environment';

function check(condition: unknown): asserts condition {
  expect(Boolean(condition), `Worker check failed during the step to ${stage}.`).toBe(true);
}

async function waitFor(probe: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const result = await probe();
      if (result) return result;
    } catch {
      // The local service may still be starting.
    }
    await delay(1000);
  }
  throw new Error('Smoke service did not become ready');
}

function run(args: string[], env: NodeJS.ProcessEnv, capture: (chunk: string) => void) {
  const child = spawn('pnpm', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', capture);
  child.stderr.setEncoding('utf8').on('data', capture);
  const done = new Promise((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  return { child, done };
}

function cookieHeader() {
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

async function request(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams } = {},
  cookie = cookieHeader(),
  storeCookies = true
) {
  check(harness);
  const headers = new Headers(options.headers);
  headers.set('Origin', base);
  if (cookie) headers.set('Cookie', cookie);
  const response = await harness.fetch(new URL(path, base), {
    ...options,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(5000)
  });

  if (storeCookies) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';', 1);
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) {
        credentialMarkers.add(value);
        cookies.set(name, value);
      } else {
        cookies.delete(name);
      }
    }
  }
  return response;
}

function authRequest(
  path: string,
  body: typeof account | Pick<typeof account, 'email' | 'password'>,
  headers?: Record<string, string>
) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

function checkPrivateRedirect(response: Awaited<ReturnType<typeof request>>) {
  const destination = response.headers.get('location');
  check(response.status === 303 && destination === '/login');
}

beforeAll(async () => {
  const exampleEnv = await readFile('.env.example', 'utf8');
  const env = {
    ...parseEnv(exampleEnv),
    PUBLIC_BASE_URL: base,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: secret,
    DATABASE_URL: databaseUrl,
    DATABASE_AUTH_TOKEN: databaseToken
  };
  stage = 'apply Drizzle migrations to local libSQL';
  await waitFor(() => database.execute('select 1'));
  const migrationDb = drizzle(database);
  await migrate(migrationDb, { migrationsFolder: 'src/lib/db/migrations' });

  stage = 'build the Cloudflare Worker';
  const build = run(['build'], { ...process.env, ...env }, (chunk) => {
    buildOutput += chunk;
  });
  const buildExitCode = await build.done;
  check(buildExitCode === 0);

  stage = 'start the built Worker';
  harness = createTestHarness({
    workers: [{ configPath: './wrangler.jsonc', secrets: env }]
  });
  await harness.listen();
}, 120_000);

it('serves a known asset through the Worker ASSETS binding', async () => {
  check(harness);
  const { ASSETS } = await harness.getWorker<{ ASSETS: { fetch: typeof fetch } }>().getEnv();
  const response = await ASSETS.fetch(new URL('/robots.txt', base).href);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('User-agent: *');
});

it('renders sign-in HTML and persists and revokes database-backed sessions', async () => {
  stage = 'verify server-rendered sign-in HTML';
  const loginPage = await request('/login');
  check(loginPage.status === 200);
  const loginHtml = await loginPage.text();
  const hasSignInForm = /<form\b/.test(loginHtml) && loginHtml.includes('Sign in');
  check(hasSignInForm && !loginHtml.includes(secret));

  stage = 'seed the synthetic account through Better Auth';
  const signup = await authRequest('/api/auth/sign-up/email', account);
  check(signup.ok);
  const seedSession = (await signup.json()) as { token?: unknown };
  check(typeof seedSession.token === 'string' && seedSession.token.length > 0);
  credentialMarkers.add(seedSession.token);
  const logout = () =>
    request('/logout', {
      method: 'POST',
      body: new URLSearchParams({ redirectTo: '/login' })
    });
  const seedLogout = await logout();
  check(seedLogout.status === 303);
  const dashboardAfterSeedLogout = await request('/dashboard');
  checkPrivateRedirect(dashboardAfterSeedLogout);

  stage = 'exercise a controlled authentication rejection';
  const rejected = await authRequest(
    `/api/auth/sign-in/email?smoke=${queryMarker}`,
    { email: account.email, password: wrongPassword },
    { 'X-Smoke-Marker': headerMarker }
  );
  check(rejected.status === 401);

  stage = 'verify sign-in and database-backed session persistence';
  const signIn = await authRequest('/api/auth/sign-in/email', {
    email: account.email,
    password: account.password
  });
  check(signIn.ok);
  const signedInCookie = cookieHeader();
  check(signedInCookie.length > 0);
  const sessions = await database.execute('select token from session');
  check(sessions.rows.length === 1 && typeof sessions.rows[0].token === 'string');
  const token = sessions.rows[0].token;
  credentialMarkers.add(token);
  const sessionCookie = [...cookies].find(([, value]) => decodeURIComponent(value).startsWith(`${token}.`));
  check(sessionCookie);
  const firstDashboardVisit = await request('/dashboard');
  check(firstDashboardVisit.status === 200);
  const secondDashboardVisit = await request('/dashboard');
  check(secondDashboardVisit.status === 200);

  stage = 'verify sign-out and rejection of the original session cookie';
  const signOut = await logout();
  check(signOut.status === 303);
  const [sessionCookieName] = sessionCookie;
  check(!cookies.has(sessionCookieName));

  const dashboardWithoutCookie = await request('/dashboard', {}, '', false);
  checkPrivateRedirect(dashboardWithoutCookie);
  const dashboardWithOriginalCookie = await request('/dashboard', {}, signedInCookie, false);
  checkPrivateRedirect(dashboardWithOriginalCookie);

  const sessionsAfterSignOut = await database.execute('select token from session');
  check(sessionsAfterSignOut.rows.length === 0);
}, 30_000);

afterAll(async () => {
  try {
    const workerOutput = JSON.stringify(harness?.getLogs() ?? []);
    const libsqlOutput = await readFile('/diagnostics/libsql.log', 'utf8');
    const diagnosticStreams = [
      ['build', buildOutput],
      ['workerd and application', workerOutput],
      ['local libSQL', libsqlOutput]
    ];

    for (const [stream, output] of diagnosticStreams) {
      const containsSyntheticMarker = [...credentialMarkers].some((marker) => {
        const encodedMarker = encodeURIComponent(marker);
        return output.includes(marker) || output.includes(encodedMarker);
      });
      expect(containsSyntheticMarker, `Synthetic PII or credential marker in ${stream} output`).toBe(false);
    }
    expect(libsqlOutput.trim().length > 0, 'Expected local libSQL diagnostics').toBe(true);
    expect(workerOutput.includes('Invalid password'), 'Expected the invalid-password warning').toBe(true);
  } finally {
    database.close();
    await harness?.close();
  }
});
