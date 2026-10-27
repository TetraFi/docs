#!/usr/bin/env node
// Leak gate: this repository is public, so every push publishes everything it carries. Two scans:
//   1. the tree a push would publish (tracked plus untracked-not-ignored files): every rule;
//   2. every blob added or changed in the commits the push would carry (<base>..HEAD, base
//      default origin/main): the hard rules (ids, hosts, credentials). A leak committed and then
//      removed is still published by the push, so history counts.
//
//   node scripts/leak-gate.mjs [--json <report.json>] [--root <dir>] [--base <ref>] [--head <ref>] [--no-history]
//
// The pre-push hook (.githooks/pre-push) runs it with the remote's ref as base.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { allowedInternalNames, defaultPublicSpec, rulesFor, scanText } from './leak-rules.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const root = path.resolve(flag('--root') ?? path.join(import.meta.dirname, '..'));
const jsonOut = flag('--json');
const publicSpec = defaultPublicSpec(root);
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const list = (...a) => git(...a).split('\0').filter(Boolean);

// The rule files describe what to look for; binary assets carry no text worth scanning.
const SKIP = [/^scripts\/leak-(?:gate|rules)\.mjs$/, /^scripts\/.*\.test\.mjs$/, /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm)$/i, /^package-lock\.json$/];
const skipped = (file) => SKIP.some((re) => re.test(file));

const allowed = allowedInternalNames(publicSpec);
const rules = rulesFor(root, allowed);
const hardRules = rules.filter((r) => r.severity === 'hard');
const hits = [];

const files = [...new Set([...list('ls-files', '-z'), ...list('ls-files', '-z', '--others', '--exclude-standard')])]
  .filter((f) => !skipped(f) && existsSync(path.join(root, f)));
for (const file of files) {
  for (const h of scanText(readFileSync(path.join(root, file), 'utf8'), rules)) hits.push({ scope: 'tree', file, ...h });
}

let history = null;
if (!args.includes('--no-history')) {
  const base = flag('--base') ?? 'origin/main';
  // A base that cannot be resolved is a gate that cannot say what the push carries: refuse.
  git('rev-parse', '--verify', `${base}^{commit}`);
  const head = flag('--head') ?? 'HEAD';
  git('rev-parse', '--verify', `${head}^{commit}`);
  const commits = git('rev-list', `${base}..${head}`).split('\n').filter(Boolean);
  history = { base, head, commits: commits.length, blobs: 0 };
  for (const commit of commits) {
    const changed = list('diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--diff-filter=AM', '--root', commit);
    for (const file of changed.filter((f) => !skipped(f))) {
      const text = git('show', `${commit}:${file}`);
      history.blobs += 1;
      for (const h of scanText(text, hardRules)) hits.push({ scope: 'history', commit: commit.slice(0, 7), file, ...h });
    }
  }
}

const report = { root, publicSpec: existsSync(publicSpec) ? publicSpec : null, allowedInternalNames: [...allowed], filesScanned: files.length, history, hits };
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
for (const h of hits) console.log(`LEAK ${h.rule} ${h.scope === 'history' ? `${h.commit}:` : ''}${h.file}:${h.line} ${h.match}`);
console.log(`leak-gate: ${files.length} files${history ? `, ${history.commits} commits / ${history.blobs} blobs since ${history.base}` : ''}, ${hits.length} hits`);
process.exit(hits.length ? 1 : 0);
