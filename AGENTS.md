# Super Stamps contributor guidance

- Read [the tech stack](docs/TECH_STACK.md) and [the architecture guide](docs/architecture.md) before extending the application. The architecture guide describes the starter's conventions; Super Stamps' documented decisions take precedence if they conflict.
- Use Docker for local development and verification to keep project dependencies in containers. Follow the [Docker verification workflow](README.md#verify-in-docker) for starter and dependency changes. The [tech stack](docs/TECH_STACK.md) describes the planned Docker Compose workflow for the Vite dev server.

## Cloudflare Workers

- **MUST** target Workers in production and verify Node dependencies there. Stream large bodies, bound memory, use Web Crypto for tokens, and handle expected failures explicitly. Await or return promises, or use `waitUntil()` for short noncritical work. Use Queues or Workflows for durable retries or long-running work.
- **MUST** use Wrangler-managed secrets, enable structured Workers logs and traces under the PII rules below, and keep source maps out of public assets. Maintain the compatibility date and regenerate Wrangler types when bindings or compatibility settings change. Follow the SvelteKit adapter’s Worker entrypoint and asset directory. Test Worker behavior with the existing Cloudflare Vitest suite in Docker.
- **SHOULD** prefer Web APIs and native bindings within the project architecture, which uses D1 bindings and R2 via S3. **MUST NOT** retain request state in module scope, hardcode or log credentials, or use `passThroughOnException()` for routine errors.

[Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## Personally identifiable information (PII)

- Keep PII and secrets out of logs, traces, error reports, and analytics. Use allowlisted diagnostic fields such as request IDs and error codes. Avoid logging raw request bodies, headers, query strings, or database records.
- Enforce server-side authorization before reading, modifying, or disclosing PII. Check the caller’s permission, tenant or account scope, and access to the specific record. Apply these checks to routes, remote functions, and integrations, and return only the fields the caller needs.

## Critical rules

- Use Svelte 5 runes syntax (`$props`, `$state`, `$derived`, `$effect`).
- Use the subpath imports in `package.json`. Include file extensions for wildcard imports and `index.ts` for directory imports.
- Declare environment variables in `src/env.ts` and import them from `$app/env/private` or `$app/env/public`.
- Use explicit TypeScript types at shared API and database boundaries. Use inference for local values, route `load` functions, and route `$props()` data and children.
- Use Remote Functions (`form`, `query`, `command`) instead of actions. Use `await` patterns for queries.
- Use Valibot schemas with `import * as v from 'valibot'`.
- **Never use `redirect()` inside `command` functions** - use `form` instead for actions that need to redirect (SvelteKit limitation: commands cannot handle redirects properly).
- Protected route groups use `requireAuth()` in their server layout. Protected remote functions and standalone protected routes must call `requireAuth()`. Auth pages use `requireGuest()`.
- Password-backed sensitive routes and remote forms use `requireChallenge('/return-path')` before the operation. Do not duplicate current-password fields in those forms.
- Forms can call `await checkRateLimit(issue.field)` and use `useRemoteForm`, `.preflight(schema)`, and `useFormValidation` for client-side usage
- Use Drizzle ORM only. Models live in `#models`, queries live in `#queries`. db connection is the default export in `#lib/server/database.ts`.
- Use class-based state machines in `#lib/state/*.svelte.ts` only for cross-route or app-wide state. Keep state local to the component otherwise.

---

## Implementation

- Prefer existing structure, conventions, helper APIs, and implemented decisions before introducing new patterns.
- Use modern, commonly recommended approaches when they fit this codebase. Do not replace working local patterns just for novelty. If a new pattern seems essential, suggest it first and explain the tradeoff.
- Keep code, comments, and docs concise. Avoid non-essential abstractions, boilerplate, explanatory notes, and fluff.
- Review suggestions and changes through the project's philosophy. Explain what they affect, why they are better or worse, and whether they still fit existing decisions.
- Consolidate README and architecture updates at module closeout. During individual work items, edit those files only when explicitly requested. At closeout, document changes to behavior, architecture, commands, or project conventions.
- Use the issue tracker for project history. Do not create, update, or carry forward changelog documents.

---

## Naming conventions

### Files

- Use `kebab-case` for all files (enforced by ESLint).
- Svelte reactive files: `*.svelte.ts` (e.g., `is-mobile.svelte.ts`).
- Remote functions: `*.remote.ts` (e.g., `auth.remote.ts`).

### Remote Functions (CRUD)

**Resources (standalone entities):**

| Operation       | Pattern            | Example                |
| --------------- | ------------------ | ---------------------- |
| Create          | `create<Resource>` | `createUser`           |
| Read (single)   | `get<Resource>`    | `getUser`              |
| Read (multiple) | `get<Resource>s`   | `getUsers`             |
| Update          | `update<Resource>` | `updateUser`           |
| Delete          | `delete<Resource>` | `deleteUser`           |
| Boolean check   | `has<Condition>`   | `hasCredentialAccount` |

**Relationships (associations):**

- `add<Resource>` - Add resource to parent
- `remove<Resource>` - Remove resource from parent
- `set<Resource>s` - Replace all associations

**Boolean Checks:**

- `has<Condition>` - Check if condition is true for current users

### Domain Actions

For user-facing interactions that don't fit CRUD patterns (likes, follows, subscriptions), use domain-specific verbs:

- `<action>` - Perform the action
- `un<action>` - Reverse the action

---

## Form validation

Use `useRemoteForm` for client-side remote form instances and `useFormValidation` for client-side validation:

```svelte
<script lang="ts">
  const formKey = $props.id();
  const loginForm = useRemoteForm(login, formKey).preflight(loginSchema);
</script>

<form {...loginForm} {...useFormValidation(loginForm)}>
```

This validates on focusout, then re-validates on input while errors exist.

---

## Testing guidance

- Name tests for the user behavior they verify.
- Run the Docker verification commands in the architecture guide when changing the starter or its dependencies.

---

**Do NOT create documentation files unless explicitly requested.**
