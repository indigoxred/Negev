import { detailAliasText } from './title-preference.mjs';
import { nextAirDateLabel } from './episode-schedule.mjs';

export function createDetailDisplay({ onTitleRendered,isCurrentDetail, state, panel, titleLabel, item, setPendingTitleKind, earlyRequest, displaySummary, element, titleBlock }) {
  let displayReleaseStatus = null;
  let nextAirData = null;
  let nextAirElement = null;
  const refreshNextAir = () => {
    if (!nextAirElement) return;
    const label = nextAirDateLabel({ kind: nextAirData.kind,
      releaseState: nextAirData.releaseState, releaseStatus: displayReleaseStatus,
      schedule: nextAirData.regularSchedule });
    nextAirElement.hidden = !label;
    nextAirElement.textContent = label ?? '';
  };
  const renderDisplay = (display, title) => {
    if (!isCurrentDetail() || display?.state !== 'display') return;
    if (display.restricted !== false &&
        (!state.showAdult || state.user?.adultAllowed !== true)) return;
    displayReleaseStatus = display.releaseStatus;
    refreshNextAir();
    panel.querySelector('.detail-title')?.replaceWith(titleLabel({ title,
      englishTitle: display.englishTitle ?? item.englishTitle },
    { tag: 'h1', className: 'detail-title' }));
    setPendingTitleKind(earlyRequest, { title },
      /movie|film/i.test(display.type ?? '') ? 'movie' :
        /series|tv|ova|ona/i.test(display.type ?? '') ? 'series' : null);
    onTitleRendered?.(title,display.englishTitle??item.englishTitle,display.restricted);
    displaySummary.replaceChildren();
    const main = element('div', undefined, 'detail-main');
    titleBlock.querySelectorAll('.detail-facts, .detail-alias').forEach(node => node.remove());
    const facts = [display.type, display.startYear, display.releaseStatus?.replaceAll('_', ' ').toLowerCase()].filter(Boolean).join(' · ');
    if (facts) titleBlock.append(element('p', facts, 'detail-facts'));
    if (display.englishTitle && display.englishTitle !== title) {
      const alias = element('p', detailAliasText(state.preferEnglish,
        title, display.englishTitle), 'detail-alias');
      alias.dataset.originalTitle = title;
      alias.dataset.titleAlias = display.englishTitle;
      titleBlock.append(alias);
    }
    const synopsis = typeof display.description === 'string'
      ? display.description.trim() : '';
    const description = element('p', synopsis ||
      'No synopsis is available for this title yet.', 'detail-description');
    main.append(description);
    if (synopsis) {
      if (synopsis.length > 280) {
        description.classList.add('is-collapsed');
        const toggle = element('button', 'Read full synopsis',
          'detail-description-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          const expanded = !description.classList.toggle('is-collapsed');
          toggle.setAttribute('aria-expanded', String(expanded));
          toggle.textContent = expanded ? 'Show less' : 'Read full synopsis';
        });
        main.append(toggle);
      }
    }
    const quickFacts = element('dl', undefined, 'detail-quickfacts');
    for (const [label, value] of [
      ['Season', display.season], ['Studio', display.studio],
      ['Runtime', display.durationMinutes ? `${display.durationMinutes} min` : null],
      ['First aired', display.startDate],
      ['Last aired', display.endDate],

    ]) {
      if (value === null || value === undefined || value === '') continue;
      const fact = element('div');
      fact.append(element('dt', label), element('dd', String(value)));
      quickFacts.append(fact);
    }
    if (display.tags?.length) {
      const tags = element('div', undefined, 'detail-tags');
      for (const tag of display.tags) tags.append(element('span', tag));
      main.append(tags);
    }
    displaySummary.append(main);
    if (quickFacts.childElementCount) displaySummary.append(quickFacts);
  };

  return { renderDisplay, mountNextAir(data, node) { nextAirData = data; nextAirElement = node; refreshNextAir(); } };
}
