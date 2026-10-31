# Private catalogue diagnostic image

**Goal:** Package the currently tested catalogue flow into a runnable Docker image for isolated future checks. It is not the end-user Negev service and must not be exposed publicly.

**Startup:** Require an explicit private-test flag, Shoko URL/key, a strong synthetic/test bearer token, and a persistent data directory. Bind to loopback by default; binding all interfaces requires a second explicit flag. Start only the catalogue Fastify app and close its SQLite ledger on shutdown. Keep credentials in environment variables and out of logs, image layers, tests and public documentation examples.

**Image:** Node 24 Debian slim, a fixed pnpm version, production dependencies only, and non-root runtime. No bundled credentials, media mounts or preconfigured NAS addresses. A GitHub Actions job builds the image without publishing it.

**Verification:** Pure startup-config tests, existing synthetic catalogue integration, full Node tests, image build on Linux CI. No NAS deployment, download, Shoko metadata write or live user access.
