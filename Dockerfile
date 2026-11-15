FROM node:24.11.1-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@').pop()")"

COPY . .
RUN SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 pnpm install --frozen-lockfile

CMD ["sh", "-c", "pnpm check && BETTER_AUTH_SECRET=superstamps-local-build-verification-only pnpm build"]
