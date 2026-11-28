import { attachPosterRecovery } from './poster-recovery.mjs';
import { detailAliasText } from './title-preference.mjs';

// Owns DOM construction, title presentation and poster rendering. Construction does not register event handlers.
export function createViewHelpers({ byId, state, document = globalThis.document }) {
  function message(text, error = false) {
    const node = byId('message');
    node.textContent = text;
    node.classList.toggle('error', error);
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function preferredDisplayTitle(item) {
    return state.preferEnglish && item.englishTitle?.trim() || item.title;
  }

  function titleLabel(item, { tag = 'strong', className } = {}) {
    const english = item.englishTitle?.trim();
    const label = element(tag, preferredDisplayTitle(item),
      className);
    if (english && english !== item.title) {
      label.dataset.originalTitle = item.title;
      label.dataset.englishTitle = english;
      label.title = state.preferEnglish ? `Original: ${item.title}` : `English: ${english}`;
    }
    return label;
  }

  function applyTitlePreference() {
    const toggle = byId('english-title-toggle');
    toggle.textContent = 'Show English titles';
    toggle.setAttribute('aria-pressed', String(state.preferEnglish));
    for (const label of document.querySelectorAll('[data-english-title]')) {
      label.textContent = state.preferEnglish
        ? label.dataset.englishTitle : label.dataset.originalTitle;
      label.title = state.preferEnglish
        ? `Original: ${label.dataset.originalTitle}`
        : `English: ${label.dataset.englishTitle}`;
    }
    const heading=state.routePage==='title'?document.querySelector('#detail .detail-title'):null;
    if(heading?.textContent)document.title='Negev · '+heading.textContent;
    for (const alias of document.querySelectorAll('[data-title-alias]')) {
      alias.textContent = detailAliasText(state.preferEnglish,
        alias.dataset.originalTitle, alias.dataset.titleAlias);
    }
  }

  const posterUrl = (item) => /^[0-9a-f-]{36}$/i.test(item.posterUid ?? '')
    ? `/api/catalogue/posters/${item.posterUid}`
    : `/api/catalogue/posters/anidb/${item.anidbId}`;

  function posterImage(item, className = '') {
    const poster = document.createElement('img');
    poster.alt = '';
    poster.loading = 'lazy';
    if (className) poster.className = className;
    attachPosterRecovery(poster);
    poster.src = posterUrl(item);
    return poster;
  }
  return { message, element, preferredDisplayTitle, titleLabel, applyTitlePreference, posterImage };
}
