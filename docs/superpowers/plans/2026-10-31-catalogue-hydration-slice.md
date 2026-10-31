# Isolated Catalogue Hydration Slice

**Goal:** Join the proved AniDB title/detail adapters, durable admission ledger, and one-ID Shoko refresh contract into a testable detail-load flow without deploying Negev.

**Architecture:** A coordinator receives injected search-identity evidence, detail reader, ledger, and refresh adapter. It verifies the title is known server-side, reads detail first, reserves a durable claim only for `detail_pending`, then calls the supported Shoko metadata action once. A later observation completes the claim only when the exact same AniDB title has a fully enumerated regular episode. The private Fastify app exposes an authenticated `POST /api/catalogue/:id/load-detail` action; its existing GET stays read-only. The app factory has no listener.

**Failure behavior:** Unknown title, Shoko outage, partial detail, invalid response, and admission denial are visible states. A failed or uncertain POST retains the durable claim and holds automatic resubmission. No refresh result alone marks episodes requestable. Long episode pagination is a separate gate and remains pending.

**Tests:** Synthetic Fastify injection and temporary SQLite only. Prove one title gets one refresh, a duplicate request cannot submit again, a later valid detail completes the claim, a wrong anime/trailer-only response cannot, and partial detail does not trigger another refresh. No live Shoko, Plex or qBittorrent calls.
