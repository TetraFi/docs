#!/usr/bin/env node
// Every refusal code the API declares has a row on trade/errors.mdx, and every row names a code
// the API still declares. The declared list is the API's own file, never a list kept here:
//   - tetrafi-rfq/docs/api/integrator/error-codes.json   (TETRAFI_RFQ_API_DOCS overrides docs/api)
// A row is a table row under "## Refusals by area"; its codes are the backticked SCREAMING_SNAKE
// tokens in its first cell (`400 UNKNOWN_ASSET` or 400 `UNKNOWN_ASSET`). Source reason tokens are an
// open list on that page and are not checked here.
//
//   node scripts/refusal-coverage.mjs   exit 1 on REFUSAL_UNDOCUMENTED <code> or REFUSAL_UNKNOWN <code>
//
// Until the API publishes error-codes.json this prints REFUSAL_COVERAGE_PENDING and exits 0. A file
// that exists but yields no codes is refused (REFUSAL_COVERAGE_UNREADABLE), never read as empty.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const ROW_CODE = /`(?:\d{3} )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
const SECTION = '## Refusals by area';

export function sourcePath(env = process.env) {
  const docs = env.TETRAFI_RFQ_API_DOCS ?? path.join(root, '..', 'tetrafi-rfq', 'docs', 'api');
  return path.join(docs, 'integrator', 'error-codes.json');
}

// The file's shape is the contract owner's. Accepted: an array of codes or of {code}, or an object
// whose `codes` (or `errors`) is such an array or an object keyed by code. Anything else yields
// no codes, which the caller refuses.
export function declaredCodes(json) {
  const fromList = (list) => list.map((entry) => (typeof entry === 'string' ? entry : entry?.code ?? entry?.error));
  let raw = [];
  if (Array.isArray(json)) raw = fromList(json);
  else if (json && typeof json === 'object') {
    const inner = json.codes ?? json.errors;
    if (Array.isArray(inner)) raw = fromList(inner);
    else if (inner && typeof inner === 'object') raw = Object.keys(inner);
  }
  return new Set(raw.filter((code) => typeof code === 'string' && CODE.test(code)));
}

export function documentedCodes(page) {
  const lines = page.split('\n');
  const start = lines.findIndex((line) => line.trim() === SECTION);
  if (start < 0) throw new Error(`REFUSAL_TABLES_MISSING ${SECTION}`);
  const codes = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (!line.startsWith('|') || /^\|[\s:|-]+\|?\s*$/.test(line)) continue;
    const first = line.split('|')[1] ?? '';
    for (const match of first.matchAll(ROW_CODE)) codes.add(match[1]);
  }
  return codes;
}

export function coverage(declared, documented) {
  return {
    undocumented: [...declared].filter((code) => !documented.has(code)).sort(),
    unknown: [...documented].filter((code) => !declared.has(code)).sort(),
  };
}

export function main({ env = process.env, log = console.log } = {}) {
  const from = sourcePath(env);
  if (!existsSync(from)) {
    log('REFUSAL_COVERAGE_PENDING error-codes.json not published');
    return 0;
  }
  let declared;
  try {
    declared = declaredCodes(JSON.parse(readFileSync(from, 'utf8')));
  } catch {
    declared = new Set();
  }
  if (!declared.size) {
    log(`REFUSAL_COVERAGE_UNREADABLE ${from}`);
    return 1;
  }
  const documented = documentedCodes(readFileSync(path.join(root, 'trade', 'errors.mdx'), 'utf8'));
  const { undocumented, unknown } = coverage(declared, documented);
  for (const code of undocumented) log(`REFUSAL_UNDOCUMENTED ${code}`);
  for (const code of unknown) log(`REFUSAL_UNKNOWN ${code}`);
  log(`refusal-coverage: ${declared.size} declared, ${documented.size} documented, ${undocumented.length} undocumented, ${unknown.length} unknown`);
  return undocumented.length || unknown.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
