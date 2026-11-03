#!/usr/bin/env node
// Every response field a published page or sample reads must be documented by the public spec, on
// the response of the operation that produced it. Checked readers:
//   - samples/http/*.sh            jq filters over a variable an API call (or a helper wrapping one) filled
//   - published pages              JSON blocks, unless their own label says Output, Request or Summary
//   - TypeScript SDK snippet tabs  property reads on results of `client.<method>(…)`, inside the
//                                  regions samples/sdk-regions.json publishes
// A read is rooted at its operation's response schemas (every status) when the operation is known:
// the request path of the call that fed the jq, the SDK method's request, or the operation the page
// names around a block. A page block is a fragment, so it may start at any object inside that
// operation's response, but every key of the block must fit that one object. Only when the operation
// cannot be determined does a read fall back to any response schema; those reads are counted.
//
//   node scripts/field-coverage.mjs               exit 1 on FIELD_UNDOCUMENTED, FIELD_NO_READS or an unreadable input
//   node scripts/field-coverage.mjs --fallbacks   also list each FIELD_ROOT_FALLBACK read
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(import.meta.dirname, '..');
const ARRAY = '[]';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const display = (parts) => parts.reduce((out, part) => out + (part === ARRAY ? part : `.${part}`), '');
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `METHOD /path` → the spec's operation key, or null. Placeholders on either side match one path
// segment; a literal segment beats a parameter (`/orders/preflight` is not `/orders/{id}`).
export function operationIndex(spec) {
  const operations = [];
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const pattern = new RegExp(`^${route.split(/\{[^}]+\}/).map(escapeRe).join('[^/]+')}$`);
      operations.push({ key: `${method.toUpperCase()} ${route}`, method: method.toUpperCase(), pattern, params: (route.match(/\{/g) ?? []).length });
    }
  }
  return (method, rawPath) => {
    const route = normalizePath(rawPath);
    if (!route) return null;
    const hits = operations.filter((op) => op.method === String(method).toUpperCase() && op.pattern.test(route)).sort((a, b) => a.params - b.params);
    return hits[0]?.key ?? null;
  };
}

// A path as written in a sample, page or SDK: shell expansions and {params} become one opaque
// segment; a path that is only an expansion ("$path") names no operation.
function normalizePath(raw) {
  let text = String(raw).trim().replace(/^["']|["']$/g, '');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$(', i)) {
      let depth = 0; let j = i;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; if (text[j] === ')' && --depth === 0) break; }
      out += '\u0001'; i = j;
    } else if (text.startsWith('${', i)) { i = text.indexOf('}', i); out += '\u0001'; if (i < 0) break; }
    else if (text[i] === '$' && /[\w]/.test(text[i + 1] ?? '')) { while (/[\w]/.test(text[i + 1] ?? '')) i++; out += '\u0001'; }
    else if (text[i] === '{') { i = text.indexOf('}', i); out += '\u0001'; if (i < 0) break; }
    else out += text[i];
  }
  out = out.replace(/\?.*$/, '').replace(/[.,:;]+$/, '');
  if (!out.startsWith('/')) return null;
  return out.replace(/\u0001+/g, 'x');
}

export function responseSchemas(spec) {
  const resolve = (node) => {
    if (!node?.$ref) return node;
    if (!node.$ref.startsWith('#/')) throw new Error(`unsupported reference ${node.$ref}`);
    const target = node.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    if (!target) throw new Error(`unresolved reference ${node.$ref}`);
    return target;
  };
  const byOperation = new Map();
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const roots = [];
      for (const response of Object.values(operation?.responses ?? {})) {
        for (const media of Object.values(resolve(response)?.content ?? {})) if (media.schema) roots.push(media.schema);
      }
      if (roots.length) byOperation.set(`${method.toUpperCase()} ${route}`, roots);
    }
  }
  if (!byOperation.size) throw new Error('no response schemas');
  function reachableFrom(roots) {
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
    // Do not make a map's arbitrary keys anchors: `.dispatch.missing` must not be accepted
    // merely because ApiError.details permits code-specific detail keys.
    return [...reachable].filter((node) => node.properties || node.allOf || node.oneOf || node.anyOf || node.items);
  }
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
  const anywhere = reachableFrom([...byOperation.values()].flat());
  const inside = new Map([...byOperation].map(([key, roots]) => [key, reachableFrom(roots)]));
  const rootsOf = (operation) => {
    const roots = byOperation.get(operation);
    if (!roots) throw new Error(`unknown operation ${operation}`);
    return roots;
  };
  // documented(parts)             any object of any response (the counted fallback)
  // documented(parts, operation)  that operation's response, from its top level
  const documented = (parts, operation = null) => (operation ? rootsOf(operation) : anywhere).some((node) => matches(node, parts));
  // The reads of one fragment that no single object can hold: [] when one object, inside the
  // operation's response (or any response when operation is null), documents every read.
  documented.fragment = (partsList, operation = null) => {
    if (operation) rootsOf(operation);
    let best = null;
    for (const node of operation ? inside.get(operation) : anywhere) {
      const misses = partsList.filter((parts) => !matches(node, parts));
      if (!misses.length) return [];
      if (!best || misses.length < best.length) best = misses;
    }
    return best ?? partsList;
  };
  // A read from an operation whose position in the response is unknown (a jq result of several paths).
  documented.inside = (parts, operation) => { rootsOf(operation); return inside.get(operation).some((node) => matches(node, parts)); };
  return documented;
}

// A small jq reader for the sample dialect: pipes change the current input, select preserves
// it, object construction ends API provenance, and `as` binds the input for later $var reads.
// Offsets are kept so diagnostics point at the actual read, including inside select/interpolation.
// A context path may start with a root marker (an object) naming where its value came from.
function jqTokens(source) {
  const tokens = [];
  const pattern = /"(?:\\.|[^"\\])*"|\$[A-Za-z_][\w]*|\.[A-Za-z_][\w]*(?:\??)|[A-Za-z_][\w]*|\d+|\/\/|==|!=|<=|>=|\+=|[\s\S]/g;
  for (const match of source.matchAll(pattern)) if (!/^\s+$/.test(match[0])) tokens.push({ value: match[0], offset: match.index });
  return tokens;
}

// Filters whose argument runs on each element of the input array.
const ELEMENT_FILTERS = new Set(['map', 'group_by', 'sort_by', 'unique_by', 'min_by', 'max_by', 'any', 'all']);
const isField = (part) => typeof part === 'string' && part !== ARRAY;

export function jqEvaluate(source, { input = [[]], variables = new Map(), unbound = [[]] } = {}) {
  const reads = [];
  const tokens = jqTokens(source);
  const add = (contexts, parts, token) => {
    const paths = contexts.map((base) => [...base, ...parts]);
    for (const parts of paths) if (parts.some(isField)) reads.push({ parts, offset: token.offset });
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
        } else if (value === '(' && split(inner, ';').length > 1) {
          // any(gen; cond) / all(gen; cond) test cond on what gen produces; other arguments see the input.
          const [first, ...rest] = split(inner, ';');
          const fn = list[i - 1]?.value;
          const generated = evaluate(first, input, variables);
          for (const argument of rest) evaluate(argument, ['any', 'all'].includes(fn) ? generated : input, variables);
          output = ['any', 'all'].includes(fn) ? input : [];
        } else if (value === '(' && ELEMENT_FILTERS.has(list[i - 1]?.value)) {
          // f in map(f), group_by(f), any(f)… applies to each element of the input array.
          const fn = list[i - 1].value;
          const elements = input.map((base) => [...base, ARRAY]);
          evaluate(inner, elements, variables);
          output = ['min_by', 'max_by'].includes(fn) ? elements : ['map', 'group_by'].includes(fn) ? [] : input;
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
        const contexts = isVariable ? (variables.get(value) ?? unbound) : input;
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
  const output = evaluate(tokens, input, new Map(variables));
  return { reads, output };
}

export const jqReads = (source) => jqEvaluate(source).reads;

// ---- Shell samples -------------------------------------------------------------------------

// Where a shell value came from: an operation's response at a prefix, an operation's response at an
// unknown position, a value the script built itself, or nothing known.
const binding = {
  api: (operation, prefix = []) => ({ kind: 'api', operation, prefix }),
  inside: (operation) => ({ kind: 'inside', operation }),
  local: () => ({ kind: 'local' }),
  unknown: () => ({ kind: 'unknown' }),
};
const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One shell word starting at i (a quoted string may hold $( … ) with its own quotes).
function shellWord(text, i) {
  let j = i; let quote = null; let depth = 0;
  for (; j < text.length; j++) {
    const c = text[j];
    if (text.startsWith('$(', j)) { depth++; j++; continue; }
    if (depth && c === ')') { depth--; continue; }
    if (depth) { if (c === "'") j = text.indexOf("'", j + 1); continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/[\s;)|&<>]/.test(c)) break;
  }
  return text.slice(i, j);
}

function shellFunctions(shell) {
  const functions = new Map();
  for (const match of shell.matchAll(/^[ \t]*(\w+)\(\)\s*\{/gm)) {
    let depth = 0; let end = match.index + match[0].length - 1;
    for (; end < shell.length; end++) {
      const c = shell[end];
      if (c === "'") { end = shell.indexOf("'", end + 1); if (end < 0) break; continue; }
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) break;
    }
    functions.set(match[1], { start: match.index, end, body: [match.index + match[0].length, end] });
  }
  return functions;
}

// The operations a stretch of shell calls: `tetrafi METHOD PATH`, or curl with -X and
// $TETRAFI_BASE_URL. Unresolvable paths are null.
function callsIn(shell, from, to, operationOf, functionOps = new Map()) {
  const calls = [];
  const text = shell.slice(from, to).replace(/\\\n/g, '  ');
  for (const match of text.matchAll(/(?<![\w-])tetrafi\s+([A-Z]+)\s+/g)) {
    const word = shellWord(text, match.index + match[0].length);
    calls.push({ offset: from + match.index, operation: operationOf(match[1], word) });
  }
  for (const match of text.matchAll(/(?<![\w-])curl\b[^\n]*/g)) {
    const method = match[0].match(/-X\s+"?([A-Z]+)"?/)?.[1];
    const url = match[0].match(/"\$\{?TETRAFI_BASE_URL\}?([^"]*)"/)?.[1];
    if (method && url !== undefined) calls.push({ offset: from + match.index, operation: operationOf(method, url) });
  }
  for (const [name, op] of functionOps) {
    for (const match of text.matchAll(new RegExp(`(?:^|[\\s;(&|]|\\$\\()${name}(?=\\s|\\)|$)`, 'gm'))) {
      if (/\(\)\s*\{/.test(text.slice(match.index + match[0].length, match.index + match[0].length + 6))) continue;
      calls.push({ offset: from + match.index, operation: op });
    }
  }
  return calls.sort((a, b) => a.offset - b.offset);
}

const single = (calls) => {
  const ops = [...new Set(calls.map((call) => call.operation))];
  return ops.length === 1 ? ops[0] : null;
};

// Reads, per region, of one sample. operationOf maps `METHOD path` to a spec operation.
export function analyseSample(text, operationOf = () => null) {
  const reads = [];
  // Samples use single-quoted jq filters. Quoted request JSON has no preceding jq command.
  // Apostrophes in shell comments (for example "account's") are not string delimiters.
  const shell = text.replace(/^[ \t]*#.*$/gm, (comment) => ' '.repeat(comment.length));

  // A helper that sends exactly one operation stands for it; the transport itself does not.
  const functions = shellFunctions(shell);
  const functionOps = new Map();
  for (const [name, fn] of functions) {
    if (name === 'tetrafi') continue;
    const calls = callsIn(shell, fn.body[0], fn.body[1], operationOf);
    if (calls.length) functionOps.set(name, single(calls));
  }
  const inFunction = (offset) => [...functions].find(([, fn]) => offset > fn.body[0] && offset < fn.body[1])?.[0] ?? null;

  // Assignments in source order: var → binding, from an API call, a helper, a file an API call
  // wrote, or a jq result (added while the filters are read, below).
  const events = new Map();
  const record = (name, offset, value) => { if (!events.has(name)) events.set(name, []); events.get(name).push({ offset, value }); };
  const files = [];
  for (const match of shell.matchAll(/(?<![\w$])(\w+)=\$\(\s*(?:\w+=(?:'[^']*'|"[^"]*"|[^\s)]*)\s+)*(<|[\w-]+)/g)) {
    const [, name, callee] = match; const after = match.index + match[0].length;
    if (callee === 'jq') continue;
    if (callee === 'tetrafi') {
      const rest = shell.slice(after).match(/^\s+([A-Z]+)\s+/);
      const operation = rest ? operationOf(rest[1], shellWord(shell, after + rest[0].length)) : null;
      record(name, match.index, operation ? binding.api(operation) : binding.unknown());
    } else if (callee === '<') {
      const file = shellWord(shell, after).trim();
      record(name, match.index, { kind: 'file', file });
    } else if (functionOps.has(callee)) {
      const operation = functionOps.get(callee);
      record(name, match.index, operation ? binding.api(operation) : binding.unknown());
    } else record(name, match.index, binding.unknown());
  }
  for (const match of shell.matchAll(/(?<![\w-])tetrafi\s+([A-Z]+)\s+/g)) {
    const word = shellWord(shell, match.index + match[0].length);
    const line = shell.slice(match.index, shell.indexOf('\n', match.index) < 0 ? shell.length : shell.indexOf('\n', match.index));
    const target = line.match(/(?<![<>])>\s*("[^"]+"|\S+)/)?.[1];
    if (target) files.push({ offset: match.index, file: target.replace(/^"|"$/g, ''), operation: operationOf(match[1], word) });
  }

  const positionals = new Map();
  function lookup(name, offset, depth = 0) {
    if (/^\d+$/.test(name)) return positional(name, offset, depth);
    const list = (events.get(name) ?? []).filter((event) => event.offset < offset);
    let value = list.at(-1)?.value;
    // A function body reads globals assigned after its definition: use them when they agree.
    if (!value && inFunction(offset)) {
      const all = (events.get(name) ?? []).map((event) => event.value);
      if (all.length && all.every((v) => sameBinding(v, all[0]))) value = all[0];
    }
    if (!value) return binding.unknown();
    if (value.kind === 'file') {
      const written = files.filter((entry) => entry.file === value.file);
      const ops = [...new Set(written.map((entry) => entry.operation))];
      return ops.length === 1 && ops[0] ? binding.api(ops[0]) : binding.unknown();
    }
    return value;
  }
  // $N inside a function: every call site must pass a variable with the same binding.
  function positional(index, offset, depth) {
    const name = inFunction(offset);
    if (!name || depth > 3) return binding.unknown();
    const key = `${name} ${index}`;
    if (positionals.has(key)) return positionals.get(key);
    positionals.set(key, binding.unknown());
    const fn = functions.get(name); const found = [];
    for (const match of shell.matchAll(new RegExp(`(?:^|[\\s;(&|]|\\$\\()${name}[ \\t]+([^\\n;|&)]*)`, 'gm'))) {
      if (match.index >= fn.start && match.index <= fn.end) continue;
      const words = match[1].match(/"(?:[^"\\]|\\.|\$\([^)]*\))*"|'[^']*'|\S+/g) ?? [];
      const word = words[Number(index) - 1];
      const variable = word?.match(/^"?\$\{?(\w+)\}?"?$/)?.[1];
      found.push(variable ? lookup(variable, match.index, depth + 1) : binding.unknown());
    }
    const value = found.length && found.every((v) => sameBinding(v, found[0])) ? found[0] : binding.unknown();
    positionals.set(key, value);
    return value;
  }

  // Root markers carry a binding through jq into each read.
  const markers = [];
  const contextOf = (value) => {
    markers.push(value);
    const marker = { root: markers.length - 1 };
    return value.kind === 'api' ? [marker, ...value.prefix] : [marker];
  };
  const strings = [...shell.matchAll(/'([^']*)'/g)];
  let previousEnd = 0;
  for (const match of strings) {
    const before = shell.slice(previousEnd, match.index);
    previousEnd = match.index + match[0].length;
    const command = before.slice(before.lastIndexOf('jq'));
    if (!/\bjq\s/.test(command)) continue;
    const filter = match[1];
    const lineEnd = text.indexOf('\n', previousEnd) < 0 ? text.length : text.indexOf('\n', previousEnd);
    const after = shell.slice(previousEnd, lineEnd);
    const source = after.match(/<<<\s*"?\$\{?(\w+)/)?.[1];
    const nullInput = /(?:^|\s)-[a-z]*n[a-z]*(?:\s|$)/.test(command);
    const assignment = before.match(/(\w+)=\$\(jq\b[^]*$/)?.[1];
    const input = nullInput ? binding.local() : source ? lookup(source, match.index) : binding.unknown();
    const variables = new Map();
    for (const arg of `${command} ${after}`.matchAll(/--argjson\s+(\w+)\s+("[^"]*"|\S+)/g)) {
      const variable = arg[2].match(/^"?\$\{?(\w+)\}?"?$/)?.[1];
      variables.set(`$${arg[1]}`, [contextOf(variable ? lookup(variable, match.index) : binding.local())]);
    }
    for (const arg of `${command} ${after}`.matchAll(/--arg\s+(\w+)\s/g)) variables.set(`$${arg[1]}`, [contextOf(binding.local())]);
    const { reads: found, output } = jqEvaluate(filter, { input: [contextOf(input)], variables, unbound: [contextOf(binding.unknown())] });
    for (const read of found) {
      const [marker, ...parts] = read.parts;
      const from = markers[marker.root];
      if (from.kind === 'local' || !parts.some(isField)) continue;
      const line = lineAt(text, match.index + 1 + read.offset);
      if (from.kind === 'api') reads.push({ parts, line, operation: from.operation, root: 'operation' });
      else if (from.kind === 'inside') reads.push({ parts, line, operation: from.operation, root: 'inside' });
      else reads.push({ parts, line, operation: null, root: 'fallback' });
    }
    if (assignment) {
      // The variable holds what the filter output: one response path keeps its operation and prefix.
      let value = binding.local();
      const roots = output.map(([marker, ...parts]) => ({ from: markers[marker.root], parts }));
      if (roots.length) {
        const first = roots[0];
        const sameRoot = roots.every((r) => r.from === first.from);
        const samePath = roots.every((r) => JSON.stringify(r.parts) === JSON.stringify(first.parts));
        if (first.from.kind === 'api' && sameRoot) value = samePath ? binding.api(first.from.operation, first.parts) : binding.inside(first.from.operation);
        else if (first.from.kind === 'inside' && sameRoot) value = binding.inside(first.from.operation);
        else if (first.from.kind !== 'local') value = binding.unknown();
      }
      record(assignment, match.index, value);
    }
  }

  // The operation each region calls, for pages that show that region's response.
  const regions = new Map();
  for (const match of text.matchAll(/^[ \t]*# region (\S+)[ \t]*$/gm)) {
    const end = text.indexOf('# endregion', match.index);
    const calls = callsIn(shell, match.index, end < 0 ? text.length : end, operationOf, functionOps);
    regions.set(match[1], single(calls));
  }
  return { reads, regions };
}

export const sampleReads = (text, operationOf) => analyseSample(text, operationOf).reads;

// ---- Published pages -----------------------------------------------------------------------

const OPERATION_MENTION = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[^\s`)"'<>\]]*)/g;
// A link's text names another page's operation, never the block's own: it does not count.
function mentionedOperation(text, operationOf) {
  const ops = new Set();
  for (const match of text.replace(/\[[^\]\n]*\]\([^)\n]*\)/g, ' ').matchAll(OPERATION_MENTION)) { const op = operationOf(match[1], match[2]); if (op) ops.add(op); }
  return ops.size === 1 ? [...ops][0] : null;
}

// Every JSON block is a response example unless its own label says Output (a script's projection,
// whose jq reads the sample check covers), Request or Summary. The operation is the one the block's
// label or lead-in paragraph names, else the one the snippet just above it calls, else the one its
// section names; otherwise it is unknown.
export function pageReads(text, { operationOf = () => null, regionOps = new Map() } = {}) {
  const reads = []; const blocks = /(^[ \t]*```json\b([^\n]*)\n)([\s\S]*?)^[ \t]*```/gim;
  const snippets = new Map([...text.matchAll(/^import\s+(\w+)\s+from\s+['"]\/snippets\/samples\/([\w-]+)\.mdx['"]/gm)].map((m) => [m[1], m[2]]));
  let previousBlockEnd = 0; let blockIndex = 0;
  for (const block of text.matchAll(blocks)) {
    const before = text.slice(0, block.index);
    const label = block[2];
    const headingAt = [...before.matchAll(/^[ \t]*#{1,6} .*$/gm)].at(-1)?.index ?? 0;
    const since = Math.max(previousBlockEnd, headingAt);
    previousBlockEnd = block.index + block[0].length;
    if (/\b(output|request|summary)\b/i.test(label)) continue;
    const paragraph = before.trimEnd().split(/\n\s*\n/).at(-1) ?? '';
    const lastSnippet = [...text.slice(since, block.index).matchAll(/<(\w+)\s*\/>/g)].map((m) => snippets.get(m[1])).filter(Boolean).at(-1);
    const operation = mentionedOperation(`${label}\n${paragraph}`, operationOf)
      ?? (lastSnippet ? regionOps.get(lastSnippet) ?? null : null)
      ?? mentionedOperation(text.slice(headingAt, block.index), operationOf);
    const contentOffset = block.index + block[1].length;
    // Read the keys lexically so shortened examples and JSON-lines still receive coverage; each
    // top-level value of the block is one fragment.
    const stack = []; let value = 0;
    const pattern = /"(?:\\.|[^"\\])*"\s*:|[{}\[\],]|"(?:\\.|[^"\\])*"/g;
    for (const token of block[3].matchAll(pattern)) {
      const raw = token[0];
      if (raw.endsWith(':')) {
        const key = JSON.parse(raw.slice(0, raw.lastIndexOf(':')).trim());
        if (key === '...') continue;
        const frame = stack.at(-1); if (!frame) continue;
        frame.key = key;
        const parts = stack.flatMap((entry) => entry.type === 'array' ? [ARRAY] : entry.key ? [entry.key] : []);
        reads.push({ parts, line: lineAt(text, contentOffset + token.index), operation, fragment: `${blockIndex}:${value}`, root: operation ? 'inside' : 'fallback' });
      } else if (raw === '{' || raw === '[') {
        stack.push({ type: raw === '[' ? 'array' : 'object', key: null });
      } else if (raw === '}' || raw === ']') { stack.pop(); if (!stack.length) value++; }
      else if (raw === ',' && stack.at(-1)?.type === 'object') stack.at(-1).key = null;
    }
    blockIndex++;
  }
  return reads;
}

// ---- TypeScript SDK -------------------------------------------------------------------------

// The SDK method → the operation its first request names; a method that only delegates
// (`requote` → `quote`) takes the operation of the one method it calls. Anything else is unknown.
export function sdkMethodOperations(source, operationOf) {
  const reserved = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'throw', 'new', 'typeof', 'else']);
  const definitions = [];
  for (const match of source.matchAll(/^[ \t]*(?:(?:export\s+)?const\s+(\w+)\s*=\s*async\b|(?:async\s+\*?\s*)?([a-z]\w*)\s*\(.*\)\s*(?::\s*[^{\n]+)?\{)/gm)) {
    const name = match[1] ?? match[2];
    if (!reserved.has(name)) definitions.push({ name, start: match.index });
  }
  const spans = new Map();
  definitions.forEach((definition, i) => spans.set(definition.name, source.slice(definition.start, definitions[i + 1]?.start ?? source.length)));
  const operations = new Map();
  for (const [name, span] of spans) {
    const request = span.match(/\braw\.(GET|POST|PUT|PATCH|DELETE)\(\s*['"`]([^'"`]+)['"`]/);
    if (request) operations.set(name, operationOf(request[1], request[2]));
  }
  for (const [name, span] of spans) {
    if (operations.has(name)) continue;
    const called = [...new Set([...span.slice(name.length).matchAll(/\b(\w+)\(/g)].map((m) => m[1]).filter((callee) => callee !== name && spans.has(callee)))];
    if (called.length === 1 && operations.has(called[0])) operations.set(name, operations.get(called[0]));
  }
  return operations;
}

// Code with comments and string text blanked (template ${…} kept), offsets preserved.
function tsCode(source) {
  const out = source.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  // Each stack entry is a template literal or a `${` expression (with its own brace depth).
  const stack = [{ kind: 'code', depth: 0 }];
  for (let i = 0; i < source.length; i++) {
    const top = stack.at(-1); const c = source[i];
    if (top.kind === 'template') {
      const start = i;
      while (i < source.length && source[i] !== '`' && !source.startsWith('${', i)) { if (source[i] === '\\') i++; i++; }
      blank(start, i);
      if (source[i] === '`') stack.pop();
      else { stack.push({ kind: 'code', depth: 0 }); i++; }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); blank(i, end < 0 ? source.length : end); i = end < 0 ? source.length : end; continue; }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); blank(i, end < 0 ? source.length : end + 2); i = end < 0 ? source.length : end + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < source.length && source[j] !== c && source[j] !== '\n') { if (source[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j; continue;
    }
    if (c === '`') { stack.push({ kind: 'template' }); continue; }
    if (c === '{') top.depth++;
    if (c === '}') { if (top.depth === 0 && stack.length > 1) { out[i] = ' '; stack.pop(); } else top.depth--; }
  }
  return out.join('');
}

const ELEMENT_CALLBACKS = new Set(['find', 'findLast', 'filter', 'some', 'every', 'map', 'flatMap', 'forEach', 'findIndex']);
const KEEPS_ARRAY = new Set(['filter', 'slice', 'sort', 'toSorted', 'reverse']);
const ELEMENT_RESULT = new Set(['find', 'findLast', 'at']);

// Property reads on values the SDK returned: `const x = await client.method(…)`, destructuring of
// such a result, and the parameters of array callbacks over them (`set.quotes.find((q) => q.id)`).
export function tsReads(source, methodOps = new Map()) {
  const code = tsCode(source);
  const tokens = [...code.matchAll(/[A-Za-z_$][\w$]*|\?\.|=>|\.\.\.|\d[\d_]*|\S/g)].map((m) => ({ value: m[0], offset: m.index }));
  const reads = [];
  const bindings = new Map();
  const at = (i) => tokens[i]?.value;
  const closing = (i) => {
    const open = at(i); const close = { '(': ')', '[': ']', '{': '}' }[open]; let d = 0;
    for (let j = i; j < tokens.length; j++) { if (at(j) === open) d++; if (at(j) === close && --d === 0) return j; }
    return tokens.length - 1;
  };
  const record = (value, parts, token) => {
    if (!value.accessed) return;
    reads.push({ parts, offset: token.offset, line: lineAt(source, token.offset), operation: value.operation, root: value.operation ? 'operation' : 'fallback' });
  };
  // `client.method(` at i → its operation binding.
  const clientCall = (i) => at(i) === 'client' && (at(i + 1) === '.' || at(i + 1) === '?.') && /^\w+$/.test(at(i + 2) ?? '') && at(i + 3) === '('
    ? { operation: methodOps.get(at(i + 2)) ?? null, prefix: [] } : null;
  // An arrow function's parameters starting at i: `x =>`, `(x) =>`, `(x: T) =>`.
  function arrowParam(i) {
    if (/^\w+$/.test(at(i) ?? '') && at(i + 1) === '=>') return { name: at(i), body: i + 2 };
    if (at(i) === '(') {
      const end = closing(i);
      let k = end + 1;
      if (at(k) === ':') { while (k < tokens.length && at(k) !== '=>') k++; }
      if (at(k) !== '=>') return null;
      const inner = tokens.slice(i + 1, end).map((t) => t.value);
      return { name: /^\w+$/.test(inner[0] ?? '') && (inner.length === 1 || inner[1] === ':') ? inner[0] : null, names: inner.filter((v, n) => /^\w+$/.test(v) && (n === 0 || inner[n - 1] === ',')), body: k + 1 };
    }
    return null;
  }
  // Follow a property chain from a bound identifier at i; returns { end, path } (path null when
  // the chain leaves the response, for example through `.map(…)` or a method on a value).
  function chain(i, base) {
    let path = [...base.prefix]; const state = { operation: base.operation, accessed: false };
    let j = i + 1;
    for (;;) {
      if (at(j) === '!' && ['.', '?.', '['].includes(at(j + 1))) { j++; continue; }
      if ((at(j) === '.' || at(j) === '?.') && /^[A-Za-z_$][\w$]*$/.test(at(j + 1) ?? '')) {
        const name = at(j + 1);
        if (at(j + 2) === '(') {
          const close = closing(j + 2);
          if (ELEMENT_CALLBACKS.has(name) || name === 'at') {
            const param = arrowParam(j + 3);
            if (param?.name) bindings.set(param.name, { operation: state.operation, prefix: [...path, ARRAY] });
            walk(param ? param.body : j + 3, close);
            if (ELEMENT_RESULT.has(name)) { path = [...path, ARRAY]; j = close + 1; continue; }
            if (KEEPS_ARRAY.has(name)) { j = close + 1; continue; }
            record(state, path, tokens[i]);
            return { end: close + 1, path: null };
          }
          record(state, path, tokens[i]);
          return { end: j, path: null };
        }
        if (name === 'length') { record(state, path, tokens[i]); return { end: j + 2, path: null }; }
        path = [...path, name]; state.accessed = true; j += 2; continue;
      }
      if (at(j) === '[') {
        const close = closing(j);
        if (close === j + 2 && /^\d+$/.test(at(j + 1))) { path = [...path, ARRAY]; j = close + 1; continue; }
      }
      break;
    }
    record(state, path, tokens[i]);
    return { end: j, path };
  }
  function walk(from, to) {
    for (let i = from; i < to; i++) {
      const value = at(i);
      if (['const', 'let', 'var'].includes(value)) {
        if (at(i + 1) === '{') {
          const close = closing(i + 1);
          let k = close + 1;
          if (at(k) === '=' && at(k + 1) === 'await') {
            const call = clientCall(k + 2);
            const names = tokens.slice(i + 2, close);
            for (let n = 0; n < names.length; n++) {
              if (!/^\w+$/.test(names[n].value) || (n > 0 && names[n - 1].value === ':')) continue;
              const local = names[n + 1]?.value === ':' ? names[n + 2]?.value : names[n].value;
              if (call) {
                reads.push({ parts: [names[n].value], offset: names[n].offset, line: lineAt(source, names[n].offset), operation: call.operation, root: call.operation ? 'operation' : 'fallback' });
                bindings.set(local, { operation: call.operation, prefix: [names[n].value] });
              } else bindings.delete(local);
            }
          }
          i = close; continue;
        }
        const name = at(i + 1);
        if (!/^\w+$/.test(name ?? '')) continue;
        let k = i + 2;
        if (at(k) === ':') { let d = 0; for (k++; k < tokens.length; k++) { if (['(', '<', '{', '['].includes(at(k))) d++; if ([')', '>', '}', ']'].includes(at(k))) d--; if (!d && at(k) === '=') break; } }
        if (at(k) !== '=') { bindings.delete(name); continue; }
        const rhs = at(k + 1) === 'await' ? k + 2 : k + 1;
        const call = clientCall(rhs);
        if (call) { bindings.set(name, call); i = rhs + 3; continue; }
        if (bindings.has(at(rhs)) && !['.', '?.'].includes(at(rhs - 1))) {
          const result = chain(rhs, bindings.get(at(rhs)));
          if (result.path && at(result.end) === ';') bindings.set(name, { operation: bindings.get(at(rhs)).operation, prefix: result.path });
          else bindings.delete(name);
          i = result.end - 1; continue;
        }
        bindings.delete(name); i = k; continue;
      }
      // An arrow function's own parameters shadow any binding of the same name.
      if (value === '(' || /^\w+$/.test(value ?? '')) {
        const param = arrowParam(i);
        if (param && !(value === '(' && ELEMENT_CALLBACKS.has(at(i - 1)))) for (const n of param.names ?? [param.name]) if (n) bindings.delete(n);
      }
      if (bindings.has(value) && !['.', '?.'].includes(at(i - 1)) && at(i + 1) !== ':' && at(i + 1) !== '=>') {
        const result = chain(i, bindings.get(value));
        i = result.end - 1;
      }
    }
  }
  walk(0, tokens.length);
  return reads;
}

// ---- Site ------------------------------------------------------------------------------------

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

// SDK reads inside published regions, located in the generated snippet that shows them.
function sdkReads(root, env, operationOf) {
  const mapFile = path.join(root, 'samples', 'sdk-regions.json');
  if (!existsSync(mapFile)) return [];
  const map = JSON.parse(readFileSync(mapFile, 'utf8')).regions ?? {};
  const examples = env.TETRAFI_SDK_EXAMPLES ?? path.join(root, '..', 'tetrafi-ui', 'packages', 'sdk', 'examples');
  const client = path.join(examples, '..', 'src', 'client.ts');
  if (!existsSync(examples)) throw new Error(`SDK examples missing ${examples} (samples/sdk-regions.json publishes them)`);
  if (!existsSync(client)) throw new Error(`SDK client missing ${client}`);
  const methodOps = sdkMethodOperations(readFileSync(client, 'utf8'), operationOf);
  const out = [];
  for (const file of readdirSync(examples).filter((f) => f.endsWith('.ts')).sort()) {
    const source = readFileSync(path.join(examples, file), 'utf8');
    const lines = source.split('\n');
    const regions = [];
    lines.forEach((line, i) => {
      const open = line.match(/^\s*\/\/ #region (\S+)\s*$/);
      if (open && map[open[1]]) regions.push({ snippet: map[open[1]], open: i + 1, close: lines.findIndex((l, k) => k > i && /^\s*\/\/ #endregion/.test(l)) + 1 });
    });
    if (!regions.length) continue;
    const reads = tsReads(source, methodOps);
    for (const region of regions) {
      const snippetFile = `snippets/samples/${region.snippet}.mdx`;
      const snippetPath = path.join(root, snippetFile);
      let fence = null;
      if (existsSync(snippetPath)) {
        const index = readFileSync(snippetPath, 'utf8').split('\n').findIndex((l) => /^```typescript\b/.test(l));
        if (index >= 0) fence = index + 1;
      }
      // sync-samples drops the region's leading blank lines.
      const leading = lines.slice(region.open, region.close - 1).findIndex((l) => l.trim());
      const first = region.open + 1 + Math.max(0, leading);
      const inRegion = reads.filter((read) => read.line > region.open && read.line < region.close);
      out.push({ file: fence ? snippetFile : path.relative(root, path.join(examples, file)),
        reads: inRegion.map((read) => ({ ...read, line: fence ? fence + 1 + (read.line - first) : read.line })) });
    }
  }
  return out;
}

export function main({ root = siteRoot, env = process.env, log = console.log, listFallbacks = false } = {}) {
  const from = path.join(env.TETRAFI_RFQ_API_DOCS ?? path.join(root, '..', 'tetrafi-rfq', 'docs', 'api'), 'integrator', 'openapi.json');
  if (!existsSync(from)) { log(`FIELD_SPEC_MISSING ${from}`); return 1; }
  try {
    const spec = JSON.parse(readFileSync(from, 'utf8'));
    const documented = responseSchemas(spec);
    const operationOf = operationIndex(spec);
    const sources = [];
    const regionOps = new Map();
    for (const file of readdirSync(path.join(root, 'samples', 'http')).filter((f) => f.endsWith('.sh')).sort()) {
      const { reads, regions } = analyseSample(readFileSync(path.join(root, 'samples', 'http', file), 'utf8'), operationOf);
      for (const [name, op] of regions) regionOps.set(name, op);
      sources.push({ file: `samples/http/${file}`, reads });
    }
    for (const file of publishedPages(root)) sources.push({ file, reads: pageReads(readFileSync(path.join(root, file), 'utf8'), { operationOf, regionOps }) });
    sources.push(...sdkReads(root, env, operationOf));

    const counts = { operation: 0, inside: 0, fallback: 0 }; let misses = 0;
    const files = new Set(sources.map((s) => s.file));
    for (const { file, reads } of sources) {
      const unique = new Set(); const fragments = new Map();
      const kept = [];
      for (const read of reads) {
        const key = `${read.line} ${display(read.parts)} ${read.fragment ?? ''}`;
        if (unique.has(key)) continue;
        unique.add(key); kept.push(read); counts[read.root]++;
        if (read.root === 'fallback' && listFallbacks) log(`FIELD_ROOT_FALLBACK ${file}:${read.line} ${display(read.parts)}`);
        if (read.fragment !== undefined) {
          if (!fragments.has(read.fragment)) fragments.set(read.fragment, []);
          fragments.get(read.fragment).push(read);
        }
      }
      const undocumented = new Set();
      for (const group of fragments.values()) {
        const missing = documented.fragment(group.map((r) => r.parts), group[0].operation);
        for (const read of group) if (missing.includes(read.parts)) undocumented.add(read);
      }
      for (const read of kept) {
        if (read.fragment !== undefined) continue;
        const ok = read.root === 'operation' ? documented(read.parts, read.operation)
          : read.root === 'inside' ? documented.inside(read.parts, read.operation) : documented(read.parts);
        if (!ok) undocumented.add(read);
      }
      for (const read of kept) if (undocumented.has(read)) { log(`FIELD_UNDOCUMENTED ${file}:${read.line} ${display(read.parts)}`); misses++; }
    }
    const total = counts.operation + counts.inside + counts.fallback;
    if (!total) { log('FIELD_NO_READS no response field read was found; the readers are broken or the inputs moved'); return 1; }
    log(`field-coverage: ${files.size} files, ${total} reads (${counts.operation} at their operation's response, ${counts.inside} inside their operation's response, ${counts.fallback} on any response (operation unknown)), ${misses} undocumented`);
    return misses ? 1 : 0;
  } catch (error) {
    log(`FIELD_COVERAGE_UNREADABLE ${error.message}`); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main({ listFallbacks: process.argv.includes('--fallbacks') });
