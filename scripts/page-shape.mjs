#!/usr/bin/env node
// Keeps the guides short, keeps their facts, and keeps code samples inside the code block.
//   1. Budget: each guide page (the Guides tab, plus the hand-written reference pages) shows at most
//      PAGE_BUDGET words before anything is opened: code blocks and accordion bodies do not count,
//      tables and prose do. A page over budget needs an entry in BUDGET_EXCEPTIONS with its reason.
//   2. Facts: every backticked token, error code and number with a unit that scripts/page-facts.json
//      records must still appear somewhere on the site (any page, or the published spec). Removing a
//      fact on purpose means running --update, so the removal shows in that file's diff.
//   3. Width: a published code sample line longer than WIDE columns scrolls sideways in the code block
//      (it shows about 80 at 1440 px). samples/wide-lines.json records how many each snippet has; a
//      snippet may only lose wide lines. --update records the current counts.
//
//   node scripts/page-shape.mjs            check (exit 1 with PAGE_OVER_BUDGET, FACT_LOST, SAMPLE_LINES_TOO_WIDE)
//   node scripts/page-shape.mjs --update   rewrite page-facts.json and wide-lines.json from the current tree
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.TETRAFI_DOCS_ROOT ?? path.resolve(import.meta.dirname, '..');
const update = process.argv.includes('--update');
const PAGE_BUDGET = 450;
const WIDE = 80;
const BUDGET_EXCEPTIONS = {
  'reference/conventions': [600, 'a reference of rule tables that other pages link into, one per section'],
  'trade/sign-with-your-own-wallet': [700, 'the own-wallet contract draft, owned by the own-wallet work until it ships'],
  'recipes/own-wallet-trade': [500, 'the own-wallet walk-through, owned by the own-wallet work until it ships'],
};
const REFERENCE_PAGES = ['reference/introduction', 'reference/conventions', 'reference/rate-limits'];
const factsFile = path.join(root, 'scripts', 'page-facts.json');
const wideFile = path.join(root, 'samples', 'wide-lines.json');

const read = (file) => readFileSync(path.join(root, file), 'utf8');
const words = (text) => (text.replace(/<[^>]+>/g, ' ').replace(/[#*`|>\-[\]()]/g, ' ').match(/[A-Za-z0-9][\w'.:/-]*/g) ?? []).length;
const body = (text) => text.replace(/^---[\s\S]*?---/, '').replace(/^import .*$/gm, '');

export function visibleWords(text) {
  return words(body(text).replace(/```[\s\S]*?```/g, '')
    .replace(/<Accordion\b([^>]*)>[\s\S]*?<\/Accordion>/g, (_, attributes) => ` ${(attributes.match(/title="([^"]*)"/) ?? [])[1] ?? ''} `)
    .replace(/<Expandable\b[^>]*>[\s\S]*?<\/Expandable>/g, ' '));
}

export function facts(text) {
  const found = new Set();
  const source = body(text);
  for (const match of source.matchAll(/`([^`\n]{1,80})`/g)) found.add(match[1].trim());
  for (const match of source.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g)) found.add(match[0]);
  for (const match of source.matchAll(/\b\d+(?:[.,]\d+)?\s?(?:seconds?|minutes?|hours?|days?|ms|%|bps|requests?)\b/g)) found.add(match[0]);
  found.delete('');
  return found;
}

export function wideLines(snippet) {
  let fenced = false;
  let count = 0;
  for (const line of snippet.split('\n')) {
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced && line.length > WIDE) count += 1;
  }
  return count;
}

function main() {
  const nav = JSON.parse(read('docs.json'));
  const guides = nav.navigation.tabs.find((tab) => tab.tab === 'Guides');
  if (!guides) throw new Error('PAGE_SHAPE_GUIDES_TAB_MISSING');
  const pageList = (group) => (group.pages ?? []).flatMap((page) => (typeof page === 'string' ? [page] : pageList(page)));
  const pages = [...guides.groups.flatMap(pageList), ...REFERENCE_PAGES].filter((page) => existsSync(path.join(root, `${page}.mdx`)));

  const problems = [];
  for (const page of pages) {
    const [budget, reason] = BUDGET_EXCEPTIONS[page] ?? [PAGE_BUDGET];
    const count = visibleWords(read(`${page}.mdx`));
    if (count > budget) problems.push(`PAGE_OVER_BUDGET ${page} ${count} visible words, budget ${budget}${reason ? ` (${reason})` : ''}`);
  }

  // The whole site counts as "somewhere": a fact may move to any page, or into the spec.
  const site = [
    ...readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith('.mdx') && !/^(node_modules|\.archive)\//.test(String(file)))
      .map((file) => read(String(file))),
    existsSync(path.join(root, 'api-reference', 'openapi.json')) ? read(path.join('api-reference', 'openapi.json')) : '',
  ].join('\n');
  const current = new Map();
  for (const page of pages) for (const fact of facts(read(`${page}.mdx`))) if (!current.has(fact)) current.set(fact, page);

  const snippetDir = path.join(root, 'snippets', 'samples');
  const wide = Object.fromEntries(readdirSync(snippetDir).filter((file) => file.endsWith('.mdx')).sort()
    .map((file) => [file.replace(/\.mdx$/, ''), wideLines(readFileSync(path.join(snippetDir, file), 'utf8'))]).filter(([, count]) => count));

  if (update) {
    writeFileSync(factsFile, `${JSON.stringify({ about: 'Facts the guides state; scripts/page-shape.mjs fails when one disappears from the site. Regenerate with --update.', facts: Object.fromEntries([...current].sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 1)}\n`);
    writeFileSync(wideFile, `${JSON.stringify({ about: 'Code lines over 80 columns per snippet; scripts/page-shape.mjs fails when a snippet gains one. Regenerate with --update.', snippets: wide }, null, 1)}\n`);
    console.log(`page-shape --update: ${current.size} facts, ${Object.values(wide).reduce((a, b) => a + b, 0)} wide lines in ${Object.keys(wide).length} snippets`);
    process.exit(0);
  }

  const recorded = existsSync(factsFile) ? JSON.parse(readFileSync(factsFile, 'utf8')).facts : null;
  if (!recorded) problems.push('PAGE_FACTS_MISSING scripts/page-facts.json (run --update)');
  for (const [fact, page] of Object.entries(recorded ?? {})) if (!site.includes(fact)) problems.push(`FACT_LOST ${JSON.stringify(fact)} (last on ${page})`);
  const allowed = existsSync(wideFile) ? JSON.parse(readFileSync(wideFile, 'utf8')).snippets : null;
  if (!allowed) problems.push('WIDE_LINES_MISSING samples/wide-lines.json (run --update)');
  for (const [snippet, count] of Object.entries(wide)) {
    if (allowed && count > (allowed[snippet] ?? 0)) problems.push(`SAMPLE_LINES_TOO_WIDE ${snippet} ${count} lines over ${WIDE} columns, recorded ${allowed[snippet] ?? 0}`);
  }
  for (const problem of problems) console.log(problem);
  console.log(`page-shape: ${pages.length} pages, ${Object.keys(recorded ?? {}).length} facts, ${problems.length} problems`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
