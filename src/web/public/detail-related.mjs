import { createFranchiseExplorer, createRelatedDetailCache, expandFranchiseBatch, groupFranchiseItems } from './franchise-explorer.mjs';
import { relationLabel } from './relation-label.mjs';
import { relatedAvailabilityText } from './season-request-selection.mjs';
import { titleRoute } from './consumer-route.mjs';

export function createDetailRelated({
  franchise,
  item,
  data,
  api,
  isCurrentDetail,
  element,
  posterImage,
  state,
  panel,
  location = globalThis.location,
  IntersectionObserver = globalThis.IntersectionObserver,
  ResizeObserver = globalThis.ResizeObserver,
  getComputedStyle = globalThis.getComputedStyle
}) {
  const family = franchise ?? createFranchiseExplorer({ anidbId: item.anidbId,
    title: data.title || item.title });
  const relatedDetails = createRelatedDetailCache({ read: (anidbId) =>
    api(`/api/catalogue/${anidbId}`,
      { signal: AbortSignal.timeout(5_000) }) });
  const checkedCards = new Set();
  const checkCard = (anidbId) => {
    if (checkedCards.has(anidbId)) return;
    checkedCards.add(anidbId);
    void relatedDetails.get(anidbId).then(() => {
      if (isCurrentDetail()) renderFamily();
    });
  };
  const relatedObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        relatedObserver.unobserve(entry.target);
        checkCard(Number(entry.target.dataset.anidbId));
      }
    }
  }, { rootMargin: '250px' });
  const relatedButton = element('button', 'Show more related titles', 'text-link related-trigger');
  const relatedList = element('div', undefined, 'related-list');
  let relatedExpanded = false;
  const relatedRowCapacity = () => Math.max(1,
    getComputedStyle(relatedList).gridTemplateColumns.trim().split(/\s+/).length);
  let installmentSelect = null;
  let selectedInstallmentId = item.anidbId;
  let selectedAvailability = 'unknown';
  let selectedCheckVersion = 0;
  let updateRequestReview = () => {};
  let syncSeasonRows = () => {};
  const syncInstallmentChoice = () => {
    if (!installmentSelect) return;
    installmentSelect.replaceChildren();
    const titles = new Map(family.items().map((entry) =>
      [entry.anidbId, entry.title]));
    for (const entry of family.items()) {
      const source = entry.relatedFrom && entry.relatedFrom !== item.anidbId
        ? titles.get(entry.relatedFrom) : null;
      const option = element('option', entry.anidbId === item.anidbId
        ? `${entry.title} · this installment`
        : `${entry.title} · ${relationLabel(entry.relation)}` +
          (source ? ` via ${source}` : ''));
      option.value = String(entry.anidbId);
      installmentSelect.append(option);
    }
    installmentSelect.value = String(selectedInstallmentId);
  };
  const renderFamily = () => {
    relatedObserver.disconnect();
    relatedList.replaceChildren();
    const groups = groupFranchiseItems(family.items(), item.anidbId);
    const capacity = relatedRowCapacity();
    const allRelated = groups.flatMap((group) => group.items);
    const visibleIds = new Set((relatedExpanded ? allRelated :
      allRelated.slice(0, capacity)).map((entry) => entry.anidbId));
    const firstRowIds = new Set(allRelated.slice(0, capacity).map((entry) =>
      entry.anidbId));
    const titles = new Map(family.items().map((entry) =>
      [entry.anidbId, entry.title]));
    if (groups.length === 0) relatedList.append(element('p',
      'No related anime links are available from the current metadata. Other installments may still exist; search by title to find them.', 'muted'));
    for (const group of groups) {
      // Direct relation labels already appear on each card. Keep those
      // cards together in one compact grid; only separate indirect hops.
      for (const installment of group.items) {
        if (!visibleIds.has(installment.anidbId)) continue;
        const open = element('button', undefined, 'related-card');
        open.title = installment.title;
        open.dataset.anidbId = String(installment.anidbId);
        const art = element('span', 'N', 'related-art poster-fallback');
        const image = posterImage(installment);
        image.addEventListener('load', () => art.classList.add('has-poster'));
        art.append(image);
        const copy = element('span', undefined, 'related-copy');
        const relation = relationLabel(installment.relation);
        const source = installment.relatedFrom === item.anidbId ? null
          : titles.get(installment.relatedFrom);
        copy.append(element('small', source
          ? `${relation} · via ${source}` : relation, 'related-relation'));
        copy.append(element('strong', installment.title));
        const relatedDetail = relatedDetails.peek(installment.anidbId);
        const knownCount = installment.libraryPresence?.state === 'in_library'
          ? installment.libraryPresence.verifiedEpisodeCount : 0;
        const availabilityText = relatedDetail
          ? relatedAvailabilityText(relatedDetail) : knownCount > 0
            ? `${knownCount} verified item${knownCount === 1 ? '' : 's'} in library · loading details…`
            : 'Loading title details…';
        copy.append(element('span', availabilityText,
          `related-presence ${availabilityText.startsWith('Available')
            ? 'available' : availabilityText.startsWith('Partial')
              ? 'partial' : 'unconfirmed'}`));
        open.append(art, copy);
        open.addEventListener('click', () => {
          state.searchItems.set(installment.anidbId, installment);
          location.hash = titleRoute(installment.anidbId);
        });
        relatedList.append(open);
        if (firstRowIds.has(installment.anidbId)) {
          checkCard(installment.anidbId);
        } else relatedObserver.observe(open);
      }
    }
    const overflow = allRelated.length > capacity;
    relatedButton.textContent = 'Show more related titles';
    relatedButton.hidden = relatedExpanded || !overflow;
    relatedButton.disabled = relatedButton.hidden;
    syncInstallmentChoice();
    syncSeasonRows();
  };
  if (franchise) renderFamily();
  else {
    relatedList.append(element('p', 'Finding related titles…', 'muted'));
    relatedButton.textContent = 'Finding related titles…';
    relatedButton.disabled = true;
  }
  let relatedLoading = false;
  let lastRelatedFailure = null;
  let syncSeasonLookup = () => {};
  let expandForOpenPopup = false;
  let openSeasonDialog = null;
  const loadRelated = async ({ batch = false, initial = false } = {}) => {
    const next = family.next();
    if (!next || relatedLoading) return;
    relatedLoading = true;
    relatedButton.disabled = true;
    relatedButton.textContent = 'Loading related titles…';
    syncSeasonLookup();
    try {
      const result = await expandFranchiseBatch({ explorer: family,
        read: (anidbId) => api(`/api/catalogue/${anidbId}/related`),
        maxReads: initial ? 12 : batch ? 8 : 1,
        minNewItems: initial ? Math.min(49, Math.max(1,
          relatedRowCapacity() + 1 - (family.items().length - 1))) : batch ? 8 : 1,
        shouldContinue: isCurrentDetail });
      if (isCurrentDetail()) {
        renderFamily();
        lastRelatedFailure = result.failures === 0 ? null :
          result.state === 'rate_limited'
            ? 'Related titles are temporarily rate limited. Try again in about a minute.'
            : result.state === 'temporarily_unavailable'
            ? 'Related titles are temporarily unavailable. Try again shortly.'
            : result.state === 'root_unavailable'
            ? 'Related titles could not be loaded. Try again or search for another installment.'
            : 'Some relationships could not be loaded. You can open that title directly or continue exploring.';
        if (!lastRelatedFailure) return;
        const error = element('p', lastRelatedFailure, 'muted related-error');
        if (relatedList.querySelector('.related-card')) {
          relatedList.querySelector('.related-error')?.remove();
          relatedList.append(error);
        } else relatedList.replaceChildren(error);
        if (family.next()) {
          relatedButton.textContent = 'Try related titles again';
          relatedButton.hidden = false;
          relatedButton.disabled = false;
        }
      }
    } catch {
      if (!isCurrentDetail()) return;
      lastRelatedFailure = 'Related titles could not be loaded. Try again shortly.';
      renderFamily();
      relatedList.querySelector('.related-error')?.remove();
      relatedList.append(element('p', lastRelatedFailure, 'muted related-error'));
      relatedButton.textContent = 'Try related titles again';
      relatedButton.hidden = false;
      relatedButton.disabled = false;
    } finally {
      relatedLoading = false;
      syncSeasonLookup();
      if (expandForOpenPopup) {
        expandForOpenPopup = false;
        if (openSeasonDialog?.open && family.next() && !lastRelatedFailure) {
          void loadRelated({ batch: true });
        }
      }
    }
  };
  relatedButton.addEventListener('click', () => {
    if (!relatedExpanded && family.items().length - 1 > relatedRowCapacity()) {
      relatedExpanded = true;
      renderFamily();
    }
    if (family.next()) void loadRelated({ batch: true });
  });
  const relatedHeading = element('h2', 'Related titles', 'related-heading');
  panel.append(relatedHeading, relatedList, relatedButton);
  let relatedWidth = -1;
  let initialRelatedStarted = false;
  const relatedResize = new ResizeObserver(([entry]) => {
    if (!isCurrentDetail()) { relatedResize.disconnect(); return; }
    const width = Math.round(entry.contentRect.width);
    if (width <= 0 || width === relatedWidth) return;
    relatedWidth = width;
    renderFamily();
    // Grid capacity is unreliable before the panel is mounted. Fill the
    // actual visible row (plus one overflow card) after layout is known.
    if (!initialRelatedStarted && family.next() &&
        family.items().length - 1 <= relatedRowCapacity()) {
      initialRelatedStarted = true;
      void loadRelated({ initial: true });
    }
  });
  relatedResize.observe(relatedList);

  return { get expandForOpenPopup() { return expandForOpenPopup; }, set expandForOpenPopup(value) { expandForOpenPopup = value; }, family,
    relatedDetails,
    syncInstallmentChoice,
    loadRelated,
    relatedHeading,
    get installmentSelect() { return installmentSelect; }, set installmentSelect(value) { installmentSelect = value; },
    get selectedInstallmentId() { return selectedInstallmentId; }, set selectedInstallmentId(value) { selectedInstallmentId = value; },
    get selectedAvailability() { return selectedAvailability; }, set selectedAvailability(value) { selectedAvailability = value; },
    get selectedCheckVersion() { return selectedCheckVersion; }, set selectedCheckVersion(value) { selectedCheckVersion = value; },
    get updateRequestReview() { return updateRequestReview; }, set updateRequestReview(value) { updateRequestReview = value; },
    get syncSeasonRows() { return syncSeasonRows; }, set syncSeasonRows(value) { syncSeasonRows = value; },
    get relatedLoading() { return relatedLoading; }, set relatedLoading(value) { relatedLoading = value; },
    get lastRelatedFailure() { return lastRelatedFailure; }, set lastRelatedFailure(value) { lastRelatedFailure = value; },
    get syncSeasonLookup() { return syncSeasonLookup; }, set syncSeasonLookup(value) { syncSeasonLookup = value; },
    get openSeasonDialog() { return openSeasonDialog; }, set openSeasonDialog(value) { openSeasonDialog = value; } };
}
