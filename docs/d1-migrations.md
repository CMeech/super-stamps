# D1 migrations

After updating the Drizzle models, run `pnpm db:generate` in the development container and review the generated SQL and metadata before committing them. Apply the checked-in migrations with `pnpm db:migrate`. This targets the local `DB` binding. To retain local D1 state across disposable Docker containers, mount a named volume at `/app/.wrangler/state` and use that same volume when running Wrangler.

```sh
docker run --rm -v superstamps-d1:/app/.wrangler/state superstamps-starter pnpm db:migrate
```

To check a portable backup with synthetic data, export the local D1 database and load the SQL into a fresh SQLite database. Compare the expected rows and run `PRAGMA foreign_key_check;` in SQLite.

```sh
pnpm exec wrangler d1 export DB --local --output /tmp/superstamps-export.sql
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  db.exec(readFileSync("/tmp/superstamps-export.sql", "utf8"));
  if (db.prepare("PRAGMA foreign_key_check").all().length) process.exit(1);
  console.log(db.prepare("SELECT count(*) AS users FROM user").get());
'
```

The cutover starts from an empty D1 database because there are no Turso records to import. Before deploying a hosted environment, provision its own D1 database and configure its `DB` binding with the real database ID and the same migrations directory. Apply the reviewed SQL before deploying the Worker with `pnpm exec wrangler d1 migrations apply DB --env production --remote` for production.
