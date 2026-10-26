'use strict';
// Pipwise core engine: indicators, strategy, outcomes, metrics, backtest. No dependencies.
const TF_MIN = { '15min': 15, '1h': 60, '4h': 240 };
const DEFAULTS = { version: 'v1', rsiBull: [50, 70], rsiBear: [30, 50], atrStop: 1.5, rr: 2 };

// Candle = { t: open time (ms, UTC), o, h, l, c }
function validateCandles(c, tf) {
  const ms = TF_MIN[tf] * 60000, issues = [], seen = new Set();
  c.forEach((k, i) => {
    if (![k.t, k.o, k.h, k.l, k.c].every(Number.isFinite) || k.h < Math.max(k.o, k.c, k.l) || k.l > Math.min(k.o, k.c, k.h)) issues.push({ i, type: 'ohlc' });
    if (seen.has(k.t)) issues.push({ i, type: 'duplicate' });
    seen.add(k.t);
    if (i > 0) { if (k.t <= c[i - 1].t) issues.push({ i, type: 'order' }); else if (k.t - c[i - 1].t > ms) issues.push({ i, type: 'gap' }); } // gaps include weekend closures
  });
  return issues;
}
const closedOnly = (c, tf, now = Date.now()) => c.filter(k => k.t + TF_MIN[tf] * 60000 <= now);
const isStale = (c, tf, now = Date.now(), tolerance = 2) => !c.length || now - (c[c.length - 1].t + TF_MIN[tf] * 60000) > tolerance * TF_MIN[tf] * 60000;

// EMA: seeded with SMA of first n values, then k = 2/(n+1). null until seeded.
function ema(v, n) {
  const out = Array(v.length).fill(null); if (v.length < n) return out;
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = e; const k = 2 / (n + 1);
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
// RSI (Wilder): first averages are simple means of n changes, then Wilder smoothing.
function rsi(v, n = 14) {
  const out = Array(v.length).fill(null); if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[n] = val();
  for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = val(); }
  return out;
}
// ATR (Wilder): TR from index 1; first ATR = mean of first n TRs.
function atr(c, n = 14) {
  const out = Array(c.length).fill(null); if (c.length <= n) return out;
  const tr = c.map((k, i) => i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - c[i - 1].c), Math.abs(k.l - c[i - 1].c)));
  let a = 0; for (let i = 1; i <= n; i++) a += tr[i]; a /= n; out[n] = a;
  for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}
function indicators(c) {
  const cl = c.map(k => k.c);
  return { e20: ema(cl, 20), e50: ema(cl, 50), e200: ema(cl, 200), rsi: rsi(cl, 14), atr: atr(c, 14) };
}

// Pure decision from one set of indicator values (completed candle only).
function decide(v, p = DEFAULTS) {
  if ([v.close, v.e20, v.e50, v.e200, v.rsi, v.atr].some(x => x == null || !Number.isFinite(x))) return { signal: 'WAIT', rules: [], reason: 'insufficient history' };
  const buy = [
    { name: 'EMA50 > EMA200', pass: v.e50 > v.e200 }, { name: 'EMA20 > EMA50', pass: v.e20 > v.e50 },
    { name: `RSI in ${p.rsiBull[0]}-${p.rsiBull[1]}`, pass: v.rsi >= p.rsiBull[0] && v.rsi <= p.rsiBull[1] }, { name: 'Close > EMA20', pass: v.close > v.e20 }];
  const sell = [
    { name: 'EMA50 < EMA200', pass: v.e50 < v.e200 }, { name: 'EMA20 < EMA50', pass: v.e20 < v.e50 },
    { name: `RSI in ${p.rsiBear[0]}-${p.rsiBear[1]}`, pass: v.rsi >= p.rsiBear[0] && v.rsi <= p.rsiBear[1] }, { name: 'Close < EMA20', pass: v.close < v.e20 }];
  const signal = buy.every(r => r.pass) ? 'BUY' : sell.every(r => r.pass) ? 'SELL' : 'WAIT';
  const rules = signal === 'SELL' ? sell : buy.filter(r => r.pass).length >= sell.filter(r => r.pass).length ? buy : sell;
  return { signal, rules, levels: signal === 'WAIT' ? null : levels(signal, v.close, v.atr, p) };
}
function levels(dir, entry, atrV, p = DEFAULTS) {
  const risk = p.atrStop * atrV, s = dir === 'BUY' ? 1 : -1;
  const L = { entry, stop: entry - s * risk, target: entry + s * p.rr * risk, risk, rr: p.rr };
  const ok = [L.entry, L.stop, L.target, risk].every(x => Number.isFinite(x) && x > 0) && (dir === 'BUY' ? L.stop < entry && L.target > entry : L.stop > entry && L.target < entry);
  return ok ? L : null; // invalid levels => no valid setup
}
function signalAt(ind, c, i, p = DEFAULTS) {
  const d = decide({ close: c[i].c, e20: ind.e20[i], e50: ind.e50[i], e200: ind.e200[i], rsi: ind.rsi[i], atr: ind.atr[i] }, p);
  return { ...d, t: c[i].t, strategy: p.version };
}

// Outcome policy: bars after the signal candle; a bar touching both stop and target is 'ambiguous'.
function resolve(sig, future, maxBars = 48) {
  const L = sig.levels, buy = sig.signal === 'BUY';
  for (let j = 0; j < Math.min(future.length, maxBars); j++) {
    const k = future[j], stop = buy ? k.l <= L.stop : k.h >= L.stop, tgt = buy ? k.h >= L.target : k.l <= L.target;
    if (stop && tgt) return { status: 'ambiguous', bars: j + 1, r: null };
    if (stop) return { status: 'stop', bars: j + 1, r: -1 };
    if (tgt) return { status: 'target', bars: j + 1, r: L.rr };
  }
  return future.length >= maxBars ? { status: 'expired', bars: maxBars, r: null } : { status: 'open', bars: future.length, r: null };
}

// Metrics over resolved R-multiples only (target/stop). Open, expired and ambiguous are excluded and counted separately.
function metrics(rs) {
  const n = rs.length, wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  let cum = 0, peak = 0, dd = 0; for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { resolved: n, wins: wins.length, losses: losses.length, winRate: n ? wins.length / n : null, avgR: n ? cum / n : null, expectancyR: n ? cum / n : null, profitFactor: gl > 0 ? gw / gl : null, maxDrawdownR: dd, cumulativeR: cum };
}
function summarize(trades) {
  const by = s => trades.filter(t => t.status === s).length;
  return { signals: trades.length, open: by('open'), ambiguous: by('ambiguous'), expired: by('expired'),
    gross: metrics(trades.filter(t => t.r != null).map(t => t.r)), costAdjusted: metrics(trades.filter(t => t.r != null).map(t => t.netR)) };
}

// Backtest: indicators are causal; one position at a time; dev/out-of-sample split by time. spread is in price units.
function backtest(c, tf, p = DEFAULTS, o = {}) {
  const { spread = 0, maxBars = 48, devFraction = 0.7, from, to } = o;
  const issues = validateCandles(c, tf), bad = issues.filter(x => x.type !== 'gap');
  if (bad.length) throw new Error(`Invalid candles: ${bad.length} issue(s), first: ${JSON.stringify(bad[0])}`);
  const ind = indicators(c), trades = []; let busy = -1;
  for (let i = 200; i < c.length; i++) {
    if (i <= busy || (from && c[i].t < from) || (to && c[i].t > to)) continue;
    const s = signalAt(ind, c, i, p); if (s.signal === 'WAIT' || !s.levels) continue;
    const r = resolve(s, c.slice(i + 1, i + 1 + maxBars), maxBars), cost = spread / s.levels.risk;
    trades.push({ t: s.t, dir: s.signal, status: r.status, r: r.r, netR: r.r == null ? null : r.r - cost, levels: s.levels });
    busy = i + r.bars;
  }
  const cut = c[Math.floor(c.length * devFraction)].t;
  return { params: p, options: { spread, maxBars, devFraction }, candles: c.length, gaps: issues.length, trades,
    all: summarize(trades), development: summarize(trades.filter(t => t.t < cut)), outOfSample: summarize(trades.filter(t => t.t >= cut)) };
}
// Is a signal still worth entering at the current price? Transparent heuristic, not a prediction.
function entryCheck(dir, L, price, o = {}) {
  const { minRR = 1.5, maxAdverseR = 0.5, maxEntryBars = 3, barsOld = 0 } = o;
  if (!L || !Number.isFinite(price)) return { state: 'UNKNOWN', text: 'No live price available' };
  const s = dir === 'BUY' ? 1 : -1, risk = Math.abs(L.entry - L.stop);
  if (s * (price - L.stop) <= 0) return { state: 'INVALID', text: 'Price is already beyond the stop - setup failed' };
  if (s * (L.target - price) <= 0) return { state: 'INVALID', text: 'Price already reached the target - too late' };
  if (barsOld > maxEntryBars) return { state: 'EXPIRED', text: `Entry window passed: signal is ${barsOld} candles old (limit ${maxEntryBars})` };
  const moved = s * (price - L.entry) / risk, rrNow = (s * (L.target - price)) / (s * (price - L.stop));
  if (moved < -maxAdverseR) return { state: 'SKIP', moved, rrNow, text: `Skip: price moved ${(-moved).toFixed(2)}R against the setup` };
  if (rrNow < minRR) return { state: 'LATE', moved, rrNow, text: `Late, skip: price is ${moved.toFixed(2)}R toward target, remaining R:R ${rrNow.toFixed(2)} (needs ${minRR})` };
  return { state: 'ENTER', moved, rrNow, text: `Still valid: price ${moved >= 0 ? '+' : ''}${moved.toFixed(2)}R from entry, remaining R:R ${rrNow.toFixed(2)}` };
}
module.exports = { entryCheck, TF_MIN, DEFAULTS, validateCandles, closedOnly, isStale, ema, rsi, atr, indicators, decide, levels, signalAt, resolve, metrics, summarize, backtest };
