// node scripts/reason-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredReasons, reasonsIn } from './reason-coverage.mjs';

test('reasons are read only in reason contexts', () => {
  const page = [
    '{ "status": "unsupported", "reason": "pairNotServed" }',
    'Advanced venues read `unavailable` with the reason `advancedModeDisabled`.',
    '| `unavailable`, `apiKeyOrganisationWalletScopeRequired` | no grant |',
    'Set `priceProtectionBps` and read `minOut`.',
    '| `quoteId`, `requoteOf` | ids |',
  ].join('\n');
  assert.deepEqual(reasonsIn(page).map((r) => r.token), ['pairNotServed', 'advancedModeDisabled', 'apiKeyOrganisationWalletScopeRequired']);
});

test('a source outcome is never mistaken for a reason', () => {
  assert.deepEqual(reasonsIn('{ "reason": "unavailable" }'), []);
});

test('an empty or missing catalogue is refused, never read as empty', () => {
  assert.throws(() => declaredReasons({ sourceReasons: [] }), /REASON_CATALOGUE_UNREADABLE/);
  assert.throws(() => declaredReasons({}), /REASON_CATALOGUE_UNREADABLE/);
  assert.ok(declaredReasons({ sourceReasons: [{ reason: 'pairNotServed' }] }).has('pairNotServed'));
});
