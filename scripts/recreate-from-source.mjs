/**
 * recreate-from-source.mjs  —  Phase A/B of the docs clone (Step 1: fidelity only)
 *
 * Pulls a source Mintlify docs site into THIS repo as a local working base:
 *   1. parse llms.txt -> canonical page list (+ titles/descriptions) and spec list
 *   2. fetch each page's `.md` (MDX) -> write <slug>.mdx with synthesized frontmatter
 *   3. download OpenAPI/AsyncAPI specs -> api-reference/specs/
 *   4. download same-origin images -> images/ and rewrite paths
 *   5. Playwright: scrape sidebar (tabs/groups/order) + theme tokens + logo/footer
 *   6. reconstruct docs.json (navigation + branding) for pixel parity
 *
 * HARD RULES: writes only inside this repo; runs NO git commands; no rebrand/rewrite.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');               // docs/ repo root
const WORK = join(ROOT, '.recreate');                // gitignored artifacts

const BASE = process.env.SOURCE_BASE ?? 'https://docs.bebop.xyz';
const HOST = new URL(BASE).host;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);
const VIEWPORT = { width: 1440, height: 900 };

const log = (...a) => console.log('[extract]', ...a);

// ---------------------------------------------------------------- fetch utils
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'docs-clone/1.0' } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return await r.text();
}
async function fetchBuffer(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'docs-clone/1.0' } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { error: String(e) }; log('WARN', items[idx]?.url || items[idx], String(e)); }
    }
  });
  await Promise.all(workers);
  return out;
}
async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// ------------------------------------------------------------- llms.txt parse
function parseLlms(txt) {
  const pages = [];
  const specs = [];
  let section = '';
  for (const line of txt.split('\n')) {
    const h = line.match(/^##\s+(.*)/);
    if (h) { section = h[1].trim(); continue; }
    const m = line.match(/^\s*-\s+\[(.+?)\]\((https?:\/\/[^)]+)\)(?::\s*(.*))?$/);
    if (!m) continue;
    const [, title, url, description] = m;
    if (/OpenAPI|AsyncAPI/i.test(section) || /\.(json|ya?ml)$/.test(url)) {
      specs.push({ title, url, kind: /Async/i.test(section) ? 'async' : 'openapi' });
    } else {
      pages.push({ title, url, description: (description || '').trim() });
    }
  }
  return { pages, specs };
}

// slug = path after host, no leading slash, no `.md`/`.mdx`
function urlToSlug(url) {
  return new URL(url).pathname.replace(/^\//, '').replace(/\.(md|mdx)$/i, '');
}

// ------------------------------------------------------- MDX transform
const yaml = (s) => JSON.stringify(s ?? '');  // JSON strings are valid YAML scalars

function transformMdx(raw, fallback) {
  let lines = raw.replace(/\r\n/g, '\n').split('\n');

  // 1) strip the auto-injected "Documentation Index" preamble blockquote at the very top
  if (lines[0]?.startsWith('>')) {
    const block = [];
    let i = 0;
    while (i < lines.length && (lines[i].startsWith('>') || lines[i].trim() === '')) {
      block.push(lines[i]); i++;
      if (lines[i] && !lines[i].startsWith('>') && lines[i].trim() !== '') break;
    }
    if (block.join('\n').includes('Documentation Index')) {
      lines = lines.slice(i);
      while (lines[0]?.trim() === '') lines.shift();
    }
  }

  // 2) first H1 -> title, remove from body
  let title = fallback.title;
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 !== -1) {
    title = lines[h1].replace(/^#\s+/, '').trim();
    lines.splice(h1, 1);
    while (lines[h1]?.trim() === '') lines.splice(h1, 1);
  }

  // 3) a blockquote immediately after the (removed) H1 -> description, remove from body
  let description = fallback.description || '';
  if (lines[0]?.startsWith('>')) {
    const desc = [];
    while (lines[0]?.startsWith('>')) desc.push(lines.shift().replace(/^>\s?/, ''));
    const joined = desc.join(' ').trim();
    if (joined) description = joined;
    while (lines[0]?.trim() === '') lines.shift();
  }

  return { title, description, body: lines.join('\n').trim() + '\n' };
}

// collect + rewrite same-origin / root-relative image refs; returns {body, images:Set}
function rewriteImages(body, images) {
  const isAsset = (u) => /\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(u);
  const handle = (u) => {
    if (!u) return u;
    let abs;
    try { abs = new URL(u, BASE); } catch { return u; }
    if (abs.host !== HOST) return u;            // leave foreign CDNs as absolute
    if (!isAsset(abs.pathname)) return u;
    const local = abs.pathname.startsWith('/') ? abs.pathname : '/' + abs.pathname;
    images.add(abs.href);
    return local;                               // -> /images/... served by mint dev
  };
  // markdown ![alt](url)
  body = body.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (_, a, u, c) => a + handle(u) + c);
  // html/jsx src="..."  src='...'
  body = body.replace(/(\ssrc=)("([^"]+)"|'([^']+)')/g, (m, p, _q, d1, d2) => {
    const u = d1 ?? d2; return `${p}"${handle(u)}"`;
  });
  return body;
}

// ------------------------------------------------------- Playwright: nav+theme
const TAB_ENTRY = [
  { tab: 'Discover', path: '/welcome' },
  { tab: 'Build', path: '/build' },
  { tab: 'Resources', path: '/support' },
];

async function scrapeSidebar(page, path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => { const s = document.querySelector('#sidebar'); return s && s.querySelectorAll('a[href]').length > 0; },
    { timeout: 9000 }
  ).catch(() => {});
  // expand every collapsed group so hidden links render
  for (let i = 0; i < 10; i++) {
    const toggles = await page.$$('#sidebar [aria-expanded="false"]');
    if (!toggles.length) break;
    for (const t of toggles) { try { await t.click({ timeout: 800 }); } catch {} }
    await page.waitForTimeout(200);
  }
  const raw = await page.evaluate(() => {
    const sb = document.querySelector('#sidebar');
    if (!sb) return [];
    const items = [];
    const walker = document.createTreeWalker(sb, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        items.push({ t: 'link', text: (node.textContent || '').trim(), href: node.getAttribute('href') });
      } else {
        const direct = [...node.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
        if (direct && direct.length < 40 && !node.querySelector('a')) items.push({ t: 'group', text: direct });
      }
      node = walker.nextNode();
    }
    return items;
  });
  // dedupe: drop group spans equal to the preceding link's label (per-link noise)
  const groups = [];
  let cur = null;
  let prevLink = null;
  for (const it of raw) {
    if (it.t === 'group') {
      if (prevLink && it.text === prevLink) continue;
      cur = { group: it.text, pages: [] };
      groups.push(cur);
    } else {
      prevLink = it.text;
      const slug = it.href.replace(/^\//, '').replace(/[?#].*$/, '');
      if (!slug) continue;
      if (!cur) { cur = { group: 'Overview', pages: [] }; groups.push(cur); }
      if (!cur.pages.includes(slug)) cur.pages.push(slug);
    }
  }
  return groups.filter((g) => g.pages.length);
}

async function scrapeThemeAndChrome(page) {
  // a content page (not a landing) reliably exposes sidebar, links, banner
  await page.goto(BASE + '/rfq-api/introduction', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return await page.evaluate(() => {
    const rgbToHex = (rgb) => {
      const m = (rgb || '').match(/\d+(\.\d+)?/g); if (!m) return null;
      const [r, g, b] = m.map(Number); const h = (n) => Math.round(n).toString(16).padStart(2, '0');
      return '#' + h(r) + h(g) + h(b);
    };
    const isVivid = (rgb) => {
      const m = (rgb || '').match(/\d+/g); if (!m) return false;
      const [r, g, b] = m.map(Number); const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return (mx - mn) > 40 && mx > 60; // saturated, not gray/black/white
    };
    // primary = most common vivid text color among links/nav/headings
    const tally = {};
    document.querySelectorAll('#sidebar a, #content-area a, a, h1, h2').forEach((el) => {
      const c = getComputedStyle(el).color; if (isVivid(c)) tally[c] = (tally[c] || 0) + 1;
    });
    const primaryRgb = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    // banner = Mintlify's announcement bar (#banner). Capture its background so
    // custom.css can reproduce it (Mintlify defaults the banner to the primary color).
    let banner = null;
    const bannerEl = document.querySelector('#banner');
    if (bannerEl) {
      banner = {
        text: (bannerEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        bg: rgbToHex(getComputedStyle(bannerEl).backgroundColor),
        links: [...bannerEl.querySelectorAll('a')].map((a) => ({ text: a.textContent.trim(), href: a.href })),
      };
    }
    const logo = document.querySelector('header img, a[href="/"] img, #navbar img');
    const fontFirst = (getComputedStyle(document.body).fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
    const footerEl = document.querySelector('footer');
    const footerLinks = footerEl ? [...footerEl.querySelectorAll('a[href]')].map((a) => a.href) : [];
    return {
      dark: document.documentElement.classList.contains('dark'),
      primary: primaryRgb ? rgbToHex(primaryRgb) : null,
      font: fontFirst,
      banner,
      footerLinks,
      feedback: /was this page helpful/i.test(document.body.innerText || ''),
      logoSrc: logo?.getAttribute('src') || null,
      title: document.title,
    };
  });
}

// ------------------------------------------------------- deterministic nav
// Authoritative page set comes from llms.txt; structure comes from URL paths +
// the group taxonomy learned from the rendered sidebar. This avoids the fragile
// DOM-walk off-by-one on nested API-reference groups. The convergence loop
// verifies ordering/labels against the rendered source.
const leaf = (s) => s.split('/').pop();
function ordered(slugs, hints = []) {
  return [...slugs].sort((a, b) => {
    const ra = hints.indexOf(leaf(a)) === -1 ? 1e9 : hints.indexOf(leaf(a));
    const rb = hints.indexOf(leaf(b)) === -1 ? 1e9 : hints.indexOf(leaf(b));
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}
const HINTS = {
  useCases: ['consumer', 'institutional', 'aggregators', 'solvers', 'cross-chain-aggregators', 'liquidators', 'rwa-issuers', 'market-makers'],
  coreConcepts: ['authentication', 'token-approvals', 'execution-modes', 'settlement-smart-contracts', 'monetization'],
  apiDirect: ['introduction', 'quickstart', 'reference'],
  apiRef: ['quote', 'order', 'order-status', 'competition', 'token-list', 'token-info', 'trades', 'trade-by-tx-hash', 'supported-chains'],
  discoverIntro: ['welcome', 'bopamm-beta', 'how-bebop-works', 'supported-chains', 'monetize'],
  resources: ['support', 'faq', 'audits', 'brand-kit', 'privacy', 'terms'],
};
// Build-tab API sections, in the order observed in the rendered sidebar.
const API_SECTIONS = [
  { group: 'RFQ API', prefix: 'rfq-api/' },
  { group: 'BopAMM', prefix: 'bopamm/' },
  { group: 'Aggregation API', prefix: 'aggregation-api/' },
  { group: 'Price API', prefix: 'price-api/' },
  { group: 'Trade History API', prefix: 'trade-history-api/' },
];

// --- OpenAPI wiring: map each api-reference page to a spec operation ----------
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// REST specs per Build API section (Price websockets is AsyncAPI — handled as prose)
const SPEC_BY_SECTION = {
  'rfq-api/': 'rfq-api.json',
  'aggregation-api/': 'aggregation-api.json',
  'trade-history-api/': 'trade-history-api.json',
};
function loadSpecOps(specDir) {
  const map = {};
  for (const [prefix, file] of Object.entries(SPEC_BY_SECTION)) {
    try {
      const spec = JSON.parse(readFileSync(join(specDir, file), 'utf8'));
      const ops = {};
      for (const [p, methods] of Object.entries(spec.paths || {})) {
        for (const [m, op] of Object.entries(methods)) {
          if (!op || typeof op !== 'object') continue;
          const sig = `${m.toUpperCase()} ${p}`;
          if (op.summary) ops[norm(op.summary)] = sig;       // page title == op summary
          if (op.operationId) ops[norm(op.operationId)] = sig;
          ops[norm(p.split('/').pop())] = sig;               // last path segment
        }
      }
      map[prefix] = { specPath: `/api-reference/specs/${file}`, ops };
    } catch (e) { log('WARN spec parse', file, String(e)); }
  }
  return map;
}
// returns "METHOD /path" for an api-reference page, or null
function openapiFor(slug, title, specOps) {
  for (const [prefix, info] of Object.entries(specOps)) {
    if (slug.startsWith(prefix) && slug.includes('/api-reference/')) {
      return info.ops[norm(leaf(slug))] || info.ops[norm(title)] || null;
    }
  }
  return null;
}

function apiSectionGroup(name, prefix, all) {
  const inSec = all.filter((s) => s.startsWith(prefix));
  const guides = inSec.filter((s) => s.startsWith(prefix + 'guides/'));
  const apiref = inSec.filter((s) => s.includes('/api-reference/'));
  const direct = inSec.filter((s) => !guides.includes(s) && !apiref.includes(s));
  const pages = ordered(direct, HINTS.apiDirect);
  if (guides.length) pages.push({ group: 'Guides', pages: ordered(guides) });
  if (apiref.length) {
    const grp = { group: 'API Reference', pages: ordered(apiref, HINTS.apiRef) };
    const spec = SPEC_BY_SECTION[prefix];
    if (spec) grp.openapi = `/api-reference/specs/${spec}`; // register spec for the group
    pages.push(grp);
  }
  return { group: name, pages };
}

function buildTabs(known) {
  const all = [...known];
  const has = (s) => known.has(s);
  const tabs = [{ tab: 'Home', pages: ['home'] }];

  // Discover
  tabs.push({
    tab: 'Discover',
    groups: [
      { group: 'Introduction', pages: ordered(HINTS.discoverIntro.filter(has), HINTS.discoverIntro) },
      { group: 'Built for', pages: ordered(all.filter((s) => s.startsWith('use-cases/')), HINTS.useCases) },
    ].filter((g) => g.pages.length),
  });

  // Build
  const buildGroups = [
    { group: 'Introduction', pages: ['build'].filter(has) },
    { group: 'Core Concepts', pages: ordered(all.filter((s) => s.startsWith('core-concepts/')), HINTS.coreConcepts) },
    ...API_SECTIONS.map((s) => apiSectionGroup(s.group, s.prefix, all)),
  ].filter((g) => g.pages.length);
  tabs.push({ tab: 'Build', groups: buildGroups });

  // Resources
  tabs.push({ tab: 'Resources', pages: ordered(HINTS.resources.filter(has), HINTS.resources) });

  return tabs;
}

// ------------------------------------------------------------------- assemble
function assembleDocsJson(prev, pages, theme) {
  const known = new Set(pages.map((p) => urlToSlug(p.url)));
  const tabs = buildTabs(known);

  // guard: nothing lost — append any unplaced slug to a "More" tab
  const placed = new Set();
  const collect = (arr) => arr.forEach((p) => (typeof p === 'string' ? placed.add(p) : p.pages && collect(p.pages)));
  for (const t of tabs) { (t.pages || []).forEach((s) => placed.add(s)); (t.groups || []).forEach((g) => collect(g.pages)); }
  const leftover = [...known].filter((s) => !placed.has(s));
  if (leftover.length) {
    tabs.push({ tab: 'More', groups: [{ group: 'Unsorted', pages: leftover }] });
    log('NOTE unplaced pages -> "More" tab (verify taxonomy):', leftover);
  }

  const primary = theme.primary || prev.colors?.primary || '#16A34A';
  const siteName = (theme.title || '').split(/\s[|–—-]\s/).pop().trim() || prev.name || 'Docs';
  const out = {
    $schema: 'https://mintlify.com/docs.json',
    theme: prev.theme || 'mint',
    name: siteName,
    colors: { primary, light: primary, dark: primary },
    favicon: prev.favicon || '/favicon.svg',
    navigation: { tabs },
  };
  if (theme.dark) out.appearance = { default: 'dark' };
  if (theme.font) out.fonts = { family: theme.font };
  if (theme.banner?.text) {
    let content = theme.banner.text;
    for (const l of theme.banner.links || []) {
      if (!l.text) continue;
      const href = l.href.includes(HOST) ? new URL(l.href).pathname : l.href;
      content = content.replace(l.text, `[${l.text}](${href})`);
    }
    out.banner = { content, dismissible: true };
  }
  if (existsSync(join(ROOT, 'logo'))) out.logo = prev.logo || { light: '/logo/light.svg', dark: '/logo/dark.svg' };

  // footer socials (Mintlify renders "Powered by" automatically; skip that link)
  const socialMap = [[/github\.com/i, 'github'], [/x\.com|twitter\.com/i, 'x'], [/linkedin\.com/i, 'linkedin'], [/discord/i, 'discord'], [/youtube|youtu\.be/i, 'youtube'], [/t\.me|telegram/i, 'telegram']];
  const socials = {};
  for (const href of theme.footerLinks || []) {
    if (/mintlify/i.test(href)) continue;
    const m = socialMap.find(([re]) => re.test(href));
    if (m) { if (!socials[m[1]]) socials[m[1]] = href; }
    else { try { if (new URL(href).host !== HOST && !socials.website) socials.website = href; } catch {} }
  }
  if (Object.keys(socials).length) out.footer = { socials };
  if (theme.feedback) out.feedback = { thumbsRating: true };
  // collapse API request/response schemas by default to match the source's compact playground
  // (without this, mint v4.2.x expands every nested field → API pages render ~4× too tall).
  // valid enum: 'all' | 'closed'.
  out.api = { params: { expanded: 'closed' } };
  return out;
}

// ------------------------------------------------------------------------ main
async function main() {
  await mkdir(WORK, { recursive: true });
  log('source:', BASE);

  // 1) llms.txt
  const llms = await fetchText(`${BASE}/llms.txt`);
  await write(join(WORK, 'llms.txt'), llms);
  const { pages, specs } = parseLlms(llms);
  log(`parsed ${pages.length} pages, ${specs.length} specs`);

  // 2) specs first, so page frontmatter can wire the OpenAPI playgrounds
  await mkdir(join(ROOT, 'api-reference', 'specs'), { recursive: true });
  await pool(specs, CONCURRENCY, async (s) => {
    const buf = await fetchBuffer(s.url);
    const name = s.url.split('/').pop();
    await write(join(ROOT, 'api-reference', 'specs', name), buf);
    return name;
  });
  const specOps = loadSpecOps(join(ROOT, 'api-reference', 'specs'));
  log(`downloaded ${specs.length} specs; mapped ops for ${Object.keys(specOps).length} sections`);

  // 3) pages -> mdx (api-reference pages get `openapi:` frontmatter for the playground)
  const images = new Set();
  const customClasses = new Set();   // custom className tokens used in MDX (for custom.css recovery)
  // home is a Mintlify "custom" full-width landing on the source (no sidebar/TOC/title);
  // the .md endpoint strips its `mode:` frontmatter, so re-add it. welcome/build use the
  // default mode (they render sidebars — confirmed by the nav scrape).
  const CUSTOM_MODE = new Set(['home']);
  let wired = 0;
  const written = await pool(pages, CONCURRENCY, async (p) => {
    const mdUrl = p.url.endsWith('.md') ? p.url : p.url + '.md';
    const raw = await fetchText(mdUrl);
    const slug = urlToSlug(p.url);
    const t = transformMdx(raw, p);
    const body = rewriteImages(t.body, images);
    for (const m of body.matchAll(/className="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && customClasses.add(c));
    const fmLines = [`title: ${yaml(t.title)}`, `description: ${yaml(t.description)}`];
    if (CUSTOM_MODE.has(slug)) fmLines.push('mode: "custom"');
    const oa = openapiFor(slug, t.title, specOps);
    if (oa) { fmLines.push(`openapi: ${yaml(oa)}`); wired++; }
    const fm = `---\n${fmLines.join('\n')}\n---\n\n`;
    const file = join(ROOT, slug + '.mdx');
    await write(file, fm + body);
    return { slug, file };
  });
  const okPages = written.filter((w) => w && !w.error);
  log(`wrote ${okPages.length}/${pages.length} mdx pages (${wired} wired to OpenAPI)`);

  // 4) images
  const imgList = [...images];
  await pool(imgList, CONCURRENCY, async (u) => {
    const buf = await fetchBuffer(u);
    const path = new URL(u).pathname.replace(/^\//, '');
    await write(join(ROOT, path), buf);
    return path;
  });
  log(`downloaded ${imgList.length} images`);

  // 5) Playwright: nav + theme
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  const nav = {};
  for (const { tab, path } of TAB_ENTRY) {
    try { nav[tab] = await scrapeSidebar(page, path); log(`scraped ${tab}: ${nav[tab].length} groups`); }
    catch (e) { nav[tab] = []; log('WARN nav', tab, String(e)); }
  }
  // keep the raw scrape as a reference artifact (the loop checks ordering against it)
  await write(join(WORK, 'nav-scrape.json'), JSON.stringify(nav, null, 2));
  const theme = await scrapeThemeAndChrome(page);
  // recover source custom.css rules for the custom classes used in the MDX
  // (Bebop inlines them; we read the resolved rules straight from the stylesheet)
  theme.customCss = await page.evaluate((classes) => {
    const refs = (txt) => classes.some((c) => txt.includes('.' + c));
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; } // skip cross-origin
      for (const rule of rules) {
        const txt = rule.cssText || '';
        if (rule.type === 1 && refs(txt)) out.push(txt);                       // style rule
        else if (rule.cssRules) {                                              // @media etc.
          for (const r of rule.cssRules) { if (refs(r.cssText || '')) { out.push(txt); break; } }
        }
      }
    }
    return [...new Set(out)];
  }, [...customClasses]);
  log(`recovered ${theme.customCss.length} custom CSS rules for ${customClasses.size} classes`);
  await write(join(WORK, 'theme.json'), JSON.stringify(theme, null, 2));
  // download source logo into logo/ for an exact local base (swapped in Step 2).
  // CDN URLs are signed — fetch the full URL as-is, then sniff the real file type.
  if (theme.logoSrc) {
    try {
      const buf = await fetchBuffer(theme.logoSrc);
      const head = buf.slice(0, 16).toString('latin1');
      const ext = /<svg|<\?xml/.test(head) ? 'svg' : head.startsWith('\x89PNG') ? 'png'
        : head.startsWith('RIFF') ? 'webp' : head.startsWith('\xff\xd8') ? 'jpg' : 'svg';
      await write(join(ROOT, 'logo', `source.${ext}`), buf);
      theme.logoLight = theme.logoDark = `/logo/source.${ext}`;
      log('logo saved:', theme.logoLight, `(${buf.length} bytes)`);
    } catch (e) { log('WARN logo', String(e)); }
  }
  await browser.close();

  // 6) docs.json
  const prev = JSON.parse(await readFile(join(ROOT, 'docs.json'), 'utf8'));
  const docsJson = assembleDocsJson(prev, pages, theme);
  if (theme.logoLight) docsJson.logo = { light: theme.logoLight, dark: theme.logoDark || theme.logoLight };
  await write(join(ROOT, 'docs.json'), JSON.stringify(docsJson, null, 2) + '\n');
  log('reconstructed docs.json with', docsJson.navigation.tabs.length, 'tabs');

  // custom.css: styling Mintlify can't express in docs.json (e.g. the banner color,
  // which Mintlify otherwise defaults to the primary color). Auto-loaded by mint.
  const css = [];
  if (theme.banner?.bg && /^#/.test(theme.banner.bg)) {
    css.push(`/* match source announcement banner */\n#banner { background-color: ${theme.banner.bg} !important; }`);
  }
  if (theme.customCss?.length) {
    css.push('/* recovered custom.css rules from source (home hero, color grid, logo showcase) */\n' + theme.customCss.join('\n'));
  }
  if (css.length) { await write(join(ROOT, 'custom.css'), css.join('\n\n') + '\n'); log('wrote custom.css'); }

  // status manifest for the convergence loop
  const manifest = {
    source: BASE,
    pages: okPages.map((w) => ({ slug: w.slug, status: 'written' })),
    specs: specs.map((s) => s.url.split('/').pop()),
    images: imgList.length,
  };
  await write(join(WORK, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log('DONE. Review with: mint dev   (then run scripts/verify-convergence.mjs)');
}

main().catch((e) => { console.error(e); process.exit(1); });
