-- Synthetic normal v309 worker false completion after a member choice update; v310 intermediate migration
PRAGMA foreign_keys=OFF;
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
    , checked_release_revision INTEGER NOT NULL DEFAULT 0, scan_scope TEXT, decision_ms INTEGER, scan_target_count INTEGER, coverage_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(coverage_policy_revision>=0), request_scope_policy_revision INTEGER NOT NULL DEFAULT 0
        CHECK(request_scope_policy_revision>=0)) STRICT;
INSERT INTO "acquisition_request_checks" VALUES(1,1,'held','request_fully_available',NULL,1000,1801000,NULL,NULL,1000,0,NULL,0,1,'a04a67f3f0ad63048c2f58089c3678f018324b8d1933c8a959b8ae65648f7d7c',1000,2,1,1);
CREATE TABLE acquisition_request_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT;
INSERT INTO "acquisition_request_cursor" VALUES(1,0,1);
CREATE TABLE acquisition_request_suspensions (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80),
      recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
    ) STRICT;
CREATE TABLE airing_poll_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0)
    ) STRICT;
INSERT INTO "airing_poll_cursor" VALUES(1,0);
CREATE TABLE preferred_release_waits (
    request_id INTEGER NOT NULL REFERENCES requests(id),
    episode_id INTEGER NOT NULL CHECK(episode_id>0),
    first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
    deadline_ms INTEGER NOT NULL CHECK(deadline_ms>=first_seen_ms),
    closed_ms INTEGER CHECK(closed_ms>=first_seen_ms),
    fallback_json TEXT NOT NULL,
    PRIMARY KEY(request_id,episode_id)
  ) STRICT;
CREATE TABLE request_targets (
      request_id INTEGER NOT NULL REFERENCES requests(id),
      target_id INTEGER NOT NULL REFERENCES targets(id),
      PRIMARY KEY(request_id,target_id)
    ) STRICT;
INSERT INTO "request_targets" VALUES(1,1);
INSERT INTO "request_targets" VALUES(1,2);
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
INSERT INTO "requests" VALUES(1,1,'desired',NULL,'Example',42,'series','1001,1002',0,0,NULL,1000,'held','awaiting_availability_evidence','{"mode":"manual","phase":"selecting","revision":3}');
CREATE TABLE rss_watch_timing (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      next_metadata_ms INTEGER NOT NULL CHECK(next_metadata_ms>=0),
      feed_interval_ms INTEGER NOT NULL CHECK(feed_interval_ms>0),
      rush_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(rush_until_ms>=0)
    ) STRICT;
CREATE TABLE targets (
      id INTEGER PRIMARY KEY,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL,
      UNIQUE(anidb_id,episode_id)
    ) STRICT;
INSERT INTO "targets" VALUES(1,42,1001,'held','awaiting_availability_evidence');
INSERT INTO "targets" VALUES(2,42,1002,'held','awaiting_availability_evidence');
PRAGMA foreign_keys=ON;
