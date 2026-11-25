import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeReleaseControl } from '../src/acquisition/release-control.mjs';

test('startup migrates legacy controls once and reopening normalized choices does not write them', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, release_control TEXT);');
    initializeReleaseControl(db);
    const legacy = { candidate: { indexerId: 1, guid: 'http://provider.invalid/1/download?apikey=old&link=abc&file=Example' }, preview: { episodeIds: [101] } };
    db.prepare('INSERT INTO requests VALUES(?,?)').run(1, JSON.stringify({ mode: 'manual', phase: 'chosen', revision: 7, selection: legacy }));
    db.prepare('INSERT INTO preferred_release_waits VALUES(?,?,?,?,?,?)').run(1, 101, 10, 20, null, JSON.stringify(legacy));
    db.exec(`CREATE TABLE normalization_writes(kind TEXT);
      CREATE TRIGGER count_control AFTER UPDATE OF release_control ON requests BEGIN INSERT INTO normalization_writes VALUES('control'); END;
      CREATE TRIGGER count_wait AFTER UPDATE OF fallback_json ON preferred_release_waits BEGIN INSERT INTO normalization_writes VALUES('wait'); END;`);
    initializeReleaseControl(db);
    assert.equal(db.prepare('SELECT count(*) n FROM normalization_writes').get().n, 2);
    const saved = db.prepare('SELECT release_control FROM requests').get().release_control;
    const fallback = db.prepare('SELECT fallback_json FROM preferred_release_waits').get().fallback_json;
    assert.ok(!saved.includes('apikey'));
    assert.equal(JSON.parse(saved).revision, 7);
    assert.equal(db.prepare('SELECT count(*) n FROM acquisition_candidate_aliases').get().n, 1);
    initializeReleaseControl(db);
    assert.equal(db.prepare('SELECT count(*) n FROM normalization_writes').get().n, 2, 'reopen skips identical JSON updates');
    assert.equal(db.prepare('SELECT release_control FROM requests').get().release_control, saved);
    assert.equal(db.prepare('SELECT fallback_json FROM preferred_release_waits').get().fallback_json, fallback);
  } finally { db.close(); }
});

test('startup compare-and-swap preserves a choice changed after its migration snapshot', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY, release_control TEXT);');
    initializeReleaseControl(db);
    const legacy = { candidate: { indexerId: 1, guid: 'http://provider.invalid/1/download?apikey=old&link=abc&file=Example' } };
    const newer = JSON.stringify({ mode: 'manual', phase: 'selecting', revision: 9 });
    db.prepare('INSERT INTO requests VALUES(?,?)').run(1, JSON.stringify({ mode: 'manual', phase: 'chosen', revision: 8, selection: legacy }));
    db.prepare('INSERT INTO preferred_release_waits VALUES(?,?,?,?,?,?)').run(1, 101, 10, 20, null, JSON.stringify(legacy));
    const newerFallback = JSON.stringify({ candidate: { indexerId: 1, guid: 'new-choice' } });
    // Deterministically interleave a second writer after each real SQLite read.
    const interleaved = {
      exec: sql => db.exec(sql),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith('SELECT id,release_control FROM requests') &&
            !sql.startsWith('SELECT request_id,episode_id,fallback_json FROM preferred_release_waits')) return statement;
        return { all() {
          const rows = statement.all();
          if (sql.includes('FROM requests')) db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(newer);
          else db.prepare('UPDATE preferred_release_waits SET fallback_json=? WHERE request_id=1').run(newerFallback);
          return rows;
        } };
      },
    };
    initializeReleaseControl(interleaved);
    assert.equal(db.prepare('SELECT release_control FROM requests').get().release_control, newer);
    assert.equal(db.prepare('SELECT fallback_json FROM preferred_release_waits').get().fallback_json, newerFallback);
    assert.equal(db.prepare('SELECT count(*) n FROM acquisition_candidate_aliases').get().n, 1);
  } finally { db.close(); }
});
