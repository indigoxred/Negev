// Shoko 6 permits one managed-folder-relative root slash. Apply the same
// idempotent rule at every boundary; malformed double prefixes stay invalid.
export function normalizeManagedRelativePath(raw) {
  if(typeof raw!=='string'||!raw||raw.length>2048||/[\\\0\r\n]/.test(raw))return null;
  const name=raw.startsWith('/')?raw.slice(1):raw;
  return name && !name.split('/').some(part=>!part||part==='.'||part==='..') ? name : null;
}
