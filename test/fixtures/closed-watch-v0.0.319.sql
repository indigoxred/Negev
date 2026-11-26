-- Synthetic database written by unmodified v0.0.319 request-ledger and queue.
-- Both modules loaded from tag; relative dependencies use the unchanged installed modules.
-- Ordinary writer deadline is finite (3601000); NULL edge cases are injected explicitly by tests.
CREATE TABLE requests (
      id INTEGER PRIMARY KEY,
      requester_id INTEGER NOT NULL CHECK(requester_id > 0),
      request_key TEXT NOT NULL,
      command_key TEXT,
      title TEXT,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      kind TEXT NOT NULL CHECK(kind IN ('series','movie')),
      episode_key TEXT NOT NULL,
      monitor_future INTEGER NOT NULL CHECK(monitor_future IN (0,1)),
      watch_closed INTEGER NOT NULL DEFAULT 0 CHECK(watch_closed IN (0,1)),
      cancelled_ms INTEGER CHECK(cancelled_ms >= 0),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL, release_control TEXT,
      UNIQUE(requester_id,request_key)
    ) STRICT;
INSERT INTO "requests" ("id","requester_id","request_key","command_key","title","anidb_id","kind","episode_key","monitor_future","watch_closed","cancelled_ms","created_ms","status","reason","release_control") VALUES (1,1,'legacy',NULL,'Example',100,'series','1001',1,0,NULL,1000,'held','awaiting_availability_evidence',NULL);
CREATE TABLE targets (
      id INTEGER PRIMARY KEY,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL,
      UNIQUE(anidb_id,episode_id)
    ) STRICT;
INSERT INTO "targets" ("id","anidb_id","episode_id","status","reason") VALUES (1,100,1001,'held','awaiting_availability_evidence');
CREATE TABLE request_targets (
      request_id INTEGER NOT NULL REFERENCES requests(id),
      target_id INTEGER NOT NULL REFERENCES targets(id),
      PRIMARY KEY(request_id,target_id)
    ) STRICT;
INSERT INTO "request_targets" ("request_id","target_id") VALUES (1,1);
CREATE TABLE airing_poll_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0)
    ) STRICT;
INSERT INTO "airing_poll_cursor" ("id","after_id") VALUES (1,0);
CREATE TABLE rss_watch_timing (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      next_metadata_ms INTEGER NOT NULL CHECK(next_metadata_ms>=0),
      feed_interval_ms INTEGER NOT NULL CHECK(feed_interval_ms>0),
      rush_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(rush_until_ms>=0)
    ) STRICT;
CREATE TABLE preferred_release_waits (
    request_id INTEGER NOT NULL REFERENCES requests(id),
    episode_id INTEGER NOT NULL CHECK(episode_id>0),
    first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
    deadline_ms INTEGER NOT NULL CHECK(deadline_ms>=first_seen_ms),
    closed_ms INTEGER CHECK(closed_ms>=first_seen_ms),
    fallback_json TEXT NOT NULL,
    PRIMARY KEY(request_id,episode_id)
  ) STRICT;
CREATE TABLE acquisition_request_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT;
INSERT INTO "acquisition_request_cursor" ("id","after_id","pass") VALUES (1,0,1);
CREATE TABLE acquisition_request_checks (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      pass INTEGER NOT NULL CHECK(pass>0),
      state TEXT CHECK(state IN ('held','stopped_observed')),
      reason TEXT,
      attempt_id INTEGER CHECK(attempt_id>0),
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0),
      empty_since_ms INTEGER CHECK(empty_since_ms>=0),
      metadata_since_ms INTEGER CHECK(metadata_since_ms>=0),
      scan_started_ms INTEGER CHECK(scan_started_ms>=0),
      candidate_offset INTEGER NOT NULL DEFAULT 0 CHECK(candidate_offset BETWEEN 0 AND 50),
      candidate_fingerprint TEXT,
      search_policy_rechecked INTEGER NOT NULL DEFAULT 0
        CHECK(search_policy_rechecked IN (0,1,2))
    , checked_release_revision INTEGER NOT NULL DEFAULT 0, scan_scope TEXT, decision_ms INTEGER, scan_target_count INTEGER, discovery_policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(discovery_policy_revision=1), coverage_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(coverage_policy_revision>=0), request_scope_policy_revision INTEGER NOT NULL DEFAULT 0
        CHECK(request_scope_policy_revision>=0)) STRICT;
INSERT INTO "acquisition_request_checks" ("request_id","pass","state","reason","attempt_id","checked_ms","next_due_ms","empty_since_ms","metadata_since_ms","scan_started_ms","candidate_offset","candidate_fingerprint","search_policy_rechecked","checked_release_revision","scan_scope","decision_ms","scan_target_count","discovery_policy_revision","coverage_policy_revision","request_scope_policy_revision") VALUES (1,1,'held','no_safe_release',NULL,1000,3601000,1000,NULL,1000,0,NULL,0,0,'1000631b959300142db7f9ea20406e60c5b876415ff1f55258749b5bf1718833',NULL,1,1,1,1);
CREATE TABLE acquisition_request_suspensions (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80),
      recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
    ) STRICT;
