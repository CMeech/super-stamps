# Technology Stack and Architecture

**Project:** Loyalty Card Application  
**Date:** November 11, 2026  
**Last updated:** November 12, 2026  
**Status:** Proposed technical baseline; implementation and deployment validation pending

## 1. Purpose and architectural direction

Build a full-stack TypeScript application from SvelteKit Omakase, with authentication owned and operated by the application. The frontend, application API, and authentication endpoints share one application deployment.

Cloudflare Workers is the intended production runtime. This replaces the original single-container deployment preference with a single primary application deployment and managed supporting services. Any additional Workers, Durable Objects, or queue consumers must be explicitly documented when introduced. A Node container remains a possible alternative deployment target, rather than a requirement to maintain two production targets initially.

This document records decisions and required future work. It does not represent completed features or a verified deployment.

## 2. Selected stack

| Layer | Selection | Responsibility / status |
| --- | --- | --- |
| Starter | SvelteKit Omakase, MIT licensed | Application foundation; review and pin a source revision before implementation |
| Language and framework | TypeScript, Svelte, SvelteKit | UI, server rendering, backend endpoints, and server-side business logic |
| UI | Tailwind CSS and shadcn-svelte | Styling and reusable components inherited from Omakase |
| Production runtime | Cloudflare Workers | Edge execution; Cloudflare adapter and runtime compatibility validation required |
| Application database | Turso Cloud | Operational application data and authentication records |
| Database access | Drizzle ORM | Typed schema, queries, and controlled migrations; validate the Turso driver under Workers |
| Authentication | Better Auth, hosted within the application | Users, sessions, password login, and configured social providers; no separate Better Auth cloud account |
| Delegated / machine access | Better Auth OAuth Provider plugin | Authorization Code + PKCE and client credentials; additional implementation required |
| Production object storage | Cloudflare R2 through the S3 API | Uploaded files; keep application storage configuration portable |
| Local object storage | LocalStack S3 | Local development and integration testing; configuration required |
| Local database | SQLite/libSQL compatible with the application schema | Local development; not persistent production storage inside Workers |
| Transactional email | Resend, inherited from the starter | Confirm provider and local email testing before implementing account recovery flows |
| Analytics event delivery | External event pipeline; provider undecided | Backend event publication and analytics/history storage outside the application database |
| Live user notifications | Transport and coordination service undecided | Authenticated delivery to active frontend clients |
| External integrations | Server-side integration service layer | Square webhook ingestion and outbound API calls; required future work |
| MCP tool API | Authenticated MCP endpoint; SDK and transport to be selected | Expose scoped application capabilities to LLM adapters; required future work |

The inspected starter currently declares SvelteKit 3, Svelte 5, and Node 24+ for development/build tooling. Pin dependency versions and a lockfile during bootstrap; development tooling requirements do not establish Workers runtime compatibility.

## 3. Authentication ownership and access model

Better Auth executes within the SvelteKit backend and uses the application database. Application operators control authentication configuration, signing keys, client registrations, and authorization policy. Hosted Turso and external storage/email providers require their own accounts; Better Auth does not require a hosted identity-provider account.

### Browser users

Use secure application sessions. Keep authentication cookies HttpOnly and Secure in production, choose an appropriate SameSite policy, and apply CSRF/origin checks to cookie-authenticated mutations. Never cache authenticated pages or token responses in a shared public cache.

### LLM adapters acting on a user's behalf — required future work

Add Better Auth's OAuth Provider plugin and required database schema. Support Authorization Code + PKCE using S256, registered redirect URIs, user login and consent, and narrowly scoped API access. Enable rotating refresh tokens where ongoing delegated access is required. Provide discovery metadata and token validation appropriate to the intended clients.

The API must enforce user and account/tenant boundaries as well as scopes. Define client registration, consent management, token expiry, revocation, refresh-token storage, and credential rotation. Validate each target LLM/MCP client's protocol requirements before declaring compatibility. MCP integration may require additional metadata and plugin configuration.

### Unattended automation — required future work

Support confidential OAuth clients using the client credentials grant. Explicitly assign permitted machine scopes and associate each client with the account or organization it can access. Machine credentials represent the integration, rather than a signed-in user. Keep client secrets out of browser code and provide administrative client management.

Omakase's existing password/Google login configuration does not itself enable either OAuth provider flow. API bearer-token validation must be added separately from its existing browser session checks.

## 4. Cloudflare edge deployment — required future work

Configure the SvelteKit Cloudflare adapter and Wrangler with pinned compatibility settings, environment bindings, secrets, deployment environments, and custom-domain routing. Audit dependencies for native modules, filesystem assumptions, Node-specific behavior, and request lifecycle restrictions. Enable Node compatibility only where required and verify functionality in the Workers runtime.

Connect to Turso remotely. A normal Worker has no persistent local database file; production must not depend on an embedded SQLite/Turso file or an in-process embedded replica for durability. Keep secrets, including database tokens, OAuth keys, and storage credentials, in server-only configuration.

Use isolated development, preview, and production resources. Apply database migrations through a controlled deployment step, rather than from every incoming request or Worker instance. Validate database latency, connection behavior, bundle size, and runtime limits.

Do not rely on process-local memory for durable state, shared notification subscriptions, cross-instance coordination, or reliable event delivery. Any required coordination or background processing must use an appropriate external service or Cloudflare binding.

## 5. Portable S3 storage and LocalStack — required future work

Omakase already uses the AWS S3 SDK and presigned uploads, but hardcodes an R2 endpoint and region. Introduce provider-neutral configuration for endpoint, region, credentials, bucket, public asset base URL, and optional path-style addressing.

For local development, initialize a LocalStack bucket and its CORS configuration automatically. LocalStack currently requires an account/auth token for AWS emulation; include setup instructions without committing credentials.

### URL and browser access requirements

- Presigned upload URLs must resolve from the browser. Docker-internal names such as `localstack` must not leak into browser-facing URLs unless explicitly resolvable there.
- Configure the signing endpoint before generating a URL. Rewriting a signed hostname or path afterward can invalidate the signature.
- Allow the actual frontend origins, required methods, and upload headers in the bucket CORS policy. Expose response headers such as ETag only when the application needs them.
- Configure public file URLs separately from the API/signing endpoint. Define access policy explicitly: public assets may use a public base URL; private files require authorized retrieval or signed download URLs.
- Test browser preflight, upload, and retrieval against LocalStack and a real R2 staging bucket. LocalStack emulates S3, not every R2 behavior.
- Never expose storage access keys to the frontend. Authorize upload preparation and validate upload policy, ownership, content type, and size server-side; verify stored objects where necessary.

Acceptance: browser uploads and reads work locally and in staging with the intended CORS and CSP policies, and the application contains no hardcoded Cloudflare storage endpoint.

## 6. Frontend Content Security Policy — required future work

Design and enforce a CSP through SvelteKit and Worker-generated HTTP response headers. Validate dynamic HTML, static assets, error responses, and any prerendered pages. Do not assume a Cloudflare static `_headers` file covers dynamically rendered application responses.

Start with restrictive defaults and explicitly configure script, style, image, font, connection, framing, base URI, and form submission policies. Use framework-supported nonces or hashes for necessary inline content. Avoid broadly allowing inline scripts or arbitrary third-party origins.

The connection policy must account for API requests, presigned S3/R2 uploads, SSE streams, and WebSocket endpoints if selected. Image policy must account for uploaded assets and permitted avatar sources. CORS and CSP are independent: both must permit a browser operation.

Use separate local and production policies so development server/HMR allowances do not reach production. For nonce-based SSR, ensure HTML and CSP headers remain paired through caching; use an appropriate hash strategy for prerendered content. Introduce report-only monitoring before enforcement, then test login, consent, uploads, streaming, and notifications under the enforced policy.

## 7. Backend message streaming and analytics — required future work

Publish backend events to an external analytics/event pipeline. The application database will not store message/conversation history or analytics event history. It remains responsible for operational business data and required authentication records.

The analytics sink, event transport, retention policy, and any need for full message content remain undecided. Prefer structured metadata unless storing message content is explicitly required. Define privacy filtering, deletion requirements, and access controls before collecting content.

Define a versioned event envelope with event ID, event type, occurrence time, correlation ID, account/user identifiers where appropriate, and payload. Add schema validation, batching where useful, retry policy, idempotent consumption, failure monitoring, and a dead-letter strategy if using a queue.

Separate analytics event delivery from HTTP response streaming and frontend notification delivery. A browser stream is not an analytics archive. Cloudflare Queues is a candidate for reliable asynchronous delivery; a streaming response can use the Workers Streams API when needed. Neither is selected merely by this document.

Define delivery guarantees explicitly. If an event must be atomic with a database mutation, resolve the database/event-publish consistency gap before implementation; without a durable outbox or equivalent mechanism, do not claim lossless delivery. An outbox in the application database would require a specific exception to the no-event-history policy, with bounded retention.

Do not leave important analytics delivery to untracked asynchronous work after a request. Use runtime-supported lifecycle handling or an acknowledged durable handoff.

## 8. Real-time frontend notifications — required future work

Deliver authorized events to currently connected frontend users. Evaluate SSE for one-way notifications and WebSockets if bidirectional communication is required. SSE is an initial candidate, rather than a final transport decision.

Define event types, recipient routing, authorization, account isolation, connection limits, heartbeat behavior, reconnect/backoff behavior, and session expiry/revocation handling. Validate origins for browser socket connections and prevent credentials from appearing in URL query strings or logs.

Workers may serve different requests in different instances. Select a coordination/fan-out mechanism for cross-instance delivery; an in-memory subscriber map in the application Worker is insufficient. Durable Objects with WebSockets is one candidate. Confirm SvelteKit adapter integration and whether a separate Worker entry point is required before adopting it.

Specify whether notifications are best effort while connected or need offline delivery, replay, read/unread state, or acknowledgements. Durable notification history is not assumed. If replay or an inbox is required, select a separate durable store and retention policy consistent with the application database boundary. On reconnect, the frontend should refresh relevant operational state rather than assuming no events were missed.

Acceptance: a backend action can notify the correct signed-in user across separate Worker instances, with no cross-user delivery, and the frontend recovers cleanly from disconnects.

## 9. Integration service layer — required future work

Introduce a server-side integration service layer for external providers, initially Square. Separate provider-specific clients and webhook parsing from application business rules. Webhook handlers, frontend APIs, background jobs, and MCP tools should call shared application services so authorization and business behavior remain consistent.

### Inbound Square webhooks

Provide an HTTPS endpoint for Square webhook push API calls. Select the required event subscriptions and map each verified provider account/location to the correct application account. Validate webhook signatures against the original request body and configured notification URL using Square's documented verification procedure before trusting or processing the payload.

Design for duplicate, delayed, retried, and out-of-order events. Deduplicate using provider event identifiers and make business mutations idempotent. Define a durable acceptance/processing boundary: acknowledge only after required processing or an acknowledged durable handoff, and handle downstream failures through retries and operational visibility. Resolve any need for reconciliation by fetching current provider state.

Keep any deduplication receipts, retry state, and synchronization cursors minimal and subject to retention rules. These are operational integration records, not permission to store full webhook or analytics history in the application database. Select an external queue/store if durable payload retention is needed.

### Outbound Square API access

Provide a typed server-side Square client behind a provider interface. Decide whether access uses an application-owned Square account or merchant-authorized connections, and define the corresponding credential lifecycle, permissions, and account mapping. Square credentials and provider OAuth tokens are separate from Better Auth's tokens for access to this application.

Keep credentials server-side with secure storage, rotation, and refresh/revocation handling where applicable. Define API version pinning, timeouts, bounded retries, rate-limit handling, pagination, error mapping, and idempotency keys for supported write operations. Avoid retrying non-idempotent operations blindly. Use sandbox resources and test fixtures for development.

Validate any selected Square SDK in the Workers runtime; use a compatible HTTP client if needed. Publish sanitized integration analytics to the external event pipeline and notify frontend users through the selected notification mechanism when relevant application state changes.

Acceptance: a verified webhook updates only its mapped account, duplicate delivery does not duplicate business effects, and authorized server-side API calls handle provider failures without exposing credentials or losing accepted work.

## 10. MCP tool API — required future work

Expose selected application capabilities as an authenticated MCP tool API for LLM adapters. Select a maintained TypeScript MCP SDK, protocol version, and remote HTTP transport compatible with Cloudflare Workers and the intended clients. Define the endpoint, discovery requirements, connection/session lifecycle, and any additional routing or deployment resources.

Use the self-contained Better Auth OAuth provider for delegated Authorization Code + PKCE access. Support client credentials only for explicitly authorized machine integrations where the client supports that flow. Validate tokens for the intended resource/audience and required scopes; enforce user, account/tenant, and tool-level permissions on every call. Treat MCP session identifiers as routing state, not authentication credentials.

Define a small, versioned tool catalog with input/output schemas, validation, pagination, bounded result sizes, timeouts, and predictable errors. Separate read tools from tools that change state. Establish explicit authorization and approval requirements for sensitive mutations, and idempotency rules for retryable actions. Tool descriptions and annotations do not replace server-side enforcement.

Route tools through shared application services and the integration layer rather than duplicating business logic or allowing unrestricted provider API access. Do not expose arbitrary SQL, arbitrary URLs, provider credentials, or cross-account data. Emit sanitized tool execution events to the analytics pipeline without storing conversation history in the application database.

Validate CORS and Origin handling for supported HTTP clients, OAuth discovery and consent, token expiry/revocation, account isolation, malformed inputs, retries, and Workers runtime behavior. MCP response streaming, frontend SSE notifications, and backend analytics delivery remain separate concerns.

Acceptance: an intended LLM adapter can discover and invoke permitted tools using delegated access, while missing scopes, invalid tokens, and cross-account requests are rejected. Retryable mutations do not create duplicate business effects.

## 11. Implementation milestones

| Milestone | Deliverable |
| --- | --- |
| 1. Bootstrap and edge proof | Pin Omakase revision; validate build, SSR, database, and Better Auth sessions under Workers |
| 2. Storage portability | Configurable S3 integration, LocalStack initialization, public/private URL handling, CORS browser verification |
| 3. Browser security | CSP report-only rollout followed by enforcement and complete browser flow verification |
| 4. Integration authentication | Auth Code + PKCE, consent, token verification, refresh/revocation, and scoped machine clients |
| 5. Analytics pipeline | Select sink/transport; document retention and delivery guarantees; verify failure behavior |
| 6. Live notifications | Select transport/coordination; implement authenticated routing, reconnect behavior, and cross-instance tests |
| 7. Integration service layer | Square webhook verification, account mapping, durable processing, deduplication, and server-side API access |
| 8. MCP tool API | Select SDK/transport; implement scoped tools over shared services and verify target LLM adapter interoperability |

## 12. Open decisions

- Exact LLM adapter/MCP clients and their OAuth compatibility requirements.
- Analytics provider, content collection policy, event retention, and acceptable event loss/duplication.
- SSE versus WebSockets and the coordination service for notifications.
- Whether offline notification history or replay is required.
- Which uploads are public and which require authenticated downloads.
- Whether maintaining a Node container deployment alongside Workers is necessary.
- Square event subscriptions, account/location mapping, credential model, and reconciliation requirements.
- Integration queue/store selection, operational receipt retention, and accepted-work delivery guarantees.
- Initial MCP tool catalog, target clients, SDK/transport, and approval rules for sensitive mutations.

## 13. Source references

Source and documentation reviewed November 11, 2026. Repository links track upstream branches; record a commit when bootstrapping the application.

- [Omakase repository and license](https://github.com/n00ki/sveltekit-omakase)
- [Omakase dependencies](https://github.com/n00ki/sveltekit-omakase/blob/main/package.json), [deployment configuration](https://github.com/n00ki/sveltekit-omakase/blob/main/vite.config.ts), and [database connection](https://github.com/n00ki/sveltekit-omakase/blob/main/src/lib/server/database.ts)
- [Omakase authentication](https://github.com/n00ki/sveltekit-omakase/blob/main/src/lib/server/auth.ts), [storage](https://github.com/n00ki/sveltekit-omakase/blob/main/src/lib/server/storage.ts), and [upload URL helpers](https://github.com/n00ki/sveltekit-omakase/blob/main/src/lib/upload/policies.ts)
- [SvelteKit Cloudflare adapter](https://svelte.dev/docs/kit/adapter-cloudflare) and [configuration reference](https://svelte.dev/docs/kit/@sveltejs-kit-vite)
- [Cloudflare Workers filesystem limitations](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)
- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider), [client registration and machine scopes](https://better-auth.com/docs/plugins/oauth-provider/clients), and [MCP integration](https://better-auth.com/docs/plugins/mcp)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [LocalStack S3](https://docs.localstack.cloud/aws/services/s3/) and [installation requirements](https://docs.localstack.cloud/aws/getting-started/installation/)
- [Workers Streams API](https://developers.cloudflare.com/workers/runtime-apis/streams/), [Cloudflare Queues](https://developers.cloudflare.com/queues/), and [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
