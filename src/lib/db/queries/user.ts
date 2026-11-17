import type { Database } from '#lib/server/database.ts';

import { and, eq, isNull, like, or } from 'drizzle-orm';

import { User } from '#lib/db/models/index.ts';

export async function setUserImageFromOAuth(db: Database, userId: string, image: string): Promise<void> {
  await db
    .update(User)
    .set({ image })
    .where(
      and(
        eq(User.id, userId),
        or(isNull(User.image), eq(User.image, ''), like(User.image, 'http://%'), like(User.image, 'https://%'))
      )
    );
}
