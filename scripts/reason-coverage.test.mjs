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

// The export names each union variant as its own schema; the outcomes are behind the `$ref`s.
test('outcomes behind referenced variant schemas are read, and a dangling reference is refused', () => {
  const spec = { components: { schemas: {
    PriceRowStatus: { oneOf: [{ $ref: '#/components/schemas/PriceRowStatusPriced' }, { $ref: '#/components/schemas/PriceRowStatusStale' }] },
    PriceRowStatusPriced: { properties: { status: { enum: ['priced'] } } },
    PriceRowStatusStale: { properties: { status: { enum: ['stale'] } } },
  } } };
  assert.deepEqual([...outcomesFrom(spec)].sort(), ['priced', 'stale']);
  const dangling = { components: { schemas: { QuoteSourceEntry: { oneOf: [{ $ref: '#/components/schemas/Missing' }] } } } };
  assert.throws(() => outcomesFrom(dangling), /REASON_OUTCOMES_UNREADABLE/);
});

// Catches REASON_OUTCOMES_UNREADABLE once open statuses moved from a plain enum to anyOf [{enum}, {type: string}].
test('outcomes are read from an open status enum published as anyOf', () => {
  const open = (values) => ({ anyOf: [{ type: 'string', enum: values }, { type: 'string' }], 'x-extensible-enum': true });
  const spec = { components: { schemas: {
    QuoteSourceEntry: { oneOf: [{ $ref: '#/components/schemas/QuoteSourceEntryAnswered' }, { properties: { status: open(['unavailable', 'filteredOut']) } }] },
    QuoteSourceEntryAnswered: { properties: { status: open(['answered']) } },
    PriceRowStatus: { properties: { status: { anyOf: [{ type: 'string' }] } } },
  } } };
  assert.deepEqual([...outcomesFrom(spec)].sort(), ['answered', 'filteredOut', 'unavailable']);
  // An open status with no listed member names no outcome, so a spec holding only that is refused.
  assert.throws(() => outcomesFrom({ components: { schemas: { PriceRowStatus: { properties: { status: { anyOf: [{ type: 'string' }] } } } } } }), /REASON_OUTCOMES_UNREADABLE/);
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

// Catches an open reason set (no enum) whose fixed values are named only in a description.
test('backticked values in a reason description count; other descriptions do not', () => {
  const spec = { components: { schemas: {
    WorkspaceBalanceUnreachable: { properties: { reason: { description: 'The refusal code; `accessSettingsUnavailable` for `accessSettings`.' } } },
    OrderView: { description: 'Read `settled` orders.', properties: { status: { description: '`filled` or `unfilled`.' } } },
  } } };
  const reasons = specReasonEnums(spec);
  assert.ok(reasons.has('accessSettingsUnavailable'));
  assert.ok(!reasons.has('settled'));
  assert.ok(!reasons.has('filled'));
});
