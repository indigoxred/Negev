# Negev discovery UI design

## Purpose

Make Negev usable by a first-time requester. The owner chose a discovery-first home. Search, title details, requests, and monitored Airing titles must be easy to distinguish. Technical acquisition controls stay in an owner-only advanced view.

## Current problems and source of truth

- The current page is one long search/detail/request form with no navigation or images.
- Search returns AniDB titles but no public Plex status. A saved request's status is not a substitute for current availability.
- The detail page exposes one manual episode probe at a time. The backend already has a bounded availability-page route and a title-check job, but the UI does not use the former and the latter is disabled in the current combined test.
- The franchise action reads Shoko's cached AniDB relations. A title with no cached links returns an empty list; this is not proof that the wider franchise has no other installments. The UI currently gives that case a misleading button label.
- Shoko search provides cached poster IDs, but those cover only part of the catalogue. The AniDB title dump has no images. Every result may therefore request artwork by its exact AniDB ID from AniMap's AniDB record and AniDB's fixed image host. The UI must fall back when that source has no cover or is unavailable; it may not infer a poster match by title text.
- A current public Plex proof is the only positive availability badge. Unknown must stay neutral; an old request or a missing cache row must not become an Available or Missing claim.

## Screen model

1. **Discover** is the first signed-in view: prominent search, image-led results, clear Available/Partly available/Not checked labels, and a useful empty state. Results can open an installment without leaving the view.
2. **Title** shows title/type metadata, one primary request action, an episode list with saved public status, and a bounded refresh action where the title-check worker is configured. Specials remain distinct. It lists verified related installments when present; otherwise it explains that franchise links are not cached instead of claiming the franchise is empty.
3. **My requests** groups active Airing watches above one-time requests. Each row says what is playable, what is still being watched or acquired, and whether owner review is needed. IDs, file plans, and torrent details remain behind Advanced.
4. **Owner review** stays separate from requester navigation and contains only actionable holds.

## Delivery slices

1. Fix the misleading franchise empty/error states and expose the existing bounded availability-page action. Separate active monitored Airing requests from one-time history. These use current data and can ship without a new metadata provider.
2. Add a narrowly validated Shoko poster proxy for cached records and a bounded AniDB-ID poster reader for the broader catalogue. Add public-status summaries from saved exact Plex evidence; fetch no media or poster by title guess. Make results and details responsive cards with accessible text fallbacks.
3. Add seasonal browsing and popularity filters only after a maintained, license-compatible metadata feed with exact AniDB IDs, artwork, season, and ranking fields is selected and measured. Do not present the plain AniDB title dump as a season or popularity feed.

## Acceptance

- A new user can search, identify a title, see truthful availability, and request a series or movie without opening technical controls.
- A current exact public Plex proof yields a clear green Available indicator; incomplete proof yields Partly available; no proof yields Not checked, never Missing.
- Active Airing watches have their own visible section, and completed one-time requests remain accessible.
- A catalogue poster loads through Negev by exact AniDB ID, with Shoko's cached image preferred when present, without exposing credentials or allowing arbitrary URLs; missing posters show a purposeful fallback.
- Franchise exploration works for cached linked titles and gives an honest, useful empty/error state for others.
- Mobile width, keyboard operation, image alt text, loading states, and error states are checked against the running candidate before deployment.
