// Run with node scripts/field-coverage.test.mjs (not node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, jqReads, pageReads, sampleReads, responseSchemas } from './field-coverage.mjs';

function fixture(sample, schema = { type: 'object', properties: { dispatch: { type: 'object', properties: { venueOrderId: { type: 'string' } } } } }) {
  const root = mkdtempSync(path.join(tmpdir(), 'field-coverage-'));
  for (const dir of ['samples/http', 'contract/integrator']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['response'] } }));
  writeFileSync(path.join(root, 'response.mdx'), '# Example\n');
  writeFileSync(path.join(root, 'samples/http/example.sh'), sample);
  const spec = { paths: { '/orders': { get: { responses: { 200: { content: { 'application/json': { schema } } } } } } } };
  writeFileSync(path.join(root, 'contract/integrator/openapi.json'), JSON.stringify(spec));
  return { root, env: { TETRAFI_RFQ_API_DOCS: path.join(root, 'contract') } };
}

test('a sample reading an undocumented dispatch field fails', () => {
  const input = fixture(`response=$(tetrafi GET /orders)\njq '.dispatch.inputSpent' <<<"$response"\n`);
  const output = [];
  assert.equal(main({ ...input, log: (line) => output.push(line) }), 1);
  assert.ok(output.some((line) => /FIELD_UNDOCUMENTED samples\/http\/example.sh:2 \.dispatch\.inputSpent/.test(line)), output.join('\n'));
});

test('a documented sample field passes', () => {
  const input = fixture(`response=$(tetrafi GET /orders)\njq '.dispatch.venueOrderId' <<<"$response"\n`);
  const output = [];
  assert.equal(main({ ...input, log: (line) => output.push(line) }), 0, output.join('\n'));
});

test('a missing spec fails closed', () => {
  const input = fixture(''); const output = [];
  assert.equal(main({ ...input, env: { TETRAFI_RFQ_API_DOCS: path.join(input.root, 'missing') }, log: (line) => output.push(line) }), 1);
  assert.match(output[0], /^FIELD_SPEC_MISSING /);
});

test('jq follows arrays, pipes, select, aliases, interpolation and shorthand keys', () => {
  const fields = jqReads('.quotes[] | select(.next.kind == "order") | {id, venue: .legs[0].venue.id, amount: "\\(.pay.amount)"}').map((read) => read.parts.join('.'));
  for (const field of ['quotes.[]', 'quotes.[].next.kind', 'quotes.[].id', 'quotes.[].legs.[].venue.id', 'quotes.[].pay.amount']) assert.ok(fields.includes(field), `${field}: ${fields}`);
  const aliases = jqReads('.quotes[] as $q | $q.bindingOptions[] | .candidates[] | {id: $q.id, label}').map((read) => read.parts.join('.'));
  assert.ok(aliases.includes('quotes.[].id'));
  assert.ok(aliases.includes('quotes.[].bindingOptions.[].candidates.[].label'));
});

test('request builders and reads of local output are not API readers', () => {
  const fields = sampleReads(`request=$(jq -n '{madeUp: "request"}')\nsummary=$(jq -n '{madeUp: "local"}')\njq '.madeUp' <<<"$summary"\njq '.dispatch.venueOrderId' <<<"$response"`).map((read) => read.parts.join('.'));
  assert.deepEqual(fields, ['dispatch.venueOrderId']);
});

test('response JSON includes every nested key but not requests or script projections', () => {
  const page = '## Response\n```json\n{"dispatch":{"venueOrderId":"x","missing":"x"}}\n```\n## Request\n```json Request\n{"notAResponse":true}\n```\n```json Output\n{"localProjection":true}\n```';
  assert.deepEqual(pageReads(page).map((read) => read.parts.join('.')), ['dispatch', 'dispatch.venueOrderId', 'dispatch.missing']);
});

test('an unlabelled block is a response even in a section that says send or summary', () => {
  const page = '## Specific venues\nSend this id:\n\n```json\n{"venue":{"id":"x","madeUp":1}}\n```\n\nThe script\'s last line is a summary:\n\n```json\n{"localOnly":true}\n```';
  assert.deepEqual(pageReads(page).map((read) => read.parts.join('.')), ['venue', 'venue.id', 'venue.madeUp', 'localOnly']);
});

test('resolution follows response refs, composition and explicit maps, not unused schemas', () => {
  const spec = { paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Response' } } } } } } } }, components: { schemas: {
    Response: { allOf: [{ properties: { id: { type: 'string' } } }, { oneOf: [{ properties: { map: { additionalProperties: { anyOf: [{ properties: { amount: { type: 'string' } } }] } } } }] }] },
    Unused: { properties: { undocumented: { type: 'string' } } },
  } } };
  const documented = responseSchemas(spec);
  assert.equal(documented(['id']), true);
  assert.equal(documented(['map', 'anyKey', 'amount']), true);
  assert.equal(documented(['map', 'anyKey', 'missing']), false);
  assert.equal(documented(['undocumented']), false);
});

test('an open detail map cannot document arbitrary fields elsewhere', () => {
  const spec = { paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: {
    oneOf: [{ properties: { dispatch: { properties: { venueOrderId: { type: 'string' } } } } },
      { properties: { details: { properties: { reason: { type: 'string' } }, additionalProperties: {} } } }],
  } } } } } } } } };
  const documented = responseSchemas(spec);
  assert.equal(documented(['details', 'codeSpecific', 'nested']), true);
  assert.equal(documented(['dispatch', 'inputSpent']), false);
  assert.equal(documented(['totallyUndocumented']), false);
});

test('real shell comments, capture results and local builders preserve reader coverage', () => {
  const sample = `# This account's response stays a response.\nresponse=$(tetrafi GET /orders)\nrequest=$(jq -n '{madeUp: true}')\njq 'select(.error == "LIMITED") | .details.retryAfter | capture("(?<s>[0-9]+)").s' <<<"$response"\njq '.dispatch.inputSpent' <<<"$response"`;
  const fields = sampleReads(sample).map((read) => read.parts.join('.'));
  assert.deepEqual(fields, ['error', 'details.retryAfter', 'dispatch.inputSpent']);
});

test('a published response block fails for a nested undocumented key', () => {
  const input = fixture(''); const output = [];
  writeFileSync(path.join(input.root, 'response.mdx'), '## Response\n```json\n{"dispatch":{"inputSpent":"1"}}\n```');
  assert.equal(main({ ...input, log: (line) => output.push(line) }), 1);
  assert.ok(output.some((line) => /FIELD_UNDOCUMENTED response.mdx:3 \.dispatch\.inputSpent/.test(line)), output.join('\n'));
});

test('unreadable specs and unresolved refs fail closed', () => {
  const input = fixture(''); const output = [];
  writeFileSync(path.join(input.env.TETRAFI_RFQ_API_DOCS, 'integrator/openapi.json'), '{');
  assert.equal(main({ ...input, log: (line) => output.push(line) }), 1);
  assert.match(output[0], /^FIELD_COVERAGE_UNREADABLE /);
  assert.throws(() => responseSchemas({ paths: { '/x': { get: { responses: { 200: { $ref: '#/missing' } } } } } }), /unresolved reference/);
});

// Two operations whose fields must not document each other: GET /orders has no `message`, and
// only POST /quotes's refusal does.
const twoOperations = { paths: {
  '/orders': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {
    id: { type: 'string' }, dispatch: { type: 'object', properties: { venueOrderId: { type: 'string' } } } } } } } } } } },
  '/quotes': { post: { responses: {
    200: { content: { 'application/json': { schema: { type: 'object', properties: {
      quotes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, next: { type: 'object', properties: { kind: { type: 'string' } } } } } } } } } } },
    400: { content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } } } },
  } } },
} };

function site({ page = '# Example\n', sample = '', spec = twoOperations, sdk = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'field-coverage-'));
  for (const dir of ['samples/http', 'contract/integrator', 'snippets/samples']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['response'] } }));
  writeFileSync(path.join(root, 'response.mdx'), page);
  if (sample !== null) writeFileSync(path.join(root, 'samples/http/example.sh'), sample);
  writeFileSync(path.join(root, 'contract/integrator/openapi.json'), JSON.stringify(spec));
  const env = { TETRAFI_RFQ_API_DOCS: path.join(root, 'contract') };
  if (sdk) {
    const examples = path.join(root, 'sdk', 'examples');
    mkdirSync(examples, { recursive: true }); mkdirSync(path.join(root, 'sdk', 'src'));
    writeFileSync(path.join(examples, '01-example.ts'), sdk.example);
    writeFileSync(path.join(root, 'sdk', 'src', 'client.ts'), sdk.client);
    writeFileSync(path.join(root, 'samples', 'sdk-regions.json'), JSON.stringify({ regions: { example: 'example' } }));
    writeFileSync(path.join(root, 'snippets/samples/example.mdx'), sdk.snippet);
    env.TETRAFI_SDK_EXAMPLES = examples;
  }
  const output = [];
  const status = main({ root, env, log: (line) => output.push(line) });
  return { status, output: output.join('\n') };
}

test('a sample read is rooted at the operation that produced it, not at any schema', () => {
  const wrong = site({ sample: `orders=$(tetrafi GET /orders)\njq -r '.message' <<<"$orders"\n` });
  assert.equal(wrong.status, 1, wrong.output);
  assert.match(wrong.output, /FIELD_UNDOCUMENTED samples\/http\/example.sh:2 \.message/);
  const right = site({ sample: `if refusal=$(tetrafi POST /quotes '{}'); then exit 1; fi\njq -r '.message' <<<"$refusal"\n` });
  assert.equal(right.status, 0, right.output);
  assert.match(right.output, /1 at their operation's response/);
});

test('a derived variable keeps its prefix, and a helper function carries its operation', () => {
  const sample = `quote_request() {\n  tetrafi POST /quotes "$1"\n}\nquotes=$(quote_request '{}')\nbest=$(jq -c '.quotes[0]' <<<"$quotes")\njq -r '.next.kind, .message' <<<"$best"\n`;
  const result = site({ sample });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FIELD_UNDOCUMENTED samples\/http\/example.sh:6 \.quotes\[\]\.message/);
  assert.doesNotMatch(result.output, /\.quotes\[\]\.next\.kind/);
});

test('a read whose operation cannot be known falls back to any response, and is counted', () => {
  const result = site({ sample: `check() { jq -r '.dispatch.venueOrderId' <<<"$1"; }\n` });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 on any response \(operation unknown\)/);
});

test('a page block is rooted at the operation its paragraph names', () => {
  const page = '## Read an order\n\n`GET /orders` answers:\n\n```json\n{"id":"o_1","message":"x"}\n```\n';
  const result = site({ page });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FIELD_UNDOCUMENTED response.mdx:6 \.message/);
});

test('a block whose operation is unknown must still fit one object', () => {
  const page = '## Mixed\n\n```json\n{"quotes":[],"message":"x"}\n```\n';
  const result = site({ page });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FIELD_UNDOCUMENTED response.mdx:4 \.(quotes|message)/);
  assert.match(result.output, /on any response \(operation unknown\)/);
});

test('a paragraph that says summary does not exempt the block; only its own label does', () => {
  const page = 'The script\'s last line is a summary:\n\n```json\n{"madeUp":true}\n```\n\n```json Output\n{"localProjection":true}\n```\n';
  const result = site({ page });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FIELD_UNDOCUMENTED response.mdx:4 \.madeUp/);
  assert.doesNotMatch(result.output, /localProjection/);
});

test('JSON blocks are scanned whatever the fence case', () => {
  const result = site({ page: '`GET /orders` answers:\n\n```JSON\n{"madeUp":true}\n```\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FIELD_UNDOCUMENTED response.mdx:4 \.madeUp/);
});

test('TypeScript SDK tabs are scanned for response reads, rooted at the SDK method\'s operation', () => {
  const example = [
    'async function main() {',
    '  // #region example',
    '  const set = await client.quote({ amount: \'1\' });',
    '  // Comments name `set.notRead`, and strings say "set.notRead".',
    '  const ids = set.quotes.filter((quote) => quote.next.kind === \'order\').map((quote) => quote.id);',
    '  const best = set.quotes.find((quote) => quote.madeUp);',
    '  console.log(best?.id, best.inventedToo);',
    '  // #endregion example',
    '}',
  ].join('\n');
  const client = "  return {\n    async quote(body) {\n      return unwrap(await raw.POST('/quotes', { body }));\n    },\n  };\n";
  const snippet = "{/* Generated */}\n\n<CodeGroup>\n\n```typescript TypeScript SDK\nconst set = await client.quote({ amount: '1' });\n// Comments\nconst ids = x;\nconst best = y;\nconsole.log();\n```\n\n</CodeGroup>\n";
  const result = site({ sdk: { example, client, snippet } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FIELD_UNDOCUMENTED snippets\/samples\/example.mdx:9 \.quotes\[\]\.madeUp/);
  assert.match(result.output, /FIELD_UNDOCUMENTED snippets\/samples\/example.mdx:10 \.quotes\[\]\.inventedToo/);
  assert.doesNotMatch(result.output, /notRead|\.quotes\[\]\.next|\.quotes\[\]\.id\b/);
});

test('no reads at all is a failure, never a pass', () => {
  const result = site({ page: '# Nothing here\n', sample: '#!/usr/bin/env bash\necho hi\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /^FIELD_NO_READS/m);
});
