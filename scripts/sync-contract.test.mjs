// Run with node scripts/sync-contract.test.mjs (not node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function fixture(spec) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'contract-permissions-'));
  const site = path.join(workspace, 'docs');
  const source = path.join(workspace, 'contract');
  mkdirSync(path.join(site, 'scripts'), { recursive: true });
  mkdirSync(path.join(source, 'integrator'), { recursive: true });
  mkdirSync(path.join(workspace, 'tetrafi-docs/public-site'), { recursive: true });
  for (const script of ['sync-contract.mjs', 'leak-rules.mjs']) {
    copyFileSync(path.join(import.meta.dirname, script), path.join(site, 'scripts', script));
  }
  const terms = path.join(workspace, 'tetrafi-docs/public-site/leak-terms.json');
  writeFileSync(terms, JSON.stringify({ terms: ['private.example'] }));
  writeFileSync(path.join(source, 'COMPATIBILITY.md'), '# Compatibility\n\nAdditions stay compatible.\n');
  writeFileSync(path.join(source, 'integrator/openapi.json'), JSON.stringify(spec));
  writeFileSync(path.join(source, 'integrator/error-codes.json'), JSON.stringify({
    version: '1',
    codes: [{ code: 'AUTH_REQUIRED', status: [401], meaning: 'Authentication is required.', remedy: 'Send credentials.', retryable: false }],
    sourceReasons: [{ reason: 'unavailable', meaning: 'No quote is available.', remedy: 'Try later.', retryable: true }],
  }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(site, 'scripts/sync-contract.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, TETRAFI_RFQ_API_DOCS: source, TETRAFI_LEAK_TERMS: terms },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { run, page: path.join(site, 'reference/permissions.mdx') };
}

const scopedSpec = () => ({
  openapi: '3.1.0',
  security: [{ api_key: ['quotes:read'] }],
  paths: {
    '/api/v1/quotes': { post: { summary: 'Request quotes', security: [
      { api_key: ['quotes:read', 'orders:write'] }, { bearer_auth: ['quotes:read', 'orders:write'] },
    ] } },
    '/api/v1/assets': { get: { summary: 'List assets' } },
    '/api/v1/me': { get: { summary: 'Inspect this key', security: [{ api_key: [] }, { bearer_auth: [] }] } },
    '/api/v1/session': { get: { summary: 'Read the session', security: [{ bearer_auth: ['profile:read'] }] } },
    '/api/v1/oauth/token': { post: { summary: 'Exchange credentials', security: [{}] } },
  },
  components: { securitySchemes: { api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key',
    'x-tetrafi-scopes': {
      'quotes:read': { permission: 'Read quotes', description: 'Read assets and prices.' },
      'orders:write': { permission: 'Submit orders', description: 'Place orders.' },
    },
  } } },
});

// Catches lost scope-to-checkbox associations, inherited security, and false API-key access.
test('scopes and app labels generate a row for every integrator operation', () => {
  const { run, page } = fixture(scopedSpec());
  const synced = run();
  assert.equal(synced.status, 0, synced.output);
  const text = readFileSync(page, 'utf8');
  for (const row of [
    '| GET | `/api/v1/assets` | List assets | `quotes:read` | Read quotes |',
    '| GET | `/api/v1/me` | Inspect this key | None | None |',
    '| POST | `/api/v1/oauth/token` | Exchange credentials | No API key required | Not applicable |',
    '| POST | `/api/v1/quotes` | Request quotes | `quotes:read`<br />`orders:write` | Read quotes<br />Submit orders |',
    '| GET | `/api/v1/session` | Read the session | Session only | Not applicable |',
  ]) assert.ok(text.includes(row), `Missing row: ${row}`);
  assert.ok(text.indexOf('`/api/v1/assets`') < text.indexOf('`/api/v1/quotes`'));
  assert.equal(run('--check').status, 0);
});

// Catches a fabricated no-permission matrix when the source has not exported scopes yet.
test('no scopes anywhere generates only an unavailable placeholder and an informational line', () => {
  const { run, page } = fixture({ openapi: '3.1.0', paths: {
    '/api/v1/assets': { get: { summary: 'List assets', security: [{ api_key: [] }, { bearer_auth: [] }] } },
  } });
  const synced = run();
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /^SCOPES_NOT_EXPORTED\b/m);
  const text = readFileSync(page, 'utf8');
  assert.match(text, /permission matrix is not yet available/i);
  assert.doesNotMatch(text, /\| GET \|/);
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.output);
  assert.match(checked.output, /0 drifted/);
});

// Catches a used scope being published as if its app permission were known.
test('a missing scope label stays visible, is reported, and fails check even without drift', () => {
  for (const labels of [undefined, { 'quotes:read': { permission: 'Read quotes' } }, {
    'quotes:read': { permission: 'Read quotes' }, 'orders:write': { permission: ' ' },
  }]) {
    const spec = scopedSpec();
    spec.components.securitySchemes.api_key['x-tetrafi-scopes'] = labels;
    const { run, page } = fixture(spec);
    const synced = run();
    assert.equal(synced.status, 0, synced.output);
    assert.match(synced.output, /^SCOPE_LABEL_MISSING orders:write$/m);
    assert.match(readFileSync(page, 'utf8'), /`orders:write`.*SCOPE_LABEL_MISSING/);
    const checked = run('--check');
    assert.equal(checked.status, 1, checked.output);
    assert.match(checked.output, /^SCOPE_LABEL_MISSING orders:write$/m);
    assert.match(checked.output, /0 drifted/);
  }
});

// Catches the matrix being omitted from the generator's managed drift outputs.
test('check reports a hand-edited permissions page and regeneration repairs it', () => {
  const { run, page } = fixture(scopedSpec());
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(page, 'Hand-edited permission matrix.\n');
  const checked = run('--check');
  assert.equal(checked.status, 1, checked.output);
  assert.match(checked.output, /^CONTRACT_DRIFT reference\/permissions.mdx$/m);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
});
