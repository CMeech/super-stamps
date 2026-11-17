# SuperStamps

SuperStamps is a digital loyalty card application based on [SvelteKit Omakase](https://github.com/n00ki/sveltekit-omakase/tree/fedb890c5cea7663aae331c65241c56ee1f862c9). The starter was imported from commit `fedb890c5cea7663aae331c65241c56ee1f862c9`. SuperStamps is licensed under the [AGPL-3.0](LICENSE). The imported starter’s MIT notice is in [LICENSE-OMAKASE](LICENSE-OMAKASE).

## Verify in Docker

From the project directory, build the image and run the type check and Cloudflare Worker build.

```sh
docker build -t superstamps-starter .
docker run --rm --env-file .env.example superstamps-starter
```

The image build installs dependencies with `pnpm install --frozen-lockfile` using the checked-in `pnpm-lock.yaml`. The verification command supplies a placeholder remote database URL and Better Auth secret during the build.

## Run the built Worker locally

With the Docker image built above, start Wrangler with synthetic configuration.

```sh
docker run --rm -p 127.0.0.1:8787:8787 superstamps-starter sh -ec '
  sed -e "s|:5173|:8787|g" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=https://database.example.invalid|" \
      -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=superstamps-local-runtime-verification-only|" \
      .env.example > .env
  pnpm build
  pnpm exec wrangler dev --ip 0.0.0.0 --port 8787
'
```

Open [the sign-in page](http://127.0.0.1:8787/login) to verify SSR. Sign-in, email, and file uploads require their own service configuration. Worker builds use libSQL over HTTP. The Vite dev server and Drizzle tooling can still use a local SQLite file.

Run `bash scripts/smoke-worker.sh` to verify SSR, database-backed sign-in and sign-out, private-route access, and diagnostic redaction. The command starts a disposable libSQL service with Docker Compose and uses synthetic credentials.

## Worker environments

Wrangler targets separate Workers through `--env preview`, `--env staging`, and `--env production`. Give each Worker its own Turso database and token, Better Auth secret, and any OAuth, storage, or email resources it uses. Use the Worker’s dashboard settings for public values and each Worker’s own encrypted secrets for credentials. The variable names are listed in `src/env.ts`. Set `PUBLIC_BASE_URL` and `BETTER_AUTH_URL` to that environment’s origin. Production requires a Cloudflare route or custom domain.

For MVP verification, run the built Worker locally in Docker. The hosted staging deployment is deferred until after the MVP. See the [technology stack](docs/TECH_STACK.md#4-cloudflare-edge-deployment--required-future-work) for the environment policy.

See the [architecture guide](docs/architecture.md) for the project layout, coding conventions, and available commands.
