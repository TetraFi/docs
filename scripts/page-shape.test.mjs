import assert from 'node:assert/strict';
import test from 'node:test';
import { facts, visibleWords, wideLines } from './page-shape.mjs';

test('accordion bodies, code blocks and frontmatter are not visible words; tables and titles are', () => {
  const page = ['---', 'title: "T"', '---', 'import X from "/x.mdx"', 'One two three.', '| A | B |', '| --- | --- |', '| four | five |',
    '```bash', 'hidden code words', '```', '<Accordion title="Six seven">', 'hidden body words here', '</Accordion>'].join('\n');
  assert.equal(visibleWords(page), 9);
});

test('facts are backticked tokens, error codes and numbers with units', () => {
  const found = facts('Send `minReceive` or get QUOTE_EXPIRED within 300 seconds, at 50 bps.');
  assert.deepEqual([...found].sort(), ['300 seconds', '50 bps', 'QUOTE_EXPIRED', 'minReceive']);
});

test('only code lines over 80 columns count as wide, never prose', () => {
  const long = 'x'.repeat(81);
  assert.equal(wideLines([long, '```bash', 'short', long, '```', long].join('\n')), 1);
});
