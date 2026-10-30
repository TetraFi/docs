// Run with node scripts/sync-postman.test.mjs (not node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { collectionFromSpec, main, signingScript } from './sync-postman.mjs';

const spec = { openapi: '3.1.0', paths: {
  '/api/v1/assets': { get: { parameters: [
    { name: 'X-Workspace-Id', in: 'header', required: true, schema: { type: 'string' } },
    { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
  ] } },
  '/api/v1/orders/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    get: {}, post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } } } } },
}, components: { schemas: { Body: { type: 'object', required: ['quoteId'], properties: {
  quoteId: { type: 'string' }, optional: { type: 'boolean' },
} } } } };

test('collection has every operation, three empty-safe variables, inherited auth and signing', () => {
  const collection = collectionFromSpec(spec);
  assert.match(collection.info.schema, /collection\/v2\.1\.0/);
  assert.deepEqual(collection.variable.map(({ key, value }) => [key, value]), [
    ['baseUrl', 'https://api.tetrafi.io'], ['apiKey', ''], ['signingSecret', ''],
  ]);
  assert.equal(collection.item.length, 3);
  assert.equal(collection.auth.type, 'apikey');
  assert.equal(collection.auth.apikey.find((entry) => entry.key === 'key').value, 'X-API-Key');
  assert.equal(collection.event[0].script.exec.join('\n'), signingScript);
  assert.equal(collection.protocolProfileBehavior.disableUrlEncoding, true);
  const assets = collection.item.find((item) => item.name === 'GET /api/v1/assets').request;
  assert.equal(assets.header.some((entry) => entry.key === 'X-Workspace-Id'), false);
  assert.equal(assets.url.query[0].disabled, true);
  const order = collection.item.find((item) => item.name === 'POST /api/v1/orders/{id}').request;
  assert.equal(order.url.path.at(-1), ':id');
  assert.equal(order.url.variable[0].value, '<id>');
  assert.deepEqual(JSON.parse(order.body.raw), { quoteId: '<quoteId>' });
});

test('generator honors the source override and drift fails until regeneration', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'postman-sync-'));
  const siteRoot = path.join(workspace, 'docs');
  const source = path.join(workspace, 'contract');
  mkdirSync(siteRoot);
  mkdirSync(path.join(source, 'integrator'), { recursive: true });
  mkdirSync(path.join(workspace, 'tetrafi-docs/public-site'), { recursive: true });
  writeFileSync(path.join(workspace, 'tetrafi-docs/public-site/leak-terms.json'), JSON.stringify({ terms: ['private.example'] }));
  writeFileSync(path.join(source, 'integrator/openapi.json'), JSON.stringify(spec));
  const input = { siteRoot, env: { TETRAFI_RFQ_API_DOCS: source }, log: () => {} };
  assert.equal(main({ ...input, check: false }), 0);
  assert.equal(main({ ...input, check: true }), 0);
  const output = path.join(siteRoot, 'api-reference/tetrafi.postman_collection.json');
  writeFileSync(output, `${readFileSync(output, 'utf8')} `);
  const messages = [];
  assert.equal(main({ ...input, check: true, log: (line) => messages.push(line) }), 1);
  assert.ok(messages.some((line) => line.startsWith('POSTMAN_DRIFT ')));
  assert.equal(main({ ...input, check: false }), 0);
  assert.equal(main({ ...input, check: true }), 0);
  assert.throws(() => main({ ...input, env: { TETRAFI_RFQ_API_DOCS: path.join(workspace, 'missing') } }), /POSTMAN_SPEC_MISSING/);
  writeFileSync(path.join(source, 'integrator/openapi.json'), JSON.stringify({ ...spec, paths: {
    '/api/v1/assets': { get: { summary: 'Do not publish private.example' } },
  } }));
  assert.throws(() => main({ ...input, check: false }), /POSTMAN_WITHHELD/);
});

test('default source reads committed HEAD and ignores uncommitted source edits', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'postman-head-'));
  const siteRoot = path.join(workspace, 'docs'), rfqRoot = path.join(workspace, 'tetrafi-rfq');
  mkdirSync(siteRoot);
  mkdirSync(path.join(rfqRoot, 'docs/api/integrator'), { recursive: true });
  mkdirSync(path.join(workspace, 'tetrafi-docs/public-site'), { recursive: true });
  writeFileSync(path.join(workspace, 'tetrafi-docs/public-site/leak-terms.json'), JSON.stringify({ terms: ['private.example'] }));
  const source = path.join(rfqRoot, 'docs/api/integrator/openapi.json');
  writeFileSync(source, JSON.stringify(spec));
  const git = (...args) => execFileSync('git', ['-C', rfqRoot, ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  git('add', 'docs/api/integrator/openapi.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture contract');
  writeFileSync(source, JSON.stringify({ ...spec, paths: { '/uncommitted': { get: {} } } }));
  assert.equal(main({ siteRoot, env: {}, check: false, log: () => {} }), 0);
  const collection = JSON.parse(readFileSync(path.join(siteRoot, 'api-reference/tetrafi.postman_collection.json'), 'utf8'));
  assert.equal(collection.item.length, 3);
});

test('unresolved references and unsupported request bodies fail closed', () => {
  assert.throws(() => collectionFromSpec({ ...spec, paths: { '/x': { $ref: '#/missing' } } }), /POSTMAN_REFERENCE_MISSING/);
  assert.throws(() => collectionFromSpec({ ...spec, paths: { '/x': { post: { requestBody: { content: {} } } } } }), /POSTMAN_BODY_UNSUPPORTED/);
});

function sign({ secret = 'ab'.repeat(32), method = 'post', url = 'https://api.example.test/api/v1/orders?limit=2&cursor=a%2Fb', body = '{\n  "quoteId": "{{quoteId}}", "note": "café"\n}', mode = 'raw', disabled = false } = {}) {
  const headers = new Map([['Content-Type', 'application/json'], ['X-Signature', 'stale'], ['X-Timestamp', 'stale']]);
  const variables = { signingSecret: secret, quoteId: 'q_test' };
  const request = { method, headers: {
    get: (key) => headers.get(key), remove: (key) => headers.delete(key), upsert: ({ key, value }) => headers.set(key, value),
  }, url: { toString: () => url, update: (value) => { url = value; } } };
  if (body !== undefined) request.body = { raw: body, mode, disabled, update: (value) => { request.body.raw = value; } };
  // The facade makes CryptoJS's byte-oriented API observable without installing
  // a test dependency; expected canonical/HMAC values use Node's crypto directly.
  const CryptoJS = {
    enc: { Hex: { parse: (value) => Buffer.from(value, 'hex') } },
    SHA256: (value) => ({ toString: () => createHash('sha256').update(value).digest('hex') }),
    HmacSHA256: (value, key) => ({ toString: () => createHmac('sha256', key).update(value).digest('hex') }),
  };
  vm.runInNewContext(signingScript, { require: (name) => { assert.equal(name, 'crypto-js'); return CryptoJS; },
    Date: { now: () => 1_800_000_000_000 }, pm: { request, variables: {
      get: (key) => variables[key], replaceIn: (value) => value.replace(/\{\{([^}]+)\}\}/g, (_, key) => variables[key]),
    } } });
  return { headers, request, url };
}

test('signing hashes the exact resolved UTF-8 body and includes the full query', () => {
  const { headers, request, url } = sign();
  const body = '{\n  "quoteId": "q_test", "note": "café"\n}';
  assert.equal(request.body.raw, body);
  assert.equal(url, 'https://api.example.test/api/v1/orders?limit=2&cursor=a%2Fb');
  const canonical = `1800000000\nPOST\n/api/v1/orders?limit=2&cursor=a%2Fb\n${createHash('sha256').update(body).digest('hex')}`;
  assert.equal(headers.get('X-Timestamp'), '1800000000');
  assert.equal(headers.get('X-Signature'), createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(canonical).digest('hex'));
});

test('empty secret removes both signature headers; empty GET bodies use the empty digest', () => {
  const unsigned = sign({ secret: '', body: '' });
  assert.equal(unsigned.headers.has('X-Signature'), false);
  assert.equal(unsigned.headers.has('X-Timestamp'), false);
  const signed = sign({ method: 'get', body: '', url: 'https://api.example.test/api/v1/assets?limit=1' });
  const canonical = `1800000000\nGET\n/api/v1/assets?limit=1\n${createHash('sha256').update('').digest('hex')}`;
  assert.equal(signed.headers.get('X-Signature'), createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(canonical).digest('hex'));
});

test('malformed secrets, non-raw bodies and JSON comments are refused before send', () => {
  assert.throws(() => sign({ secret: 'not-hex' }), /64 hexadecimal/);
  assert.throws(() => sign({ mode: 'formdata' }), /raw request bodies only/);
  assert.throws(() => sign({ body: '{/* comment */ "quoteId": "q_test"}' }));
});
