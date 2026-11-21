import path from 'node:path';

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);
const BONUS_DIRECTORY = /^(?:OVAs?|OADs?|Specials?|Extras?|Films?|Movies?)$/i;

// Mirror the manifest's relative-name/video policy without importing its gate.
// The manifest still owns validation of every original input file.
function safeVideoName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /:/.test(name) ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      path.posix.isAbsolute(name)) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !part.endsWith('.') && !part.endsWith(' ')) &&
    VIDEO.has(path.posix.extname(name).toLowerCase());
}

// Only explicit structural markers make a file optional. Ordinary title/group
// words and regular SxxExx episodes must survive in the main manifest.
export function isPackBonusVideo(name) {
  if (!safeVideoName(name)) return false;
  const stem = path.posix.basename(name, path.posix.extname(name));
  const ungrouped = stem.replace(/\[[^\]]*\]/g, ' ').trim();
  // Preserve bracketed regular coordinates too, before optional zero hints.
  if (/(?:^|[^a-z0-9])S0*[1-9]\d{0,2}E0*[1-9]\d{0,3}(?:v\d+)?(?=$|[^a-z0-9])/i.test(stem)) return false;
  // Zero is only an optional-file hint. The bonus planner still requires an
  // exact same-show Special prediction before importing it as a Special.
  // Conflicting regular coordinates must remain main files for the mapper to
  // reject; uncertainty must never silently discard a requested episode.
  const zeroCoordinate = /(?:^|[ ._-])S\d{1,3}E0{1,4}(?:v\d+)?(?=$|[ ._([])/i.test(ungrouped) ||
      / - (?:E)?0{1,4}(?:v\d+)?(?=$|[ ._([])/i.test(ungrouped) ||
      /(?:^|[ ._-])E0{1,4}(?:v\d+)?(?=$|[ ._([])/i.test(ungrouped) ||
      /^0{1,4}(?:v\d+)?$/i.test(ungrouped);
  if (zeroCoordinate) {
    if (/(?:^|[ ._-])(?:S\d{1,3}E|E)0*[1-9]\d{0,3}(?:v\d+)?(?=$|[ ._([])/i.test(ungrouped) ||
        /(?:^| - )0*[1-9]\d{0,3}(?:v\d+)?(?=$|[ ._([])/i.test(ungrouped)) return false;
    return true;
  }
  if (/(?:^|[^a-z0-9])S0*[1-9]\d{0,2}E\d{1,4}(?:v\d+)?(?=$|[^a-z0-9])/i.test(stem)) return false;
  if (name.split('/').slice(0, -1).some((part) => BONUS_DIRECTORY.test(part))) return true;
  // A group named [OVA] is not a marker; numeric/suffix markers outside
  // groups, or a terminal delimited marker, are deliberately conservative.
  return /(?:^|[ ._-])(?:OVA|OAD|Special|NCOP|NCED|OP|ED|PV|Trailer)[ ._-]*\d+(?:v\d+)?(?=$|[ ._-])/i.test(ungrouped) ||
    /(?:^| - )(?:NCOP|NCED|OP|ED|PV)(?:v\d+)?$/i.test(ungrouped) ||
    /(?:^| - )(?:OVA|OAD|Special|Trailer)$/i.test(ungrouped);
}



