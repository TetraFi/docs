#!/usr/bin/env node
// Every code sample on the site comes from a runnable source, so a published sample is one a test
// has executed. Sources:
//   - samples/http/*.sh                          curl, owned by this repo
//   - samples/node/*.mjs, samples/python/*.py    Node.js and Python, owned by this repo
//   - ../tetrafi-ui/packages/sdk/examples/*.ts   TypeScript SDK (TETRAFI_SDK_EXAMPLES overrides)
// A region `# region <name>` … `# endregion` (shell, Python) or `// #region <name>` … `// #endregion`
// (JavaScript, TypeScript) becomes snippets/samples/<name>.mdx: one <CodeGroup> holding every language that
// defines that region. Pages import the snippet; they never hold inline request samples.
//
//   node scripts/sync-samples.mjs           write snippets
//   node scripts/sync-samples.mjs --check   exit 1 on drift (SNIPPET_DRIFT <name>)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'snippets', 'samples');
const check = process.argv.includes('--check');

const SOURCES = [
  { dir: path.join(root, 'samples', 'http'), ext: '.sh', lang: 'bash', title: 'cURL', open: /^\s*# region (\S+)\s*$/, close: /^\s*# endregion(?:\s+(\S+))?\s*$/ },
  { dir: path.join(root, 'samples', 'node'), ext: '.mjs', lang: 'javascript', title: 'Node.js', open: /^\s*\/\/ #region (\S+)\s*$/, close: /^\s*\/\/ #endregion(?:\s+(\S+))?\s*$/ },
  { dir: path.join(root, 'samples', 'python'), ext: '.py', lang: 'python', title: 'Python', open: /^\s*# region (\S+)\s*$/, close: /^\s*# endregion(?:\s+(\S+))?\s*$/ },
  {
    dir: process.env.TETRAFI_SDK_EXAMPLES ?? path.join(root, '..', 'tetrafi-ui', 'packages', 'sdk', 'examples'),
    ext: '.ts', lang: 'typescript', title: 'TypeScript SDK', open: /^\s*\/\/ #region (\S+)\s*$/, close: /^\s*\/\/ #endregion(?:\s+(\S+))?\s*$/,
  },
];

// Without the map no SDK region is published; removing it changes every paired snippet, which
// --check reports as drift.
const sdkMapFile = path.join(root, 'samples', 'sdk-regions.json');
const sdkMap = existsSync(sdkMapFile) ? JSON.parse(readFileSync(sdkMapFile, 'utf8')).regions : null;
function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join('\n').replace(/^\n+|\n+$/g, '');
}

function regions(source) {
  // A source this repo publishes from must exist; a missing one would silently drop its language.
  if (!existsSync(source.dir)) {
    if (source.lang === 'typescript' && !sdkMap) return [];
    throw new Error(`SAMPLE_SOURCE_MISSING ${source.dir}`);
  }
  const found = [];
  for (const file of readdirSync(source.dir).filter((f) => f.endsWith(source.ext)).sort()) {
    const lines = readFileSync(path.join(source.dir, file), 'utf8').split('\n');
    let name = null;
    let body = [];
    lines.forEach((line, i) => {
      const opened = line.match(source.open);
      if (opened) {
        if (name) throw new Error(`${file}:${i + 1} region ${opened[1]} opens inside ${name}`);
        [name, body] = [opened[1], []];
      } else if (source.close.test(line)) {
        if (!name) throw new Error(`${file}:${i + 1} endregion without region`);
        const closes = line.match(source.close)[1];
        if (closes && closes !== name) throw new Error(`${file}:${i + 1} endregion ${closes} closes region ${name}`);
        found.push({ name, file, code: dedent(body) });
        name = null;
      } else if (name) {
        body.push(line);
      }
    });
    if (name) throw new Error(`${file}: region ${name} is never closed`);
  }
  return found;
}

// The SDK publishes only the regions samples/sdk-regions.json names, renamed to the docs snippet
// they pair with; a listed region the examples no longer define is drift, never a silent gap.
function published(source) {
  if (source.lang === 'typescript' && !sdkMap) return [];
  const found = regions(source);
  if (source.lang !== 'typescript') return found;
  const missing = Object.keys(sdkMap).filter((name) => !found.some((r) => r.name === name));
  if (missing.length) throw new Error(`SDK_REGION_MISSING ${missing.join(', ')} (listed in samples/sdk-regions.json)`);
  return found.filter((r) => sdkMap[r.name]).map((r) => ({ ...r, name: sdkMap[r.name] }));
}

const byName = new Map();
for (const source of SOURCES) {
  for (const region of published(source)) {
    const entry = byName.get(region.name) ?? [];
    if (entry.some((e) => e.lang === source.lang)) throw new Error(`region ${region.name} is defined twice in ${source.lang}`);
    entry.push({ ...region, lang: source.lang, title: source.title, dir: source.dir });
    byName.set(region.name, entry);
  }
}

function render(name, entries) {
  const from = entries.map((e) => path.relative(root, path.join(e.dir, e.file))).join(', ');
  const blocks = entries.map((e) => `\`\`\`${e.lang} ${e.title}\n${e.code}\n\`\`\``).join('\n\n');
  return `{/* Generated by scripts/sync-samples.mjs from ${from}. Edit the source, then run npm run sync. */}\n\n<CodeGroup>\n\n${blocks}\n\n</CodeGroup>\n`;
}

const expected = new Map([...byName].map(([name, entries]) => [`${name}.mdx`, render(name, entries)]));
const existing = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.mdx')) : [];
const drift = [];
for (const [file, content] of expected) {
  const target = path.join(outDir, file);
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content) drift.push(file);
}
for (const file of existing) if (!expected.has(file)) drift.push(file);

if (check) {
  for (const file of drift) console.log(`SNIPPET_DRIFT ${file.replace(/\.mdx$/, '')}`);
  console.log(`sync-samples --check: ${expected.size} snippets, ${drift.length} drifted`);
  process.exit(drift.length ? 1 : 0);
}
mkdirSync(outDir, { recursive: true });
for (const [file, content] of expected) writeFileSync(path.join(outDir, file), content);
// A snippet whose source region is gone is archived, not left published.
const stale = existing.filter((f) => !expected.has(f));
if (stale.length) {
  console.log(`stale snippets (no source region): ${stale.join(', ')}; archive them with mv into .archive/snippets/samples/`);
  process.exit(1);
}
console.log(`sync-samples: wrote ${expected.size} snippets`);
