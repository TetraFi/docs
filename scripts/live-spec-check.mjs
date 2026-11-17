#!/usr/bin/env node
// Does production serve the contract these docs describe? The docs are synced from the newest rfq
// export, and production serves the export inside the binary it runs, so the two drift whenever
// production runs an older commit. Run before telling a client the docs are current.
//   node scripts/live-spec-check.mjs [--origin https://api.tetrafi.io]
// Exit 0: identical. Exit 1: they differ, with what differs. Exit 2: production could not be read
// (never reported as a match).
import { readFileSync } from 'node:fs';

const at = process.argv.indexOf('--origin');
const origin = (at > 0 ? process.argv[at + 1] : 'https://api.tetrafi.io').replace(/\/$/, '');

async function read(path) {
  const response = await fetch(`${origin}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

const operations = (spec) => new Set(Object.entries(spec.paths ?? {})
  .flatMap(([path, item]) => Object.keys(item).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
    .map((m) => `${m.toUpperCase()} ${path}`)));

// Compare canonically, so key order never reads as a difference.
const canonical = (value) => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

let served, health;
try {
  [served, health] = await Promise.all([read('/api-docs/openapi.json'), read('/health')]);
} catch (error) {
  console.error(`LIVE_SPEC_UNREADABLE ${origin}: ${error.message}`);
  process.exit(2);
}
const docs = JSON.parse(readFileSync(new URL('../api-reference/openapi.json', import.meta.url), 'utf8'));
const revision = health.buildRevision ?? 'unknown';

if (canonical(served) === canonical(docs)) {
  console.log(`live-spec-check: ${origin} (rfq ${revision}) serves the contract these docs describe`);
  process.exit(0);
}

const [liveOps, docOps] = [operations(served), operations(docs)];
const onlyDocs = [...docOps].filter((op) => !liveOps.has(op));
const onlyLive = [...liveOps].filter((op) => !docOps.has(op));
const liveSchemas = served.components?.schemas ?? {};
const docSchemas = docs.components?.schemas ?? {};
const changed = Object.keys(docSchemas).filter((name) => name in liveSchemas && canonical(liveSchemas[name]) !== canonical(docSchemas[name]));
const missing = Object.keys(docSchemas).filter((name) => !(name in liveSchemas));
console.log(`LIVE_SPEC_DRIFT ${origin} (rfq ${revision}) serves a different contract from these docs`);
for (const op of onlyDocs) console.log(`  documented, not served: ${op}`);
for (const op of onlyLive) console.log(`  served, not documented: ${op}`);
console.log(`  schemas changed: ${changed.length}${changed.length ? ` (${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ', …' : ''})` : ''}`);
console.log(`  schemas documented, not served: ${missing.length}${missing.length ? ` (${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''})` : ''}`);
process.exit(1);
