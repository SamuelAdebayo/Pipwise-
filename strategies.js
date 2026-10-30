'use strict';
// A library of well-known, openly documented strategies. Each one only decides BUY / SELL from candles up to and including candle i.
// Every strategy uses the SAME stop and target (1.5 x ATR, 2R) so their results can be compared fairly.
// The source links explain the indicator maths only. We do not rely on any profit claim made there.
const E = require('./engine');
const RISK = { atrStop: 1.5, rr: 2 };

function bands(c, n = 20) { // Bollinger: average and standard deviation of the last n closes
  const mid = Array(c.length).fill(null), sd = Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) { let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j].c; const m = s / n; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (c[j].c - m) ** 2; mid[i] = m; sd[i] = Math.sqrt(v / n); }
  return { mid, sd };
}
function prep(c) { let bb = null; return { c, ind: E.indicators(c), adx: E.adx(c, 14), get bb() { return bb || (bb = bands(c)); } }; }

const STRATEGIES = [
  { id: 'ema-rsi-trend', name: 'EMA / RSI / ATR trend follower', source: null, description: 'The original Pipwise rules (for comparison).', versions: [{ label: 'v1', params: {} }],
    signal: (x, i) => { const d = E.decide({ close: x.c[i].c, e20: x.ind.e20[i], e50: x.ind.e50[i], e200: x.ind.e200[i], rsi: x.ind.rsi[i], atr: x.ind.atr[i] }); return d.signal === 'WAIT' ? null : d.signal; } },
  { id: 'donchian-breakout', name: 'Donchian channel breakout', source: 'https://en.wikipedia.org/wiki/Donchian_channel', description: 'BUY when the close breaks above the highest high of the previous n candles, SELL when it breaks below the lowest low.',
    versions: [{ label: 'n20', params: { n: 20 } }, { label: 'n55', params: { n: 55 } }],
    signal: (x, i, p) => { if (i < p.n) return null; let hi = -Infinity, lo = Infinity; for (let j = i - p.n; j < i; j++) { hi = Math.max(hi, x.c[j].h); lo = Math.min(lo, x.c[j].l); } return x.c[i].c > hi ? 'BUY' : x.c[i].c < lo ? 'SELL' : null; } },
  { id: 'rsi-dip-in-trend', name: 'RSI dip in a trend', source: 'https://en.wikipedia.org/wiki/Relative_strength_index', description: 'In an uptrend (EMA 50 above EMA 200) BUY when RSI 14 falls below the level; in a downtrend SELL when it rises above 100 minus the level.',
    versions: [{ label: 'level30', params: { level: 30 } }, { label: 'level35', params: { level: 35 } }, { label: 'level40', params: { level: 40 } }],
    signal: (x, i, p) => { const a = x.ind.e50[i], b = x.ind.e200[i], r = x.ind.rsi[i]; if (a == null || b == null || r == null) return null; return a > b && r < p.level ? 'BUY' : a < b && r > 100 - p.level ? 'SELL' : null; } },
  { id: 'bollinger-reversion', name: 'Bollinger band reversion', source: 'https://en.wikipedia.org/wiki/Bollinger_Bands', description: 'BUY when the close is below the lower band (20-candle average minus k standard deviations), SELL when above the upper band.',
    versions: [{ label: 'k2', params: { k: 2 } }, { label: 'k2.5', params: { k: 2.5 } }],
    signal: (x, i, p) => { const m = x.bb.mid[i], s = x.bb.sd[i]; if (m == null || !s) return null; return x.c[i].c < m - p.k * s ? 'BUY' : x.c[i].c > m + p.k * s ? 'SELL' : null; } },
  { id: 'ema-cross-adx', name: 'EMA 20/50 cross with trend strength', source: 'https://en.wikipedia.org/wiki/Average_directional_movement_index', description: 'BUY when EMA 20 crosses above EMA 50 while ADX 14 is at least the level; SELL on the opposite cross.',
    versions: [{ label: 'adx20', params: { adx: 20 } }, { label: 'adx25', params: { adx: 25 } }],
    signal: (x, i, p) => { const { e20, e50 } = x.ind, a = x.adx[i]; if (i < 1 || [e20[i], e50[i], e20[i - 1], e50[i - 1], a].some(v => v == null) || a < p.adx) return null; return e20[i - 1] <= e50[i - 1] && e20[i] > e50[i] ? 'BUY' : e20[i - 1] >= e50[i - 1] && e20[i] < e50[i] ? 'SELL' : null; } },
];
const find = id => STRATEGIES.find(s => s.id === id);

// Runs one strategy version over candles with the shared backtester (same costs, one trade at a time, 70/30 split).
function backtestStrategy(c, tf, def, params, o = {}) {
  const x = prep(c);
  const signalFn = i => { const dir = def.signal(x, i, params), a = x.ind.atr[i]; if (!dir || a == null) return { signal: 'WAIT' }; const levels = E.levels(dir, c[i].c, a, RISK); return levels ? { signal: dir, levels, t: c[i].t } : { signal: 'WAIT' }; };
  return E.backtest(c, tf, E.DEFAULTS, { ...o, signalFn });
}
// Trades at or after the end time never count, so the final segment cannot change the result.
// Average result (after costs) in K equal slices of time: shows whether a result is steady or came from one lucky stretch.
function segments(trades, c, K = 4, end = null) {
  const t0 = c[200].t, t1 = end ?? c[c.length - 1].t + 1, w = (t1 - t0) / K, out = Array.from({ length: K }, () => ({ n: 0, sum: 0 }));
  for (const tr of trades) { if (tr.netR == null || tr.t >= t1) continue; const k = Math.min(K - 1, Math.max(0, Math.floor((tr.t - t0) / w))); out[k].n++; out[k].sum += tr.netR; }
  return out.map(s => ({ trades: s.n, avgR: s.n ? s.sum / s.n : null }));
}
module.exports = { STRATEGIES, find, prep, backtestStrategy, segments, RISK };
