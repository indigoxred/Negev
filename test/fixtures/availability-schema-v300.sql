-- Frozen stock v0.0.300 availability ledger constructors. Synthetic empty schema only.
CREATE TABLE shoko_inventory_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      page INTEGER NOT NULL CHECK(page>0),
      pass INTEGER NOT NULL CHECK(pass>0),
      page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 100),
      sort_mode TEXT NOT NULL DEFAULT 'FileID' CHECK(sort_mode='FileID')
    ) STRICT;
CREATE TABLE shoko_inventory_files (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      updated TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('provisional','linked','unverified')),
      pairs_json TEXT NOT NULL,
      seen_pass INTEGER NOT NULL CHECK(seen_pass>=0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT;
CREATE TABLE shoko_inventory_pairs (
      file_id INTEGER NOT NULL REFERENCES shoko_inventory_files(file_id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      PRIMARY KEY(file_id,anidb_id,episode_id)
    ) STRICT;
CREATE TABLE shoko_inventory_file_hints (
      file_id INTEGER PRIMARY KEY REFERENCES shoko_inventory_files(file_id),
      updated TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size>0),
      paths_json TEXT NOT NULL,
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT;
CREATE TABLE shoko_provisional_rechecks (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      last_attempt_ms INTEGER NOT NULL CHECK(last_attempt_ms>=0)
    ) STRICT;
CREATE TABLE shoko_inventory_passes (
      pass INTEGER PRIMARY KEY CHECK(pass>0),
      total INTEGER NOT NULL CHECK(total>=0),
      started_ms INTEGER NOT NULL CHECK(started_ms>=0),
      seen_count INTEGER NOT NULL CHECK(seen_count>=0),
      last_file_id INTEGER NOT NULL CHECK(last_file_id>=0),
      digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','complete','invalid'))
    ) STRICT;
CREATE TABLE shoko_file_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL CHECK(file_id>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      before_json TEXT,
      after_json TEXT,
      delivered INTEGER NOT NULL DEFAULT 1 CHECK(delivered IN (0,1))
    ) STRICT;
CREATE TABLE plex_card_observations (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      identity_signature TEXT,
      PRIMARY KEY(library_id,rating_key)
    ) STRICT;
CREATE TABLE plex_part_candidates (
      library_id INTEGER NOT NULL,
      rating_key INTEGER NOT NULL,
      part_id INTEGER NOT NULL CHECK(part_id>0),
      file_size INTEGER NOT NULL CHECK(file_size>0),
      plex_path TEXT NOT NULL,
      candidate_key TEXT,
      PRIMARY KEY(library_id,rating_key,part_id),
      FOREIGN KEY(library_id,rating_key)
        REFERENCES plex_card_observations(library_id,rating_key)
    ) STRICT;
CREATE TABLE plex_card_removals (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      PRIMARY KEY(library_id,rating_key)
    ) STRICT;
CREATE TABLE plex_card_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT;
CREATE TABLE plex_card_cursors (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      offset INTEGER NOT NULL CHECK(offset>=0),
      PRIMARY KEY(library_id,kind)
    ) STRICT;
CREATE TABLE plex_sweep_passes (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      pass_num INTEGER NOT NULL CHECK(pass_num>0),
      total_size INTEGER NOT NULL CHECK(total_size>=0),
      started_ms INTEGER NOT NULL CHECK(started_ms>=0),
      status TEXT NOT NULL CHECK(status IN ('running','complete','invalid')),
      PRIMARY KEY(library_id,kind,pass_num)
    ) STRICT;
CREATE TABLE plex_sweep_keys (
      library_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      pass_num INTEGER NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      PRIMARY KEY(library_id,kind,pass_num,ordinal),
      UNIQUE(library_id,kind,pass_num,rating_key),
      FOREIGN KEY(library_id,kind,pass_num)
        REFERENCES plex_sweep_passes(library_id,kind,pass_num) ON DELETE CASCADE
    ) STRICT;
CREATE TABLE plex_card_retries (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      attempts INTEGER NOT NULL CHECK(attempts>0),
      due_ms INTEGER NOT NULL CHECK(due_ms>=0),
      PRIMARY KEY(library_id,rating_key)
    ) STRICT;
CREATE TABLE file_availability_proofs (
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      file_id INTEGER NOT NULL CHECK(file_id>0),
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      part_id INTEGER NOT NULL CHECK(part_id>0),
      verified_ms INTEGER NOT NULL CHECK(verified_ms>=0),
      presentation TEXT NOT NULL DEFAULT 'exact'
        CHECK(presentation IN ('exact','alternate_card')),
      PRIMARY KEY(anidb_id,episode_id,file_id,library_id,rating_key,part_id)
    ) STRICT;
CREATE TABLE direct_availability_targets (
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      due_ms INTEGER NOT NULL CHECK(due_ms>=0),
      version INTEGER NOT NULL CHECK(version>0),
      priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('pending','checking','available','unknown')),
      verified_ms INTEGER,
      proof_file_id INTEGER,
      proof_library_id INTEGER,
      proof_rating_key INTEGER,
      proof_part_id INTEGER,
      proof_presentation TEXT CHECK(proof_presentation IN ('alternate_card')),
      PRIMARY KEY(anidb_id,episode_id)
    ) STRICT;
CREATE TABLE title_check_jobs (
      anidb_id INTEGER PRIMARY KEY CHECK(anidb_id>0),
      generation INTEGER NOT NULL CHECK(generation>0),
      state TEXT NOT NULL CHECK(state IN ('loading','checking','done','held')),
      kind TEXT CHECK(kind IN ('series','movie')),
      total_count INTEGER CHECK(total_count>=0 AND total_count<=10000),
      next_page INTEGER NOT NULL CHECK(next_page>0 AND next_page<=1000),
      version INTEGER NOT NULL CHECK(version>0),
      requested_ms INTEGER NOT NULL CHECK(requested_ms>=0),
      lease_until_ms INTEGER NOT NULL CHECK(lease_until_ms>=0)
    ) STRICT;
CREATE TABLE title_check_targets (
      anidb_id INTEGER NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>0),
      ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      state TEXT NOT NULL CHECK(state IN ('pending','available','unknown')),
      checked_ms INTEGER,
      PRIMARY KEY(anidb_id,generation,episode_id),
      UNIQUE(anidb_id,generation,ordinal),
      FOREIGN KEY(anidb_id) REFERENCES title_check_jobs(anidb_id)
    ) STRICT;
CREATE TABLE title_check_positive_proofs (
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),
      PRIMARY KEY(anidb_id,episode_id)
    ) STRICT;
CREATE INDEX shoko_provisional_age
      ON shoko_inventory_files(observed_ms,file_id)
      WHERE state='provisional';
CREATE INDEX shoko_change_file
      ON shoko_file_change_events(file_id,id);
CREATE INDEX shoko_change_undelivered
      ON shoko_file_change_events(id) WHERE delivered=0;
CREATE INDEX shoko_inventory_episode
      ON shoko_inventory_pairs(anidb_id,episode_id,file_id);
CREATE INDEX plex_oldest_card
      ON plex_card_observations(library_id,kind,observed_ms,rating_key);
CREATE INDEX plex_change_card
      ON plex_card_change_events(library_id,rating_key,id);
CREATE INDEX plex_candidate_size ON plex_part_candidates(file_size,library_id,rating_key);
CREATE INDEX plex_candidate_identity ON plex_part_candidates(candidate_key,library_id,rating_key);
CREATE INDEX plex_retry_due ON plex_card_retries(library_id,kind,due_ms);
CREATE INDEX file_proof_episode
      ON file_availability_proofs(anidb_id,episode_id,verified_ms DESC);
CREATE INDEX file_proof_file
      ON file_availability_proofs(file_id,verified_ms);
CREATE INDEX file_proof_card
      ON file_availability_proofs(library_id,rating_key,verified_ms);
CREATE INDEX direct_availability_priority_due
      ON direct_availability_targets(priority DESC,due_ms,anidb_id,episode_id);
CREATE INDEX title_check_next_target ON
      title_check_targets(anidb_id,generation,state,ordinal);