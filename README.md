# SuperStamps

SuperStamps is a digital loyalty card application based on [SvelteKit Omakase](https://github.com/n00ki/sveltekit-omakase/tree/fedb890c5cea7663aae331c65241c56ee1f862c9). The starter was imported from commit `fedb890c5cea7663aae331c65241c56ee1f862c9`. SuperStamps is licensed under the [AGPL-3.0](LICENSE). The imported starter’s MIT notice is in [LICENSE-OMAKASE](LICENSE-OMAKASE).

## Verify in Docker

From the project directory, build the image and run the type check and starter build.

```sh
docker build -t superstamps-starter .
docker run --rm --env-file .env.example superstamps-starter
```

The image build installs dependencies with `pnpm install --frozen-lockfile` using the checked-in `pnpm-lock.yaml`. The verification command uses the sample environment and supplies a placeholder Better Auth secret during the build. Running features such as sign-in, email, or file uploads requires configuring their services.

See the [architecture guide](docs/architecture.md) for the project layout, coding conventions, and available commands.
