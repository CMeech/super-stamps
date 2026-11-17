import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/db/models/index.ts',
  out: './src/lib/db/migrations',
  breakpoints: true,
  casing: 'snake_case',
  strict: true
});
