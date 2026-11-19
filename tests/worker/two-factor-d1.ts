import type { WorkerSmoke } from './worker-smoke.ts';

import { randomUUID } from 'node:crypto';
import * as schema from '#models';
import {
  confirmPendingTwoFactor,
  deleteEnabledTwoFactor,
  replacePendingTwoFactor,
  replaceRecoveryCodes
} from '#queries/two-factor.ts';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { expect, it } from 'vitest';

import { createAccount } from './worker-smoke.ts';

export function registerTwoFactorD1(smoke: WorkerSmoke) {
  it('rejects stale two-factor mutations and rolls back a failed confirmation', async () => {
    const { database, credentialMarkers } = smoke;
    const db = drizzle(database, { schema, casing: 'snake_case' });
    const { Session, TwoFactor, User } = schema;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const account = createAccount(credentialMarkers);
    const userId = randomUUID();
    const token = randomUUID();
    const otherToken = randomUUID();

    for (const marker of [
      userId,
      token,
      otherToken,
      'first-secret',
      'first-codes',
      'second-secret',
      'second-codes',
      'stale-secret',
      'stale-codes',
      'new-codes'
    ]) {
      credentialMarkers.add(marker);
    }

    await db.batch([
      db.insert(User).values({ id: userId, email: account.email, name: account.name }),
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
      const [session] = await db
        .select()
        .from(Session)
        .where(and(eq(Session.userId, userId), eq(Session.token, sessionToken)));
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
      `CREATE TRIGGER reject_2fa_confirmation BEFORE UPDATE OF two_factor_completed_at ON session WHEN OLD.user_id = '${userId}' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;`
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
}
