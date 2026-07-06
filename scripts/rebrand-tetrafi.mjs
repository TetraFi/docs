/**
 * rebrand-tetrafi.mjs — swap the Bebop brand IDENTITY to TetraFi (Step 2, branding only).
 *
 * Scope (deliberately narrow):
 *   1. docs.json chrome: name, colors, logo, favicon, footer.socials  (banner/api/nav untouched)
 *   2. TetraFi brand assets: logo marks (light/dark) + favicon
 *   3. FACTUAL brand-reference tokens across *.mdx — an explicit allow-list, NOT a
 *      `Bebop`→`TetraFi` word replacement. Product prose + API surface are left verbatim.
 *
 * Preserved on purpose: api.bebop.xyz, help.bebop.xyz, docs.bebop.xyz, *.typeform.com,
 * mintcdn.com, *.s3.* (case-study/audit images), and every in-prose "Bebop" mention.
 *
 * Local only. Runs NO git. Uses TetraFi's real facts sourced from tetrafi-web-v2 / design-system.
 */
import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // docs/
const WEB = resolve(ROOT, '..', 'tetrafi-web-v2');
const log = (...a) => console.log('[rebrand]', ...a);

// ---- 1. TetraFi brand assets --------------------------------------------------
const mark = readFileSync(join(WEB, 'public/images/tetrafi-mark.svg'), 'utf8');
await mkdir(join(ROOT, 'logo'), { recursive: true });
await writeFile(join(ROOT, 'logo/tetrafi-mark-dark.svg'), mark);                         // white mark → dark bg
await writeFile(join(ROOT, 'logo/tetrafi-mark-light.svg'), mark.replace(/#ffffff/gi, '#1e3a8a')); // navy mark → light bg
await copyFile(join(WEB, 'public/favicon.svg'), join(ROOT, 'favicon.svg'));
log('assets: logo marks (light/dark) + favicon copied');

// ---- 2. docs.json chrome (preserve banner/api/feedback/fonts/appearance/navigation) ----
const dj = JSON.parse(await readFile(join(ROOT, 'docs.json'), 'utf8'));
dj.name = 'TetraFi';
dj.colors = { primary: '#2c5282', light: '#3b6db5', dark: '#1e3a8a' };
dj.logo = { light: '/logo/tetrafi-mark-light.svg', dark: '/logo/tetrafi-mark-dark.svg' };
dj.favicon = '/favicon.svg';
dj.footer = {
  socials: {
    github: 'https://github.com/TetraFi',
    linkedin: 'https://www.linkedin.com/company/tetrafi',
    telegram: 'https://t.me/TetraFi_Team',
    website: 'https://tetrafi.io',
  },
};
await writeFile(join(ROOT, 'docs.json'), JSON.stringify(dj, null, 2) + '\n');
log('docs.json: name/colors/logo/favicon/footer.socials → TetraFi (banner + api + nav preserved)');

// ---- 3. Factual reference tokens across *.mdx (explicit allow-list) -----------
// Order matters: specific tokens before the bare-domain rule.
const REPLACERS = [
  [/hello@bebop\.xyz/g, 'enquiries@tetrafi.io'],
  [/github\.com\/bebop-dex/g, 'github.com/TetraFi'],
  [/linkedin\.com\/company\/bebopdex/g, 'linkedin.com/company/tetrafi'],
  [/(?<!\.)bebop\.xyz/g, 'tetrafi.io'], // bare domain only — lookbehind preserves api./help./docs.<sub>.bebop.xyz
];

async function walkMdx(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.recreate', '.git', 'logo'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p.endsWith(join('api-reference', 'specs'))) continue; // never touch spec files
      out.push(...await walkMdx(p));
    } else if (e.name.endsWith('.mdx')) out.push(p);
  }
  return out;
}

const files = await walkMdx(ROOT);
let changed = 0, edits = 0;
for (const f of files) {
  const before = await readFile(f, 'utf8');
  let after = before;
  for (const [re, to] of REPLACERS) after = after.replace(re, () => (edits++, to));
  if (after !== before) { await writeFile(f, after); changed++; log('  ✎', f.replace(ROOT + '/', '')); }
}
log(`references: ${edits} token swaps across ${changed} mdx files`);
log('DONE. Identity pages (home/support/brand-kit) are edited separately by hand.');
