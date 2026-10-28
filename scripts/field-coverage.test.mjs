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

test('an unlabelled block is a response even in a section that says send', () => {
  const page = '## Specific venues\nSend this id:\n\n```json\n{"venue":{"id":"x","madeUp":1}}\n```\n\nThe script\'s last line is a summary:\n\n```json\n{"localOnly":true}\n```';
  assert.deepEqual(pageReads(page).map((read) => read.parts.join('.')), ['venue', 'venue.id', 'venue.madeUp']);
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
