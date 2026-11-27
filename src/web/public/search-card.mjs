import { titleRoute } from './consumer-route.mjs';

// Owns verified search result presentation and ID-only placeholders. Construction does not register event handlers.
export function createSearchCard({ element, markAdult, posterImage, publicPresenceBadge, state, titleLabel, trackedCard, location = globalThis.location }) {
  function searchResultCard(item, inLibrary) {
    // ID-only results do not create labels or request posters until verified.
    if (!item.title) return markAdult(element('div', undefined, 'tracked-title'),
      { anidbId: item.anidbId }, { hideUnknown: true });
    const button = element('button', undefined, 'result');
    button.type = 'button';
    const tile = element('span', 'N', 'poster-fallback');
    tile.setAttribute('aria-hidden', 'true');
    const poster = posterImage(item);
    poster.addEventListener('load', () => tile.classList.add('has-poster'));
    tile.append(poster);
    const copy = element('span', undefined, 'result-copy');
    copy.append(titleLabel(item), element('small', `AniDB ${item.anidbId}`));
    const presence = inLibrary ? item.verifiedLibraryPresence : item.libraryPresence;
    copy.append(inLibrary && presence?.state !== 'in_library'
      ? element('span', 'Not found in Negev’s verified library', 'presence unknown')
      : publicPresenceBadge(presence, item));
    if (item.adult === true) copy.append(
      element('span', '18+', 'badge partial adult-label'));
    button.append(tile, copy);
    button.addEventListener('click', () => { location.hash = titleRoute(item.anidbId); });
    return trackedCard(button, item, { hideUnknown: true });
  }
  return { searchResultCard };
}
