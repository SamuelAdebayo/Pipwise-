'use strict';
// Pipwise core engine: indicators, strategy, outcomes, metrics, backtest. No dependencies.
const TF_MIN = { '15min': 15, '1h': 60, '4h': 240 }; // timeframes you can select
const TF_ALL = { ...TF_MIN, '1day': 1440 }; // also includes daily candles, used only as trend context
const DEFAULTS = { version: 'v1', rsiBull: [50, 70], rsiBear: [30, 50], atrStop: 1.5, rr: 2 };

// Candle = { t: open time (ms, UTC), o, h, l, c }
function validateCandles(c, tf) {
  const ms = TF_ALL[tf] * 60000, issues = [], seen = new Set();
  c.forEach((k, i) => {
    if (![k.t, k.o, k.h, k.l, k.c].every(Number.isFinite) || k.h < Math.max(k.o, k.c, k.l) || k.l > Math.min(k.o, k.c, k.h)) issues.push({ i, type: 'ohlc' });
    if (seen.has(k.t)) issues.push({ i, type: 'duplicate' });
    seen.add(k.t);
    if (i > 0) { if (k.t <= c[i - 1].t) issues.push({ i, type: 'order' }); else if (k.t - c[i - 1].t > ms) issues.push({ i, type: 'gap' }); } // gaps include weekend closures
  });
  return issues;
}
const closedOnly = (c, tf, now = Date.now()) => c.filter(k => k.t + TF_ALL[tf] * 60000 <= now);
const isStale = (c, tf, now = Date.now(), tolerance = 2) => !c.length || now - (c[c.length - 1].t + TF_ALL[tf] * 60000) > tolerance * TF_ALL[tf] * 60000;

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
function backtest(c, tf, p = DEFAULTS, o = {}) { // o.accept(i, dir) can veto a signal (used by the filters)
  const { spread = 0, slippage = 0, maxBars = 48, devFraction = 0.7, from, to } = o; // spread and slippage are in price units, both charged as cost / risk in R
  const issues = validateCandles(c, tf), bad = issues.filter(x => x.type !== 'gap');
  if (bad.length) throw new Error(`Invalid candles: ${bad.length} issue(s), first: ${JSON.stringify(bad[0])}`);
  const ind = indicators(c), trades = []; let busy = -1;
  for (let i = 200; i < c.length; i++) {
    if (i <= busy || (from && c[i].t < from) || (to && c[i].t > to)) continue;
    const s = o.signalFn ? o.signalFn(i) : signalAt(ind, c, i, p); if (s.signal === 'WAIT' || !s.levels) continue; // o.signalFn lets another strategy supply the signal
    if (o.accept && !o.accept(i, s.signal, s.levels)) continue;
    const r = resolve(s, c.slice(i + 1, i + 1 + maxBars), maxBars), cost = (spread + slippage) / s.levels.risk;
    trades.push({ t: s.t, dir: s.signal, status: r.status, r: r.r, netR: r.r == null ? null : r.r - cost, levels: s.levels });
    busy = i + r.bars;
  }
  const cut = c[Math.floor(c.length * devFraction)].t;
  return { params: p, options: { spread, slippage, maxBars, devFraction }, candles: c.length, gaps: issues.length, trades,
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
// Drops provider candles that fail validation (bad OHLC, duplicate or out-of-order times) and reports them, instead of failing the whole dataset.
function sanitize(c) {
  const out = [], excluded = []; let lastT = -Infinity;
  for (const k of c) {
    const ok = [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite) && k.h >= Math.max(k.o, k.c, k.l) && k.l <= Math.min(k.o, k.c, k.h);
    if (!ok) excluded.push({ t: k.t, type: 'ohlc' }); else if (k.t <= lastT) excluded.push({ t: k.t, type: 'duplicate_or_order' }); else { out.push(k); lastT = k.t; }
  }
  return { candles: out, excluded };
}
// ADX 14 (Wilder). Measures trend strength regardless of direction: low = sideways market.
function adx(c, n = 14) {
  const out = Array(c.length).fill(null); if (c.length < 2 * n + 1) return out;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  let st = 0, sp = 0, sm = 0; for (let i = 0; i < n; i++) { st += tr[i]; sp += pdm[i]; sm += mdm[i]; }
  const dx = [], push = () => { const a = st ? 100 * sp / st : 0, b = st ? 100 * sm / st : 0; dx.push(a + b ? 100 * Math.abs(a - b) / (a + b) : 0); };
  push();
  for (let i = n; i < tr.length; i++) { st = st - st / n + tr[i]; sp = sp - sp / n + pdm[i]; sm = sm - sm / n + mdm[i]; push(); }
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n; out[2 * n - 1] = a; // dx[k] belongs to candle n+k
  for (let k = n; k < dx.length; k++) { a = (a * (n - 1) + dx[k]) / n; out[n + k] = a; }
  return out;
}
// Sessions in each city's own local time, so daylight saving is handled: London 08:00-16:30, New York 08:00-17:00.
const _fmt = {};
function localMinutes(t, tz) {
  const f = _fmt[tz] || (_fmt[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })), p = f.formatToParts(new Date(t));
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value;
}
function inSession(t) { const l = localMinutes(t, 'Europe/London'), n = localMinutes(t, 'America/New_York'); return (l >= 480 && l < 990) || (n >= 480 && n < 1020); }
// Optional filters for the Filter Lab. Each one only uses information available when the signal candle closed.
function buildAccept(c, tf, cfg = {}, htfC = null, htfTf = null) {
  const ms = TF_MIN[tf] * 60000, checks = [];
  if (cfg.adx) { const a = adx(c, 14); checks.push(i => a[i] != null && a[i] >= cfg.adx); }
  if (cfg.session) checks.push(i => inSession(c[i].t + ms));
  if (cfg.htf) {
    if (!htfC || !htfTf) throw new Error('Higher timeframe data required');
    const h = indicators(htfC), hms = TF_ALL[htfTf] * 60000 + (htfTf === '1day' ? 86400000 : 0); // daily candle boundaries differ between providers, so a daily candle is only used one extra day after it ends (avoids look-ahead)
    checks.push((i, dir) => {
      const tc = c[i].t + ms; let lo = 0, hi = htfC.length - 1, k = -1; // last higher-timeframe candle already closed at tc
      while (lo <= hi) { const m = (lo + hi) >> 1; if (htfC[m].t + hms <= tc) { k = m; lo = m + 1; } else hi = m - 1; }
      if (k < 0 || h.e50[k] == null || h.e200[k] == null) return false;
      const bull = h.e50[k] > h.e200[k]; return dir === 'BUY' ? bull : !bull;
    });
  }
  if (cfg.pullback) { // price touched the 20 EMA within the last k candles, then resumed (the base rules already require the close back beyond it)
    const k = cfg.pullback, ind = indicators(c);
    checks.push((i, dir) => { for (let j = Math.max(0, i - k + 1); j <= i; j++) { const e20 = ind.e20[j]; if (e20 == null) return false; if (dir === 'BUY' ? c[j].l <= e20 : c[j].h >= e20) return true; } return false; });
  }
  if (cfg.sr) { // reject if a confirmed swing high (BUY) or swing low (SELL) sits closer than cfg.sr times the risk
    const L = 5, look = 300;
    checks.push((i, dir, lv) => {
      if (!lv) return true; const risk = Math.abs(lv.entry - lv.stop); let near = Infinity;
      for (let j = i - L; j >= Math.max(L, i - look); j--) { // a swing at j is only known once candle j+L has closed
        let isH = true, isL = true;
        for (let q = j - L; q <= j + L; q++) { if (q === j) continue; if (c[q].h >= c[j].h) isH = false; if (c[q].l <= c[j].l) isL = false; }
        if (dir === 'BUY' && isH && c[j].h > lv.entry) near = Math.min(near, c[j].h - lv.entry);
        if (dir === 'SELL' && isL && c[j].l < lv.entry) near = Math.min(near, lv.entry - c[j].l);
      }
      return near >= cfg.sr * risk;
    });
  }
  return (i, dir, lv) => checks.every(f => f(i, dir, lv));
}
module.exports = { TF_ALL, adx, inSession, buildAccept, sanitize, entryCheck, TF_MIN, DEFAULTS, validateCandles, closedOnly, isStale, ema, rsi, atr, indicators, decide, levels, signalAt, resolve, metrics, summarize, backtest };
