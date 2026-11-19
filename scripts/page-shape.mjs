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
//   4. Endpoint pages: the spec lead, the fits line and the page's snippet (its table and toggle titles)
//      show at most ENDPOINT_BUDGET words, and a lead at most LEAD_LIMIT. A page is held to this once it
//      is migrated (it has a snippet, or its lead is already short); the rest are counted as pending.
//      Group intros (api-reference/intros) show at most INTRO_BUDGET.
//   5. Spec facts: scripts/spec-facts.json froze every fact of the operation descriptions and the API-key
//      scheme text before they were shortened. Each must stay on the site, or be listed under `removed`
//      with a reason. --without-spec-descriptions strips those descriptions from the spec first, so a cut
//      is proved lossless before the rfq commit.
//
//   node scripts/page-shape.mjs            check (exit 1 with PAGE_OVER_BUDGET, FACT_LOST, SAMPLE_LINES_TOO_WIDE,
//                                          ENDPOINT_OVER_BUDGET, LEAD_TOO_LONG, INTRO_OVER_BUDGET, SPEC_FACT_LOST)
//   node scripts/page-shape.mjs --update   rewrite page-facts.json and wide-lines.json from the current tree
//   node scripts/page-shape.mjs --without-spec-descriptions   the same check with the spec descriptions removed
//   node scripts/page-shape.mjs --totals   also print every guide's total words, toggles included
//   node scripts/page-shape.mjs --freeze-spec-facts           write scripts/spec-facts.json once (refuses to overwrite)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.TETRAFI_DOCS_ROOT ?? path.resolve(import.meta.dirname, '..');
const update = process.argv.includes('--update');
const PAGE_BUDGET = 350;
const ENDPOINT_BUDGET = 110;
const LEAD_LIMIT = 50;
const INTRO_BUDGET = 150;
const WIDE = 80;
const BUDGET_EXCEPTIONS = {
  'reference/conventions': [600, 'a reference of rule tables that other pages link into, one per section'],
  'trade/sign-with-your-own-wallet': [700, 'the own-wallet contract draft, owned by the own-wallet work until it ships'],
  'recipes/own-wallet-trade': [500, 'the own-wallet walk-through, owned by the own-wallet work until it ships'],
};
// Guides over the budget when it dropped from 450 to 350 (2026-11-19), at their visible count then.
// A page here may only shrink; it leaves the list when it is at or under its budget.
const PENDING_TRIM = {
  'authentication': 447, 'trade/balances': 362, 'trade/wallets-and-accounts': 445, 'trade/errors': 432,
};
const REFERENCE_PAGES = ['reference/introduction', 'reference/conventions', 'reference/rate-limits'];
const factsFile = path.join(root, 'scripts', 'page-facts.json');
const specFactsFile = path.join(root, 'scripts', 'spec-facts.json');
const specFile = path.join(root, 'api-reference', 'openapi.json');
const withoutSpecDescriptions = process.argv.includes('--without-spec-descriptions');
const wideFile = path.join(root, 'samples', 'wide-lines.json');

const read = (file) => readFileSync(path.join(root, file), 'utf8');
const words = (text) => (text.replace(/<[^>]+>/g, ' ').replace(/[#*`|>\-[\]()]/g, ' ').match(/[A-Za-z0-9][\w'.:/-]*/g) ?? []).length;
const body = (text) => text.replace(/^---[\s\S]*?---/, '').replace(/^import .*$/gm, '');

export function visibleWords(text) {
  return words(body(text).replace(/```[\s\S]*?```/g, '')
    .replace(/<Accordion\b([^>]*)>[\s\S]*?<\/Accordion>/g, (_, attributes) => ` ${(attributes.match(/title="([^"]*)"/) ?? [])[1] ?? ''} `)
    .replace(/<Expandable\b[^>]*>[\s\S]*?<\/Expandable>/g, ' '));
}

// What a reader sees on an endpoint page before opening anything: the spec's lead above the method box,
// then the stub's fits line and the snippet's table and toggle titles.
export function endpointVisibleWords(stubText, lead, snippetText = '') {
  return words(lead ?? '') + visibleWords(stubText) + (snippetText ? visibleWords(snippetText) : 0);
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// The operation and response descriptions and the API-key scheme text: the spec text this plan shortens.
export function specDescriptions(spec) {
  const found = [];
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const key = `${method.toUpperCase()} ${route}`;
      if (op.description) found.push([key, op.description]);
      for (const [status, response] of Object.entries(op.responses ?? {})) if (response?.description) found.push([`${key} ${status}`, response.description]);
    }
  }
  const scheme = spec.components?.securitySchemes?.api_key?.description;
  if (scheme) found.push(['securityScheme api_key', scheme]);
  return found;
}

export function stripSpecDescriptions(spec) {
  const copy = structuredClone(spec);
  for (const item of Object.values(copy.paths ?? {})) {
    for (const method of METHODS) {
      if (!item[method]) continue;
      delete item[method].description;
      for (const response of Object.values(item[method].responses ?? {})) if (response) delete response.description;
    }
  }
  if (copy.components?.securitySchemes?.api_key) delete copy.components.securitySchemes.api_key.description;
  return copy;
}

// Every word a reader could open, toggles included; code blocks excluded.
export function totalWords(text) {
  return words(body(text).replace(/```[\s\S]*?```/g, ''));
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
    const text = read(`${page}.mdx`);
    const count = visibleWords(text);
    const pending = PENDING_TRIM[page];
    if (pending !== undefined) {
      if (count > pending) problems.push(`PAGE_GREW ${page} ${count} visible words, was ${pending} (pending trim to ${budget})`);
      else if (count <= budget) problems.push(`PENDING_TRIM_DONE ${page} ${count} visible words: remove it from PENDING_TRIM`);
    } else if (count > budget) problems.push(`PAGE_OVER_BUDGET ${page} ${count} visible words, budget ${budget}${reason ? ` (${reason})` : ''}`);
    if (process.argv.includes('--totals')) console.log(`TOTAL_WORDS ${page} ${totalWords(text)} (visible ${count})`);
  }

  // The whole site counts as "somewhere": a fact may move to any page, or into the spec.
  const spec = existsSync(specFile) ? JSON.parse(readFileSync(specFile, 'utf8')) : null;
  const shownSpec = spec && withoutSpecDescriptions ? stripSpecDescriptions(spec) : spec;
  const site = [
    ...readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith('.mdx') && !/^(node_modules|\.archive)\//.test(String(file)))
      .map((file) => read(String(file))),
    shownSpec ? JSON.stringify(shownSpec, null, 2) : '',
  ].join('\n');
  // Backticks are formatting: "409 `CODE`" still states the fact "409 CODE".
  const siteText = site.replace(/`/g, '');
  const onSite = (fact) => site.includes(fact) || siteText.includes(fact.replace(/`/g, ''));

  if (process.argv.includes('--freeze-spec-facts')) {
    if (existsSync(specFactsFile)) { console.log('SPEC_FACTS_EXIST scripts/spec-facts.json is frozen; edit it by hand'); process.exit(1); }
    if (!spec) { console.log('SPEC_MISSING api-reference/openapi.json'); process.exit(1); }
    const frozen = {};
    for (const [owner, text] of specDescriptions(spec)) for (const fact of facts(text)) frozen[fact] ??= owner;
    writeFileSync(specFactsFile, `${JSON.stringify({ about: 'Facts of the spec operation descriptions and API-key scheme text, frozen before they were shortened (2026-11-19). page-shape fails when one leaves the site; a deliberate drop goes under removed with its reason.', facts: Object.fromEntries(Object.entries(frozen).sort(([a], [b]) => (a < b ? -1 : 1))), removed: {} }, null, 1)}\n`);
    console.log(`page-shape --freeze-spec-facts: ${Object.keys(frozen).length} facts`);
    process.exit(0);
  }

  // Endpoint pages and group intros.
  const leads = new Map(spec ? specDescriptions(spec) : []);
  let pendingEndpoints = 0;
  const apiDir = path.join(root, 'api-reference');
  for (const dir of existsSync(apiDir) ? readdirSync(apiDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
    for (const file of readdirSync(path.join(apiDir, dir.name)).filter((f) => f.endsWith('.mdx'))) {
      const page = `api-reference/${dir.name}/${file}`;
      const text = read(page);
      if (dir.name === 'intros') {
        const count = visibleWords(text);
        if (count > INTRO_BUDGET) problems.push(`INTRO_OVER_BUDGET ${page} ${count} visible words, budget ${INTRO_BUDGET}`);
        continue;
      }
      const op = (text.match(/^openapi:\s*"api-reference\/openapi\.json (\w+) ([^"]+)"/m) ?? []).slice(1).join(' ');
      const lead = leads.get(op) ?? '';
      const snippet = (text.match(/^import Notes from '\/(snippets\/[^']+)'/m) ?? [])[1];
      const leadWords = words(lead);
      if (!snippet && leadWords > LEAD_LIMIT) { pendingEndpoints += 1; continue; }
      if (leadWords > LEAD_LIMIT) problems.push(`LEAD_TOO_LONG ${op} ${leadWords} words, limit ${LEAD_LIMIT} (shorten its rfq description)`);
      const count = endpointVisibleWords(text, lead, snippet && existsSync(path.join(root, snippet)) ? read(snippet) : '');
      if (count > ENDPOINT_BUDGET) problems.push(`ENDPOINT_OVER_BUDGET ${page} ${count} visible words, budget ${ENDPOINT_BUDGET}`);
    }
  }

  // Facts of the original spec descriptions stay on the site.
  const specFacts = existsSync(specFactsFile) ? JSON.parse(readFileSync(specFactsFile, 'utf8')) : null;
  for (const [fact, owner] of Object.entries(specFacts?.facts ?? {})) {
    if (!Object.hasOwn(specFacts.removed ?? {}, fact) && !onSite(fact)) problems.push(`SPEC_FACT_LOST ${JSON.stringify(fact)} (${owner})`);
  }
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
  for (const [fact, page] of Object.entries(recorded ?? {})) if (!onSite(fact)) problems.push(`FACT_LOST ${JSON.stringify(fact)} (last on ${page})`);
  const allowed = existsSync(wideFile) ? JSON.parse(readFileSync(wideFile, 'utf8')).snippets : null;
  if (!allowed) problems.push('WIDE_LINES_MISSING samples/wide-lines.json (run --update)');
  for (const [snippet, count] of Object.entries(wide)) {
    if (allowed && count > (allowed[snippet] ?? 0)) problems.push(`SAMPLE_LINES_TOO_WIDE ${snippet} ${count} lines over ${WIDE} columns, recorded ${allowed[snippet] ?? 0}`);
  }
  for (const problem of problems) console.log(problem);
  console.log(`page-shape: ${pages.length} pages, ${Object.keys(recorded ?? {}).length} facts, ${Object.keys(specFacts?.facts ?? {}).length} spec facts, ${pendingEndpoints} endpoint pages pending, ${problems.length} problems${withoutSpecDescriptions ? ' (spec descriptions removed)' : ''}`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
