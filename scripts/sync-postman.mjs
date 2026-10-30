#!/usr/bin/env node
// Generate the Postman collection from the same integrator contract as sync-contract.mjs.
// TETRAFI_RFQ_API_DOCS overrides the source directory. --check refuses generated-file drift.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowedInternalNames, rulesFor, scanText } from './leak-rules.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = 'api-reference/tetrafi.postman_collection.json';
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

// Canonical form mirrors samples/http/quickstart.sh: timestamp, uppercase method,
// path INCLUDING query, SHA-256 of exact UTF-8 body bytes; secret decoded from hex.
export const signingScript = `const cryptoJs = require('crypto-js');
// Never retain headers from an earlier signed send when signing is turned off.
pm.request.headers.remove('X-Timestamp');
pm.request.headers.remove('X-Signature');

// Resolve variables ONCE, including dynamic variables, before hashing and sending.
const resolvedUrl = pm.variables.replaceIn(pm.request.url.toString());
const parts = /^(https?:\\/\\/[^/?#]+)([^#]*)/.exec(resolvedUrl);
if (!parts) throw new Error('Set baseUrl to an absolute HTTP or HTTPS URL');
const target = parts[2].startsWith('/') ? parts[2] : '/' + parts[2];
// Encode explicitly and disable subsequent transport encoding, so the signed
// target is exactly what is sent. Keep already percent-encoded bytes unchanged.
const pathWithQuery = encodeURI(target).replace(/%25([0-9a-f]{2})/gi, '%$1').replace(/'/g, '%27');
pm.request.url.update(parts[1] + pathWithQuery);
let body = '';
if (pm.request.body && !pm.request.body.disabled) {
  if (pm.request.body.mode !== 'raw') throw new Error('Signing supports raw request bodies only');
  body = pm.variables.replaceIn(pm.request.body.raw || '');
  // JSON comments are not valid API input and Postman would strip them AFTER
  // signing. Refuse them rather than signing bytes different from the wire.
  if (body && pm.request.headers.get('Content-Type')?.includes('application/json')) JSON.parse(body);
  pm.request.body.update(body);
}
const secret = pm.variables.get('signingSecret');
if (secret) {
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('signingSecret must contain 64 hexadecimal characters');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = cryptoJs.SHA256(body).toString(cryptoJs.enc.Hex);
  const canonical = [timestamp, pm.request.method.toUpperCase(), pathWithQuery, digest].join('\\n');
  const signature = cryptoJs.HmacSHA256(canonical, cryptoJs.enc.Hex.parse(secret)).toString(cryptoJs.enc.Hex);
  pm.request.headers.upsert({ key: 'X-Timestamp', value: timestamp });
  pm.request.headers.upsert({ key: 'X-Signature', value: signature });
}`;

function resolve(spec, node) {
  if (!node?.$ref) return node ?? {};
  if (!node.$ref.startsWith('#/')) throw new Error(`POSTMAN_REFERENCE_UNSUPPORTED ${node.$ref}`);
  const target = node.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  if (!target) throw new Error(`POSTMAN_REFERENCE_MISSING ${node.$ref}`);
  return resolve(spec, target);
}

// Explicit examples/defaults win; otherwise render required fields only, never
// invent an id or a signature. Angle-bracket strings ask the caller for real data.
function example(spec, input, name = 'value', seen = new Set()) {
  if (input?.$ref) {
    if (seen.has(input.$ref)) throw new Error(`POSTMAN_SCHEMA_CYCLE ${input.$ref}`);
    seen = new Set([...seen, input.$ref]);
  }
  const schema = resolve(spec, input);
  if (schema.example !== undefined) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const variant = (schema.oneOf ?? schema.anyOf)?.find((entry) => entry.type !== 'null');
  if (variant) return example(spec, variant, name, seen);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((entry) => example(spec, entry, name, seen)));
  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
  if (type === 'object' || schema.properties) return Object.fromEntries((schema.required ?? [])
    .map((key) => [key, example(spec, schema.properties?.[key], key, seen)]));
  if (type === 'array') return [example(spec, schema.items, name, seen)];
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return schema.minimum ?? 0;
  return `<${name}>`;
}

export function collectionFromSpec(spec) {
  if (!spec.openapi?.startsWith('3.') || !spec.paths) throw new Error('POSTMAN_SPEC_INVALID expected OpenAPI 3 paths');
  const items = [];
  for (const [route, input] of Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const pathItem = resolve(spec, input);
    for (const method of methods) {
      if (!pathItem[method]) continue;
      const operation = resolve(spec, pathItem[method]);
      const parameters = new Map();
      for (const input of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
        const parameter = resolve(spec, input);
        parameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      const query = [], header = [{ key: 'Accept', value: 'application/json' }];
      for (const parameter of parameters.values()) {
        const value = String(parameter.example ?? example(spec, parameter.schema, parameter.name));
        if (parameter.in === 'query') query.push({ key: parameter.name, value,
          disabled: !parameter.required, description: parameter.description ?? '' });
        // API keys imply the workspace. Do not require a fourth variable because
        // the shared session/API-key spec marks its session-only header required.
        if (parameter.in === 'header' && !['x-workspace-id', 'x-api-key', 'x-timestamp', 'x-signature'].includes(parameter.name.toLowerCase())) {
          header.push({ key: parameter.name, value, disabled: !parameter.required, description: parameter.description ?? '' });
        }
      }
      const routePath = route.replace(/\{([^}]+)\}/g, ':$1');
      const request = {
        method: method.toUpperCase(), header,
        description: [operation.summary, operation.description].filter(Boolean).join('\n\n'),
        url: { raw: `{{baseUrl}}${routePath}`, host: ['{{baseUrl}}'], path: routePath.slice(1).split('/'),
          ...(query.length ? { query } : {}),
          ...(/\{/.test(route) ? { variable: [...route.matchAll(/\{([^}]+)\}/g)].map(([, key]) => {
            const parameter = parameters.get(`path:${key}`);
            return { key, value: String(parameter?.example ?? example(spec, parameter?.schema, key)), description: parameter?.description ?? '' };
          }) } : {}),
        },
      };
      if (operation.requestBody) {
        const body = resolve(spec, operation.requestBody);
        const media = body.content?.['application/json'];
        if (!media) throw new Error(`POSTMAN_BODY_UNSUPPORTED ${method.toUpperCase()} ${route}`);
        const firstExample = Object.values(media.examples ?? {})[0];
        const value = media.example ?? (firstExample ? resolve(spec, firstExample).value : undefined) ?? example(spec, media.schema);
        request.header.push({ key: 'Content-Type', value: 'application/json' });
        request.body = { mode: 'raw', raw: JSON.stringify(value, null, 2), options: { raw: { language: 'json' } } };
      }
      items.push({ name: `${method.toUpperCase()} ${route}`, request, response: [] });
    }
  }
  if (!items.length) throw new Error('POSTMAN_SPEC_EMPTY no operations');
  return {
    info: { name: 'TetraFi API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: 'Generated from the TetraFi integrator specification. Set baseUrl, apiKey and signingSecret in your local collection variables. Start with GET /api/v1/assets. Replace angle-bracket placeholders with real values before sending other requests; review each write rather than running the entire collection. Never share populated credentials.' },
    auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-API-Key', type: 'string' },
      { key: 'value', value: '{{apiKey}}', type: 'string' }, { key: 'in', value: 'header', type: 'string' }] },
    variable: [
      { key: 'baseUrl', value: 'https://api.tetrafi.io', type: 'string' },
      { key: 'apiKey', value: '', type: 'string' },
      { key: 'signingSecret', value: '', type: 'string' },
    ],
    protocolProfileBehavior: { disableUrlEncoding: true },
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: signingScript.split('\n') } }],
    item: items,
  };
}

export function main({ siteRoot = root, env = process.env, check = process.argv.includes('--check'), log = console.log } = {}) {
  const rfqRoot = path.join(siteRoot, '..', 'tetrafi-rfq');
  const source = path.join(env.TETRAFI_RFQ_API_DOCS ?? path.join(rfqRoot, 'docs', 'api'), 'integrator', 'openapi.json');
  // Match sync-contract: the default source is committed HEAD, not a peer's
  // working tree. Explicit source overrides remain useful for fixtures/exports.
  let text;
  if (!env.TETRAFI_RFQ_API_DOCS && existsSync(path.join(rfqRoot, '.git'))) {
    try {
      text = execFileSync('git', ['-C', rfqRoot, 'show', 'HEAD:docs/api/integrator/openapi.json'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw new Error('POSTMAN_SPEC_UNREADABLE integrator/openapi.json at committed HEAD');
    }
  } else {
    if (!existsSync(source)) throw new Error('POSTMAN_SPEC_MISSING integrator/openapi.json');
    text = readFileSync(source, 'utf8');
  }
  const content = `${JSON.stringify(collectionFromSpec(JSON.parse(text)), null, 2)}\n`;
  const hits = scanText(content, rulesFor(siteRoot, allowedInternalNames(source)));
  if (hits.length) throw new Error(`POSTMAN_WITHHELD ${hits.length} leak hits; fix the source before publishing`);
  const destination = path.join(siteRoot, output);
  const drift = !existsSync(destination) || readFileSync(destination, 'utf8') !== content;
  if (check) {
    if (drift) log(`POSTMAN_DRIFT ${output}`);
    log(`sync-postman --check: 1 files, ${drift ? 1 : 0} drifted`);
    return drift ? 1 : 0;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  log(`sync-postman: wrote ${output}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
