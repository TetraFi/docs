// node --test scripts/leak-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rulesFor, scanText } from './leak-rules.mjs';

const terms = path.join(mkdtempSync(path.join(tmpdir(), 'leak-terms-')), 'terms.json');
writeFileSync(terms, JSON.stringify({ terms: ['example-internal-host'] }));
process.env.TETRAFI_LEAK_TERMS = terms;
const rules = rulesFor(import.meta.dirname, new Set());
const caught = (text) => scanText(text, rules).map((h) => h.rule);

test('credential and id shapes are caught', () => {
  for (const sample of [
    `tfk_live_${'a1B2'.repeat(6)}`, `tfk_test_${'Zz9_'.repeat(5)}`,
    `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.sig`, `ghp_${'x'.repeat(30)}`, 'op://vault/item/field',
    `0x${'ab'.repeat(32)}`, 'see BACKEND-1', 'see ko-1', 'host 100.101.2.3', ['example', 'tail0000', 'ts', 'net'].join('.'),
    ['ADR', '0001'].join(' '), ['U', 'RE'].join('') + ' X1', 'example-internal-host',
  ]) assert.ok(caught(sample).length, `not caught: ${sample}`);
});

test('ordinary docs text passes', () => {
  for (const sample of ['an OTC desk quotes', 'chain eip155:8453', 'amount "10.0134"', 'address 0x2e7E7cc62919eAf4c502dAC34753cFc5A29e9693'])
    assert.deepEqual(caught(sample), [], sample);
});

test('a leak committed and then removed from the tree still fails the gate', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'leak-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(path.join(repo, 'page.mdx'), 'clean\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(repo, 'page.mdx'), `see ${['KO', '1234'].join('-')}\n`); git('commit', '-qam', 'leak');
  writeFileSync(path.join(repo, 'page.mdx'), 'clean again\n'); git('commit', '-qam', 'fix');
  const run = spawnSync('node', [path.join(import.meta.dirname, 'leak-gate.mjs'), '--root', repo, '--base', base], { encoding: 'utf8', env: process.env });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stdout, /LEAK ticket-id [0-9a-f]{7}:page\.mdx:1 K[O]-1234/);
});

test('an unresolvable base refuses instead of passing', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'leak-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const run = spawnSync('node', [path.join(import.meta.dirname, 'leak-gate.mjs'), '--root', repo, '--base', 'origin/main'], { encoding: 'utf8', env: process.env });
  assert.notEqual(run.status, 0);
});
