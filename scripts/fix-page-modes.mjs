/**
 * fix-page-modes.mjs — match Bebop's per-page Mintlify layout `mode`.
 *
 * The `.md` extraction stripped the `mode:` frontmatter, so our pages render default
 * (sidebar + right "On this page" TOC + narrower content) while many source pages use
 * `wide` (no right TOC, wider) or `custom` (landing). This reads each source page's
 * ACTUAL rendered layout and stamps the matching `mode:` onto the local .mdx.
 *
 * Layout/config only — reads which mode each page uses (functional), touches no content.
 * Local only; runs NO git.
 */
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.SOURCE_BASE ?? 'https://docs.bebop.xyz';
const log = (...a) => console.log('[modes]', ...a);

function flattenPages(nav) {
  const out = [];
  const walk = (arr) => arr.forEach((p) => (typeof p === 'string' ? out.push(p) : p.pages && walk(p.pages)));
  for (const t of nav.tabs || []) { if (t.pages) walk(t.pages); if (t.groups) t.groups.forEach((g) => walk(g.pages)); }
  return [...new Set(out)];
}

// set/replace/remove the `mode:` line in a file's frontmatter; leave everything else intact
function applyMode(src, mode) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { src, changed: false, prev: null }; // no frontmatter — skip
  const prevLine = m[1].split('\n').find((l) => /^mode:\s*/.test(l));
  const prev = prevLine ? prevLine.replace(/^mode:\s*/, '').replace(/['"]/g, '').trim() : null;
  const target = mode === 'default' ? null : mode;
  if (prev === target || (prev === null && target === null)) return { src, changed: false, prev };
  const kept = m[1].split('\n').filter((l) => !/^mode:\s*/.test(l));
  if (target) kept.push(`mode: "${target}"`);
  const rebuilt = `---\n${kept.join('\n')}\n---\n` + src.slice(m[0].length);
  return { src: rebuilt, changed: true, prev };
}

async function detectMode(page, slug) {
  const res = await page.goto(`${SOURCE}/${slug}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  if (!res || res.status() >= 400) return { mode: null, status: res ? res.status() : 0 };
  await page.waitForTimeout(2200); // hydration
  return await page.evaluate(() => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    // right "On this page" TOC — the heading is a leaf node with that exact text
    const tocHeading = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'On this page'
    );
    const tocVisible = vis(tocHeading);
    const sidebar = document.querySelector('#sidebar');
    const sidebarVisible = vis(sidebar) && sidebar.querySelectorAll('a[href]').length > 0;
    const content = document.querySelector('#content-area, main');
    const contentW = content ? Math.round(content.getBoundingClientRect().width) : null;
    let mode;
    if (!sidebarVisible) mode = 'custom';                 // landing pages (no sidebar/TOC/chrome)
    else if (tocVisible) mode = 'default';                // sidebar + TOC
    else mode = 'wide';                                   // sidebar, no TOC, wider content
    return { mode, tocVisible, sidebarVisible, contentW, status: 200 };
  });
}

async function main() {
  const docsJson = JSON.parse(await readFile(join(ROOT, 'docs.json'), 'utf8'));
  const slugs = flattenPages(docsJson.navigation);
  log(`detecting layout mode for ${slugs.length} pages from ${SOURCE}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  const map = [];
  for (const slug of slugs) {
    const file = join(ROOT, slug + '.mdx');
    if (!existsSync(file)) { log(`skip ${slug} (no local file)`); continue; }
    const d = await detectMode(page, slug);
    if (!d.mode) { log(`? ${slug} (source ${d.status})`); map.push({ slug, mode: 'source-missing' }); continue; }
    const before = await readFile(file, 'utf8');
    const { src, changed, prev } = applyMode(before, d.mode);
    if (changed) await writeFile(file, src);
    map.push({ slug, mode: d.mode, toc: d.tocVisible, changed, prev });
    log(`${changed ? '✎' : '·'} ${slug.padEnd(42)} bebop=${d.mode.padEnd(7)} toc=${d.tocVisible ? 'y' : 'n'} w=${d.contentW}${changed ? `  (was ${prev ?? 'default'})` : ''}`);
  }
  await browser.close();

  const byMode = map.reduce((a, r) => ((a[r.mode] = (a[r.mode] || 0) + 1), a), {});
  const changes = map.filter((r) => r.changed);
  log(`\nmode distribution: ${JSON.stringify(byMode)}`);
  log(`changed ${changes.length} pages: ${changes.map((c) => `${c.slug}→${c.mode}`).join(', ') || '(none)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
