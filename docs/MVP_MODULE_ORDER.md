# MVP module order

Based on [the tech stack](TECH_STACK.md). Work within each phase can overlap once its dependencies are ready.

1. **Prove the foundation.** Start **Application Bootstrap and Workers Deployment** and **Developer Workflow, Testing, and CI** together. Bring **Turso Data Foundation and Encryption** and **PII-Free Logging and Diagnostics** into the first deployed slice. Validate Turso BYOK with the Worker before loading real PII.
2. **Secure the application.** Establish **Authentication and PII Access Controls** and **Shared Application Services and Retry Safety** before exposing private data or retryable writes. Start **Browser Security and Content Security Policy** in report-only mode and build **Portable Object Storage and Uploads** alongside it.
3. **Build the reusable integration paths.** Run **Delegated and Machine API Access**, **Backend Events and Analytics Delivery**, and **Authenticated Live Notifications** in parallel as their auth and service dependencies become available. Verify recipient authorization before sending live events.
4. **Prove external entry points.** Build **Square Integration Foundation** on shared services and retry safety. Build **Authenticated MCP Tool API** once delegated access and shared service authorization work. Use sandbox and synthetic flows to verify the end-to-end paths, then finish CSP enforcement once login, consent, uploads, and streaming pass browser tests.
