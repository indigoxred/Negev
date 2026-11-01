# Acquisition Runtime Plan

Negev's acquisition runtime remains opt-in. This plan describes source contracts and validation gates; private service responses, media identities, configuration, and operational measurements belong outside this public repository.

## Intended behavior

- Support AniDB series and movies. Airing requests continue watching for new episodes; Completed requests are one-time target sets.
- Keep request, torrent start, completed-file verification, and Shoko publication journals durable across restart.
- Require an exact AniDB-registered file identity before any video reaches Shoko Import.
- Hold an uncertain, unrecognized, or unsafe item without blocking unrelated requests.
- Confirm public Plex playback independently of the download and Shoko import states.
- Never interpret an empty positive-only cache as proof that a target is absent.

## Source stages

1. **Presence probe:** report bounded Shoko, Import, and public Plex observations without granting acquisition permission.
2. **Candidate search:** use configured indexers and inspect torrent metadata before submission.
3. **Stopped submission:** reserve exact episode targets and journal the one-time qBittorrent send intent before an external action.
4. **Completed-file gate:** verify selected video bytes against the AniDB file ID, size, hash, anime, episode set, and coverage. Reject executable and unexpected files.
5. **Handoff:** copy verified files to an unwatched holding area, recheck them, and journal the one-time publication intent before an atomic move into Shoko Import.
6. **Arrival:** wait for Shoko's exact imported identity and a readable matching Part in an allowed public Plex library. An incomplete observation stays Unknown.

These modules have synthetic and isolated source tests. Source composition alone does not prove an operational download, import, or playback result.

## Remaining gates

- Verify current provider response shapes and configured public-library identity through narrow private checks.
- Prove a target-scoped Import quiet window and an explicit missing-target decision. A Shoko 404 or empty Plex positive index alone is insufficient.
- Verify mounts, permissions, free space, resource limits, and rollback in an isolated deployment.
- Rehearse restart after uncertain torrent submission and watched-folder publication without repeating either external action.
- Observe a genuine request through download, exact file verification, Shoko import, and public Plex availability.
- Observe a direct Shoko import and a later withdrawal without a Negev request.
- Review the end-user UI and maintenance controls before any production cutover.

Keep acquisition disabled until these gates pass. Preserve existing services and user media during validation.
