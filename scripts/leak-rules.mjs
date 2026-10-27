// What must never reach this public repository, shared by the leak gate and the contract sync.
// Generic shapes live here. Internal host and tooling names are not published: they load from the
// private tetrafi-docs repository (public-site/leak-terms.json, or TETRAFI_LEAK_TERMS), and the gate
// refuses to run without that file rather than scanning with half its rules.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SHAPES = [
  { rule: 'ticket-id', severity: 'hard', re: /\b(?:KO|AQ|FD|CEX|BACKEND|CHAIN|INFRA|PLAN|FRONTEND)-\d+\b/gi },
  { rule: 'ticket-id', severity: 'hard', re: /\bR0-[A-Z0-9]/g },
  { rule: 'internal-programme', severity: 'hard', re: /\bURE\b|\bADR[ -]?\d{3,4}\b/g },
  { rule: 'internal-host', severity: 'hard', re: /[a-z0-9-]+\.ts\.net\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/gi },
  { rule: 'credential', severity: 'hard', re: /\btfk_[A-Za-z0-9_]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bop:\/\/[^\s"')]+/g },
  { rule: 'private-key-shape', severity: 'hard', re: /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g },
  { rule: 'retired-surface', severity: 'content', re: /\/api\/v1\/(?:rfq|router|pairs|solvers)\b|\/router\/(?:quotes|orders)|quotes\/indicative/g },
  { rule: 'retired-term', severity: 'content', re: /\bquoteResponse\b|\bintegrityChecksum\b|\bdirectUserId\b|\bminValidUntil\b|\bcards\[|"intent"\s*:/g },
];
export const INTERNAL_NAMES = ['firmOnRequote', 'budgetExhausted', 'routingOptions', 'stepUpProof', 'continuationOf', 'operationId'];

export function defaultPublicSpec(root) {
  return process.env.TETRAFI_PUBLIC_SPEC ?? path.join(root, '..', 'tetrafi-rfq', 'docs', 'api', 'integrator', 'openapi.json');
}

function localTerms(root) {
  const file = process.env.TETRAFI_LEAK_TERMS ?? path.join(root, '..', 'tetrafi-docs', 'public-site', 'leak-terms.json');
  if (!existsSync(file)) throw new Error(`LEAK_TERMS_MISSING ${file}: the internal host and project terms are required; the gate never runs with half its rules`);
  const { terms } = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(terms) || !terms.length) throw new Error(`LEAK_TERMS_EMPTY ${file}`);
  const escaped = terms.map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { rule: 'internal-term', severity: 'hard', re: new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi') };
}

// A name is allowed only when the public spec uses it as a schema property or parameter name.
// Prose mentions and OpenAPI keywords (every spec has "operationId" as a keyword) do not count.
export function allowedInternalNames(specPath) {
  if (!existsSync(specPath)) return new Set();
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.properties && typeof node.properties === 'object') Object.keys(node.properties).forEach((k) => names.add(k));
    if (typeof node.name === 'string' && typeof node.in === 'string') names.add(node.name);
    Object.values(node).forEach(walk);
  };
  walk(spec.components ?? {});
  walk(spec.paths ?? {});
  return new Set(INTERNAL_NAMES.filter((name) => names.has(name)));
}

export function rulesFor(root, allowed) {
  const refused = INTERNAL_NAMES.filter((name) => !allowed.has(name));
  const rules = [...SHAPES, localTerms(root)];
  if (refused.length) rules.push({ rule: 'internal-name', severity: 'content', re: new RegExp(`\\b(?:${refused.join('|')})\\b`, 'g') });
  return rules;
}

export function scanText(text, rules) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const { rule, severity, re } of rules) {
      for (const match of line.matchAll(re)) hits.push({ line: index + 1, rule, severity, match: match[0] });
    }
  });
  return hits;
}
