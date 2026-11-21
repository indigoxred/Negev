# Negev visual preview implementation plan

Approved spec: updated user brief of 21 November 2026. Supersedes November 5 appearance guidance; acquisition policies remain unchanged.

Goal: working desktop (1440x900), mobile (390x844), and intermediate preview of the existing app navigation, Discover, title, request/release choice and Requests before production deployment.
Architecture: preserve vanilla ES modules and API contracts. Consolidate shared CSS rather than add a framework. Development-only loopback server serves actual frontend with clearly labelled in-memory fixtures; never imports acquisition workers, production credentials or databases. Preview writes are disposable fixture state only.

- [x] Build a fixture preview server using real catalogue artwork and representative long titles, aliases, missing art, partial season, active measured transfer, attention, errors, related titles and release selection. Explicit persistent preview label.
- [x] Replace conflicting legacy style layers with graphite/slate design tokens, consistent controls, restrained lilac, readable >=14px secondary text, 16px body. Use existing system font initially; no new external font dependency required.
- [x] Compact labelled navigation, discover search/filter layout, active filters and clear action; artwork-first grids near page top. Preserve filtering, sorting, ownership and 18+ protections.
- [x] Coherent title summary, responsive poster/facts/synopsis, main request action and related row. Preserve exact installment scope and release choice semantics.
- [x] Compact request rows, clear status/progress/receipt. Preserve completed/cancelled default collapse and measured-only progress.
- [x] Finish interaction/accessibility: outside/Escape, focus restoration, modal background locking, route cleanup and browser-history/scroll preservation; no acquisition API contract changes.
- [x] Render actual pages via built-in browser DOM; inspect 1440x900, 390x844, intermediate. Fix clipping/overflow, menus, title wraps and error states before screenshots.
- [x] Run frontend regression checks and end-to-end fixture walkthrough; fresh whole-change review. Deliver local clickable preview/screenshots, precise limitations. Do not merge/deploy before user reviews.

Guardrails: do not include uncommitted bonus/acquisition work from the other worktree. No backend acquisition, media checks, download selection/ranking, ownership or source media changes. No live test requests. No frontend framework dependency or production service changes. Fixture data is clearly labelled and dev-only. Admin remains owner-only.

## Review-stage result

The working preview is implemented in this isolated frontend checkout, with a loopback-only in-memory fixture host. Desktop 1440x900, mobile 390x844, intermediate900x900 inspected. Screenshots and gallery delivered privately. Real acquisition/backend modules, dependencies, ownership checks and production unchanged. Native dialog focus return verified through Manual Pick; removed unnecessary custom focus bookkeeping. Search refresh keeps prior results visible while revalidating badges. Fixed observed Browse retry on equivalent filter URLs.

This completes the first visible slice for feedback, not the application-wide production appearance acceptance. Remaining: apply feedback; finish broader Airing/Library/account/error-state validation with real read-only data; preserve additional expanded search result pages and their scroll position across title returns; verify supported Plex playback-link placement and compact pagination across all browse variants. These are explicit follow-up checks before production deployment, not permission to change acquisition.
