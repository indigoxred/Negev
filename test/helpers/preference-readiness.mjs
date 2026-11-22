// Self-contained predicates also evaluated inside the browser by CDP fixtures.
export function preferenceEditorReady() {
  const editor = document.querySelector('dialog.release-search-dialog[open]:modal .release-preference-editor');
  return Boolean(editor && !editor.hidden && editor.querySelector('summary')?.getClientRects().length);
}
export function preferenceSaveReady() {
  const editor = document.querySelector('dialog.release-search-dialog[open]:modal .release-preference-editor');
  const save = [...(editor?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Save group');
  return Boolean(editor && !editor.hidden && editor.open && save && !save.disabled && save.getClientRects().length);
}
