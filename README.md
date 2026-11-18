# SuperStamps

SuperStamps is a digital loyalty card application based on [SvelteKit Omakase](https://github.com/n00ki/sveltekit-omakase/tree/fedb890c5cea7663aae331c65241c56ee1f862c9). The starter was imported from commit `fedb890c5cea7663aae331c65241c56ee1f862c9`. SuperStamps is licensed under the [AGPL-3.0](LICENSE). The imported starter’s MIT notice is in [LICENSE-OMAKASE](LICENSE-OMAKASE).

Cloudflare D1 is the application database for operational data and Better Auth. The verification commands below use local D1 in Docker. See the [technology stack](docs/TECH_STACK.md#4-cloudflare-edge-deployment--required-future-work).

## Verify in Docker

From the project directory, build the image and run the type check and Cloudflare Worker build.

```sh
docker build -t superstamps-starter .
docker run --rm --env-file .env.example superstamps-starter
```

The image build installs dependencies with `pnpm install --frozen-lockfile` using the checked-in `pnpm-lock.yaml`. The verification command supplies a synthetic Better Auth secret during the build.

## Run the built Worker locally

With the Docker image built above, apply the checked-in migrations to local D1 and start Wrangler with synthetic configuration. Both commands use the same named volume to retain local D1 state across container runs.

```sh
docker run --rm -v superstamps-d1:/app/.wrangler/state superstamps-starter pnpm db:migrate
docker run --rm -v superstamps-d1:/app/.wrangler/state -p 127.0.0.1:8787:8787 superstamps-starter sh -ec '
  sed -e "s|:5173|:8787|g" \
      -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=superstamps-local-runtime-verification-only|" \
      .env.example > .env
  pnpm build
  pnpm exec wrangler dev --ip 0.0.0.0 --port 8787
'
```

Open [the sign-in page](http://127.0.0.1:8787/login) to verify SSR. Email, Google sign-in, and file uploads require their own service configuration.

Run `bash scripts/smoke-worker.sh` locally or in CI to run the Vitest Worker suite. Docker Compose runs Wrangler’s `createTestHarness()` with a disposable D1 binding and synthetic credentials. The suite checks the `ASSETS` binding, SSR, database-backed sign-in and sign-out, private-route access, two-factor settings, and diagnostic redaction.

Run `docker run --rm --env-file .env.example superstamps-starter pnpm test:unit --run` for the Node unit suite.

To clear local auth data and keep the schema and migration history, run:

```sh
docker run --rm -v superstamps-d1:/app/.wrangler/state superstamps-starter pnpm db:clear
```

For a full local reset, stop containers using the volume, then delete the volume and reapply the migrations. This discards all local D1 data and migration history.

```sh
docker volume rm superstamps-d1
docker run --rm -v superstamps-d1:/app/.wrangler/state superstamps-starter pnpm db:migrate
```

## Worker environments

Wrangler targets separate Workers through `--env preview`, `--env staging`, and `--env production`. For D1 deployments, configure a separate D1 database binding for each deployed environment. Give each Worker its own Better Auth secret and any OAuth, storage, or email resources it uses. Use the Worker’s dashboard settings for public values and each Worker’s own encrypted secrets for credentials. The variable names are listed in `src/env.ts`. Set `PUBLIC_BASE_URL` and `BETTER_AUTH_URL` to that environment’s origin. Production requires a Cloudflare route or custom domain.

Apply reviewed migrations to the selected environment’s D1 database before deploying the Worker to that same environment. See the [D1 migration guide](docs/d1-migrations.md) for the remote command.

For MVP verification, run the built Worker locally in Docker. The hosted staging deployment is deferred until after the MVP. See the [technology stack](docs/TECH_STACK.md#4-cloudflare-edge-deployment--required-future-work) for the environment policy.

See the [architecture guide](docs/architecture.md) for the project layout, coding conventions, and available commands.
