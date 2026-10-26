'use strict';
const E = require('./engine');
const INSTRUMENTS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'GBP/JPY', 'XAU/USD'];
const MAX_BARS = 48;
const ASSUMPTIONS = `Entry = signal candle close. Outcome from later completed candles of the same timeframe. Stop and target in one candle = ambiguous. Expires after ${MAX_BARS} bars. No spread, slippage or gaps modelled.`;
const version = p => `v1|bull${p.rsiBull.join('-')}|bear${p.rsiBear.join('-')}|atr${p.atrStop}|rr${p.rr}`;

function cleanParams(i = {}) {
  const num = (x, lo, hi, n) => { x = Number(x); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`Invalid ${n}`); return x; };
  const rng = (a, n) => { if (!Array.isArray(a) || a.length !== 2) throw new Error(`Invalid ${n}`); const r = [num(a[0], 0, 100, n), num(a[1], 0, 100, n)]; if (r[0] >= r[1]) throw new Error(`Invalid ${n}`); return r; };
  const d = E.DEFAULTS;
  const p = { rsiBull: rng(i.rsiBull ?? d.rsiBull, 'rsiBull'), rsiBear: rng(i.rsiBear ?? d.rsiBear, 'rsiBear'), atrStop: num(i.atrStop ?? d.atrStop, 0.1, 10, 'atrStop'), rr: num(i.rr ?? d.rr, 0.1, 10, 'rr') };
  p.version = version(p); return p;
}

function createService({ store, fetchCandles, now = Date.now, ttlMs = 60000, provider = 'twelvedata' }) {
  const cache = new Map();
  const params = () => cleanParams(JSON.parse(store.getSetting('params') || '{}'));

  async function load(symbol, tf, size = 400, force = false) {
    const key = `${symbol}|${tf}|${size}`, hit = cache.get(key);
    if (hit && !force && now() - hit.at < ttlMs) return hit.data; // cached: avoids hitting the provider on every page load
    try { const data = await fetchCandles({ symbol, tf, outputsize: size }); cache.set(key, { at: now(), data }); return data; }
    catch (e) {
      const kind = e.kind || 'provider';
      if (kind !== 'no_credentials') store.addAlert(`api:${kind}:${symbol}:${tf}:${Math.floor(now() / 3600000)}`, 'api_error', `${symbol} ${tf}: ${e.message}`, now());
      const err = new Error(e.message); err.kind = kind; throw err; // never falls back to fake prices
    }
  }

  function track(symbol, tf, closed) {
    const ms = E.TF_MIN[tf] * 60000; let limited = 0;
    for (const s of store.openSignals(symbol, tf)) {
      if (!closed.length || closed[0].t > s.candle_t + ms) { limited++; continue; } // history no longer covers this signal
      const future = closed.filter(k => k.t > s.candle_t);
      const r = E.resolve({ signal: s.dir, levels: { stop: s.stop, target: s.target, rr: s.rr } }, future, MAX_BARS);
      if (r.status === 'open') continue;
      store.tx(() => {
        if (store.resolveSignal(s.id, r.status, r.r, future[r.bars - 1].t, ASSUMPTIONS))
          store.addAlert(`out:${s.id}`, 'outcome', `${s.symbol} ${s.tf} ${s.dir} signal: ${r.status}${r.r != null ? ` (${r.r}R)` : ''}`, now());
      });
    }
    return limited;
  }

  async function snapshot(symbol, tf, force = false) {
    const p = params(); let d;
    try { d = await load(symbol, tf, 400, force); }
    catch (e) { return { ok: false, error: { kind: e.kind, message: e.message }, strategy: p.version }; }
    const bad = E.validateCandles(d.candles, tf).filter(x => x.type !== 'gap');
    if (bad.length) { store.addAlert(`invalid:${symbol}:${tf}:${Math.floor(now() / 3600000)}`, 'api_error', `${symbol} ${tf}: ${bad.length} invalid candle(s) from provider`, now()); return { ok: false, error: { kind: 'invalid_data', message: `${bad.length} invalid candle(s) received` }, strategy: p.version }; }
    const closed = E.closedOnly(d.candles, tf, now()), stale = E.isStale(closed, tf, now()), last = closed[closed.length - 1];
    if (stale) store.addAlert(`stale:${symbol}:${tf}:${last ? last.t : 0}`, 'stale_data', `${symbol} ${tf}: latest closed candle is stale`, now());
    const ind = E.indicators(closed), i = closed.length - 1;
    const sig = i >= 0 ? E.signalAt(ind, closed, i, p) : { signal: 'WAIT', rules: [], levels: null };
    let recorded = null;
    if (!stale && sig.levels && !store.openSignals(symbol, tf).some(s => s.dir === sig.signal)) {
      recorded = store.addSignal({ symbol, tf, dir: sig.signal, strategy: p.version, params: p, candle_t: last.t, provider: d.source, ...sig.levels, indicators: { e20: ind.e20[i], e50: ind.e50[i], e200: ind.e200[i], rsi: ind.rsi[i], atr: ind.atr[i] }, created_at: now() });
      if (recorded) store.addAlert(`sig:${recorded}`, 'new_signal', `${symbol} ${tf}: new ${sig.signal} signal at ${sig.levels.entry}`, now());
    }
    const trackingLimited = track(symbol, tf, closed), from = Math.max(0, closed.length - 120);
    return { ok: true, symbol, tf, source: d.source, fetchedAt: d.fetchedAt, latestCandleT: last ? last.t : null, latestClose: last ? last.c : null, stale, strategy: p.version, params: p,
      signal: sig.signal, rules: sig.rules, reason: sig.reason || null, levels: sig.levels, newSignalId: recorded, trackingLimited,
      indicators: i >= 0 ? { e20: ind.e20[i], e50: ind.e50[i], e200: ind.e200[i], rsi: ind.rsi[i], atr: ind.atr[i] } : null,
      chart: closed.slice(from).map((k, j) => ({ ...k, e20: ind.e20[from + j], e50: ind.e50[from + j], e200: ind.e200[from + j] })) };
  }

  async function backtest(o) {
    if (!INSTRUMENTS.includes(o.symbol) || !E.TF_MIN[o.tf]) throw new Error('Unsupported symbol or timeframe');
    const p = cleanParams(o.params), spread = Number(o.spread || 0);
    if (!(spread >= 0)) throw new Error('Invalid spread');
    const d = await load(o.symbol, o.tf, 5000), closed = E.closedOnly(d.candles, o.tf, now());
    if (closed.length < 400) throw new Error('Not enough history for a backtest (need 400+ closed candles)');
    const res = E.backtest(closed, o.tf, p, { spread, maxBars: MAX_BARS, from: o.from, to: o.to });
    const dataset = { provider: d.source, symbol: o.symbol, tf: o.tf, candles: closed.length, first: closed[0].t, last: closed[closed.length - 1].t, gapsOrClosures: res.gaps };
    const out = { dataset, params: p, spread, assumptions: `${ASSUMPTIONS} One position at a time. Spread charged as spread/risk in R, only where you entered a spread.`, all: res.all, development: res.development, outOfSample: res.outOfSample, trades: res.trades.length };
    store.saveBacktest({ symbol: o.symbol, tf: o.tf, params: p, spread, from: o.from || null, to: o.to || null }, out, now());
    return out;
  }

  function performance(f = {}) {
    const rows = store.allSignals(f), toTrade = s => ({ status: s.status, r: s.r, netR: s.r });
    const group = key => Object.fromEntries([...new Set(rows.map(key))].map(k => { const g = E.summarize(rows.filter(s => key(s) === k).map(toTrade)); delete g.costAdjusted; return [k, g]; }));
    const all = E.summarize(rows.map(toTrade)); delete all.costAdjusted;
    return { overall: all, bySymbol: group(s => s.symbol), byTimeframe: group(s => s.tf), byStrategy: group(s => s.strategy), note: 'Gross results: no reliable spread data is stored for live signals. Open, expired and ambiguous signals are excluded from win rate.' };
  }
  return { snapshot, backtest, performance, params, cleanParams, load };
}
module.exports = { createService, cleanParams, INSTRUMENTS, ASSUMPTIONS };
