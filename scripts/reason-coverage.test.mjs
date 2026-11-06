// node scripts/reason-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredReasons, outcomesFrom, reasonsIn, specReasonEnums } from './reason-coverage.mjs';

const OUTCOMES = new Set(['answered', 'unsupported', 'unavailable', 'filteredOut']);

test('reasons are read only in reason contexts', () => {
  const page = [
    '{ "status": "unsupported", "reason": "pairNotServed" }',
    'Advanced venues read `unavailable` with the reason `advancedModeDisabled`.',
    '| `unavailable`, `apiKeyOrganisationWalletScopeRequired` | no grant |',
    'Set `priceProtectionBps` and read `minOut`.',
    '| `quoteId`, `requoteOf` | ids |',
  ].join('\n');
  assert.deepEqual(reasonsIn(page, OUTCOMES).map((r) => r.token), ['pairNotServed', 'advancedModeDisabled', 'apiKeyOrganisationWalletScopeRequired']);
});

test('a source outcome is never mistaken for a reason', () => {
  assert.deepEqual(reasonsIn('{ "reason": "unavailable" }', OUTCOMES), []);
});

test('an empty or missing catalogue is refused, never read as empty', () => {
  assert.throws(() => declaredReasons({ sourceReasons: [] }), /REASON_CATALOGUE_UNREADABLE/);
  assert.throws(() => declaredReasons({}), /REASON_CATALOGUE_UNREADABLE/);
  assert.ok(declaredReasons({ sourceReasons: [{ reason: 'pairNotServed' }] }).has('pairNotServed'));
});

test('outcomes are read from the spec, and a spec without them is refused', () => {
  const spec = { components: { schemas: { QuoteSourceEntry: { oneOf: [{ properties: { status: { const: 'answered' } } }, { properties: { status: { enum: ['unavailable'] } } }] } } } };
  assert.deepEqual([...outcomesFrom(spec)].sort(), ['answered', 'unavailable']);
  assert.throws(() => outcomesFrom({ components: { schemas: {} } }), /REASON_OUTCOMES_UNREADABLE/);
});

// Catches a reason from another declared enum (a balances page's incomplete reason) read as undeclared.
test('reason enums the public spec declares count, and only schemas named for a reason', () => {
  const spec = { components: { schemas: {
    WorkspaceBalancesIncompleteReason: { type: 'string', enum: ['accessSettingsUnavailable'] },
    OrderStatus: { type: 'string', enum: ['settled'] },
  } } };
  const reasons = specReasonEnums(spec);
  assert.ok(reasons.has('accessSettingsUnavailable'));
  assert.ok(!reasons.has('settled'));
  assert.equal(specReasonEnums({}).size, 0);
});
