#!/usr/bin/env node
// Leak gate: this repository is public, so every push publishes. Scans every file a push would
// carry (tracked plus untracked-not-ignored) for internal ids, internal hosts, retired API
// surfaces and credential-shaped strings. Exits 1 with one line per hit.
//
//   node scripts/leak-gate.mjs [--json <report.json>] [--root <dir>]
//
// Internal field names are allowed only while the public spec still contains them, so a
// renamed contract field turns the gate red until the pages follow.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const root = path.resolve(flag('--root') ?? path.join(import.meta.dirname, '..'));
const jsonOut = flag('--json');
const publicSpec = process.env.TETRAFI_PUBLIC_SPEC
  ?? path.join(root, '..', 'tetrafi-rfq', 'docs', 'api', 'integrator', 'openapi.json');

const RULES = [
  { rule: 'ticket-id', re: /\b(?:KO|AQ|FD|CEX)-\d+\b/g },
  { rule: 'ticket-id', re: /\bR0-[A-Z0-9]/g },
  { rule: 'internal-programme', re: /\bURE\b|\bADR[ -]?\d{3,4}\b/g },
  { rule: 'internal-host', re: /[a-z0-9-]+\.ts\.net\b|\btailscale\b|\btetrafi-builder\b|\bdevbox\b|\bgpu-a\b/gi },
  { rule: 'credential', re: /\btfk_[A-Za-z0-9]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'retired-surface', re: /\/api\/v1\/(?:rfq|router|pairs|solvers)\b|\/router\/(?:quotes|orders)|quotes\/indicative/g },
  { rule: 'retired-term', re: /\bquoteResponse\b|\bintegrityChecksum\b|\bdirectUserId\b|\bminValidUntil\b|\bcards\[|"intent"\s*:/g },
];
const INTERNAL_NAMES = ['firmOnRequote', 'budgetExhausted', 'routingOptions', 'stepUpProof', 'continuationOf', 'operationId'];

// Files that describe the gate itself, and binary assets, are not content.
const SKIP = [/^scripts\/leak-gate\.mjs$/, /^scripts\/.*\.test\.mjs$/, /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|mp4|pdf)$/i, /^package-lock\.json$/];

function publishableFiles() {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...git('ls-files'), ...git('ls-files', '--others', '--exclude-standard')])]
    .filter((f) => !SKIP.some((re) => re.test(f)) && existsSync(path.join(root, f)));
}

function allowedInternalNames() {
  if (!existsSync(publicSpec)) return new Set();
  const spec = readFileSync(publicSpec, 'utf8');
  return new Set(INTERNAL_NAMES.filter((name) => spec.includes(`"${name}"`)));
}

const allowed = allowedInternalNames();
const internalRe = INTERNAL_NAMES.filter((n) => !allowed.has(n));
const rules = internalRe.length ? [...RULES, { rule: 'internal-name', re: new RegExp(`\\b(?:${internalRe.join('|')})\\b`, 'g') }] : RULES;

const hits = [];
const files = publishableFiles();
for (const file of files) {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
  lines.forEach((text, index) => {
    for (const { rule, re } of rules) {
      for (const match of text.matchAll(re)) hits.push({ file, line: index + 1, rule, match: match[0] });
    }
  });
}

const report = { root, publicSpec: existsSync(publicSpec) ? publicSpec : null, allowedInternalNames: [...allowed], filesScanned: files.length, hits };
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
for (const h of hits) console.log(`LEAK ${h.rule} ${h.file}:${h.line} ${h.match}`);
console.log(`leak-gate: ${files.length} files, ${hits.length} hits`);
process.exit(hits.length ? 1 : 0);
