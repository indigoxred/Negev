import { DatabaseSync } from 'node:sqlite';

const MAX_SNAPSHOT_BYTES = 30_000_000;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validEntry = (entry) => validId(entry?.anidbId) &&
  (entry.malId === null || validId(entry.malId)) &&
  typeof entry.title === 'string' && entry.title.length > 0 &&
  entry.title.length <= 300 && typeof entry.type === 'string' &&
  entry.type.length <= 80 && Array.isArray(entry.tags) &&
  entry.tags.length <= 100 && entry.tags.every((tag) =>
    typeof tag === 'string' && tag.length <= 40) &&
  (entry.releaseStatus === null ||
    typeof entry.releaseStatus === 'string' &&
    entry.releaseStatus.length <= 80);

function decode(row) {
  if (!row || Buffer.byteLength(row.payload, 'utf8') >
      MAX_SNAPSHOT_BYTES) return null;
  try {
    const saved = JSON.parse(row.payload);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(saved.sourceDate) ||
        !Number.isSafeInteger(row.checked_ms) || row.checked_ms < 0 ||
        !Array.isArray(saved.groups) || saved.groups.length > 1_000 ||
        !Array.isArray(saved.allEntries) ||
        saved.allEntries.length > 100_000) return null;
    const groups = new Map();
    for (const pair of saved.groups) {
      if (!Array.isArray(pair) || pair.length !== 2 ||
          !/^\d{4}-(WINTER|SPRING|SUMMER|FALL)$/.test(pair[0]) ||
          !Array.isArray(pair[1]) || pair[1].length > 100_000 ||
          !pair[1].every(validEntry) || groups.has(pair[0])) return null;
      groups.set(pair[0], pair[1]);
    }
    if (!saved.allEntries.every((entry) => validEntry(entry) &&
        Number.isSafeInteger(entry.year) &&
        entry.year >= 1900 && entry.year <= 2100 &&
        ['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(entry.season))) {
      return null;
    }
    return { checkedMs: row.checked_ms,
      map: { sourceDate: saved.sourceDate, groups,
        allEntries: saved.allEntries } };
  } catch { return null; }
}

// A presentation-only snapshot. It cannot establish Plex availability or
// authorize a request, download, or import.
export function openSeasonalSnapshot(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath) {
    throw new TypeError('Seasonal snapshot database required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS catalogue_seasonal_snapshot (
    id INTEGER PRIMARY KEY CHECK(id=1),
    checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),
    payload TEXT NOT NULL
  ) STRICT`);
  const read = db.prepare('SELECT checked_ms,payload FROM catalogue_seasonal_snapshot WHERE id=1');
  const write = db.prepare(`INSERT INTO catalogue_seasonal_snapshot
    (id,checked_ms,payload) VALUES (1,?,?)
    ON CONFLICT(id) DO UPDATE SET checked_ms=excluded.checked_ms,
    payload=excluded.payload`);
  return {
    load() { return decode(read.get()); },
    save({ checkedMs, map }) {
      if (!Number.isSafeInteger(checkedMs) || checkedMs < 0 ||
          !map || !Array.isArray(map.allEntries) ||
          !(map.groups instanceof Map)) {
        throw new TypeError('Invalid seasonal snapshot');
      }
      const payload = JSON.stringify({ sourceDate: map.sourceDate,
        groups: [...map.groups], allEntries: map.allEntries });
      if (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new TypeError('Seasonal snapshot too large');
      }
      write.run(checkedMs, payload);
    },
    close() { db.close(); },
  };
}
