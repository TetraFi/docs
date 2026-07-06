/**
 * verify-layout.mjs — confirm LAYOUT/FORMAT parity (not content) across all pages × screen sizes.
 *
 * Content now differs (rebrand), so this compares the structural layout signature — right
 * "On this page" TOC visible? left sidebar visible? content width — between local and source,
 * at each viewport. A page passes a viewport if TOC + sidebar presence match the source.
 *
 * Prereq: `mint dev` on LOCAL_BASE. Read-only; no git.
 */
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.recreate');
const SOURCE = process.env.SOURCE_BASE ?? 'https://docs.bebop.xyz';
const LOCAL = process.env.LOCAL_BASE ?? 'http://localhost:3000';
const CONC = Number(process.env.CONC ?? 3);
const VIEWPORTS = [
  { name: 'ultrawide', width: 1920, height: 1080 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
];
const log = (...a) => console.log('[layout]', ...a);

function flattenPages(nav) {
  const out = [];
  const walk = (arr) => arr.forEach((p) => (typeof p === 'string' ? out.push(p) : p.pages && walk(p.pages)));
  for (const t of nav.tabs || []) { if (t.pages) walk(t.pages); if (t.groups) t.groups.forEach((g) => walk(g.pages)); }
  return [...new Set(out)];
}

async function sig(page, url) {
  const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  if (!r || r.status() >= 400) return { ok: false, status: r ? r.status() : 0 };
  await page.waitForTimeout(1400);
  return page.evaluate(() => {
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 1 && b.height > 1; };
    const tocH = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'On this page');
    const sb = document.querySelector('#sidebar');
    const content = document.querySelector('#content-area, main');
    return { ok: true, toc: vis(tocH), sidebar: !!sb && vis(sb) && sb.querySelectorAll('a[href]').length > 0, w: content ? Math.round(content.getBoundingClientRect().width) : 0 };
  }).catch(() => ({ ok: false, status: -1 }));
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  await mkdir(WORK, { recursive: true });
  const docsJson = JSON.parse(await readFile(join(ROOT, 'docs.json'), 'utf8'));
  const all = flattenPages(docsJson.navigation);
  const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const slugs = only.length ? all.filter((s) => only.includes(s)) : all;
  const RETRY = Number(process.env.RETRY ?? 1);
  log(`layout parity: ${slugs.length} pages × ${VIEWPORTS.length} viewports (conc=${CONC})`);

  const browser = await chromium.launch();
  const results = [];
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: 'dark' });
    log(`\n── ${vp.name} (${vp.width}px) ──`);
    let qi = 0;
    // each worker owns its own local+source pages (no page sharing → no races)
    const workers = Array.from({ length: Math.min(CONC, slugs.length) }, async () => {
      const lp = await ctx.newPage(), sp = await ctx.newPage();
      while (qi < slugs.length) {
        const slug = slugs[qi++];
        let loc, src;
        for (let t = 0; t <= RETRY; t++) {
          [loc, src] = await Promise.all([sig(lp, `${LOCAL}/${slug}`), sig(sp, `${SOURCE}/${slug}`)]);
          if (loc.ok && src.ok) break;
        }
        const match = loc.ok && src.ok && loc.toc === src.toc && loc.sidebar === src.sidebar;
        results.push({ slug, vp: vp.name, match, loc, src });
        if (!match) log(`  ✗ ${slug}  local{toc:${loc.toc},sb:${loc.sidebar}} vs bebop{toc:${src.toc},sb:${src.sidebar}}${!loc.ok ? ' [local ' + loc.status + ']' : ''}${!src.ok ? ' [src ' + src.status + ']' : ''}`);
      }
      await lp.close(); await sp.close();
    });
    await Promise.all(workers);
    await ctx.close();
  }
  await browser.close();

  const fails = results.filter((r) => !r.match);
  const byVp = VIEWPORTS.map((v) => `${v.name}:${results.filter((r) => r.vp === v.name && r.match).length}/${slugs.length}`).join('  ');
  await writeFile(join(WORK, 'layout-parity.json'), JSON.stringify({ byViewport: byVp, fails, total: results.length }, null, 2));
  log(`\nDONE. Layout match per viewport: ${byVp}`);
  log(`Mismatches: ${fails.length}` + (fails.length ? ` → ${[...new Set(fails.map((f) => f.slug))].join(', ')}` : ''));
}

main().catch((e) => { console.error(e); process.exit(1); });
