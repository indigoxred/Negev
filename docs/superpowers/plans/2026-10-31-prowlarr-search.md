# Read-only Prowlarr candidate search

Negev searches the existing Prowlarr instance through `GET /api/v1/search`, scoped to configured indexer IDs. Prowlarr's separate `POST /api/v1/search` and `POST /api/v1/search/bulk` grab releases; this slice never calls them. The API key stays in the `X-Api-Key` header. Search responses are bounded and reduced to candidate titles, IDs, sizes, protocol and seeders; proxy download URLs and magnets never reach this boundary's result.

Search candidates are **unverified**. Filename and indexer metadata cannot establish an AniDB file match. A zero-result response is provisional because Prowlarr's controller catches some search failures and returns an empty list. A later acquisition stage must download into isolated staging and verify the completed video's exact AniDB file registration before Shoko can see it.

The guarded diagnostic exposes the adapter through an authenticated GET route only if all optional Prowlarr settings are present. This is separate from saved requests and has synthetic tests only. There is no live Prowlarr connection, download selection, grab, qBittorrent submission or request worker yet.

Source: [Prowlarr search controller](https://github.com/Prowlarr/Prowlarr/blob/3326e2d4aa978f35fa7e44f66758ebfc8f553d67/src/Prowlarr.Api.V1/Search/SearchController.cs), [query shape](https://github.com/Prowlarr/Prowlarr/blob/3326e2d4aa978f35fa7e44f66758ebfc8f553d67/src/Prowlarr.Api.V1/Search/SearchResource.cs), [release fields](https://github.com/Prowlarr/Prowlarr/blob/3326e2d4aa978f35fa7e44f66758ebfc8f553d67/src/Prowlarr.Api.V1/Search/ReleaseResource.cs).
