import assert from 'node:assert/strict';
import test from 'node:test';
import { relationLabel } from '../src/web/public/relation-label.mjs';

test('AniDB relation names read naturally on installment cards', () => {
  assert.equal(relationLabel('SideStory'), 'Side story');
  assert.equal(relationLabel('AlternativeVersion'), 'Alternative version');
  assert.equal(relationLabel('Prequel'), 'Prequel');
  assert.equal(relationLabel('same_setting'), 'Same setting');
  assert.equal(relationLabel(''), 'Related');
});
