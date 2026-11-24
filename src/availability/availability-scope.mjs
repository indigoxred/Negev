import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { validMount } from './known-card-availability.mjs';
const validIds = ids => Array.isArray(ids) && ids.length <= 20 && ids.every(id => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
// Reconcile before workers start. Only a scope identity digest is persisted;
// credentials and private mount configuration never enter this metadata row.
export function openAvailabilityScope(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') throw new TypeError('Durable availability scope required');
  const db = new DatabaseSync(dbPath,{timeout:5000});
  db.exec(`CREATE TABLE IF NOT EXISTS availability_scope (
    id INTEGER PRIMARY KEY CHECK(id=1), signature TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0)) STRICT`);
  const exists = name => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(name);
  return {
    reconcile({serverIdentity,episodeLibraryIds,movieLibraryIds,shokoMount,plexMounts,observedMs}={}) {
      const signature=availabilityScopeSignature({serverIdentity,episodeLibraryIds,movieLibraryIds,shokoMount,plexMounts,observedMs});
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior=db.prepare('SELECT signature,generation FROM availability_scope WHERE id=1').get();
        if(prior?.signature===signature){db.exec('COMMIT');return {state:'unchanged',generation:prior.generation};}
        const generation=(prior?.generation??0)+1;
        if (!Number.isSafeInteger(generation)) throw new RangeError('Availability scope exhausted');
        for(const name of ['file_availability_proofs','title_check_positive_proofs']) if(exists(name)) db.exec(`DELETE FROM ${name}`);
        if(exists('direct_availability_targets')) db.prepare(`UPDATE direct_availability_targets SET state='pending',due_ms=?,priority=1,
          version=version+1,verified_ms=NULL,proof_file_id=NULL,proof_library_id=NULL,proof_rating_key=NULL,proof_part_id=NULL`).run(observedMs);
        if(exists('title_check_targets')) db.exec("UPDATE title_check_targets SET state='pending',checked_ms=NULL");
        if(exists('title_check_jobs')) db.exec("UPDATE title_check_jobs SET state=CASE WHEN state='done' THEN 'checking' ELSE state END,version=version+1,lease_until_ms=0");
        // In-flight guarded observations must not reuse card generations from a
        // different server, library visibility policy, or mount mapping.
        for(const name of ['plex_part_candidates','plex_card_observations',
          'plex_sweep_keys','plex_sweep_passes','plex_card_cursors',
          'plex_card_retries','plex_card_removals']) if(exists(name)) db.exec(`DELETE FROM ${name}`);
        db.prepare('INSERT INTO availability_scope(id,signature,generation) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature,generation=excluded.generation').run(signature,generation);
        db.exec('COMMIT');return {state:prior?'changed':'initialized',generation};
      }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
    },
    close(){db.close();},
  };
}

export function availabilityScopeSignature({serverIdentity,episodeLibraryIds,movieLibraryIds,shokoMount,plexMounts,observedMs}={}) {
      if (typeof serverIdentity !== 'string' || !serverIdentity || serverIdentity.length>4096 ||
        !validIds(episodeLibraryIds) || !validIds(movieLibraryIds) || !validMount(shokoMount) ||
        !Array.isArray(plexMounts) || plexMounts.length<1 || plexMounts.length>8 || !plexMounts.every(validMount) ||
        !Number.isSafeInteger(observedMs) || observedMs<0) throw new TypeError('Invalid availability scope');
      const mounts = plexMounts.map(({appRoot,localRoot})=>[appRoot,localRoot]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return createHash('sha256').update(JSON.stringify([serverIdentity,[...episodeLibraryIds].sort((a,b)=>a-b),[...movieLibraryIds].sort((a,b)=>a-b),[shokoMount.appRoot,shokoMount.localRoot],mounts])).digest('hex');
}
