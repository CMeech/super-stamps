# Super Stamps contributor guidance

- Read [the tech stack](docs/TECH_STACK.md) and, once Omakase has been imported, [the architecture guide](docs/architecture.md) before extending the application. The architecture guide describes the starter's conventions; Super Stamps' documented decisions take precedence if they conflict.
- Target Cloudflare Workers for production code. Prefer Web APIs and Workers bindings; do not assume a full Node.js runtime. Node is allowed for local tooling and builds. Verify any required Node compatibility in the Workers runtime.
