FROM node:24.11.1-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@').pop()")"

COPY . .
RUN SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile

CMD ["sh", "-c", "pnpm check && DATABASE_URL=https://database.example.invalid BETTER_AUTH_SECRET=superstamps-local-build-verification-only pnpm build"]
