#!/usr/bin/env node
// Check response readers, not request builders or the samples' own summary objects.
// Paths may start at a response or at a nested response object selected by jq. Only schemas
// reachable from integrator responses count; request-only and unused component schemas do not.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(import.meta.dirname, '..');
const ARRAY = '[]';
const display = (parts) => parts.reduce((out, part) => out + (part === ARRAY ? part : `.${part}`), '');
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

export function responseSchemas(spec) {
  const resolve = (node) => {
    if (!node?.$ref) return node;
    if (!node.$ref.startsWith('#/')) throw new Error(`unsupported reference ${node.$ref}`);
    const target = node.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    if (!target) throw new Error(`unresolved reference ${node.$ref}`);
    return target;
  };
  const roots = [];
  for (const item of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(item)) {
      for (const response of Object.values(operation?.responses ?? {})) {
        for (const media of Object.values(resolve(response)?.content ?? {})) if (media.schema) roots.push(media.schema);
      }
    }
  }
  if (!roots.length) throw new Error('no response schemas');
  const reachable = new Set();
  function visit(raw) {
    const node = resolve(raw);
    if (!node || typeof node !== 'object' || reachable.has(node)) return;
    reachable.add(node);
    for (const child of Object.values(node.properties ?? {})) visit(child);
    if (node.items) visit(node.items);
    for (const kind of ['allOf', 'oneOf', 'anyOf']) for (const child of node[kind] ?? []) visit(child);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') visit(node.additionalProperties);
  }
  roots.forEach(visit);
  function matches(raw, parts, seen = new Set(), consumed = false) {
    if (!parts.length) return true;
    const node = resolve(raw);
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    const nextSeen = new Set(seen).add(node);
    for (const kind of ['allOf', 'oneOf', 'anyOf']) {
      if ((node[kind] ?? []).some((child) => matches(child, parts, nextSeen, consumed))) return true;
    }
    const [head, ...tail] = parts;
    if (head === ARRAY) return !!node.items && matches(node.items, tail, new Set(), consumed);
    if (Object.hasOwn(node.properties ?? {}, head)) return matches(node.properties[head], tail, new Set(), true);
    // An explicit map permits arbitrary keys and, for an unconstrained value, arbitrary descendants.
    // A schema's omitted additionalProperties is not documentation for unlisted fields.
    const map = node.additionalProperties;
    if (!consumed) return false;
    if (map === true) return true;
    if (map && typeof map === 'object') {
      if (!map.$ref && !map.properties && !map.items && !map.allOf && !map.oneOf && !map.anyOf && !map.type) return true;
      return matches(map, tail, new Set(), true);
    }
    return false;
  }
  // Do not make a map's arbitrary keys global roots: `.dispatch.missing` must not be
  // accepted merely because ApiError.details permits code-specific detail keys.
  const candidates = [...reachable].filter((node) => node.properties || node.allOf || node.oneOf || node.anyOf || node.items);
  return (parts) => candidates.some((node) => matches(node, parts));
}

// A small jq reader for the sample dialect: pipes change the current input, select preserves
// it, object construction ends API provenance, and `as` binds the input for later $var reads.
// Offsets are kept so diagnostics point at the actual read, including inside select/interpolation.
function jqTokens(source) {
  const tokens = [];
  const pattern = /"(?:\\.|[^"\\])*"|\$[A-Za-z_][\w]*|\.[A-Za-z_][\w]*(?:\??)|[A-Za-z_][\w]*|\d+|\/\/|==|!=|<=|>=|\+=|[\s\S]/g;
  for (const match of source.matchAll(pattern)) if (!/^\s+$/.test(match[0])) tokens.push({ value: match[0], offset: match.index });
  return tokens;
}

export function jqReads(source) {
  const reads = [];
  const tokens = jqTokens(source);
  const add = (contexts, parts, token) => {
    const paths = contexts.map((base) => [...base, ...parts]);
    for (const parts of paths) if (parts.some((p) => p !== ARRAY)) reads.push({ parts, offset: token.offset });
    return paths;
  };
  function split(list, separator) {
    const chunks = []; let start = 0; let depth = 0; let conditional = 0;
    list.forEach(({ value }, i) => {
      if (['(', '[', '{'].includes(value)) depth++;
      if ([')', ']', '}'].includes(value)) depth--;
      if (value === 'if') conditional++;
      if (value === 'end') conditional--;
      if (!depth && !conditional && value === separator) { chunks.push(list.slice(start, i)); start = i + 1; }
    });
    chunks.push(list.slice(start)); return chunks;
  }
  function evaluate(list, input, variables) {
    const pipes = split(list, '|');
    if (pipes.length > 1) return pipes.reduce((context, stage) => evaluate(stage, context, variables), input);
    const alternatives = split(list, ',');
    if (alternatives.length > 1) return alternatives.flatMap((part) => evaluate(part, input, variables));
    let output = input;
    for (let i = 0; i < list.length; i++) {
      const token = list[i]; const value = token.value;
      if (value === 'as' && list[i + 1]?.value.startsWith('$')) { variables.set(list[++i].value, output); continue; }
      if (['(', '[', '{'].includes(value)) {
        const close = { '(': ')', '[': ']', '{': '}' }[value]; let depth = 1; let end = i + 1;
        for (; end < list.length; end++) { if (list[end].value === value) depth++; if (list[end].value === close && --depth === 0) break; }
        const inner = list.slice(i + 1, end);
        if (value === '{') {
          for (const entry of split(inner, ',')) {
            const colon = entry.findIndex((t) => t.value === ':');
            if (colon >= 0) evaluate(entry.slice(colon + 1), input, variables);
            else if (entry.length === 1 && /^[A-Za-z_]\w*$/.test(entry[0].value)) add(input, [entry[0].value], entry[0]);
            else evaluate(entry, input, variables);
          }
          output = [];
        } else {
          const result = evaluate(inner, input, variables);
          const fn = list[i - 1]?.value;
          output = value === '[' ? [] : ['select', 'any', 'all'].includes(fn) ? input : result;
        }
        i = end; continue;
      }
      if (value.startsWith('"')) {
        // jq interpolation is executable, unlike the rest of a string literal.
        for (const match of value.matchAll(/\\\(([^()]*)\)/g)) {
          for (const read of jqReads(match[1])) {
            for (const base of input) reads.push({ parts: [...base, ...read.parts], offset: token.offset + match.index + 2 + read.offset });
          }
        }
        continue;
      }
      if (value.startsWith('.') || value.startsWith('$')) {
        if (value.startsWith('.') && list[i - 1]?.value === ')' && list.some((t) => t.value === 'capture')) continue; // capture(...).s is a local result
        const isVariable = value.startsWith('$');
        let contexts = isVariable ? (variables.get(value) ?? [[]]) : input;
        const parts = [];
        if (!isVariable && value !== '.') parts.push(value.slice(1).replace(/\?$/, ''));
        while (i + 1 < list.length) {
          const next = list[i + 1].value;
          if (/^\.[A-Za-z_]/.test(next)) { parts.push(next.slice(1).replace(/\?$/, '')); i++; }
          else if (next === '[') {
            let end = i + 2; let depth = 1;
            for (; end < list.length; end++) { if (list[end].value === '[') depth++; if (list[end].value === ']' && --depth === 0) break; }
            const index = list.slice(i + 2, end);
            if (!index.length || index.every((t) => /^-?\d+$/.test(t.value))) parts.push(ARRAY);
            else if (index.length === 1 && index[0].value.startsWith('"')) parts.push(JSON.parse(index[0].value));
            else evaluate(index, input, variables); // dynamic map key is not a literal API field
            i = end;
          } else break;
        }
        output = add(contexts, parts, token);
      }
    }
    return output;
  }
  evaluate(tokens, [[]], new Map());
  return reads;
}

export function sampleReads(text) {
  const reads = []; const localVariables = new Set();
  // Samples use single-quoted jq filters. Quoted request JSON has no preceding jq command.
  // Apostrophes in shell comments (for example "account's") are not string delimiters.
  const shell = text.replace(/^[ \t]*#.*$/gm, (comment) => ' '.repeat(comment.length));
  const strings = [...shell.matchAll(/'([^']*)'/g)];
  let previousEnd = 0;
  for (const match of strings) {
    const before = shell.slice(previousEnd, match.index);
    previousEnd = match.index + match[0].length;
    const command = before.slice(before.lastIndexOf('jq'));
    if (!/\bjq\s/.test(command)) continue;
    const filter = match[1];
    const after = text.slice(previousEnd, text.indexOf('\n', previousEnd) < 0 ? text.length : text.indexOf('\n', previousEnd));
    const source = after.match(/<<<\s*"?\$\{?(\w+)/)?.[1];
    const nullInput = /(?:^|\s)-[a-z]*n[a-z]*(?:\s|$)/.test(command);
    const assignment = before.match(/(\w+)=\$\(jq\b[^]*$/)?.[1];
    const localInput = source && localVariables.has(source);
    for (const read of jqReads(filter)) {
      const variableRead = filter.slice(read.offset).startsWith('$');
      if ((nullInput || localInput) && !variableRead) continue;
      reads.push({ ...read, line: lineAt(text, match.index + 1 + read.offset) });
    }
    if (assignment && (nullInput || filter.includes('{'))) localVariables.add(assignment);
  }
  return reads;
}

export function pageReads(text) {
  const reads = []; const blocks = /(^[ \t]*```json([^\n]*)\n)([\s\S]*?)^[ \t]*```/gm;
  for (const block of text.matchAll(blocks)) {
    const before = text.slice(0, block.index);
    const label = block[2];
    // Every JSON block is a response example unless it says otherwise: a page must label a
    // request body `Request` and a script's projection `Output` (its jq reads are checked in
    // the sample). Only the stated script summary is exempt without a label.
    if (/\b(output|request|summary)\b/i.test(label)) continue;
    const paragraph = before.trimEnd().split(/\n\s*\n/).at(-1) ?? '';
    if (/\b(summary|script's last line)\b/i.test(paragraph)) continue;
    const contentOffset = block.index + block[1].length;
    // Read the keys lexically so shortened examples and JSON-lines still receive coverage.
    const stack = [];
    const pattern = /"(?:\\.|[^"\\])*"\s*:|[{}\[\],]|"(?:\\.|[^"\\])*"/g;
    for (const token of block[3].matchAll(pattern)) {
      const raw = token[0];
      if (raw.endsWith(':')) {
        const key = JSON.parse(raw.slice(0, raw.lastIndexOf(':')).trim());
        if (key === '...') continue;
        const frame = stack.at(-1); if (!frame) continue;
        frame.key = key;
        const parts = stack.flatMap((entry) => entry.type === 'array' ? [ARRAY] : entry.key ? [entry.key] : []);
        reads.push({ parts, line: lineAt(text, contentOffset + token.index) });
      } else if (raw === '{' || raw === '[') {
        stack.push({ type: raw === '[' ? 'array' : 'object', key: null });
      } else if (raw === '}' || raw === ']') stack.pop();
      else if (raw === ',' && stack.at(-1)?.type === 'object') stack.at(-1).key = null;
    }
  }
  return reads;
}

function publishedPages(root) {
  const navigation = JSON.parse(readFileSync(path.join(root, 'docs.json'), 'utf8')).navigation;
  const pages = new Set();
  function visit(value) {
    if (typeof value === 'string' && existsSync(path.join(root, `${value}.mdx`))) pages.add(`${value}.mdx`);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(navigation); return [...pages].sort();
}

export function main({ root = siteRoot, env = process.env, log = console.log } = {}) {
  const from = path.join(env.TETRAFI_RFQ_API_DOCS ?? path.join(root, '..', 'tetrafi-rfq', 'docs', 'api'), 'integrator', 'openapi.json');
  if (!existsSync(from)) { log(`FIELD_SPEC_MISSING ${from}`); return 1; }
  try {
    const documented = responseSchemas(JSON.parse(readFileSync(from, 'utf8')));
    const files = publishedPages(root).map((file) => [file, pageReads]);
    for (const file of readdirSync(path.join(root, 'samples', 'http')).filter((f) => f.endsWith('.sh')).sort()) files.push([`samples/http/${file}`, sampleReads]);
    let count = 0; let misses = 0;
    for (const [file, collect] of files) {
      const unique = new Set();
      for (const { parts, line } of collect(readFileSync(path.join(root, file), 'utf8'))) {
        const field = display(parts); const key = `${line} ${field}`;
        if (unique.has(key)) continue;
        unique.add(key); count++;
        if (!documented(parts)) { log(`FIELD_UNDOCUMENTED ${file}:${line} ${field}`); misses++; }
      }
    }
    log(`field-coverage: ${files.length} files, ${count} reads, ${misses} undocumented`);
    return misses ? 1 : 0;
  } catch (error) {
    log(`FIELD_COVERAGE_UNREADABLE ${error.message}`); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
