import assert from 'node:assert/strict';
import test from 'node:test';
import { hideChineseProduction } from '../src/web/public/chinese-visibility.mjs';

test('Chinese production is hidden only when the signed-in preference is off', () => {
  assert.equal(hideChineseProduction(false, true), true);
  assert.equal(hideChineseProduction(true, true), false);
  assert.equal(hideChineseProduction(false, false), false);
  assert.equal(hideChineseProduction(false, undefined), false);
});
