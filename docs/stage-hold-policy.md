# Stage hold retry policy

`src/acquisition/stage-hold-policy.mjs` decides which start and publish holds are failed observations rather than evidence.

## Start stage

A hold in `TRANSIENT_START_HOLDS` (for example a provider, Plex, Sonarr, mount or worker that was briefly unavailable) is never sent to terminal review. It retries after 30 min, 1 h, 2 h and 4 h, then every 6 h. Every retry re-runs every start gate, so a retry cannot start a torrent by itself.

Previously a general hold retried only when the claim `version` was 1. Every claim raised the version, so one earlier session retry or restart made the next temporary failure terminal. The attempt then kept its active episode claims, so no other release of those episodes could be reserved (`target_busy`).

Decisive reasons, such as `file_plan_mismatch` or `related_installment_mismatch`, keep their single 30-minute retry followed by review. Reasons that already had a shorter schedule (session, metadata and import-quiet holds) keep it.

## Publish stage

`staging_root_unverified` is a preflight check, like `handoff_mount_unavailable`, and runs before any file is read. It now gets the same 5-minute paced retry, where before it went to terminal review on the first failure. Holds that may rehash a batch (`identity_unavailable`, `subtitle_unavailable`, `worker_unavailable`, `interrupted_before_publish`) are unchanged: they still get at most one automatic retry.

These caps (one retry, or twelve for `move_outcome_unknown` and `publish_outcome_unknown`) now count holds in a row with the same reason (`reason_run`), not every claim of the attempt. A preflight hold neither counts nor breaks a run. So mount waits no longer use up a later identity retry, and they don't grant an extra rehash either. The two new columns, `last_reason` and `reason_run`, are additive and earlier builds ignore them. When they are added, existing rows are seeded from their claim version, so those rows keep their previous allowance.

## Revival of rows parked by earlier builds, and how to undo it

When a start or publish queue opens, rows held with `next_due_ms IS NULL` for a reason now classed as transient get `next_due_ms = checked_ms + 60000`. Start rows that already have a start intent are skipped. Before each row is changed, it is recorded in `stage_hold_policy_revivals` (stage, attempt, claim version, reason, checked time, revival time). Rows are only logged and changed once.

To put revived rows back into review exactly, revert the code first. Otherwise the next open revives them again. Then run:

```sql
UPDATE start_checks SET next_due_ms=NULL WHERE state='held' AND EXISTS (
  SELECT 1 FROM stage_hold_policy_revivals v WHERE v.stage='start'
    AND v.attempt_id=start_checks.attempt_id AND v.version=start_checks.version);
-- Use pure_move_publish_checks and stage 'pure_publish' in pure mode.
UPDATE handoff_publish_checks SET next_due_ms=NULL WHERE state='held' AND EXISTS (
  SELECT 1 FROM stage_hold_policy_revivals v WHERE v.stage='publish'
    AND v.attempt_id=handoff_publish_checks.attempt_id
    AND v.version=handoff_publish_checks.version);
```

A row that has been claimed again since its revival has a newer version, so this undo leaves it alone. `stage_hold_policy_revivals` is a new table that earlier builds ignore, and it can be dropped once it is no longer needed. No existing column or table is changed or removed.

## Admin actions on the review page

An admin can act on an item in the operational review list (`POST /api/admin/review/:attemptId` with `{ stage, action }`, CSRF protected):

- **Retry now** (`start_hold`, `import_hold`): makes a parked check due immediately. Its normal worker re-runs every gate. For an import, that may read or hash the files again, which is why this never happens automatically for evidence holds.
- **Release download** (`start_hold` only): for a download that never started. Negev records the release, then uses the existing guarded prestart retirement. That removes the stopped torrent from qBittorrent with `deleteFiles=false`, proves the torrent is gone and its staging folder is empty, then retires the attempt as `policy_reset` and frees its episode claims. A different release can then be chosen, and the same release can still be chosen again later as a fresh attempt. A wrong-installment retirement keeps its `file_wrong_identity` reason.

Every action is logged in `operator_review_actions`, with the claim version it applied to and the admin's user ID. A release only authorises the retirement of the exact parked check it was recorded for. A retry is refused while a release is in progress.

To undo a retry that has not run yet:

```sql
UPDATE start_checks SET next_due_ms=NULL WHERE state='held' AND EXISTS (
  SELECT 1 FROM operator_review_actions o WHERE o.stage='start' AND o.action='retry'
    AND o.attempt_id=start_checks.attempt_id AND o.check_version=start_checks.version);
```

A completed release cannot be undone in the database, because the torrent has already been removed from qBittorrent. Re-adding the same release from the request page creates a fresh attempt.
