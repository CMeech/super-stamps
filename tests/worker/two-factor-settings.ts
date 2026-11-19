import type { WorkerSmoke } from './worker-smoke.ts';

import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import * as schema from '#models';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { it } from 'vitest';

import { createAccount, createClient } from './worker-smoke.ts';

export function registerTwoFactorSettings(smoke: WorkerSmoke) {
  const { credentialMarkers } = smoke;
  const check: WorkerSmoke['check'] = smoke.check;
  const mfaAccount = createAccount(credentialMarkers);
  const { request, authRequest } = createClient(smoke);

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

  it('lets a signed-in user enroll in two-factor authentication, replace recovery codes, and disable it', async () => {
    smoke.stage = 'sign up a separate synthetic account for two-factor settings';
    const signup = await authRequest('/api/auth/sign-up/email', mfaAccount);
    check(signup.ok);
    const seeded = (await signup.json()) as { token?: string; user?: { id: string } };
    check(seeded.token && seeded.user?.id);
    credentialMarkers.add(seeded.token);
    const userId = seeded.user.id;
    const db = drizzle(smoke.database, { schema, casing: 'snake_case' });
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

    smoke.stage = 'complete the password challenge for security settings';
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

    smoke.stage = 'start enrollment without enabling two-factor authentication';
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

    smoke.stage = 'confirm enrollment using a code generated from the displayed setup key';
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

    smoke.stage = 'regenerate recovery codes and verify the replacement is persisted';
    const recoveryPath = `${remoteModule}/getTwoFactorRecoveryCodes`;
    const original = readRecoveryCodes(await securityRemote(recoveryPath));
    const replacement = readRecoveryCodes(
      await securityRemote(`${remoteModule}/regenerateTwoFactorRecoveryCodes`, new URLSearchParams())
    );
    const persisted = readRecoveryCodes(await securityRemote(recoveryPath));
    check(replacement.every((value) => !original.includes(value)));
    check(persisted.every((value, index) => value === replacement[index]));

    smoke.stage = 'disable two-factor authentication and clear the enrollment and session marker';
    const disable = await securityRemote(`${remoteModule}/disableTwoFactor`, new URLSearchParams());
    check(readRemoteValues(disable).includes(securityPath));
    const disabled = await readStatus();
    check(!(await readEnrollment()) && disabled?.enabled === false && disabled.completedAt === null);
    const disabledSettings = await request(securityPath);
    check(disabledSettings.ok && (await disabledSettings.text()).includes('Enable 2FA'));
  }, 30_000);
}
