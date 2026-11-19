import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { endpointVisibleWords, facts, stripSpecDescriptions, visibleWords, wideLines } from './page-shape.mjs';

test('accordion bodies, code blocks and frontmatter are not visible words; tables and titles are', () => {
  const page = ['---', 'title: "T"', '---', 'import X from "/x.mdx"', 'One two three.', '| A | B |', '| --- | --- |', '| four | five |',
    '```bash', 'hidden code words', '```', '<Accordion title="Six seven">', 'hidden body words here', '</Accordion>'].join('\n');
  assert.equal(visibleWords(page), 9);
});

test('facts are backticked tokens, error codes and numbers with units', () => {
  const found = facts('Send `minReceive` or get QUOTE_EXPIRED within 300 seconds, at 50 bps.');
  assert.deepEqual([...found].sort(), ['300 seconds', '50 bps', 'QUOTE_EXPIRED', 'minReceive']);
});

test('only code lines over 80 columns count as wide, never prose', () => {
  const long = 'x'.repeat(81);
  assert.equal(wideLines([long, '```bash', 'short', long, '```', long].join('\n')), 1);
});

// Catches an endpoint page counted without its lead, or with its folded toggle bodies.
test('an endpoint page counts its lead, fits line, table and toggle titles, not toggle bodies', () => {
  const stub = ['---', 'title: "Place order"', 'openapi: "api-reference/openapi.json POST /api/v1/orders"', '---', '',
    "import Notes from '/snippets/endpoints/orders/place-order.mdx'", '', 'Needs Submit orders · Walkthrough: [Place an order](/trade/orders)', '', '<Notes />'].join('\n');
  const snippet = ['| | |', '| --- | --- |', '| **Once** | One order per quote. |', '<Accordion title="Refusals">', 'many hidden words in the body', '</Accordion>'].join('\n');
  const lead = 'Place an order on a quote you hold.';
  assert.equal(endpointVisibleWords(stub, lead, snippet), 8 + visibleWords(stub) + 5 + 1);
  assert.equal(visibleWords(stub), 8);
});

test('stripping the spec descriptions removes operation and API-key text only', () => {
  const spec = { paths: { '/a': { get: { description: 'Uses `fooBar`.', summary: 'S' } } },
    components: { securitySchemes: { api_key: { type: 'apiKey', description: 'Send `X-API-Key`.' } }, schemas: { A: { description: 'kept `fooBar`' } } } };
  const out = JSON.stringify(stripSpecDescriptions(spec));
  assert.ok(!out.includes('Uses') && !out.includes('Send') && out.includes('kept') && out.includes('"summary":"S"'));
});

// Catches a spec description cut that drops a fact no page holds.
function site({ lead, snippet = null, specFacts }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'page-shape-')));
  mkdirSync(path.join(dir, 'scripts'));
  mkdirSync(path.join(dir, 'samples'));
  mkdirSync(path.join(dir, 'snippets', 'samples'), { recursive: true });
  mkdirSync(path.join(dir, 'api-reference', 'orders'), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, 'page-shape.mjs'), path.join(dir, 'scripts', 'page-shape.mjs'));
  writeFileSync(path.join(dir, 'docs.json'), JSON.stringify({ navigation: { tabs: [{ tab: 'Guides', groups: [{ group: 'G', pages: ['guide'] }] }] } }));
  writeFileSync(path.join(dir, 'guide.mdx'), '---\ntitle: "G"\n---\nA short guide.\n');
  writeFileSync(path.join(dir, 'scripts', 'page-facts.json'), JSON.stringify({ facts: {} }));
  writeFileSync(path.join(dir, 'samples', 'wide-lines.json'), JSON.stringify({ snippets: {} }));
  writeFileSync(path.join(dir, 'scripts', 'spec-facts.json'), JSON.stringify({ facts: specFacts, removed: {} }));
  writeFileSync(path.join(dir, 'api-reference', 'openapi.json'), JSON.stringify({ paths: { '/api/v1/orders': { post: { description: lead } } } }));
  const stub = ['---', 'title: "Place order"', 'openapi: "api-reference/openapi.json POST /api/v1/orders"', '---', '',
    ...(snippet ? ["import Notes from '/snippets/endpoints/orders/place-order.mdx'", ''] : []), 'Needs Submit orders', ...(snippet ? ['', '<Notes />'] : [])].join('\n');
  writeFileSync(path.join(dir, 'api-reference', 'orders', 'place-order.mdx'), stub);
  if (snippet) {
    mkdirSync(path.join(dir, 'snippets', 'endpoints', 'orders'), { recursive: true });
    writeFileSync(path.join(dir, 'snippets', 'endpoints', 'orders', 'place-order.mdx'), snippet);
  }
  return (...args) => {
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'page-shape.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, TETRAFI_DOCS_ROOT: dir } });
    return { status: r.status, output: r.stdout + r.stderr };
  };
}

test('a long lead fails only once the page has a snippet; without one it is pending', () => {
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const pending = site({ lead: long, specFacts: {} })();
  assert.equal(pending.status, 0, pending.output);
  assert.match(pending.output, /1 endpoint pages pending/);
  const migrated = site({ lead: long, snippet: '| | |\n| --- | --- |\n| **A** | B. |\n', specFacts: {} })();
  assert.notEqual(migrated.status, 0);
  assert.match(migrated.output, /LEAD_TOO_LONG POST \/api\/v1\/orders 60 words/);
});

test('without the spec descriptions, a fact only the description held is lost; a snippet keeps it', () => {
  const specFacts = { QUOTE_ALREADY_ORDERED: 'POST /api/v1/orders' };
  const lead = 'Orders once: QUOTE_ALREADY_ORDERED.';
  const lost = site({ lead, specFacts })('--without-spec-descriptions');
  assert.notEqual(lost.status, 0);
  assert.match(lost.output, /SPEC_FACT_LOST "QUOTE_ALREADY_ORDERED" \(POST \/api\/v1\/orders\)/);
  assert.equal(site({ lead, specFacts })().status, 0);
  const kept = site({ lead, snippet: '| | |\n| --- | --- |\n| **Once** | `QUOTE_ALREADY_ORDERED`. |\n', specFacts })('--without-spec-descriptions');
  assert.equal(kept.status, 0, kept.output);
});
