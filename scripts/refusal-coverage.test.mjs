// node scripts/refusal-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { declaredCodes, documentedCodes } from './refusal-coverage.mjs';

const script = path.join(import.meta.dirname, 'refusal-coverage.mjs');
const page = readFileSync(path.join(import.meta.dirname, '..', 'trade', 'errors.mdx'), 'utf8');
const rows = [...documentedCodes(page)];

// A fixture API docs directory holding integrator/error-codes.json, or nothing when `codes` is null.
function run(codes) {
  const docs = mkdtempSync(path.join(tmpdir(), 'refusal-coverage-'));
  if (codes !== null) {
    mkdirSync(path.join(docs, 'integrator'));
    writeFileSync(path.join(docs, 'integrator', 'error-codes.json'), JSON.stringify(codes));
  }
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, TETRAFI_RFQ_API_DOCS: docs } });
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
