import { releaseFacts } from './release-choice-fields.mjs';

const evidenceLabel = state => state === 'previously_verified' ? 'Previously verified exact AniDB file' :
  state === 'likely' ? 'Likely AniDB correspondence · CRC32 and size' :
    state === 'filename_prediction' ? 'Filename prediction only · registration unknown' : 'Registration unknown';

export function compactReleaseRow({ candidate: c, element, inspect, choose,
  isCurrent, isBusy, setBusy, onError, onSelected }) {
  const facts = releaseFacts(c.title);
  const entry = element('article', undefined, 'release-entry release-compact-row');
  const main = element('div', undefined, 'release-row-main');
  const name = element('div', undefined, 'release-name');
  const title = element('strong', c.title); title.title = c.title;
  const badge = element('span', '?', 'registration-unknown release-registration');
  badge.title = 'Registration unknown'; badge.setAttribute('aria-label', badge.title);
  name.append(title, badge);
  const group = element('span', facts.group ?? '—', 'release-group'); group.title = c.group;
  const quality = element('span', c.qualityLabel ?? ([facts.source, facts.resolution ? `${facts.resolution}p` : ''].filter(Boolean).join(' ') || '—'), 'release-quality');
  const size = element('span', c.size >= 1_073_741_824 ? `${(c.size / 1_073_741_824).toFixed(2)} GiB` : `${Math.round(c.size / 1_048_576)} MiB`, 'release-size');
  const seeds = element('span', String(c.seeders ?? '?'), 'release-seeds');
  const audio = element('span', c.audioLabel ?? facts.audioLabel, 'release-audio'); audio.title = c.languageHints;
  const pick = element('button', 'Pick', 'primary release-pick'); pick.disabled = !c.eligible;
  main.append(name, group, quality, size, seeds, audio, pick);
  const details = element('details', undefined, 'release-file-evidence');
  const summary = element('summary', c.coverageKind==='advertised_pack'?'Details · Pack advertised':c.coverageKind==='unknown'?'Details · Coverage unknown':'Details');
  const body = element('div', undefined, 'release-evidence-body');
  const metadata = () => element('p', `${c.indexer} · ${c.coverage} · ${c.languageHints}`, 'muted');
  body.append(metadata(), element('p', 'Expand to inspect file coverage and registration.', 'muted'));
  details.append(summary, body); entry.append(main, details);
  let preview = null, task = null;
  const canPick = () => c.eligible && !['already_available', 'owned_unverified'].includes(preview?.selectionStatus);
  const load = async () => {
    if (task) return task;
    task = (async () => {
      badge.textContent = '…'; pick.disabled = true;
      try {
        preview = await inspect();
        if (!isCurrent()) return false;
        let confirmed = preview.files.length > 0, likely = preview.files.length > 0;
        body.replaceChildren(metadata());
        for (const file of preview.files) {
          const proof = preview.correspondence?.files?.find(p => p.name === file.name && p.size === file.size);
          confirmed &&= proof?.state === 'previously_verified';
          likely &&= ['previously_verified', 'likely'].includes(proof?.state);
          body.append(element('p', `${file.name} · AniDB episode ${file.episodeIds.join(', ')} · ${evidenceLabel(proof?.state)}`));
        }
        for (const file of preview.filesToExclude ?? []) body.append(element('p', `${file.name} · excluded`, 'muted'));
        summary.textContent = preview.coverage ? `Details · File coverage checked: ${preview.coverage.coveredEpisodeCount}/${preview.coverage.requestedEpisodeCount} requested episodes` : `Details · ${preview.episodeIds.length} episode${preview.episodeIds.length === 1 ? '' : 's'}`;
        badge.className = `${confirmed ? 'registration-confirmed' : 'registration-unknown'} release-registration`;
        badge.textContent = confirmed ? 'Verified' : likely ? 'Likely' : '?';
        badge.title = confirmed ? 'Previously verified exact AniDB files' : likely ? 'Likely CRC32-and-size correspondence; not exact verification' : 'Registration unknown';
        badge.setAttribute('aria-label', badge.title);
        if (preview.selectionStatus === 'already_available') pick.textContent = 'Available';
        if (preview.selectionStatus === 'owned_unverified') pick.textContent = 'Owned';
        return canPick();
      } catch (error) {
        badge.textContent = '?'; body.replaceChildren(metadata(), element('p', onError(error), 'muted')); task = null; return false;
      } finally { pick.disabled = !canPick(); }
    })();
    return task;
  };
  details.addEventListener('toggle', () => { if (details.open && !preview) void load(); });
  pick.addEventListener('click', async () => {
    if (isBusy()) return;
    setBusy(true); pick.disabled = true; pick.textContent = 'Checking…';
    try {
      if (!await load()) return;
      const selected = await choose();
      if (isCurrent()) onSelected(selected);
    } catch (error) { onError(error); }
    finally { setBusy(false); pick.disabled = !canPick(); if (canPick()) pick.textContent = 'Pick'; }
  });
  return entry;
}
