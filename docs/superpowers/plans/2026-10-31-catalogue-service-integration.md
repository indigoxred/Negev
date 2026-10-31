# Isolated catalogue service integration

**Goal:** Wire the existing Shoko search, cached detail, metadata refresh, title registry, reservation ledger and Fastify test app into one injectable service factory. Do not start a listener or use live credentials.

**Boundary:** The caller supplies Shoko URL/key, a durable SQLite path, a private test token and a fetch implementation. The factory returns the Fastify app and an explicit close action. Search records observed IDs; the detail-load route can submit a reserved refresh for only those IDs. GET remains read-only. The service never marks a title requestable.

**Verification:** A synthetic HTTP responder supplies the installed Shoko v3 JSON shapes and records methods. Fastify injection exercises search, missing detail, one refresh, a repeated detail-load, later exact detail, plus invalid/unseen IDs. Use a temporary SQLite database and clean it after the test. Do not deploy or configure a NAS service.
