# Stage hold retry policy

`src/acquisition/stage-hold-policy.mjs` decides which start and publish holds are failed observations rather than evidence.

## Start stage

A hold in `TRANSIENT_START_HOLDS` (for example a provider, Plex, Sonarr, mount or worker that was briefly unavailable) is never sent to terminal review. It retries after 30 min, 1 h, 2 h and 4 h, then every 6 h. Every retry re-runs every start gate, so a retry cannot start a torrent by itself.

Previously a general hold retried only when the claim `version` was 1. Every claim raised the version, so one earlier session retry or restart made the next temporary failure terminal. The attempt then kept its active episode claims, so no other release of those episodes could be reserved (`target_busy`).

Decisive reasons, such as `file_plan_mismatch` or `related_installment_mismatch`, keep their single 30-minute retry followed by review. Reasons that already had a shorter schedule (session, metadata and import-quiet holds) keep it.

## Publish stage

`staging_root_unverified` is a preflight check, like `handoff_mount_unavailable`, and runs before any file is read. It now gets the same 5-minute paced retry, where before it went to terminal review on the first failure. Holds that may rehash a batch (`identity_unavailable`, `subtitle_unavailable`, `worker_unavailable`, `interrupted_before_publish`) are unchanged: they still get at most one automatic retry.

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
