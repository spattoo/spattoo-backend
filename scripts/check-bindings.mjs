#!/usr/bin/env node
//
// ── Every name a function uses is declared where that function can SEE it ───────────────────────
//
// A "binding" is the link between a name and a declaration: `const x = …` binds `x`. Use `x` with
// nothing declaring it in scope and you get a ReferenceError — at RUN time, when the line finally
// executes, because an undeclared name is perfectly legal JavaScript until then. The process boots,
// the tests pass, the deploy goes out green, and it throws the first time somebody calls it.
//
// ── THE CRASH THIS EXISTS FOR ───────────────────────────────────────────────────────────────────
//
// `imageModel is not defined`, services/openai.js, every decoration-guide sheet from 2026-09-03.
//
// 2e7a89d ("The image model is chosen per intent") introduced a local `imageModel` in
// generateDecorationImage and, in the same file, rewrote generateDecorationStages'
// `form.append('model', config.openai.imageModel)` to `form.append('model', imageModel)` — into a
// function that declares no such thing. Nothing ran it for ten days, so the first symptom was a
// baker-facing feature that had been dead since the commit, reported as one bad element.
//
// ── WHY THIS IS PER-FUNCTION AND spattoo-admin'S IS PER-FILE ────────────────────────────────────
//
// ⚠️ The sibling gate in spattoo-admin asks "is this name declared ANYWHERE in this file", and says
// so: "A name declared in the wrong function still passes, which is honest." For a React screen
// that is the right trade — the bug there was a DELETED declaration, and file scope finds it.
//
// It would have been green on the crash above. `imageModel` IS declared in openai.js. It is
// declared in the wrong function, which is the entire bug. So this one resolves scope one level
// finer: module scope, plus the top-level function a use sits inside. That is exactly the
// granularity the failure needs, and no finer — a name from a nested closure is still visible to
// the closure, so nesting produces no false alarms.
//
// ── WHAT IT DOES NOT CATCH ──────────────────────────────────────────────────────────────────────
// Use-before-declare inside one function (TDZ), a shadowed name, a name declared in a sibling block
// of the same function. Those need a real parser and a scope chain. This is a smoke alarm sized to
// the fire that actually happened, and it deliberately OVER-collects declarations: a false alarm
// costs more trust than a missed one costs safety.
//
// `npm run check:bindings`

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIRS = ['src'];

/* ── Blanking comments and strings, with the length preserved ────────────────────────────────────
 *
 * Prose has to stop looking like code before anything is scanned, and this is a hand-rolled scanner
 * rather than one clever regular expression. It was a regex first, and the thing that killed it is
 * in this very repo:
 *
 *     `...${focus ? `The image is a photo of a WHOLE CAKE...` : `Look ONLY at...`}...`
 *
 * A NESTED template literal. No regular expression closes that correctly — the flat one matched from
 * the outer backtick to the first INNER one, and every quote after that point was paired off by one,
 * so several hundred lines of English prose came back through as "code". The gate then reported
 * `pieces(`, `part.` and `listed(` as undeclared names, from a sentence about cutting petals.
 *
 * So: one pass, a small state machine, and a stack for `${…}` depth — which is the only honest way
 * to read a template literal. Length is preserved, so a finding can still name a line number.
 *
 * Regex literals are read with the standard heuristic: a `/` opens one only where a VALUE cannot
 * legally appear (after an operator, a comma, an open bracket, `return`…), and is division
 * otherwise. Getting this wrong in the division direction blanks a stretch of real code, which HIDES
 * uses rather than inventing them — a miss, never a false alarm, which is the safe way to be wrong.
 */
function scannable(src) {
  const out = Array.from(src);
  const wipe = (from, to) => { for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '; };
  // A `/` after one of these is a REGEX; after anything else (an identifier, `)`, `]`, a number) it
  // is division. `return` and friends are words, so they are matched on a word boundary.
  const PRE_REGEX = /[({[,;:!&|?+\-*%^~<>=]$|\b(?:return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/;
  let i = 0;
  const tmpl = [];            // stack: one frame per template literal currently open
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const end = j === -1 ? src.length : j; wipe(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const end = j === -1 ? src.length : j + 2; wipe(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      wipe(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') { tmpl.push({ depth: 0 }); out[i] = ' '; i++;
      // Body of the template, up to `${` or the closing backtick.
      while (i < src.length) {
        if (src[i] === '\\') { wipe(i, i + 2); i += 2; continue; }
        if (src[i] === '`') { out[i] = ' '; tmpl.pop(); i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { out[i] = ' '; out[i + 1] = ' '; tmpl[tmpl.length - 1].depth = 1; i += 2; break; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    // Inside `${…}`: ordinary code, so fall through — but a `}` at depth 1 returns to the template.
    if (c === '}' && tmpl.length && tmpl[tmpl.length - 1].depth === 1) {
      tmpl[tmpl.length - 1].depth = 0; out[i] = ' '; i++;
      while (i < src.length) {
        if (src[i] === '\\') { wipe(i, i + 2); i += 2; continue; }
        if (src[i] === '`') { out[i] = ' '; tmpl.pop(); i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { out[i] = ' '; out[i + 1] = ' '; tmpl[tmpl.length - 1].depth = 1; i += 2; break; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '/') {
      const before = src.slice(Math.max(0, i - 24), i).replace(/\s+$/, '');
      if (PRE_REGEX.test(before)) {
        let j = i + 1, cls = false;
        while (j < src.length && (cls || src[j] !== '/')) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '\n') break;
          j++;
        }
        if (src[j] === '/') { while (/[a-z]/.test(src[j + 1] ?? '')) j++; wipe(i, j + 1); i = j + 1; continue; }
      }
    }
    i++;
  }
  return out.join('');
}
const blank = m => m.replace(/[^\n]/g, ' ');

// Things that exist without this file declaring them. NODE's globals, not a browser's: `document`
// or `localStorage` in this repo is a bug, and listing them here would be the gate agreeing to miss
// it. `require` is absent for the same reason — this is an ESM codebase.
const AMBIENT = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'do',
  'async', 'yield', 'void', 'delete', 'in', 'of', 'instanceof', 'throw', 'else', 'case', 'try',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'structuredClone', 'fetch', 'btoa', 'atob',
  'process', 'console', 'Buffer', 'globalThis', 'import', 'module', 'exports', '__dirname',
  'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'Headers', 'Request', 'Response',
  'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'crypto', 'performance',
  'ReadableStream', 'WritableStream', 'TransformStream', 'Intl',
  // Class bodies.
  'this', 'super',
  // Literals. The bare-argument site below matches `f(x, null)` and cannot tell a value from a
  // name, so the keywords that LOOK like lowercase identifiers are named here.
  'null', 'true', 'false', 'undefined', 'arguments',
]);

/* Every name a stretch of source DECLARES.
 *
 * Lifted from spattoo-admin's, minus the JSX-shaped cases, and it over-collects on purpose — a
 * default value inside a parameter list contributes its identifiers too. Bias toward "declared", so
 * the gate stays quiet on working code.
 */
function declaredNames(src) {
  const names = new Set();
  const add = chunk => { for (const m of chunk.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]); };

  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // EVERY declarator in a comma-separated declaration: `const pos = [], idx = []` declares two.
  for (const m of src.matchAll(/(?:const|let|var)\s+([^;\n]{0,400})/g)) {
    for (const d of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==[^=]|,|$)/g)) names.add(d[1]);
  }
  /* Destructuring that is assigned: `const { a, b } = …`, `let [x, y] = …`.
     BRACE-MATCHED, not a bounded lookahead. The pattern this replaces gave up after 800 characters,
     and routes/orders.js destructures a request body across forty lines of names and explanatory
     comments — so seven real parameters read as undeclared. A destructuring block has no natural
     length, and a limit is just a guess about how long somebody's prose will be. */
  for (const m of src.matchAll(/(?:const|let|var)\s*([{[])/g)) {
    const open = m.index + m[0].length - 1;
    const shut = m[1] === '{' ? '}' : ']';
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === m[1]) depth++;
      else if (src[i] === shut) { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // `= …` binds it, and so does `of …` / `in …` — `for (const [k, v] of …)` declares both.
    if (end !== -1 && /^\s*(?:=(?!=)|of\b|in\b)/.test(src.slice(end))) add(src.slice(open, end));
  }
  // Parameter lists — `(…) =>` and `(…) {`. One level of nesting, because a default value is often
  // a call sitting inside the very list that declares the name.
  for (const m of src.matchAll(/\(((?:[^()]|\([^()]*\)){0,800})\)\s*(?:=>|\{)/g)) add(m[1]);
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*([\s\S]*?)\s*from/g)) add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // Object and class METHOD shorthand — `capture(error, ctx) { … }` declares `capture`.
  for (const m of src.matchAll(/(?:^|[,{]\s*)([A-Za-z_$][\w$]*)\s*\([^()]{0,200}\)\s*\{/gm)) names.add(m[1]);
  // for (const x of …) / for (let i = 0; …)
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

/* ── The top-level functions, by BRACE MATCHING ──────────────────────────────────────────────────
 *
 * Not "from this declaration to the next one": that hands a function everything written after it up
 * to the next `function` keyword, so a nested helper silently donates its locals to its neighbour.
 * The check:image-model gate in this repo was written that way and misattributed its first finding
 * to the wrong function.
 *
 * Top-level means COLUMN ZERO — this repo declares module functions flush left and nests everything
 * else. Anything not inside one of these spans is module scope.
 */
function topLevelFunctions(src) {
  const out = [];
  /* THREE shapes, because this repo writes module code in all three and a shape the detector misses
     is a body that stays in "module scope" — where its own parameters are not collected, so every
     one of them reads as undeclared. That was the third round of false alarms. */
  const re = new RegExp([
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
    // `const name = (a, b) => {` and `const name = a => {`, with or without async.
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  ].map(r => `(?:${r.source})`).join('|'), 'gm');
  for (const m of src.matchAll(re)) {
    /* The body brace, found by scanning forward at paren depth ZERO. `indexOf('{')` lands inside a
       destructured parameter list — `({ a, b }) => {` — and brace-matching from there ends the
       "function" at the end of its own parameters. */
    let open = -1, paren = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '{' && paren <= 0) { open = i; break; }
      else if (ch === ';' && paren <= 0) break;   // a concise arrow body: nothing to match
    }
    if (open === -1) continue;
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) continue;
    /* ⚠️ TWO boundaries, because blanking and collecting want different spans — one each, and the
       first two runs of this gate got a different one wrong.
         `start` is the opening BRACE. Module scope is the file with each function's BODY blanked,
       and blanking from the `function` keyword takes the function's own NAME with it — a
       declaration hoists, so every sibling that calls it then reads as undeclared. 30-odd false
       alarms, all of them one function calling another in the same file.
         `declStart` is the keyword, and the function's OWN names are collected from there, because
       a parameter list lives before the brace. Collecting from the brace instead made every
       `(req, res, next)` read as undeclared — the same number of false alarms, the other way up. */
    /* ⚠️ `start` is the PARAMETER LIST, not the brace and not the keyword. Three spans, and each
       boundary was got wrong once before this line settled:
         from the keyword — the function's own NAME goes out of module scope with it, and a
       declaration hoists, so every sibling that calls it reads as undeclared.
         from the brace — the parameter list stays in module scope, where `function f(key)` reads
       as a CALL `f(key)` with `key` undeclared. The bare-argument site cannot tell a declaration's
       parameters from a call's arguments, so the header must not be there to be read.
       What module scope keeps is exactly `function f` / `const f =` — the name, and nothing else. */
    const argList = src.indexOf('(', m.index + m[0].length - 1);
    const start = (argList !== -1 && argList < open) ? argList : open;
    out.push({ name: m[1] ?? m[2] ?? m[3], declStart: m.index, start, end, body: src.slice(start, end), full: src.slice(m.index, end) });
  }
  return out;
}

// Where a missing name actually bites. Narrow on purpose: `x(…)` throws, `x.foo` throws, `x > 4` is
// silently false. Anything looser flags object keys and legitimate outer-scope names, and a gate
// that cries wolf gets switched off.
const SITES = [
  /[^A-Za-z0-9_.$]([a-z][A-Za-z0-9_$]*)\s*\(/g,               // name(
  /[^A-Za-z0-9_.$'"`/]([a-z][A-Za-z0-9_$]*)\s*\.[a-zA-Z]/g,   // name.foo
  /[^A-Za-z0-9_.$]([a-z][A-Za-z0-9_$]*)\s*[<>]=?\s*[\d'"`]/g, // name > 4
  /* ⚠️ A BARE ARGUMENT — `f(x)`, `f(a, x)` — and without it this gate does not catch the crash it
     was built for. `form.append('model', imageModel)` never calls `imageModel`, never reads a
     property off it and never compares it: it hands it over as a value. The three patterns above
     are spattoo-admin's, and all three missed it.
     Narrow on purpose: an identifier between `(`/`,` and `,`/`)`. Object shorthand `{ a, b }` and
     array elements `[a, b]` do not match, because neither is preceded by `(` and followed by a
     closer of this shape. */
  /[(,]\s*([a-z][A-Za-z0-9_$]*)\s*[,)]/g,                        // f(x) · f(a, x)
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(js|mjs)$/.test(entry)) out.push(rel);
  }
  return out;
}

const files = DIRS.flatMap(walk);
const problems = [];

for (const rel of files) {
  const src = scannable(readFileSync(join(ROOT, rel), 'utf8'));
  const fns = topLevelFunctions(src);

  // Module scope = the file with every top-level function BODY blanked out. Imports, module consts
  // and the function names themselves survive; one function's locals never reach another.
  let moduleOnly = src;
  for (const f of fns) moduleOnly = moduleOnly.slice(0, f.start) + blank(f.body) + moduleOnly.slice(f.end);
  const moduleNames = declaredNames(moduleOnly);

  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const scan = (chunk, offset, visible, where) => {
    for (const re of SITES) {
      for (const m of chunk.matchAll(re)) {
        const name = m[1];
        if (AMBIENT.has(name) || visible.has(name)) continue;
        problems.push({ rel, name, where, line: lineOf(offset + m.index) });
      }
    }
  };

  for (const f of fns) {
    // Its own locals, plus module scope. NOT a sibling function's.
    scan(f.body, f.start, new Set([...moduleNames, ...declaredNames(f.full)]), f.name);
  }
  scan(moduleOnly, 0, moduleNames, '(module scope)');
}

// One report per name per function: a missing declaration has as many use sites as it had users.
const seen = new Set();
const unique = problems.filter(p => {
  const k = `${p.rel}:${p.where}:${p.name}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (!unique.length) {
  console.log(`✓ check:bindings — every name used is declared where its function can see it (${files.length} files)`);
  process.exit(0);
}

console.error('✗ check:bindings — a name is used but nothing in scope declares it.\n');
console.error('  This is a ReferenceError at RUN time. It boots, it deploys, and it throws the');
console.error('  first time that line executes — which may be days later, on a live request.\n');
for (const p of unique) {
  console.error(`   • ${relative('', p.rel)}:${p.line}  →  ${p.name}   (in ${p.where})`);
}
console.error('\n  A name declared in ANOTHER function does not count — that is the bug this gate is');
console.error('  for. If one of these is a false positive the check is too crude: widen');
console.error('  declaredNames, do not silence the line.');
process.exit(1);
