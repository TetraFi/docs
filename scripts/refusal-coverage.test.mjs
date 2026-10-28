// node scripts/refusal-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { declaredCodes, documentedCodes, generatedCodes, main } from './refusal-coverage.mjs';

const page = readFileSync(path.join(import.meta.dirname, '..', 'trade', 'errors.mdx'), 'utf8');
const rows = [...documentedCodes(page)];
const generatedPage = (codes) => ['## Refusal codes', ...codes.map((code) => `| \`${code}\` | 400 |`), '## Source reasons', '| `NOT_A_REFUSAL` | A reason |'].join('\n');

// Isolated sources and pages prove that the reference, not the hand-written subset, covers codes.
function run(codes, { generated = rows, documented = page } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'refusal-coverage-'));
  const docs = path.join(fixture, 'api');
  mkdirSync(path.join(docs, 'integrator'), { recursive: true });
  mkdirSync(path.join(fixture, 'trade'));
  mkdirSync(path.join(fixture, 'reference'));
  if (codes !== null) writeFileSync(path.join(docs, 'integrator', 'error-codes.json'), JSON.stringify(codes));
  writeFileSync(path.join(fixture, 'trade', 'errors.mdx'), documented);
  if (generated !== null) writeFileSync(path.join(fixture, 'reference', 'error-codes.mdx'), generatedPage(generated));
  const output = [];
  const status = main({ env: { TETRAFI_RFQ_API_DOCS: docs }, siteRoot: fixture, log: (line) => output.push(line) });
  return { status, stdout: output.join('\n') };
}

test('the page has refusal rows to compare', () => {
  for (const code of ['MISSING_WORKSPACE', 'UNKNOWN_ASSET', 'QUOTE_RATE_LIMITED', 'IDEMPOTENCY_CONFLICT']) assert.ok(rows.includes(code), code);
});

test('a declared code with no row fails, naming it', () => {
  const result = run({ codes: [...rows, 'BRAND_NEW_REFUSAL'].map((code) => ({ code, status: 400 })) });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^REFUSAL_UNDOCUMENTED BRAND_NEW_REFUSAL$/m);
  assert.doesNotMatch(result.stdout, /REFUSAL_UNKNOWN/);
});

test('a row the API no longer declares fails, naming it', () => {
  const result = run({ codes: rows.filter((code) => code !== 'UNKNOWN_ASSET').map((code) => ({ code })) });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^REFUSAL_UNKNOWN UNKNOWN_ASSET$/m);
});

test('every declared code with a row passes', () => {
  const result = run({ codes: rows.map((code) => ({ code, status: 400, meaning: 'x' })) });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /0 undocumented, 0 unknown/);
});

test('the reference covers declared codes omitted from the hand-written subset', () => {
  const result = run({ codes: [...rows, 'REFERENCE_ONLY_CODE'].map((code) => ({ code })) }, { generated: [...rows, 'REFERENCE_ONLY_CODE'] });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /0 undocumented, 0 unknown/);
});

test('a generated row is required even when the hand-written page covers the code', () => {
  const result = run({ codes: rows.map((code) => ({ code })) }, { generated: rows.filter((code) => code !== 'UNKNOWN_ASSET') });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^REFUSAL_UNDOCUMENTED UNKNOWN_ASSET$/m);
});

test('a missing or withheld reference fails closed and still reports unknown hand-written codes', () => {
  const result = run({ codes: rows.filter((code) => code !== 'UNKNOWN_ASSET') }, { generated: null });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^REFUSAL_COVERAGE_UNREADABLE reference\/error-codes.mdx$/m);
  assert.match(result.stdout, /^REFUSAL_UNKNOWN UNKNOWN_ASSET$/m);
});

test('source reasons and prose never count as generated refusal codes', () => {
  assert.deepEqual([...generatedCodes(`${generatedPage(['UNKNOWN_ASSET'])}\nMention \`PROSE_ONLY_CODE\`.`)], ['UNKNOWN_ASSET']);
  assert.throws(() => generatedCodes('no table'), /REFUSAL_TABLES_MISSING/);
});

test('hand-written refusal tables are checked, but source reasons and prose are not', () => {
  const documented = page.replace('## Refusals by area', '## Refusals by area\n| Code | Meaning |\n| `EXTRA_TABLE_CODE` | x |');
  const result = run({ codes: rows }, { documented: `${documented}\nMention \`PROSE_ONLY_CODE\`.` });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^REFUSAL_UNKNOWN EXTRA_TABLE_CODE$/m);
  assert.doesNotMatch(result.stdout, /REFUSAL_UNKNOWN (PROSE_ONLY_CODE|API_KEY_ORGANISATION_WALLET_SCOPE_REQUIRED)/);
});

test('no published file is pending, never a pass on an invented list', () => {
  const result = run(null);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.trim(), 'REFUSAL_COVERAGE_PENDING error-codes.json not published');
});

test('a file with no readable codes is refused, never read as empty', () => {
  for (const shape of [{}, { codes: [] }, { something: 'else' }]) {
    const result = run(shape);
    assert.equal(result.status, 1, JSON.stringify(shape));
    assert.match(result.stdout, /^REFUSAL_COVERAGE_UNREADABLE /m);
  }
});

test('accepted shapes', () => {
  const want = ['QUOTE_EXPIRED', 'UNKNOWN_ASSET'];
  for (const shape of [want, want.map((code) => ({ code })), { codes: want }, { errors: Object.fromEntries(want.map((c) => [c, {}])) }])
    assert.deepEqual([...declaredCodes(shape)].sort(), want, JSON.stringify(shape));
});

test('a code the generator withheld under the leak rules counts as generated; others still need a row', () => {
  const page = ['{/* Withheld by the leak rules until the API changes its text: HIDDEN_CODE, OTHER_HIDDEN */}', generatedPage(['SHOWN_CODE'])].join('\n');
  assert.deepEqual([...generatedCodes(page)].sort(), ['HIDDEN_CODE', 'OTHER_HIDDEN', 'SHOWN_CODE']);
  assert.deepEqual([...generatedCodes(generatedPage(['SHOWN_CODE']))], ['SHOWN_CODE']);
});
