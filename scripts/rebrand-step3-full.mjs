/**
 * rebrand-step3-full.mjs — Step 3: full Bebop→TetraFi content + domain + sub-brand swap.
 *
 * Builds on rebrand-tetrafi.mjs (Step 2, identity chrome only). This pass rewrites the
 * PROSE + API SURFACE that Step 2 deliberately left verbatim, per an explicit user decision
 * to go full-scope (incl. domains).
 *
 * Rules run in order: preserve-list → domains → sub-brand → generic brand. Ordering + a
 * sentinel preserve-list are what stop the broad `bebop→tetrafi` rule from corrupting the
 * base58 settlement address, Bebop's S3 audit/icon URLs, and Bebop's mintcdn hero images.
 *
 * Excluded from processing: scripts/ (clone tooling), .recreate/ (screenshots), logo/,
 * node_modules, .git, package*.json, and audits.mdx (hand-edited — audit URLs are preserved
 * while prose is rebranded, which the mechanical rules can't disambiguate safely).
 *
 * Local only. Runs NO git.
 */
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // docs/
const log = (...a) => console.log('[step3]', ...a);

// ---- Preserve-list: sentinel these BEFORE any rule, restore AFTER --------------
const PRESERVE = [
  /https:\/\/bebop-public-images\.s3\.eu-west-2\.amazonaws\.com\/[^\s"')<>]*/g, // audit PDFs + token icons
  /https:\/\/mintcdn\.com\/[^\s"')<>]*/g,                                        // Bebop-hosted hero/case-study images
  /data-path="[^"]*"/g,                                                          // Mintlify image-path mirror (pairs w/ mintcdn)
  /BEboPej97QDH5PS9xzCVxM5vvorvwENjtt3PV5n8b62/g,                                // base58 settlement address (NOT the word)
];

// ---- Replacement rules, ORDER MATTERS (specific → generic) ---------------------
const RULES = [
  // domains (host-level; keep paths). Lookbehind on the bare rule guards sub-domains.
  [/api\.bebop\.xyz/g, 'api.tetrafi.io'],
  [/docs\.bebop\.xyz/g, 'docs.tetrafi.io'],
  [/help\.bebop\.xyz/g, 'help.tetrafi.io'],
  [/hello@bebop\.xyz/g, 'enquiries@tetrafi.io'],
  [/github\.com\/bebop-dex/g, 'github.com/TetraFi'],
  [/linkedin\.com\/company\/bebopdex/g, 'linkedin.com/company/tetrafi'],
  [/(?<!\.)bebop\.xyz/g, 'tetrafi.io'],
  // sub-brand: BopAMM → propAMM (display short form) / PropAMM (code). Branded display
  // spots ("TetraFi propAMM (RFS)") + "(Block Oracle Priced AMM)" are hand-edited after.
  [/BopAmmV2/g, 'PropAmmV2'],
  [/BopAMM/g, 'propAMM'],
  [/bopamm/g, 'propamm'],
  // generic brand — CASE-SENSITIVE so `BEboPej…` (mixed case) never matches.
  [/Bebop/g, 'TetraFi'],
  [/BEBOP/g, 'TETRAFI'],
  [/bebop/g, 'tetrafi'],
];

// Fictional identifiers with no real TetraFi equivalent — collect for the reconciliation list.
const RECON = /Bebop(?:Settlement|RouterOrder|Router|PricingUpdate)|bebop(?:_pb2|\.proto|PmmCalldata)/g;

const EXCLUDE_DIRS = new Set(['node_modules', '.recreate', '.git', 'logo', 'scripts', '.playwright-mcp']);
const EXCLUDE_FILES = new Set(['package.json', 'package-lock.json', 'audits.mdx']);
const EXTS = ['.mdx', '.json', '.yaml', '.yml'];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      out.push(...await walk(join(dir, e.name)));
    } else if (EXTS.some((x) => e.name.endsWith(x)) && !EXCLUDE_FILES.has(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

function applyRules(text) {
  // 1. sentinel-protect with null-byte delimiters (never present in these text files)
  const saved = [];
  let t = text;
  for (const re of PRESERVE) {
    t = t.replace(re, (m) => { saved.push(m); return '\x00' + (saved.length - 1) + '\x00'; });
  }
  // 2. apply ordered rules
  let edits = 0;
  for (const [re, to] of RULES) t = t.replace(re, () => { edits++; return to; });
  // 3. restore
  t = t.replace(/\x00(\d+)\x00/g, (_, i) => saved[Number(i)]);
  return { text: t, edits };
}

// ---- Run over all content files ------------------------------------------------
const files = await walk(ROOT);
let totalEdits = 0, changedFiles = 0;
const recon = new Map(); // identifier -> Set(relpath)

for (const f of files) {
  const before = await readFile(f, 'utf8');
  for (const m of before.matchAll(RECON)) {
    if (!recon.has(m[0])) recon.set(m[0], new Set());
    recon.get(m[0]).add(relative(ROOT, f));
  }
  const { text: after, edits } = applyRules(before);
  if (after !== before) {
    await writeFile(f, after);
    changedFiles++; totalEdits += edits;
    log('  edit', relative(ROOT, f), '(' + edits + ')');
  }
}
log('content: ' + totalEdits + ' swaps across ' + changedFiles + ' files');

// ---- File / directory renames (content already rewritten to new paths) ---------
const RENAMES = [
  ['how-bebop-works.mdx', 'how-tetrafi-works.mdx'],
  ['bopamm-beta.mdx', 'propamm-beta.mdx'],
  ['bopamm', 'propamm'], // directory (moves introduction/quickstart/guides with it)
];
for (const [from, to] of RENAMES) {
  try { await rename(join(ROOT, from), join(ROOT, to)); log('  rename', from, '->', to); }
  catch (e) { log('  ! rename skipped', from, '->', to, '(' + e.code + ')'); }
}

// ---- Reconciliation report -----------------------------------------------------
console.log('\n=== RECONCILIATION: fictional identifiers now written as TetraFi* ===');
if (recon.size === 0) console.log('  (none found)');
for (const [id, paths] of [...recon].sort()) {
  const mapped = id.replace(/^Bebop/, 'TetraFi').replace(/^bebop/, 'tetrafi');
  console.log('  ' + id.padEnd(22) + ' -> ' + mapped.padEnd(24) + ' in ' + [...paths].join(', '));
}
console.log('\nDONE. Next: hand-edit audits.mdx + branded propAMM display spots + docs.json label/banner.');
