-- Synthetic final recognition preservation release then actual v324 interrupted pipeline hold.
PRAGMA foreign_keys=OFF;
CREATE TABLE acquisition_attempts (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      indexer_id INTEGER NOT NULL CHECK(indexer_id > 0),
      candidate_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','dispatch_unknown','torrent_observed')),
      evidence_policy TEXT NOT NULL DEFAULT 'strict' CHECK(evidence_policy IN ('strict','first_time_permissive')),
      expected_hash TEXT,
      torrent_hash TEXT,
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms),
      UNIQUE(indexer_id,candidate_digest)
    ) STRICT;
INSERT INTO "acquisition_attempts" VALUES(1,1,42,7,'0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5','torrent_observed','strict','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1795651200000,1795651200000);
CREATE TABLE acquisition_bonus_files (
    attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
    file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 1000),
    size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1099511627776),
    anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
    episode_id INTEGER NOT NULL CHECK(episode_id>0),
    kind TEXT NOT NULL CHECK(kind IN ('ova','movie','extra','special')),
    evidence TEXT NOT NULL CHECK(evidence='shoko_filename_prediction'),
    status TEXT NOT NULL CHECK(status IN ('selected','published','identified','playable','attention','skipped')),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    shoko_file_id INTEGER CHECK(shoko_file_id>0),
    reason TEXT CHECK(length(reason) BETWEEN 1 AND 500),
    next_check_ms INTEGER NOT NULL CHECK(next_check_ms>=0),
    checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),
    created_ms INTEGER NOT NULL CHECK(created_ms>=0),
    progress_stage INTEGER NOT NULL DEFAULT 0 CHECK(progress_stage BETWEEN 0 AND 3),
    excluded_before_start INTEGER NOT NULL DEFAULT 0 CHECK(excluded_before_start IN (0,1)), claim_released_ms INTEGER CHECK(claim_released_ms>=0),
    PRIMARY KEY(attempt_id,file_name),
    CHECK(status NOT IN ('identified','playable') OR shoko_file_id IS NOT NULL),
    CHECK(active=0 OR status NOT IN ('playable','skipped'))
  ) STRICT;
CREATE TABLE acquisition_bonus_plans (
    attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
    torrent_hash TEXT NOT NULL,
    input_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL CHECK(created_ms>=0)
  ) STRICT;
CREATE TABLE acquisition_candidate_aliases (
    indexer_id INTEGER NOT NULL,canonical_digest TEXT NOT NULL,legacy_digest TEXT NOT NULL,
    PRIMARY KEY(indexer_id,canonical_digest,legacy_digest)) STRICT;
CREATE TABLE acquisition_file_plans (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL CHECK(file_size > 0),
      episode_key TEXT NOT NULL,
      PRIMARY KEY(attempt_id,file_name)
    ) STRICT;
INSERT INTO "acquisition_file_plans" VALUES(1,'Example - 01.mkv',1000,'[1001]');
CREATE TABLE acquisition_media_retirement_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN
        ('japanese_audio_missing','english_full_subtitles_missing',
         'outside_quality_profile','audio_language_unverified',
         'resolution_unavailable','media_tracks_unverified')),
      status TEXT NOT NULL CHECK(status IN ('requested','delete_unknown')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT;
CREATE TABLE acquisition_prestart_mismatch_retirements (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      retired_ms INTEGER NOT NULL CHECK(retired_ms >= 0)
    ) STRICT;
CREATE TABLE acquisition_rejections (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason = 'file_wrong_identity'),
      rejected_ms INTEGER NOT NULL CHECK(rejected_ms >= 0)
    ) STRICT;
CREATE TABLE acquisition_releases (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      released_ms INTEGER NOT NULL CHECK(released_ms >= 0)
    ) STRICT;
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
    , checked_release_revision INTEGER NOT NULL DEFAULT 0, scan_scope TEXT, decision_ms INTEGER, scan_target_count INTEGER, scan_targets_json TEXT, discovery_policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(discovery_policy_revision=1), coverage_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(coverage_policy_revision>=0), request_scope_policy_revision INTEGER NOT NULL DEFAULT 0
        CHECK(request_scope_policy_revision>=0), verification_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(verification_policy_revision>=0), recovery_hold
          INTEGER NOT NULL DEFAULT 0 CHECK(recovery_hold IN (0,1))) STRICT;
INSERT INTO "acquisition_request_checks" VALUES(1,1,'held','interrupted_attempt_present',NULL,1795651260000,NULL,NULL,NULL,1795651200000,0,NULL,0,0,'34df756d5f8ceb88e57efde7925dadcaa1b341a05d74e62df93a6c621c40b56f',NULL,1,'[[42,1001]]',1,1,1,2,1);
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
CREATE TABLE acquisition_retirements (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'file_wrong_identity'
        CHECK(reason IN ('file_wrong_identity','stalled_download','media_tracks_unsuitable','policy_reset')),
      retired_ms INTEGER NOT NULL CHECK(retired_ms >= 0)
    ) STRICT;
CREATE TABLE acquisition_stall_retirement_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('requested','delete_unknown')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT;
CREATE TABLE acquisition_start_rejections (
      send_token TEXT PRIMARY KEY,
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      rejected_ms INTEGER NOT NULL CHECK(rejected_ms>=0),
      http_status INTEGER NOT NULL CHECK(http_status=403)
    ) STRICT;
CREATE TABLE acquisition_starts (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('start_unknown','started_observed')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    , send_token TEXT) STRICT;
INSERT INTO "acquisition_starts" VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','start_unknown',1795651200000,1795651200000,NULL);
CREATE TABLE acquisition_target_claims (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      PRIMARY KEY(attempt_id,episode_id)
    ) STRICT;
INSERT INTO "acquisition_target_claims" VALUES(1,42,1001,0);
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
CREATE TABLE pure_move_completion_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      pass INTEGER NOT NULL CHECK(pass>0),
      state TEXT CHECK(state IN ('held','handoff_prepared','rejected_held')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0),
      inconclusive_count INTEGER NOT NULL DEFAULT 0 CHECK(inconclusive_count>=0),
      progress_bp INTEGER CHECK(progress_bp>=0 AND progress_bp<10000),
      eta_sec INTEGER CHECK(eta_sec>0 AND eta_sec<=604800),
      speed_bps INTEGER CHECK(speed_bps>=0 AND speed_bps<=10737418240),
      transfer_state TEXT CHECK(transfer_state IN
        ('active','stalled','queued','paused'))
    ) STRICT;
CREATE TABLE pure_move_completion_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT;
INSERT INTO "pure_move_completion_cursor" VALUES(1,0,1);
CREATE TABLE pure_move_content_observations (
      attempt_id INTEGER PRIMARY KEY REFERENCES pure_move_intents(attempt_id),
      manifest_digest TEXT NOT NULL,
      files_json TEXT NOT NULL,
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT;
CREATE TABLE pure_move_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('moving','prepared','publish_unknown','published_observed')),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=created_ms)
    ) STRICT;
INSERT INTO "pure_move_intents" VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','acbfac81abde5a9a5708b7d5895068b9517fd95f6f4ff11a06b1c1a3cf5a890c','{"attemptId":1,"torrentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stagingRoot":"/tmp/negev-dispatch-hold-iaZqG1/staging/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","holdingPath":"/tmp/negev-dispatch-hold-iaZqG1/holding/negev-1-aaaaaaaaaaaaaaaa","files":[{"name":"Example - 01.mkv","size":1000,"episodeIds":[1001],"dev":"1","ino":"2","mtimeNs":"3"}]}','published_observed',1795651200000,1795651200000);
CREATE TABLE pure_move_publish_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES pure_move_intents(attempt_id),
      version INTEGER NOT NULL CHECK(version>0),
      state TEXT CHECK(state IN ('held','publish_unknown','published_observed')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0)
    ) STRICT;
CREATE TABLE recognition_recoveries (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      file_id INTEGER NOT NULL CHECK(file_id>0),
      status TEXT NOT NULL CHECK(status IN
        ('observed','preserve_unknown','preserved','released')),
      first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=first_seen_ms)
    ) STRICT;
INSERT INTO "recognition_recoveries" VALUES(1,81,'released',1795651200000,1795651260000);
CREATE TABLE request_targets (
      request_id INTEGER NOT NULL REFERENCES requests(id),
      target_id INTEGER NOT NULL REFERENCES targets(id),
      PRIMARY KEY(request_id,target_id)
    ) STRICT;
INSERT INTO "request_targets" VALUES(1,1);
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
INSERT INTO "requests" VALUES(1,1,'desired',NULL,'Example',42,'series','1001',1,0,NULL,1795651200000,'held','awaiting_availability_evidence',NULL);
CREATE TABLE rss_watch_timing (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      next_metadata_ms INTEGER NOT NULL CHECK(next_metadata_ms>=0),
      feed_interval_ms INTEGER NOT NULL CHECK(feed_interval_ms>0),
      rush_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(rush_until_ms>=0)
    ) STRICT;
CREATE TABLE start_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      version INTEGER NOT NULL CHECK(version>0),
      state TEXT CHECK(state IN ('held','start_unknown')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0)
    , title_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(title_policy_revision>=0), storage_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(storage_policy_revision>=0)) STRICT;
CREATE TABLE targets (
      id INTEGER PRIMARY KEY,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL,
      UNIQUE(anidb_id,episode_id)
    ) STRICT;
INSERT INTO "targets" VALUES(1,42,1001,'held','awaiting_availability_evidence');
PRAGMA foreign_keys=ON;
