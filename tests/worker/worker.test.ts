import type { TestHarness } from 'wrangler';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import * as schema from '#models';
import {
  confirmPendingTwoFactor,
  deleteEnabledTwoFactor,
  replacePendingTwoFactor,
  replaceRecoveryCodes
} from '#queries/two-factor.ts';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

const base = 'http://127.0.0.1:8787';
const secret = randomUUID();
const account = {
  name: `Smoke ${randomUUID()}`,
  email: `smoke-${randomUUID()}@example.invalid`,
  password: `Smoke-${randomUUID()}`
};
const wrongPassword = randomUUID();
const queryMarker = randomUUID();
const headerMarker = randomUUID();
const credentialMarkers = new Set([...Object.values(account), secret, wrongPassword, queryMarker, headerMarker]);
const cookies = new Map<string, string>();
let database: D1Database;
let harness: TestHarness | undefined;
let buildOutput = '';
let stage = 'prepare the isolated environment';

function check(condition: unknown): asserts condition {
  expect(Boolean(condition), `Worker check failed during the step to ${stage}.`).toBe(true);
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

const securityPath = '/settings/security';

async function securityRemote(id: string, body?: URLSearchParams) {
  const response = await request(`/_app/remote/${id}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-sveltekit-pathname': securityPath, 'x-sveltekit-search': '' },
    body
  });
  check(response.ok);
  const result = (await response.json().catch(() => null)) as {
    type?: string;
    data?: string;
  } | null;
  check(result);
  return result;
}

function readRemoteValues(result: Awaited<ReturnType<typeof securityRemote>>): unknown[] {
  check(result.type === 'result' && typeof result.data === 'string');
  // SvelteKit flattens remote results into a table. The values we inspect are string literals in that table.
  const values: unknown = JSON.parse(result.data);
  check(Array.isArray(values));
  return values;
}

function readRecoveryCodes(result: Awaited<ReturnType<typeof securityRemote>>) {
  const codes = readRemoteValues(result).filter(
    (value): value is string => typeof value === 'string' && /^[a-z0-9]{5}-[a-z0-9]{5}$/i.test(value)
  );
  for (const code of codes) credentialMarkers.add(code);
  check(codes.length === 8 && new Set(codes).size === 8);
  return codes;
}

beforeAll(async () => {
  const exampleEnv = await readFile('.env.example', 'utf8');
  const env = {
    ...parseEnv(exampleEnv),
    PUBLIC_BASE_URL: base,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: secret
  };

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

  stage = 'apply checked-in migrations to the isolated D1 binding';
  const worker = harness.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations('DB');
  ({ DB: database } = await worker.getEnv());
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
  const loginAction = loginHtml.match(/<form\b[^>]*\baction="([^"]*\/remote=[^"]+)"/)?.[1];
  const emailField = loginHtml.match(/\bname="(email\/[^"]+)"/)?.[1];
  const passwordField = loginHtml.match(/\bname="(_password\/[^"]+)"/)?.[1];
  const nextField = loginHtml.match(/\bname="(next\/[^"]+)"/)?.[1];
  check(loginAction && emailField && passwordField && nextField && loginHtml.includes('Sign in'));
  check(!loginHtml.includes(secret));

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

  stage = 'verify remote form sign-in and database-backed session persistence';
  const signIn = await request(`/login${loginAction}`, {
    method: 'POST',
    headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      [emailField]: account.email,
      [passwordField]: account.password,
      [nextField]: '/dashboard'
    })
  });
  check(signIn.status === 303 && signIn.headers.get('location') === '/dashboard');
  const signedInCookie = cookieHeader();
  check(signedInCookie.length > 0);
  const sessions = await database.prepare('select token from session').all<{ token: string }>();
  check(sessions.results.length === 1 && typeof sessions.results[0].token === 'string');
  const token = sessions.results[0].token;
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

  const sessionsAfterSignOut = await database.prepare('select token from session').all<{ token: string }>();
  check(sessionsAfterSignOut.results.length === 0);
}, 30_000);

it('lets a signed-in user enroll in two-factor authentication, replace recovery codes, and disable it', async () => {
  stage = 'sign up a separate synthetic account for two-factor settings';
  const mfaAccount = {
    name: `Smoke MFA ${randomUUID()}`,
    email: `mfa-${randomUUID()}@example.invalid`,
    password: `Smoke-${randomUUID()}`
  };
  for (const marker of Object.values(mfaAccount)) credentialMarkers.add(marker);
  cookies.clear();
  const signup = await authRequest('/api/auth/sign-up/email', mfaAccount);
  check(signup.ok);
  const seeded = (await signup.json()) as { token?: string; user?: { id: string } };
  check(seeded.token && seeded.user?.id);
  credentialMarkers.add(seeded.token);
  const userId = seeded.user.id;
  const db = drizzle(database, { schema, casing: 'snake_case' });
  const { Session, TwoFactor, User } = schema;
  const readEnrollment = async () => {
    const [enrollment] = await db
      .select({ verified: TwoFactor.verified })
      .from(TwoFactor)
      .where(eq(TwoFactor.userId, userId));
    return enrollment;
  };
  const readStatus = async () => {
    const [status] = await db
      .select({ enabled: User.twoFactorEnabled, completedAt: Session.twoFactorCompletedAt })
      .from(User)
      .innerJoin(Session, eq(Session.userId, User.id))
      .where(eq(User.id, userId));
    return status;
  };

  stage = 'complete the password challenge for security settings';
  const guarded = await request(securityPath);
  const challengePath = guarded.headers.get('location');
  check(guarded.status === 303 && challengePath && challengePath.startsWith('/auth/challenge?'));
  const challengePage = await request(challengePath);
  check(challengePage.ok);
  const challengeHtml = await challengePage.text();
  const challengeAction = challengeHtml.match(/<form\b[^>]*\baction="([^"]*\/remote=[^"]+)"/)?.[1];
  const passwordField = challengeHtml.match(/\bname="(_password\/[^"]+)"/)?.[1];
  const nextField = challengeHtml.match(/\bname="(next\/[^"]+)"/)?.[1];
  check(challengeAction && passwordField && nextField);
  const challenge = await request(`/auth/challenge${challengeAction.replaceAll('&amp;', '&')}`, {
    method: 'POST',
    headers: { Accept: 'text/html' },
    body: new URLSearchParams({ [passwordField]: mfaAccount.password, [nextField]: securityPath })
  });
  check(challenge.status === 303 && challenge.headers.get('location') === securityPath);

  stage = 'start enrollment without enabling two-factor authentication';
  const settings = await request(securityPath);
  check(settings.ok);
  const settingsHtml = await settings.text();
  const remoteModule = settingsHtml.match(/\/remote=([^/"%]+)(?:\/|%2F)startTwoFactorSetup/)?.[1];
  check(remoteModule && settingsHtml.includes('Enable 2FA'));
  const setup = await securityRemote(`${remoteModule}/startTwoFactorSetup`, new URLSearchParams());
  const key = readRemoteValues(setup).find((value) => typeof value === 'string' && /^[A-Z2-7]{52}$/i.test(value));
  check(typeof key === 'string');
  credentialMarkers.add(key);
  check((await readEnrollment())?.verified === false && (await readStatus())?.enabled === false);

  stage = 'confirm enrollment using a code generated from the displayed setup key';
  const code = await createOTP(new TextDecoder().decode(base32.decode(key))).totp();
  credentialMarkers.add(code);
  const confirm = await securityRemote(
    `${remoteModule}/confirmTwoFactorSetup`,
    new URLSearchParams({ [`_code/${remoteModule}/confirmTwoFactorSetup`]: code })
  );
  check(readRemoteValues(confirm).includes(securityPath));
  const enabled = await readStatus();
  check(
    (await readEnrollment())?.verified === true && enabled?.enabled === true && enabled.completedAt instanceof Date
  );

  stage = 'regenerate recovery codes and verify the replacement is persisted';
  const recoveryPath = `${remoteModule}/getTwoFactorRecoveryCodes`;
  const original = readRecoveryCodes(await securityRemote(recoveryPath));
  const replacement = readRecoveryCodes(
    await securityRemote(`${remoteModule}/regenerateTwoFactorRecoveryCodes`, new URLSearchParams())
  );
  const persisted = readRecoveryCodes(await securityRemote(recoveryPath));
  check(replacement.every((value) => !original.includes(value)));
  check(persisted.every((value, index) => value === replacement[index]));

  stage = 'disable two-factor authentication and clear the enrollment and session marker';
  const disable = await securityRemote(`${remoteModule}/disableTwoFactor`, new URLSearchParams());
  check(readRemoteValues(disable).includes(securityPath));
  const disabled = await readStatus();
  check(!(await readEnrollment()) && disabled?.enabled === false && disabled.completedAt === null);
  const disabledSettings = await request(securityPath);
  check(disabledSettings.ok && (await disabledSettings.text()).includes('Enable 2FA'));
}, 30_000);

it('rejects stale two-factor mutations and rolls back a failed confirmation', async () => {
  const db = drizzle(database, { schema, casing: 'snake_case' });
  const { Session, TwoFactor, User } = schema;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);
  const userId = randomUUID();
  const token = randomUUID();
  const otherToken = randomUUID();

  await db.batch([
    db.insert(User).values({ id: userId, email: `${userId}@example.invalid`, name: 'Two-factor test' }),
    db.insert(Session).values([
      { userId, token, createdAt: now, updatedAt: now, expiresAt },
      { userId, token: otherToken, createdAt: now, updatedAt: now, expiresAt }
    ])
  ]);

  const readEnrollment = async () => {
    const [enrollment] = await db.select().from(TwoFactor).where(eq(TwoFactor.userId, userId));
    expect(enrollment).toBeDefined();
    return enrollment;
  };
  const readEnabled = async () => {
    const [user] = await db.select({ enabled: User.twoFactorEnabled }).from(User).where(eq(User.id, userId));
    return user.enabled;
  };
  const readSession = async (sessionToken: string) => {
    const [session] = await db.select().from(Session).where(eq(Session.token, sessionToken));
    return session.twoFactorCompletedAt;
  };

  expect(await replacePendingTwoFactor(db, userId, 'first-secret', 'first-codes')).toBe(true);
  const stale = await readEnrollment();
  expect(await replacePendingTwoFactor(db, userId, 'second-secret', 'second-codes')).toBe(true);
  const pending = await readEnrollment();
  expect(await confirmPendingTwoFactor(db, stale, token, now)).toBe(false);
  expect(await readEnrollment()).toEqual(pending);
  expect(await readEnabled()).toBe(false);
  expect(await readSession(token)).toBeNull();

  await database.exec(
    "CREATE TRIGGER reject_2fa_confirmation BEFORE UPDATE OF two_factor_completed_at ON session BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;"
  );
  try {
    await expect(confirmPendingTwoFactor(db, pending, token, now)).rejects.toThrow();
  } finally {
    await database.exec('DROP TRIGGER reject_2fa_confirmation');
  }
  expect(await readEnrollment()).toEqual(pending);
  expect(await readEnabled()).toBe(false);
  expect(await readSession(token)).toBeNull();

  const outcomes = await Promise.all([
    confirmPendingTwoFactor(db, pending, token, now),
    confirmPendingTwoFactor(db, pending, otherToken, now)
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(await readSession(outcomes[0] ? token : otherToken)).toBeInstanceOf(Date);
  expect(await readSession(outcomes[0] ? otherToken : token)).toBeNull();
  expect(await readEnabled()).toBe(true);

  expect(await replacePendingTwoFactor(db, userId, 'stale-secret', 'stale-codes')).toBe(false);
  expect(await deleteEnabledTwoFactor(db, stale, token, now)).toBe(false);
  const enabled = await readEnrollment();
  expect(enabled).toMatchObject({ id: pending.id, verified: true });
  expect(await replaceRecoveryCodes(db, enabled, 'new-codes')).toBe(true);
  expect(await replaceRecoveryCodes(db, enabled, 'stale-codes')).toBe(false);
  expect((await readEnrollment()).backupCodes).toBe('new-codes');

  const completedToken = outcomes[0] ? token : otherToken;
  expect(await deleteEnabledTwoFactor(db, enabled, completedToken, now)).toBe(true);
  expect(await readEnabled()).toBe(false);
  expect(await readSession(completedToken)).toBeNull();
  expect(await db.select().from(TwoFactor).where(eq(TwoFactor.userId, userId))).toHaveLength(0);
});

afterAll(async () => {
  try {
    const workerOutput = JSON.stringify(harness?.getLogs() ?? []);
    const diagnosticStreams = [
      ['build', buildOutput],
      ['workerd and application', workerOutput]
    ];

    for (const [stream, output] of diagnosticStreams) {
      const containsSyntheticMarker = [...credentialMarkers].some((marker) => {
        const encodedMarker = encodeURIComponent(marker);
        return output.includes(marker) || output.includes(encodedMarker);
      });
      expect(containsSyntheticMarker, `Synthetic PII or credential marker in ${stream} output`).toBe(false);
    }
    expect(workerOutput.includes('Invalid password'), 'Expected the invalid-password warning').toBe(true);
  } finally {
    await harness?.close();
  }
});
