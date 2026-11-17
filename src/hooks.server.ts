import type { Handle } from '@sveltejs/kit/hooks';

import { building } from '$app/env';

import { svelteKitHandler } from 'better-auth/svelte-kit';

import { createAuth } from '#lib/server/auth.ts';
import { createDatabase } from '#lib/server/database.ts';

export const handle: Handle = async ({ event, resolve }) => {
  const db = createDatabase();
  const auth = createAuth(db);
  event.locals.db = db;
  event.locals.auth = auth;

  const session = await auth.api.getSession({
    headers: event.request.headers
  });
  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;
  } else {
    event.locals.session = null;
    event.locals.user = null;
  }

  return svelteKitHandler({ event, resolve, auth, building });
};
