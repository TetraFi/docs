#!/usr/bin/env node
// Every in-site link with a #fragment must land on a heading of its target page.
// `mint broken-links` checks pages only, so a renamed heading silently breaks deep links.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const slug = (heading) =>
  heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    // Mintlify drops ASCII punctuation but keeps other characters (a curly apostrophe stays).
    .replace(/[!-,./:-@[-^`{-~]/g, '')
    .trim()
    .replace(/\s+/g, '-');

const anchorsOf = new Map();
function anchors(page) {
  if (!anchorsOf.has(page)) {
    const file = `${page}.mdx`;
    const text = existsSync(file) ? readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '') : null;
    anchorsOf.set(page, text === null ? null : new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]))));
  }
  return anchorsOf.get(page);
}

const files = execFileSync('git', ['ls-files', '*.mdx'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.startsWith('.archive/') && !f.startsWith('snippets/') && existsSync(f));

const link = /(?:\]\(|href=["'])(\/[a-z0-9/_-]*)?#([a-z0-9_-]+)[)"']/g;
const broken = [];
for (const file of files) {
  const self = file.replace(/\.mdx$/, '');
  for (const [, page, anchor] of readFileSync(file, 'utf8').matchAll(link)) {
    const target = page ? page.slice(1) : self;
    const set = anchors(target);
    if (set && !set.has(anchor)) broken.push(`${file}: /${target}#${anchor}`);
  }
}

if (broken.length) {
  console.error(`anchor-check: ${broken.length} link(s) point at a heading that does not exist:\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`anchor-check: ${files.length} pages, every #anchor resolves`);
