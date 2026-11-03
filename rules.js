'use strict';
// A strategy written as plain data: { long: [condition, ...], short: [condition, ...] }. A side fires when ALL its conditions hold.
// Every operand only looks at candles up to and including candle i, so a data strategy cannot peek at the future.
//   operand:   { k:'close' } | { k:'ema', n } | { k:'rsi', n } | { k:'adx' } | { k:'hh', n } (highest high of the previous n candles) | { k:'ll', n }
//              | { k:'bbU', n, m } | { k:'bbL', n, m } (Bollinger bands: n-candle average +/- m standard deviations) | { k:'num', v }
//   condition: { a: operand, op: '>' | '<' | '>=' | '<=', b: operand }   or   { cross: 'up' | 'down', a: operand, b: operand }
const E = require('./engine');
const OPS = ['>', '<', '>=', '<='], FIELDS = { close: [], adx: [], num: ['v'], ema: ['n'], rsi: ['n'], hh: ['n'], ll: ['n'], bbU: ['n', 'm'], bbL: ['n', 'm'] };
const RANGE = { n: [2, 300, true], m: [0.5, 5, false], v: [-1000000, 1000000, false] }, MAX_CONDS = 6;

function operand(o, at) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !FIELDS[o.k]) throw new Error(`${at}: unknown operand. Allowed: ${Object.keys(FIELDS).join(', ')}`);
  const out = { k: o.k };
  for (const f of Object.keys(o)) if (f !== 'k' && !FIELDS[o.k].includes(f)) throw new Error(`${at}: "${f}" is not used by ${o.k}`);
  for (const f of FIELDS[o.k]) { const [lo, hi, int] = RANGE[f], v = Number(o[f]); if (o[f] == null || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) throw new Error(`${at}: ${o.k}.${f} must be a ${int ? 'whole ' : ''}number from ${lo} to ${hi}`); out[f] = v; }
  return out;
}
function cond(c, at) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${at}: a condition must be an object`);
  if (c.cross !== undefined) { if (!['up', 'down'].includes(c.cross) || c.op !== undefined) throw new Error(`${at}: cross must be "up" or "down"`); return { cross: c.cross, a: operand(c.a, at + '.a'), b: operand(c.b, at + '.b') }; }
  if (!OPS.includes(c.op)) throw new Error(`${at}: op must be one of ${OPS.join(' ')}`);
  const a = operand(c.a, at + '.a'), b = operand(c.b, at + '.b'); if (a.k === 'num' && b.k === 'num') throw new Error(`${at}: compare an indicator with something`);
  return { a, op: c.op, b };
}
// The opposite side of a rule: flips comparisons, swaps highest-high with lowest-low and upper with lower band, mirrors RSI levels (35 -> 65).
function mirror(conds) {
  const flip = { '>': '<', '<': '>', '>=': '<=', '<=': '>=' }, swap = { hh: 'll', ll: 'hh', bbU: 'bbL', bbL: 'bbU' };
  const m = o => (swap[o.k] ? { ...o, k: swap[o.k] } : { ...o });
  return conds.map(c => {
    if (c.cross) return { cross: c.cross === 'up' ? 'down' : 'up', a: m(c.a), b: m(c.b) };
    if ((c.a.k === 'adx' && c.b.k === 'num') || (c.b.k === 'adx' && c.a.k === 'num')) return { a: { ...c.a }, op: c.op, b: { ...c.b } }; // trend strength has no direction
    const r = (c.a.k === 'rsi' && c.b.k === 'num') ? 'b' : (c.b.k === 'rsi' && c.a.k === 'num') ? 'a' : null, o = { a: m(c.a), op: flip[c.op], b: m(c.b) };
    if (r) o[r] = { k: 'num', v: 100 - c[r].v }; return o;
  });
}
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be an object with a "long" list');
  for (const k of Object.keys(spec)) if (!['long', 'short', 'mirror'].includes(k)) throw new Error(`Unknown spec field "${k}"`);
  const side = (list, name) => { if (!Array.isArray(list) || list.length < 1 || list.length > MAX_CONDS) throw new Error(`${name} needs 1 to ${MAX_CONDS} conditions`); return list.map((c, i) => cond(c, `${name}[${i}]`)); };
  const long = side(spec.long, 'long'); let short;
  if (spec.short !== undefined) short = side(spec.short, 'short'); else if (spec.mirror === false) short = []; else short = mirror(long);
  return { long, short };
}
const bandsOf = (c, n) => { const mid = Array(c.length).fill(null), sd = Array(c.length).fill(null); for (let i = n - 1; i < c.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j].c; const m = s / n; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (c[j].c - m) ** 2; mid[i] = m; sd[i] = Math.sqrt(v / n); } return { mid, sd }; };
function series(x, o) {
  const key = JSON.stringify(o); let s = x.cache.get(key); if (s) return s; const c = x.c, close = () => c.map(k => k.c);
  if (o.k === 'close') s = close(); else if (o.k === 'ema') s = E.ema(close(), o.n); else if (o.k === 'rsi') s = E.rsi(close(), o.n); else if (o.k === 'adx') s = x.adx || E.adx(c, 14);
  else if (o.k === 'hh' || o.k === 'll') s = c.map((_, i) => { if (i < o.n) return null; let m = o.k === 'hh' ? -Infinity : Infinity; for (let j = i - o.n; j < i; j++) m = o.k === 'hh' ? Math.max(m, c[j].h) : Math.min(m, c[j].l); return m; });
  else { const b = bandsOf(c, o.n); s = c.map((_, i) => (b.sd[i] ? b.mid[i] + (o.k === 'bbU' ? 1 : -1) * o.m * b.sd[i] : null)); }
  x.cache.set(key, s); return s;
}
const val = (x, o, i) => (o.k === 'num' ? o.v : series(x, o)[i] ?? null);
function holds(x, conds, i) {
  return conds.every(c => {
    if (c.cross) { if (i < 1) return false; const v = [val(x, c.a, i - 1), val(x, c.b, i - 1), val(x, c.a, i), val(x, c.b, i)]; if (v.some(q => q == null)) return false; return c.cross === 'up' ? v[0] <= v[1] && v[2] > v[3] : v[0] >= v[1] && v[2] < v[3]; }
    const a = val(x, c.a, i), b = val(x, c.b, i); if (a == null || b == null) return false; return c.op === '>' ? a > b : c.op === '<' ? a < b : c.op === '>=' ? a >= b : a <= b;
  });
}
function signal(x, i, spec) { const L = spec.long.length > 0 && holds(x, spec.long, i), S = spec.short.length > 0 && holds(x, spec.short, i); return L && !S ? 'BUY' : S && !L ? 'SELL' : null; }
const name = o => ({ close: 'close', adx: 'ADX 14', num: o.v, ema: `EMA ${o.n}`, rsi: `RSI ${o.n}`, hh: `highest high of the previous ${o.n} candles`, ll: `lowest low of the previous ${o.n} candles`, bbU: `upper Bollinger band (${o.n}, ${o.m} sd)`, bbL: `lower Bollinger band (${o.n}, ${o.m} sd)` }[o.k]);
const text = c => (c.cross ? `${name(c.a)} crosses ${c.cross === 'up' ? 'above' : 'below'} ${name(c.b)}` : `${name(c.a)} ${c.op} ${name(c.b)}`);
const describe = spec => { const t = cs => cs.map(text).join(' AND '); return { long: t(spec.long), short: spec.short.length ? t(spec.short) : '(no sell rule)' }; };
// Each condition on its own, passing or failing, at candle i. This is the evaluated-conditions record behind "Why this result?".
const explain = (x, i, spec) => { const one = cs => cs.map(c => ({ text: text(c), pass: holds(x, [c], i) })); return { buy: one(spec.long), sell: one(spec.short) }; };

// Checks a strategy a person pastes in: id, name, and 1-6 versions, each a spec.
function validateStrategyInput(o, takenIds = []) {
  if (!o || typeof o !== 'object') throw new Error('Send a JSON object');
  if (!/^[a-z0-9-]{3,40}$/.test(String(o.id || ''))) throw new Error('id must be 3-40 characters: lowercase letters, numbers and dashes');
  if (takenIds.includes(o.id)) throw new Error('That id is already used. Choose a new id for a new strategy.');
  const nm = String(o.name || '').trim(); if (!nm || nm.length > 60) throw new Error('name is required (max 60 characters)');
  if (!Array.isArray(o.versions) || o.versions.length < 1 || o.versions.length > 6) throw new Error('versions needs 1 to 6 entries');
  const seen = new Set(), versions = o.versions.map((v, i) => { const label = String((v || {}).label || ''); if (!/^[a-z0-9.-]{1,20}$/.test(label) || seen.has(label)) throw new Error(`version ${i + 1}: label must be 1-20 characters (letters, numbers, dot, dash) and unique`); seen.add(label); return { label, spec: validateSpec(v.spec) }; });
  return { id: o.id, name: nm, description: String(o.description || '').slice(0, 300), versions };
}
module.exports = { validateSpec, validateStrategyInput, mirror, signal, describe, explain, MAX_CONDS };
