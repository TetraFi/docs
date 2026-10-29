#!/usr/bin/env node
// Every source reason a published page names must be one the API declares in
// tetrafi-rfq docs/api/integrator/error-codes.json (sourceReasons). A token counts as a reason only
// in a reason context, so ordinary backticked words never do:
//   - a JSON "reason": "<token>" pair;
//   - prose "the reason `<token>`" or "reason `<token>`";
//   - a table cell "`<status>`, `<token>`" whose status is a source outcome.
// A missing or unreadable catalogue, or a site with no reasons at all, fails rather than passes.
//
//   node scripts/reason-coverage.mjs
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Source outcomes come from the public spec (the `status` of QuoteSourceEntry and PriceRowStatus),
// so an outcome is never mistaken for a reason and no outcome list is kept by hand.
export function outcomesFrom(spec) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const status = node.properties?.status;
    if (status) {
      if (typeof status.const === 'string') found.add(status.const);
      for (const value of status.enum ?? []) if (typeof value === 'string') found.add(value);
    }
    Object.values(node).forEach(walk);
  };
  for (const name of ['QuoteSourceEntry', 'PriceRowStatus']) walk(spec?.components?.schemas?.[name]);
  if (!found.size) throw new Error('REASON_OUTCOMES_UNREADABLE no source outcome statuses in the spec');
  return found;
}
let OUTCOMES = new Set();
const TOKEN = '([a-z][A-Za-z0-9]*)';

export function reasonsIn(text, outcomes = OUTCOMES) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    const add = (token) => { if (!outcomes.has(token)) found.push({ line: index + 1, token }); };
    for (const m of line.matchAll(new RegExp(`"reason"\\s*:\\s*"${TOKEN}"`, 'g'))) add(m[1]);
    for (const m of line.matchAll(new RegExp(`\\breason \`${TOKEN}\``, 'g'))) add(m[1]);
    for (const m of line.matchAll(new RegExp(`\`([a-zA-Z]+)\`, \`${TOKEN}\``, 'g'))) if (outcomes.has(m[1])) add(m[2]);
  });
  return found;
}

export function declaredReasons(json) {
  if (!Array.isArray(json?.sourceReasons) || !json.sourceReasons.length) throw new Error('REASON_CATALOGUE_UNREADABLE no sourceReasons');
  return new Set(json.sourceReasons.map((row) => row.reason));
}

function publishedPages() {
  const ignored = readFileSync(path.join(root, '.mintignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^\//, '').replace(/\/$/, ''));
  return execFileSync('git', ['-C', root, 'ls-files', '*.mdx'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !ignored.some((i) => f === i || f.startsWith(`${i}/`)));
}

export function main() {
  const from = path.join(process.env.TETRAFI_RFQ_API_DOCS ?? path.join(root, '..', 'tetrafi-rfq', 'docs', 'api'), 'integrator', 'error-codes.json');
  if (!existsSync(from)) { console.log(`REASON_CATALOGUE_MISSING ${from}`); return 1; }
  const declared = declaredReasons(JSON.parse(readFileSync(from, 'utf8')));
  OUTCOMES = outcomesFrom(JSON.parse(readFileSync(path.join(path.dirname(from), 'openapi.json'), 'utf8')));
  let seen = 0;
  let undeclared = 0;
  for (const file of publishedPages()) {
    for (const { line, token } of reasonsIn(readFileSync(path.join(root, file), 'utf8'))) {
      seen += 1;
      if (!declared.has(token)) { undeclared += 1; console.log(`REASON_UNDECLARED ${file}:${line} ${token}`); }
    }
  }
  if (!seen) { console.log('REASON_NONE_FOUND no source reason found on any page'); return 1; }
  console.log(`reason-coverage: ${seen} reasons named, ${declared.size} declared, ${undeclared} undeclared`);
  return undeclared ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
