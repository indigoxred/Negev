# Changing the SQLite schema

Negev has no central schema version. Each module creates and patches its own tables in `negev.sqlite` when it opens. That works, and stays safe to roll back, as long as every change follows these rules. `test/schema-idempotence.test.mjs` checks the most important one.

1. **Every open is idempotent.** Opening the whole service a second time must not change the schema or any row. Guard each `ALTER TABLE` with a `PRAGMA table_info` check, and write repairs so they're a no-op on rows the current code writes.
2. **Additive only.** Add tables and nullable or defaulted columns. Don't drop or rename columns that an earlier build reads. Earlier builds must still run on the database after an upgrade. For example, `requests.status` stays even though it can only be `'held'`, because older builds filter on it.
3. **Repairs of old rows run on every open, not once.** After a rollback, an earlier build can write old-style rows again. A repair that runs on every open fixes those after the roll-forward. A "run once" marker would skip them. This is why there is no migrations table.
4. **No `CREATE VIEW` over ledger tables.** SQLite refuses the `DROP TABLE` and `RENAME` table rebuilds that some ledgers use while a view names the table. Shared query logic goes in a JavaScript SQL fragment instead, such as `LIVE_ATTEMPTS` in `src/acquisition/live-attempts.mjs`.
5. **Log every data change that isn't obviously safe**, in a table that records what it changed, so the change can be undone exactly. Examples are `stage_hold_policy_revivals` and `operator_review_actions` (see `docs/stage-hold-policy.md`).
