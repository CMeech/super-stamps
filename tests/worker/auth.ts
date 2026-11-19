import type { WorkerSmoke } from './worker-smoke.ts';

import { randomUUID } from 'node:crypto';
import * as schema from '#models';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { it } from 'vitest';

import { createAccount, createClient } from './worker-smoke.ts';

export function registerAuth(smoke: WorkerSmoke) {
  const { credentialMarkers } = smoke;
  const check: WorkerSmoke['check'] = smoke.check;
  const account = createAccount(credentialMarkers);
  const wrongPassword = randomUUID();
  const queryMarker = randomUUID();
  const headerMarker = randomUUID();
  for (const marker of [wrongPassword, queryMarker, headerMarker]) credentialMarkers.add(marker);

  const { request, authRequest, cookies, cookieHeader } = createClient(smoke);

  function checkPrivateRedirect(response: Awaited<ReturnType<typeof request>>) {
    const destination = response.headers.get('location');
    check(response.status === 303 && destination === '/login');
  }

  it('renders sign-in HTML and persists and revokes database-backed sessions', async () => {
    smoke.stage = 'verify server-rendered sign-in HTML';
    const loginPage = await request('/login');
    check(loginPage.status === 200);
    const loginHtml = await loginPage.text();
    const loginAction = loginHtml.match(/<form\b[^>]*\baction="([^"]*\/remote=[^"]+)"/)?.[1];
    const emailField = loginHtml.match(/\bname="(email\/[^"]+)"/)?.[1];
    const passwordField = loginHtml.match(/\bname="(_password\/[^"]+)"/)?.[1];
    const nextField = loginHtml.match(/\bname="(next\/[^"]+)"/)?.[1];
    check(loginAction && emailField && passwordField && nextField && loginHtml.includes('Sign in'));
    check(!loginHtml.includes(smoke.secret));

    smoke.stage = 'seed the synthetic account through Better Auth';
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

    smoke.stage = 'exercise a controlled authentication rejection';
    const rejected = await authRequest(
      `/api/auth/sign-in/email?smoke=${queryMarker}`,
      { email: account.email, password: wrongPassword },
      { 'X-Smoke-Marker': headerMarker }
    );
    check(rejected.status === 401);

    smoke.stage = 'verify remote form sign-in and database-backed session persistence';
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
    const db = drizzle(smoke.database, { schema, casing: 'snake_case' });
    const { Session, User } = schema;
    const accountSessions = () =>
      db
        .select({ token: Session.token })
        .from(Session)
        .innerJoin(User, eq(Session.userId, User.id))
        .where(eq(User.email, account.email));
    const sessions = await accountSessions();
    check(sessions.length === 1 && typeof sessions[0].token === 'string');
    const token = sessions[0].token;
    credentialMarkers.add(token);
    const sessionCookie = [...cookies].find(([, value]) => decodeURIComponent(value).startsWith(`${token}.`));
    check(sessionCookie);
    const firstDashboardVisit = await request('/dashboard');
    check(firstDashboardVisit.status === 200);
    const secondDashboardVisit = await request('/dashboard');
    check(secondDashboardVisit.status === 200);

    smoke.stage = 'verify sign-out and rejection of the original session cookie';
    const signOut = await logout();
    check(signOut.status === 303);
    const [sessionCookieName] = sessionCookie;
    check(!cookies.has(sessionCookieName));

    const dashboardWithoutCookie = await request('/dashboard', {}, '', false);
    checkPrivateRedirect(dashboardWithoutCookie);
    const dashboardWithOriginalCookie = await request('/dashboard', {}, signedInCookie, false);
    checkPrivateRedirect(dashboardWithOriginalCookie);

    const sessionsAfterSignOut = await accountSessions();
    check(sessionsAfterSignOut.length === 0);
  }, 30_000);
}
