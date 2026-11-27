// Plain-English text for the reason codes shown in admin review. Codes not
// listed here fall back to a readable form of the code itself; the raw code
// stays available as a tooltip for troubleshooting.
const REASONS = {
  file_plan_mismatch: 'The downloaded files do not match the planned episodes',
  related_installment_mismatch: 'The files belong to a different season or installment',
  file_wrong_identity: 'The files are for a different title',
  identity_unavailable: 'The files could not be identified',
  subtitle_unavailable: 'The required subtitles could not be confirmed',
  interrupted_before_publish: 'Negev stopped before the files were moved into the library',
  interrupted_before_intent: 'Negev stopped before the download was started',
  move_outcome_unknown: 'It is unclear whether the files were moved',
  publish_outcome_unknown: 'It is unclear whether the files reached the library',
  completion_interrupted: 'The final file check was interrupted',
  staging_not_empty: 'The download folder still contains files',
  staging_root_unverified: 'The download folder could not be checked',
  handoff_mount_unavailable: 'The library folder was not reachable',
  mount_evidence_unavailable: 'The library folder could not be checked',
  torrent_hash_in_use: 'Another download already uses this release',
  torrent_still_present: 'The torrent is still in qBittorrent',
  torrent_not_stopped: 'The torrent did not stop',
  stop_outcome_unknown: 'It is unclear whether the torrent stopped',
  worker_unavailable: 'The file checker was unavailable',
  incomplete_import_baseline: 'Shoko had not finished its first scan',
  invalid_sidecar_evidence: 'qBittorrent reported unreadable file details',
  invalid_import_file: 'Shoko reported an unreadable import file',
  active_or_unknown_sidecar: 'qBittorrent was still writing or its state was unknown',
  unrecognized_import_file: 'Shoko did not recognise an import file',
  unmatched_sidecar_evidence: 'qBittorrent and Shoko disagree about the files',
  unrecognized_shoko_file: 'Shoko did not recognise the file',
  missing_shoko_location: 'Shoko has no location for the file',
  shoko_location_mismatch: 'Shoko placed the file somewhere unexpected',
  unrecognized_import_video: 'Shoko found a video it could not match',
};

export function reviewReasonText(reason) {
  if (typeof reason !== 'string' || !reason) return 'No reason recorded';
  if (Object.hasOwn(REASONS, reason)) return REASONS[reason];
  const words = reason.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
