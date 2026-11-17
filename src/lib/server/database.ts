import { getRequestEvent } from '$app/server';

import { error } from '@sveltejs/kit';
import * as schema from '#models';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';

export function createDatabase() {
  if (!env.DB) {
    error(500, 'Database unavailable', { code: 'DATABASE_BINDING_MISSING' });
  }

  return drizzle(env.DB, {
    schema,
    casing: 'snake_case'
  });
}

export type Database = ReturnType<typeof createDatabase>;

export default function getDatabase(): Database {
  return getRequestEvent().locals.db;
}
