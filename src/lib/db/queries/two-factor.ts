import type { Database } from '#lib/server/database.ts';

import { Session, TwoFactor, User } from '#models';
import { and, eq, exists, gt, sql } from 'drizzle-orm';

import { generateUUIDv7 } from '#lib/utils/generate.ts';

export async function replacePendingTwoFactor(
  db: Database,
  userId: string,
  encryptedSecret: string,
  backupCodes: string
): Promise<boolean> {
  const isDisabled = and(eq(User.id, userId), eq(User.twoFactorEnabled, false));
  const availableUser = db.select({ id: User.id }).from(User).where(isDisabled);
  const [, inserted] = await db.batch([
    db.delete(TwoFactor).where(and(eq(TwoFactor.userId, userId), exists(availableUser))),
    db
      .insert(TwoFactor)
      .select(
        db
          .select({
            id: sql<string>`${generateUUIDv7()}`.as('id'),
            secret: sql<string>`${encryptedSecret}`.as('secret'),
            backupCodes: sql<string>`${backupCodes}`.as('backup_codes'),
            userId: User.id,
            verified: sql<boolean>`0`.as('verified'),
            failedVerificationCount: sql<number>`0`.as('failed_verification_count'),
            lockedUntil: sql<Date | null>`null`.as('locked_until')
          })
          .from(User)
          .where(isDisabled)
      )
      .returning({ id: TwoFactor.id })
  ]);

  return inserted.length === 1;
}

export async function confirmPendingTwoFactor(
  db: Database,
  twoFactor: Pick<TwoFactor, 'id' | 'userId' | 'secret'>,
  sessionToken: string,
  now: Date
): Promise<boolean> {
  const sessionOwner = and(eq(Session.token, sessionToken), eq(Session.userId, twoFactor.userId));
  const currentSession = db
    .select({ id: Session.id })
    .from(Session)
    .where(and(sessionOwner, gt(Session.expiresAt, now)));
  const disabledUser = db
    .select({ id: User.id })
    .from(User)
    .where(and(eq(User.id, twoFactor.userId), eq(User.twoFactorEnabled, false)));

  // CloudFlare D1 doesn't allow you to get row counts between separate batches.
  // This is since different sessions are created per batch.
  // However, within a batch, changes() reports the row count from the preceding write.
  const [confirmed] = await db.batch([
    db
      .update(TwoFactor)
      .set({ verified: true })
      .where(
        and(
          eq(TwoFactor.id, twoFactor.id),
          eq(TwoFactor.userId, twoFactor.userId),
          eq(TwoFactor.secret, twoFactor.secret),
          eq(TwoFactor.verified, false),
          exists(currentSession),
          exists(disabledUser)
        )
      )
      .returning({ id: TwoFactor.id }),
    db
      .update(User)
      .set({ twoFactorEnabled: true, updatedAt: now })
      .where(and(eq(User.id, twoFactor.userId), sql`changes() = 1`)),
    db
      .update(Session)
      .set({ challengeCompletedAt: now, twoFactorCompletedAt: now, updatedAt: now })
      .where(and(sessionOwner, sql`changes() = 1`))
  ]);

  return confirmed.length === 1;
}

export async function deleteEnabledTwoFactor(
  db: Database,
  twoFactor: Pick<TwoFactor, 'id' | 'userId'>,
  sessionToken: string,
  now: Date
): Promise<boolean> {
  const enabledUser = db
    .select({ id: User.id })
    .from(User)
    .where(and(eq(User.id, twoFactor.userId), eq(User.twoFactorEnabled, true)));

  const [deleted] = await db.batch([
    db
      .delete(TwoFactor)
      .where(
        and(
          eq(TwoFactor.id, twoFactor.id),
          eq(TwoFactor.userId, twoFactor.userId),
          eq(TwoFactor.verified, true),
          exists(enabledUser)
        )
      )
      .returning({ id: TwoFactor.id }),
    db
      .update(User)
      .set({ twoFactorEnabled: false, updatedAt: now })
      .where(and(eq(User.id, twoFactor.userId), sql`changes() = 1`)),
    db
      .update(Session)
      .set({ twoFactorCompletedAt: null, updatedAt: now })
      .where(and(eq(Session.token, sessionToken), eq(Session.userId, twoFactor.userId), sql`changes() = 1`))
  ]);

  return deleted.length === 1;
}

export async function replaceRecoveryCodes(
  db: Database,
  twoFactor: Pick<TwoFactor, 'id' | 'userId' | 'backupCodes'>,
  backupCodes: string
): Promise<boolean> {
  const [updated] = await db
    .update(TwoFactor)
    .set({ backupCodes })
    .where(
      and(
        eq(TwoFactor.id, twoFactor.id),
        eq(TwoFactor.userId, twoFactor.userId),
        eq(TwoFactor.verified, true),
        eq(TwoFactor.backupCodes, twoFactor.backupCodes)
      )
    )
    .returning({ id: TwoFactor.id });

  return !!updated;
}
