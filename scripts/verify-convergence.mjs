/**
 * verify-convergence.mjs  —  Phase C of the docs clone (Step 1: fidelity only)
 *
 * Compares the LOCAL `mint dev` render against the SOURCE site, page by page,
 * and writes a status manifest + a failing-pages report for the fix-loop.
 *
 * For each page slug (flattened from docs.json navigation):
 *   - screenshot SOURCE and LOCAL at a fixed viewport (consistent dims) + fullPage
 *   - pixel-diff the viewport shots (pixelmatch), masking known-dynamic chrome
 *   - compare rendered main-content text (Jaccard over word sets)
 *   - classify pass/fail against thresholds
 *
 * Prereqs: `mint dev` running on LOCAL_BASE. Writes only into .recreate/. No git.
 *
 * Usage:
 *   node scripts/verify-convergence.mjs                 # all pages
 *   node scripts/verify-convergence.mjs --only home,support
 *   node scripts/verify-convergence.mjs --limit 6
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WORK = join(ROOT, '.recreate');
const SHOTS = join(WORK, 'shots');

const SOURCE_BASE = process.env.SOURCE_BASE ?? 'https://docs.bebop.xyz';
const LOCAL_BASE = process.env.LOCAL_BASE ?? 'http://localhost:3000';
const PIXEL_THRESHOLD = Number(process.env.PIXEL_THRESHOLD ?? 0.03); // ≤3% differing px = pass
const TEXT_THRESHOLD = Number(process.env.TEXT_THRESHOLD ?? 0.9);    // ≥0.90 Jaccard = pass
const MAX_H = Number(process.env.MAX_H ?? 12000);                    // clamp full-page height (perf/mem)

// Full coverage matrix: every breakpoint in the recovered custom.css (768/640/480)
// plus large-monitor + standard desktop + phone. A page passes only if ALL pass.
const ALL_VIEWPORTS = [
  { name: 'ultrawide', width: 1920, height: 1080 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
];

const argv = process.argv.slice(2);
const getArg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1]
  || (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : '');
const onlyArg = getArg('only');
const limitArg = Number(getArg('limit') || 0);
const vpArg = getArg('viewports'); // e.g. --viewports=desktop,mobile
const VIEWPORTS = vpArg
  ? ALL_VIEWPORTS.filter((v) => vpArg.split(',').map((s) => s.trim()).includes(v.name))
  : ALL_VIEWPORTS;

const log = (...a) => console.log('[verify]', ...a);

// flatten docs.json navigation -> ordered slug list
function flattenPages(nav) {
  const out = [];
  const walk = (arr) => arr.forEach((p) => (typeof p === 'string' ? out.push(p) : p.pages && walk(p.pages)));
  for (const t of nav.tabs || []) { if (t.pages) walk(t.pages); if (t.groups) t.groups.forEach((g) => walk(g.pages)); }
  return [...new Set(out)];
}

const NO_MOTION = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
// Masking is OFF by default: element masks misalign between source/local on short
// pages and manufacture false diffs (the search-box text delta is negligible anyway).
// Opt in with MASK=1 only if a specific dynamic widget needs suppressing.
const maskLocators = (page) => !process.env.MASK ? [] : [
  page.locator('#search-bar-entry, [id*="search" i], [aria-label*="Search" i]'),
  page.getByRole('button', { name: /ask|assistant|copy page/i }),
  page.locator('[class*="assistant" i], [aria-label*="assistant" i], [aria-label*="theme" i], [aria-label*="appearance" i]'),
];

async function capture(page, url, { withText } = {}) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
  const status = res ? res.status() : 0;
  await page.addStyleTag({ content: NO_MOTION }).catch(() => {});
  await page.waitForTimeout(1000); // hydration + fonts
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  // scroll through the page to trigger lazy-loaded images/components, then return to top
  await page.evaluate(() => new Promise((resolve) => {
    let y = 0; const step = Math.max(400, window.innerHeight);
    const tick = () => {
      window.scrollTo(0, y); y += step;
      if (y < document.body.scrollHeight) setTimeout(tick, 50); else { window.scrollTo(0, 0); resolve(); }
    };
    tick();
  })).catch(() => {});
  await page.waitForTimeout(400);
  let shot = null;
  try {
    // SCOPE=content compares only the documentation body (excludes deploy-only chrome
    // that local preview can't render: "was this helpful" feedback + AI assistant bar +
    // footer) — the fair test of clone fidelity. Default = full page.
    if (process.env.SCOPE === 'content') {
      const el = page.locator('#content-area, main, article').first();
      shot = await el.screenshot({ animations: 'disabled' }).catch(() => null);
    }
    if (!shot) shot = await page.screenshot({ fullPage: true, mask: maskLocators(page), animations: 'disabled' });
  } catch (e) {
    log('screenshot fail', url, (e.message || '').slice(0, 140));
    try { shot = await page.screenshot({ fullPage: true, animations: 'disabled' }); } catch {}
  }
  let text = '';
  if (withText) text = await page.evaluate(() => {
    const el = document.querySelector('#content-area, main, article') || document.body;
    return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
  return { status, shot, text };
}

function pixelDiff(aBuf, bBuf) {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  const width = Math.min(a.width, b.width);
  const fullH = Math.max(a.height, b.height);
  const height = Math.min(fullH, MAX_H);          // clamp for memory/perf
  const truncated = fullH > MAX_H;
  // pad-to-max: blit each image top-left into a width×height canvas; the unfilled band
  // (height delta) stays zero-filled, so a shorter/taller page counts as a real diff.
  const place = (src) => {
    const out = new PNG({ width, height });        // zero-filled
    const h = Math.min(src.height, height);
    const w = Math.min(src.width, width);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (src.width * y + x) << 2;
        const di = (width * y + x) << 2;
        out.data[di] = src.data[si];
        out.data[di + 1] = src.data[si + 1];
        out.data[di + 2] = src.data[si + 2];
        out.data[di + 3] = src.data[si + 3];
      }
    }
    return out;
  };
  const ca = place(a), cb = place(b);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(ca.data, cb.data, diff.data, width, height, { threshold: 0.1 });
  return { ratio: changed / (width * height), changed, width, height, diffPng: diff, srcH: a.height, locH: b.height, truncated };
}

function jaccard(a, b) {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (!wa.size && !wb.size) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const docsJson = JSON.parse(await readFile(join(ROOT, 'docs.json'), 'utf8'));
  let slugs = flattenPages(docsJson.navigation);
  if (onlyArg) slugs = onlyArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (limitArg) slugs = slugs.slice(0, limitArg);
  log(`comparing ${slugs.length} pages × ${VIEWPORTS.length} viewports [${VIEWPORTS.map((v) => v.name).join(', ')}] | fullPage | pixel≤${PIXEL_THRESHOLD}`);

  const browser = await chromium.launch();
  const byPage = new Map(slugs.map((s) => [s, { slug: s, viewports: {}, textSim: null }]));
  const textViewport = VIEWPORTS.find((v) => v.name === 'desktop') || VIEWPORTS[0];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, colorScheme: 'dark' });
    const srcPage = await ctx.newPage();
    const locPage = await ctx.newPage();
    log(`\n── viewport ${vp.name} (${vp.width}×${vp.height}) ──`);
    for (const slug of slugs) {
      const rec = byPage.get(slug);
      const withText = vp === textViewport;
      const src = await capture(srcPage, `${SOURCE_BASE}/${slug}`, { withText });
      const loc = await capture(locPage, `${LOCAL_BASE}/${slug}`, { withText });
      const safe = slug.replace(/\//g, '__');

      if (src.status >= 400 || !src.shot) { rec.viewports[vp.name] = { status: 'source-missing', srcStatus: src.status }; log(`? ${slug} @${vp.name} (source ${src.status})`); continue; }
      if (loc.status >= 400 || !loc.shot) { rec.viewports[vp.name] = { status: 'local-missing', locStatus: loc.status }; log(`✗ ${slug} @${vp.name} (local ${loc.status})`); continue; }

      await writeFile(join(SHOTS, `${safe}.${vp.name}.source.png`), src.shot);
      await writeFile(join(SHOTS, `${safe}.${vp.name}.local.png`), loc.shot);
      const pd = pixelDiff(src.shot, loc.shot);
      await writeFile(join(SHOTS, `${safe}.${vp.name}.diff.png`), PNG.sync.write(pd.diffPng));
      rec.viewports[vp.name] = { status: pd.ratio <= PIXEL_THRESHOLD ? 'pass' : 'fail', px: +pd.ratio.toFixed(4), srcH: pd.srcH, locH: pd.locH, ...(pd.truncated ? { truncated: true } : {}) };
      if (withText && src.text) rec.textSim = +jaccard(src.text, loc.text).toFixed(3);
      const r = rec.viewports[vp.name];
      log(`${r.status === 'pass' ? '✓' : '✗'} ${slug} @${vp.name}  px=${(r.px * 100).toFixed(1)}%  h=${pd.srcH}/${pd.locH}${pd.truncated ? ' [clamped]' : ''}`);
    }
    await ctx.close();
  }
  await browser.close();

  // aggregate: a page passes only if EVERY viewport passes
  const results = [...byPage.values()].map((rec) => {
    const vps = Object.values(rec.viewports);
    const worst = vps.length ? Math.max(...vps.map((v) => v.px ?? 1)) : 1;
    const allPass = vps.length === VIEWPORTS.length && vps.every((v) => v.status === 'pass');
    const failing = Object.entries(rec.viewports).filter(([, v]) => v.status !== 'pass')
      .map(([n, v]) => `${n}:${v.status === 'fail' ? (v.px * 100).toFixed(1) + '%' : v.status}`);
    return { slug: rec.slug, status: allPass ? 'pass' : 'fail', worstPx: +worst.toFixed(4), textSim: rec.textSim, viewports: rec.viewports, failing };
  });
  const pass = results.filter((r) => r.status === 'pass');
  const fail = results.filter((r) => r.status !== 'pass');
  const review = pass.filter((r) => r.textSim != null && r.textSim < TEXT_THRESHOLD);
  const status = { source: SOURCE_BASE, local: LOCAL_BASE, viewports: VIEWPORTS.map((v) => v.name), total: results.length, pass: pass.length, fail: fail.length, textReview: review.length, results };
  await writeFile(join(WORK, 'recreate-status.json'), JSON.stringify(status, null, 2));
  await writeFile(join(WORK, 'failing-pages.json'), JSON.stringify(fail, null, 2));
  log(`\nDONE  ${pass.length}/${results.length} pass at ALL ${VIEWPORTS.length} viewports (pixel≤${PIXEL_THRESHOLD * 100}%).  Failing: ${fail.length}.  Text-review: ${review.length}`);
  if (fail.length) for (const f of fail) log(`  ✗ ${f.slug}  [${f.failing.join(', ')}]`);
  if (review.length) log('Text-review (visually ok, content differs):', review.map((r) => r.slug).join(', '));
  log('Artifacts: .recreate/shots/<page>.<viewport>.{source,local,diff}.png, .recreate/recreate-status.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
