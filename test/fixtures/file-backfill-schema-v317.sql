-- Captured from the actual v0.0.317 file-backfill constructor. Empty schema only.
CREATE TABLE file_backfill_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_file_id INTEGER NOT NULL CHECK(after_file_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0),
      receipt INTEGER NOT NULL CHECK(receipt>=0),
      pending_json TEXT,
      claimed_ms INTEGER,
      pair_offset INTEGER NOT NULL DEFAULT 0 CHECK(pair_offset BETWEEN 0 AND 100),
      fingerprint TEXT,
      priority_claim INTEGER NOT NULL DEFAULT 0
        CHECK(priority_claim IN (0,1))
    ) STRICT;
CREATE TABLE file_backfill_priority (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      rank INTEGER NOT NULL DEFAULT 0 CHECK(rank IN (0,1))
    ) STRICT;
CREATE TABLE file_backfill_recent_events (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
      confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1))
    ) STRICT;
