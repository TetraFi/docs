// Run with node scripts/sync-contract.test.mjs (not node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Short names for every route the fixtures use; a fixture's names file holds only its own routes.
const NAMES = {
  'POST /api/v1/quotes': 'Request quotes',
  'GET /api/v1/assets': 'List assets',
  'GET /api/v1/me': 'Get current credential',
  'GET /api/v1/session': 'Get session',
  'POST /api/v1/oauth/token': 'Create access token',
  'GET /api/v1/orders/{orderId}': 'Get order',
};

const AUTH_CODES = [{ code: 'AUTH_REQUIRED', status: [401], meaning: 'Authentication is required.', remedy: 'Send credentials.', retryable: false }];

function fixture(spec, names = NAMES, codes = AUTH_CODES, { journeys = null, files = {}, env = {} } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'contract-permissions-'));
  const site = path.join(workspace, 'docs');
  const source = path.join(workspace, 'contract');
  mkdirSync(path.join(site, 'scripts'), { recursive: true });
  mkdirSync(path.join(source, 'integrator'), { recursive: true });
  mkdirSync(path.join(workspace, 'tetrafi-docs/public-site'), { recursive: true });
  for (const script of ['sync-contract.mjs', 'leak-rules.mjs', 'endpoint-names.mjs', 'journeys.mjs']) {
    copyFileSync(path.join(import.meta.dirname, script), path.join(site, 'scripts', script));
  }
  const terms = path.join(workspace, 'tetrafi-docs/public-site/leak-terms.json');
  writeFileSync(terms, JSON.stringify({ terms: ['private.example'] }));
  writeFileSync(path.join(source, 'COMPATIBILITY.md'), '# Compatibility\n\nAdditions stay compatible.\n');
  // Endpoint pages link their guide by its title, so the guides the fixture's routes use exist.
  for (const [page, title] of [['search/how-it-works', 'Request quotes'], ['trade/order-status', 'Order status'], ['trade/orders', 'Place an order'], ['authentication', 'Authentication']]) {
    mkdirSync(path.dirname(path.join(site, `${page}.mdx`)), { recursive: true });
    writeFileSync(path.join(site, `${page}.mdx`), `---\ntitle: "${title}"\n---\n`);
  }
  // The endpoint map groups operations by tag; an untagged fixture operation joins the Quotes group.
  const keys = [];
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      operation.tags ??= ['quotes'];
      keys.push(`${method.toUpperCase()} ${route}`);
    }
  }
  // Every fixture operation is placed: by default request quotes is the one journey step, the rest standalone.
  const journeyData = journeys ?? { journeys: keys.includes('POST /api/v1/quotes') ? [{ id: 'trade', title: 'Trade', guide: '/search/how-it-works', steps: [{ label: 'Quote', ops: ['POST /api/v1/quotes'] }] }] : [] };
  const placed = new Set(journeyData.journeys.flatMap((j) => j.steps.flatMap((s) => s.ops)));
  const journeysFile = path.join(workspace, 'journeys.json');
  writeFileSync(journeysFile, JSON.stringify({ standalone: keys.filter((key) => !placed.has(key)), ...journeyData }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(site, file)), { recursive: true });
    writeFileSync(path.join(site, file), text);
  }
  const namesFile = path.join(workspace, 'endpoint-names.json');
  writeFileSync(namesFile, JSON.stringify(Object.fromEntries(keys.filter((key) => names[key]).map((key) => [key, names[key]]))));
  writeFileSync(path.join(site, 'docs.json'), JSON.stringify({ navigation: { tabs: [{ tab: 'API reference', groups: [{ group: 'Endpoints', openapi: 'api-reference/openapi.json' }] }] } }));
  writeFileSync(path.join(source, 'integrator/openapi.json'), JSON.stringify(spec));
  writeFileSync(path.join(source, 'integrator/error-codes.json'), JSON.stringify({
    version: '1',
    codes,
    sourceReasons: [{ reason: 'unavailable', meaning: 'No quote is available.', remedy: 'Try later.', retryable: true }],
  }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(site, 'scripts/sync-contract.mjs'), ...args], {
      encoding: 'utf8',
      // A fixture publishes few codes, so the first-codes table names only AUTH_REQUIRED unless a test says otherwise.
      env: { ...process.env, TETRAFI_RFQ_API_DOCS: source, TETRAFI_LEAK_TERMS: terms, TETRAFI_ENDPOINT_NAMES: namesFile, TETRAFI_JOURNEYS: journeysFile, TETRAFI_FIRST_CODES: 'AUTH_REQUIRED', ...env },
      cwd: site,
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { run, site, page: path.join(site, 'reference/permissions.mdx'), endpoints: path.join(site, 'reference/endpoints.mdx'),
    errorCodes: path.join(site, 'reference/error-codes.mdx') };
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
      'quotes:read': { label: 'Read quotes', description: 'Read assets and prices.' },
      'orders:write': { label: 'Submit orders', description: 'Place orders.' },
    },
  } },
  schemas: {
    AssetKind: { type: 'string', enum: ['stablecoin', 'crypto'], 'x-extensible-enum': true },
    AssetEntry: { type: 'object', properties: { kind: { $ref: '#/components/schemas/AssetKind' } } },
  } },
});

// Catches lost scope-to-checkbox associations, inherited security, and false API-key access.
test('scopes and app labels generate a row for every integrator operation', () => {
  const { run, page } = fixture(scopedSpec());
  const synced = run();
  assert.equal(synced.status, 0, synced.output);
  const text = readFileSync(page, 'utf8');
  for (const row of [
    '| List assets<br />GET `/api/v1/assets` | `quotes:read` | Read quotes |',
    '| Get current credential<br />GET `/api/v1/me` | None | None |',
    '| Create access token<br />POST `/api/v1/oauth/token` | No API key required | Not applicable |',
    '| Request quotes<br />POST `/api/v1/quotes` | `quotes:read`<br />`orders:write` | Read quotes<br />Submit orders |',
    '| Get session<br />GET `/api/v1/session` | Session only | Not applicable |',
  ]) assert.ok(text.includes(row), `Missing row: ${row}`);
  assert.ok(text.indexOf('`/api/v1/assets`') < text.indexOf('`/api/v1/quotes`'));
  // Every published scope is listed with its label and one-line description.
  assert.ok(text.includes('| `quotes:read` | Read quotes | Read assets and prices. |'));
  assert.ok(text.includes('| `orders:write` | Submit orders | Place orders. |'));
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
  assert.doesNotMatch(text, /GET `/);
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.output);
  assert.match(checked.output, /0 drifted/);
});

// Catches a used scope being published as if its app permission were known.
test('a missing scope label stays visible, is reported, and fails check even without drift', () => {
  for (const labels of [undefined, { 'quotes:read': { label: 'Read quotes' } }, {
    'quotes:read': { label: 'Read quotes' }, 'orders:write': { label: ' ' },
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

// Catches an operation published under its spec summary, or with no name at all.
test('operations are named by their short name, and a missing name fails the sync', () => {
  const { run, page, endpoints } = fixture(scopedSpec());
  assert.equal(run().status, 0);
  assert.ok(readFileSync(page, 'utf8').includes('| Request quotes<br />POST `/api/v1/quotes` |'));
  assert.match(readFileSync(endpoints, 'utf8'), /^\| \[Request quotes\]\(\/api-reference\/quotes\/request-quotes\) \| POST `\/api\/v1\/quotes` \|/m);
  const spec = scopedSpec();
  spec.paths['/api/v1/orders/{orderId}'] = { get: { summary: 'Read an order', security: [{ api_key: ['quotes:read'] }] } };
  const unnamed = fixture(spec, Object.fromEntries(Object.entries(NAMES).filter(([key]) => key !== 'GET /api/v1/orders/{orderId}')));
  const failed = unnamed.run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /ENDPOINT_NAME_MISSING GET \/api\/v1\/orders\/\{orderId\}/);
});

// Catches description text Mintlify would drop as MDX: a bare {param}, <https://…> or <placeholder>.
test('a description with a bare brace or angle bracket fails the sync; backticked ones pass', () => {
  for (const text of ['Read it with GET /orders/{orderId}.', 'Guide: <https://example.com/guide>.', 'Send client_id=<UUID>.']) {
    const spec = scopedSpec();
    spec.paths['/api/v1/assets'].get.description = text;
    const failed = fixture(spec).run();
    assert.notEqual(failed.status, 0, text);
    assert.match(failed.output, /SPEC_DESCRIPTION_MDX_HAZARD 1 descriptions/);
  }
  const spec = scopedSpec();
  spec.paths['/api/v1/assets'].get.description = 'Read it with `GET /orders/{orderId}`; send `client_id=<UUID>`. Guide: [how it works](https://example.com/guide).';
  const synced = fixture(spec).run();
  assert.equal(synced.status, 0, synced.output);
});

// Catches codes leaving their product area, a lost docUrl anchor, a dropped status, and a code
// silently filed under a catch-all.
test('error codes group by product area in journey order, each area folded under its name', () => {
  const row = (code, status) => ({ code, status, meaning: `${code} meaning.`, remedy: 'Do this.', retryable: false });
  const { run, errorCodes } = fixture(scopedSpec(), NAMES, [
    row('WEBHOOK_NOT_FOUND', [404]), row('QUOTE_EXPIRED', [410]), row('AUTH_REQUIRED', [401]),
    row('API_KEY_ORGANISATION_WALLET_SCOPE_REQUIRED', [403]), row('ORDER_NOT_FOUND', [404, 410]),
  ]);
  const synced = run();
  assert.equal(synced.status, 0, synced.output);
  const text = readFileSync(errorCodes, 'utf8');
  const at = (area) => text.indexOf(`<Accordion title="${area}">`);
  assert.ok(at('Requests, keys and access') > 0 && at('Requests, keys and access') < at('Quotes, prices and assets'));
  assert.ok(at('Quotes, prices and assets') < at('Orders') && at('Orders') < at('Wallets and custody') && at('Wallets and custody') < at('Webhooks'));
  // The longest prefix wins: API_KEY_ORGANISATION_WALLET is a wallet code, not an API-key code.
  assert.ok(text.indexOf('API_KEY_ORGANISATION_WALLET_SCOPE_REQUIRED') > at('Wallets and custody'));
  // The docUrl anchor stays on the row, clear of the sticky header, and the status keeps every value.
  assert.ok(text.includes(`| <span id="ORDER_NOT_FOUND" style={{ scrollMarginTop: '10rem' }}></span>\`ORDER_NOT_FOUND\` | 404, 410 |`));
  // Every area is closed (no defaultOpen), no area heading is left, and each says what it covers and how many codes it holds.
  assert.ok(!text.includes('defaultOpen') && !/^### /m.test(text));
  assert.ok(text.slice(at('Orders')).startsWith('<Accordion title="Orders">\n\nPlacing, following and cancelling an order'));
  assert.match(text.slice(at('Orders')), /^<Accordion title="Orders">\n\n[^\n]* 1 code\.\n/);
  // Each accordion closes before the next opens.
  const tags = [...text.matchAll(/<\/?Accordion\b/g)].map((m) => m[0]);
  assert.ok(tags.every((tag, i) => tag === (i % 2 ? '</Accordion' : '<Accordion')));
  assert.equal(run('--check').status, 0);
});

test('the first-codes table names its codes with their contract status and links each to its row', () => {
  const row = (code, status) => ({ code, status, meaning: `${code} meaning.`, remedy: 'Do this.', retryable: false });
  const codes = [row('AUTH_REQUIRED', [401]), row('RATE_LIMITED', [429]), row('ORDER_NOT_FOUND', [404])];
  const { run, errorCodes } = fixture(scopedSpec(), NAMES, codes, { env: { TETRAFI_FIRST_CODES: 'RATE_LIMITED,AUTH_REQUIRED' } });
  const synced = run();
  assert.equal(synced.status, 0, synced.output);
  const text = readFileSync(errorCodes, 'utf8');
  const first = text.slice(text.indexOf('## Codes you will meet first'), text.indexOf('## Refusal codes'));
  assert.ok(text.indexOf('## Codes you will meet first') > 0);
  // In the listed order, with the contract's status, linking to the row's anchor; unlisted codes stay out.
  assert.ok(first.indexOf('| [`RATE_LIMITED`](#RATE_LIMITED) | 429 | Wait `Retry-After` seconds') < first.indexOf('| [`AUTH_REQUIRED`](#AUTH_REQUIRED) | 401 |'));
  assert.ok(!first.includes('ORDER_NOT_FOUND') && !first.includes('<span'));
  // A listed code the contract does not publish refuses the page instead of dropping out of the table.
  const missing = fixture(scopedSpec(), NAMES, codes, { env: { TETRAFI_FIRST_CODES: 'AUTH_REQUIRED,QUOTE_EXPIRED' } }).run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /ERROR_CODE_FIRST_UNKNOWN QUOTE_EXPIRED/);
  // A code with no What to do line refuses too.
  const unnamed = fixture(scopedSpec(), NAMES, codes, { env: { TETRAFI_FIRST_CODES: 'ZEBRA_STRIPES_MISSING' } }).run();
  assert.match(unnamed.output, /ERROR_CODE_FIRST_UNNAMED ZEBRA_STRIPES_MISSING/);
});

test('--only writes and checks just the named output and leaves every other generated file alone', () => {
  const { run, site, errorCodes, page } = fixture(scopedSpec());
  assert.equal(run().status, 0);
  writeFileSync(page, 'hand edit\n');
  writeFileSync(errorCodes, 'hand edit\n');
  const synced = run('--only', 'reference/error-codes.mdx');
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /sync-contract --only: wrote 1 files/);
  assert.notEqual(readFileSync(errorCodes, 'utf8'), 'hand edit\n');
  assert.equal(readFileSync(page, 'utf8'), 'hand edit\n');
  // --check --only judges only the named file: clean here although permissions.mdx drifted.
  const only = run('--check', '--only=./reference/error-codes.mdx');
  assert.equal(only.status, 0, only.output);
  assert.ok(!only.output.includes('permissions.mdx'));
  const whole = run('--check');
  assert.equal(whole.status, 1);
  assert.match(whole.output, /CONTRACT_DRIFT reference\/permissions\.mdx/);
  // A name that is not an output, or a missing value, refuses the run and writes nothing.
  writeFileSync(path.join(site, 'compatibility.mdx'), 'hand edit\n');
  const unknown = run('--only', 'reference/error-code.mdx');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.output, /SYNC_ONLY_UNKNOWN_OUTPUT reference\/error-code\.mdx/);
  assert.match(run('--only').output, /SYNC_ONLY_VALUE_MISSING/);
  assert.equal(readFileSync(path.join(site, 'compatibility.mdx'), 'utf8'), 'hand edit\n');
});

test('a code no area claims refuses the page', () => {
  const { run } = fixture(scopedSpec(), NAMES, [
    { code: 'ZEBRA_STRIPES_MISSING', status: [400], meaning: 'Unmapped.', remedy: 'Map it.', retryable: false },
  ]);
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /ERROR_CODE_AREA_UNMAPPED ZEBRA_STRIPES_MISSING/);
});

test('each endpoint page links the guide that walks through it, by the guide title', () => {
  const { run, page } = fixture(scopedSpec());
  assert.equal(run().status, 0);
  const site = path.dirname(path.dirname(page));
  assert.match(readFileSync(path.join(site, 'api-reference/quotes/request-quotes.mdx'), 'utf8'), /Walkthrough: \[Request quotes\]\(\/search\/how-it-works\)$/m);
});

// Catches a page that does not say where its call sits, or a new operation placed nowhere.
test('a journey operation gets a step line, a standalone one only its permission', () => {
  const journeys = { journeys: [{ id: 'trade', title: 'Trade', guide: '/search/how-it-works', steps: [
    { label: 'Quote', ops: ['POST /api/v1/quotes'] }, { label: 'Credential', ops: ['GET /api/v1/me'] }] }] };
  const { run, page } = fixture(scopedSpec(), NAMES, AUTH_CODES, { journeys });
  const synced = run();
  assert.equal(synced.status, 0, synced.output);
  const site = path.dirname(path.dirname(page));
  const quotes = readFileSync(path.join(site, 'api-reference/quotes/request-quotes.mdx'), 'utf8');
  assert.match(quotes, /^\*\*Step 1 of 2:\*\* \*\*Quote\*\* → Credential<br \/>\nNeeds Read quotes and Submit orders · Walkthrough: /m);
  assert.match(readFileSync(path.join(site, 'api-reference/quotes/list-assets.mdx'), 'utf8'), /^Needs Read quotes · Walkthrough: /m);
});

test('an operation in no journey and not standalone fails the sync', () => {
  const { run } = fixture(scopedSpec(), NAMES, AUTH_CODES, { journeys: { journeys: [], standalone: [] } });
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /JOURNEY_OPERATION_UNPLACED/);
});

test('a journey step naming an operation the spec lacks fails the sync', () => {
  const journeys = { journeys: [{ id: 'x', title: 'X', guide: '/search/how-it-works', steps: [{ label: 'Gone', ops: ['GET /api/v1/gone'] }] }] };
  const failed = fixture(scopedSpec(), NAMES, AUTH_CODES, { journeys }).run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /JOURNEY_OPERATION_UNKNOWN GET \/api\/v1\/gone/);
});

test('a snippet is imported into its stub; a stub without one still renders', () => {
  const files = { 'snippets/endpoints/quotes/request-quotes.mdx': '| | |\n| --- | --- |\n| **Once** | A rule. |\n' };
  const { run, page } = fixture(scopedSpec(), NAMES, AUTH_CODES, { files });
  assert.equal(run().status, 0);
  const site = path.dirname(path.dirname(page));
  const quotes = readFileSync(path.join(site, 'api-reference/quotes/request-quotes.mdx'), 'utf8');
  assert.match(quotes, /^import Notes from '\/snippets\/endpoints\/quotes\/request-quotes\.mdx'$/m);
  assert.match(quotes, /^<Notes \/>$/m);
  const assets = readFileSync(path.join(site, 'api-reference/quotes/list-assets.mdx'), 'utf8');
  assert.ok(!assets.includes('import Notes') && !assets.includes('<Notes'));
});

test('an intro page leads its group and survives the sync', () => {
  const intro = '---\ntitle: "Quotes"\n---\n\n1. Ask.\n';
  const { run, page } = fixture(scopedSpec(), NAMES, AUTH_CODES, { files: { 'api-reference/intros/quotes.mdx': intro } });
  assert.equal(run().status, 0);
  const site = path.dirname(path.dirname(page));
  const nav = JSON.parse(readFileSync(path.join(site, 'docs.json'), 'utf8')).navigation.tabs[0].groups.find((g) => g.group === 'Quotes');
  assert.equal(nav.pages[0], 'api-reference/intros/quotes');
  const checked = run('--check');
  assert.ok(!/CONTRACT_DRIFT api-reference\/intros/.test(checked.output), checked.output);
  assert.equal(readFileSync(path.join(site, 'api-reference/intros/quotes.mdx'), 'utf8'), intro);
});
