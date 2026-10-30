'use strict';
const E = require('./engine');
const INSTRUMENTS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'GBP/JPY', 'XAU/USD'];
const MAX_BARS = 48, HTF = { '15min': '1h', '1h': '4h', '4h': '1day' }; // higher timeframe used for the trend filter
const pipSize = s => (s.includes('JPY') ? 0.01 : s.startsWith('XAU') ? 0.1 : 0.0001); // price units per pip (XAU/USD: 1 pip = 0.10)
const LAB_ASSUMPTIONS = `Entry = signal candle close. Outcome from later completed candles of the same timeframe. Stop and target in one candle = ambiguous. Expires after ${MAX_BARS} bars. Spread and slippage are both charged as cost / risk in R, using the values you entered; gaps are not modelled. One position at a time. First 70% of time = development, last 30% = out-of-sample.`;
const ASSUMPTIONS = `Entry = signal candle close. Outcome from later completed candles of the same timeframe. Stop and target in one candle = ambiguous. Expires after ${MAX_BARS} bars. No spread, slippage or gaps modelled.`;
const fmt = (s, x) => Number(x).toFixed(s.includes('JPY') ? 3 : s.startsWith('XAU') ? 2 : 5);
const OUTCOME_TEXT = { target: r => `WIN +${r}R (target hit)`, stop: r => `LOSS ${r}R (stop hit)`, ambiguous: () => 'UNCLEAR (stop and target in the same candle)', expired: () => `EXPIRED (no result after ${MAX_BARS} candles)` };
const version = p => `v1|bull${p.rsiBull.join('-')}|bear${p.rsiBear.join('-')}|atr${p.atrStop}|rr${p.rr}`;

function cleanParams(i = {}) {
  const num = (x, lo, hi, n) => { x = Number(x); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`Invalid ${n}`); return x; };
  const rng = (a, n) => { if (!Array.isArray(a) || a.length !== 2) throw new Error(`Invalid ${n}`); const r = [num(a[0], 0, 100, n), num(a[1], 0, 100, n)]; if (r[0] >= r[1]) throw new Error(`Invalid ${n}`); return r; };
  const d = E.DEFAULTS;
  const p = { rsiBull: rng(i.rsiBull ?? d.rsiBull, 'rsiBull'), rsiBear: rng(i.rsiBear ?? d.rsiBear, 'rsiBear'), atrStop: num(i.atrStop ?? d.atrStop, 0.1, 10, 'atrStop'), rr: num(i.rr ?? d.rr, 0.1, 10, 'rr') };
  p.version = version(p); return p;
}

function createService({ store, fetchCandles, now = Date.now, ttlMs = 60000, minForceMs = 10000, maxCallsPerMin = 6, maxApprovals = 5, provider = 'twelvedata' }) {
  const cache = new Map(), lastTracked = {}, att = {}, calls = [];
  const ttlFor = tf => (ttlMs ? ({ '15min': 120000, '1h': 300000, '4h': 600000, '1day': 3600000 }[tf] || ttlMs) : 0); // slower timeframes need fewer refreshes
  const params = () => cleanParams(JSON.parse(store.getSetting('params') || '{}'));

  async function load(symbol, tf, size = 400, force = false) {
    const key = `${symbol}|${tf}|${size}`, hit = cache.get(key), t = now();
    if (hit && t - hit.at < (force ? minForceMs : ttlFor(tf))) return hit.data; // cached: avoids hitting the provider on every page load
    const fallback = () => (hit && t - hit.at < 2 * 3600000 ? { ...hit.data, fromCache: true, cacheAgeSec: Math.round((t - hit.at) / 1000) } : null); // older data, clearly labelled
    while (calls.length && t - calls[0] > 60000) calls.shift();
    if (calls.length >= maxCallsPerMin) { // pace ourselves below the provider's per-minute limit
      const f = fallback(); if (f) return f;
      const err = new Error('Rate limit reached (Pipwise is pacing its requests)'); err.kind = 'rate_limit'; throw err;
    }
    calls.push(t);
    try { const data = await fetchCandles({ symbol, tf, outputsize: size }); cache.set(key, { at: now(), data }); return data; }
    catch (e) {
      const kind = e.kind || 'provider';
      if (kind !== 'no_credentials') store.addAlert(`api:${kind}:${symbol}:${tf}:${Math.floor(now() / 3600000)}`, 'api_error', `${symbol} ${tf}: ${e.message}`, now());
      if (kind === 'rate_limit') { const f = fallback(); if (f) return f; }
      const err = new Error(e.message); err.kind = kind; throw err; // never falls back to fake prices
    }
  }

  function track(symbol, tf, closed) {
    const ms = E.TF_MIN[tf] * 60000; let limited = 0;
    if (closed.length) lastTracked[`${symbol}|${tf}`] = closed[closed.length - 1].t;
    for (const s of store.openSignals(symbol, tf)) {
      if (!closed.length || closed[0].t > s.candle_t + ms) { limited++; continue; } // history no longer covers this signal
      const future = closed.filter(k => k.t > s.candle_t);
      const r = E.resolve({ signal: s.dir, levels: { stop: s.stop, target: s.target, rr: s.rr } }, future, MAX_BARS);
      if (r.status === 'open') continue;
      store.tx(() => {
        if (store.resolveSignal(s.id, r.status, r.r, future[r.bars - 1].t, ASSUMPTIONS))
          store.addAlert(`out:${s.id}`, 'outcome', `${s.symbol} ${s.tf} ${s.dir}: ${OUTCOME_TEXT[r.status](r.r)}\nEntry ${fmt(s.symbol, s.entry)} · Stop ${fmt(s.symbol, s.stop)} · Target ${fmt(s.symbol, s.target)}`, now());
      });
    }
    return limited;
  }

  async function snapshot(symbol, tf, force = false) {
    const p = params(); let d;
    try { d = await load(symbol, tf, 400, force); }
    catch (e) { return { ok: false, error: { kind: e.kind, message: e.message }, strategy: p.version }; }
    const clean = E.sanitize(d.candles), cc = clean.candles, lastGood = cc.length ? cc[cc.length - 1].t : -1;
    if (!cc.length || clean.excluded.some(x => x.t > lastGood)) { // the newest candle itself is bad: do not trade on it
      store.addAlert(`invalid:${symbol}:${tf}:${Math.floor(now() / 3600000)}`, 'api_error', `${symbol} ${tf}: latest candle from provider failed validation`, now());
      return { ok: false, error: { kind: 'invalid_data', message: 'Latest candle from the provider failed validation' }, strategy: p.version };
    }
    const closed = E.closedOnly(cc, tf, now()), stale = E.isStale(closed, tf, now()), last = closed[closed.length - 1];
    if (stale) store.addAlert(`stale:${symbol}:${tf}:${last ? last.t : 0}`, 'stale_data', `${symbol} ${tf}: latest closed candle is stale`, now());
    const ind = E.indicators(closed), i = closed.length - 1;
    const sig = i >= 0 ? E.signalAt(ind, closed, i, p) : { signal: 'WAIT', rules: [], levels: null };
    const ms = E.TF_MIN[tf] * 60000, raw = cc[cc.length - 1];
    const live = raw && raw.t + ms > now() ? { price: raw.c, t: raw.t } : null, livePx = live ? live.price : last ? last.c : null; // live = price of the still-forming candle
    const entryCheck = sig.levels ? E.entryCheck(sig.signal, sig.levels, livePx, { barsOld: last ? Math.max(0, Math.floor((now() - (last.t + ms)) / ms)) : 0 }) : null;
    let recorded = null;
    if (!stale && sig.levels && !store.openSignals(symbol, tf).some(s => s.dir === sig.signal)) {
      recorded = store.addSignal({ symbol, tf, dir: sig.signal, strategy: p.version, params: p, candle_t: last.t, provider: d.source, ...sig.levels, indicators: { e20: ind.e20[i], e50: ind.e50[i], e200: ind.e200[i], rsi: ind.rsi[i], atr: ind.atr[i] }, created_at: now() });
      if (recorded) store.addAlert(`sig:${recorded}`, 'new_signal', `${symbol} ${tf}: new ${sig.signal} signal\nEntry ${fmt(symbol, sig.levels.entry)} · Stop ${fmt(symbol, sig.levels.stop)} · Target ${fmt(symbol, sig.levels.target)}\nReward:risk ${sig.levels.rr}:1 · Entry check: ${entryCheck ? entryCheck.state : 'n/a'}\nExperimental rules, not a prediction. Check the app before acting.`, now());
    }
    const trackingLimited = track(symbol, tf, closed), from = Math.max(0, closed.length - 120);
    return { ok: true, fromCache: !!d.fromCache, cacheAgeSec: d.cacheAgeSec || 0, excludedCandles: clean.excluded.length, live, livePrice: livePx, entryCheck, symbol, tf, source: d.source, fetchedAt: d.fetchedAt, latestCandleT: last ? last.t : null, latestClose: last ? last.c : null, stale, strategy: p.version, params: p,
      signal: sig.signal, rules: sig.rules, reason: sig.reason || null, levels: sig.levels, newSignalId: recorded, trackingLimited,
      indicators: i >= 0 ? { e20: ind.e20[i], e50: ind.e50[i], e200: ind.e200[i], rsi: ind.rsi[i], atr: ind.atr[i] } : null,
      chart: closed.slice(from).map((k, j) => ({ ...k, e20: ind.e20[from + j], e50: ind.e50[from + j], e200: ind.e200[from + j] })) };
  }

  async function backtest(o) {
    if (!INSTRUMENTS.includes(o.symbol) || !E.TF_MIN[o.tf]) throw new Error('Unsupported symbol or timeframe');
    const p = cleanParams(o.params), spread = Number(o.spread || 0);
    if (!(spread >= 0)) throw new Error('Invalid spread');
    const d = await load(o.symbol, o.tf, 5000), san = E.sanitize(d.candles), closed = E.closedOnly(san.candles, o.tf, now());
    if (closed.length < 400) throw new Error('Not enough history for a backtest (need 400+ closed candles)');
    const res = E.backtest(closed, o.tf, p, { spread, maxBars: MAX_BARS, from: o.from, to: o.to });
    const dataset = { provider: d.source, symbol: o.symbol, tf: o.tf, candles: closed.length, first: closed[0].t, last: closed[closed.length - 1].t, gapsOrClosures: res.gaps, excludedCandles: san.excluded.length, excludedSample: san.excluded.slice(0, 5).map(x => x.t) };
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
  // Checks every open signal on every pair/timeframe, at most once per candle close (a few retries if the provider lags).
  async function trackAll() {
    let n = 0;
    for (const { symbol, tf } of store.openPairs().slice(0, 8)) {
      const ms = E.TF_MIN[tf] * 60000, key = `${symbol}|${tf}`, expected = Math.floor((now() - 15000) / ms) * ms - ms;
      if (lastTracked[key] >= expected) continue;
      const a = att[key]; if (a && a.expected === expected && a.n >= 5) continue;
      att[key] = { expected, n: (a && a.expected === expected ? a.n : 0) + 1 };
      try { const d = await load(symbol, tf, 400); track(symbol, tf, E.closedOnly(E.sanitize(d.candles).candles, tf, now())); n++; } catch { /* alert already recorded by load() */ }
    }
    return n;
  }
  async function livePrice(symbol) {
    let best = null;
    for (const [k, c] of cache) if (k.startsWith(symbol + '|') && now() - c.at < 90000 && (!best || c.at > best.at)) best = c;
    try { const d = best ? best.data : await load(symbol, '15min', 3), k = d.candles[d.candles.length - 1]; return k ? k.c : null; } catch { return null; }
  }
  async function enrich(rows) {
    const px = {};
    for (const s of rows) { if (s.status !== 'open' || s.symbol in px) continue; px[s.symbol] = Object.keys(px).length >= 4 ? null : await livePrice(s.symbol); }
    return rows.map(s => {
      if (s.status !== 'open') return s;
      const ms = E.TF_MIN[s.tf] * 60000, barsOld = Math.max(0, Math.floor((now() - (s.candle_t + ms)) / ms));
      return { ...s, livePrice: px[s.symbol], check: E.entryCheck(s.dir, { entry: s.entry, stop: s.stop, target: s.target }, px[s.symbol], { barsOld }) };
    });
  }
  async function scan(symbol) {
    if (!INSTRUMENTS.includes(symbol)) throw new Error('Unsupported symbol');
    const out = [];
    for (const tf of Object.keys(E.TF_MIN)) {
      const d = await snapshot(symbol, tf), ms = E.TF_MIN[tf] * 60000;
      if (!d.ok) { out.push({ tf, ok: false, error: d.error }); continue; }
      const open = store.openSignals(symbol, tf).map(s => ({ id: s.id, dir: s.dir, entry: s.entry, stop: s.stop, target: s.target, signalT: s.candle_t + ms,
        check: E.entryCheck(s.dir, { entry: s.entry, stop: s.stop, target: s.target }, d.livePrice, { barsOld: Math.max(0, Math.floor((now() - (s.candle_t + ms)) / ms)) }) }));
      out.push({ tf, ok: true, signal: d.signal, levels: d.levels, entryCheck: d.entryCheck, stale: d.stale, signalT: d.latestCandleT + ms, livePrice: d.livePrice, open });
    }
    return out;
  }
  // ---- Filter Lab: same candles, same costs, each filter switched on separately and together ----
  const pick = m => ({ resolved: m.resolved, winRate: m.winRate, avgR: m.avgR, profitFactor: m.profitFactor, maxDrawdownR: m.maxDrawdownR, cumulativeR: m.cumulativeR });
  const pack = s => ({ signals: s.signals, open: s.open, ambiguous: s.ambiguous, expired: s.expired, gross: pick(s.gross), net: pick(s.costAdjusted) });
  function verdict(base, v) {
    const d = v.development.net, o = v.outOfSample.net; // the same after-cost numbers the Lab shows
    if (d.resolved < 30 || o.resolved < 30) return 'Too few trades to judge';
    const better = (a, b) => a.avgR > b.avgR, bd = better(d, base.development.net), bo = better(o, base.outOfSample.net);
    return bd && bo ? 'Better than plain rules in both periods' : !bd && !bo ? 'Not better than plain rules' : 'Mixed: better in only one period';
  }
  async function lab(o) {
    if (!INSTRUMENTS.includes(o.symbol) || !E.TF_MIN[o.tf]) throw new Error('Unsupported symbol or timeframe');
    const spread = Number(o.spread || 0); if (!(spread >= 0)) throw new Error('Invalid spread');
    const slipPips = Number(o.slippagePips ?? 0.5); if (!(slipPips >= 0 && slipPips <= 50)) throw new Error('Invalid slippage'); const slippage = slipPips * pipSize(o.symbol);
    const p = params(), d = await load(o.symbol, o.tf, 5000), san = E.sanitize(d.candles), closed = E.closedOnly(san.candles, o.tf, now());
    if (closed.length < 400) throw new Error('Not enough history (need 400+ closed candles)');
    const htfTf = HTF[o.tf]; let htfC = null;
    if (htfTf) { const h = await load(o.symbol, htfTf, 5000); htfC = E.closedOnly(E.sanitize(h.candles).candles, htfTf, now()); }
    const defs = [['base', 'Plain rules', {}], ['htf', 'Higher-timeframe trend agrees', { htf: true }], ['adx', 'Trend strength (ADX 20+)', { adx: 20 }], ['sr', 'Room to move: no support/resistance within 1.5R', { sr: 1.5 }]];
    const results = [];
    for (const [id, name, cfg] of defs) {
      if (cfg.htf && !htfTf) { results.push({ id, name, unavailable: 'Needs a higher timeframe, and none is available above 4h' }); continue; }
      const r = E.backtest(closed, o.tf, p, { spread, slippage, maxBars: MAX_BARS, accept: E.buildAccept(closed, o.tf, cfg, htfC, htfTf) });
      results.push({ id, name, all: pack(r.all), development: pack(r.development), outOfSample: pack(r.outOfSample) });
    }
    const base = results[0]; results.forEach(r => { if (!r.unavailable) r.verdict = r.id === 'base' ? 'Baseline' : verdict(base, r); });
    const out = { dataset: { provider: d.source, symbol: o.symbol, tf: o.tf, candles: closed.length, first: closed[0].t, last: closed[closed.length - 1].t, excludedCandles: san.excluded.length, higherTimeframe: htfTf || null },
      strategy: p.version, spread, slippagePips: slipPips, slippage: Number(slippage.toPrecision(6)), assumptions: LAB_ASSUMPTIONS, results };
    store.saveBacktest({ lab: true, symbol: o.symbol, tf: o.tf, spread, slippagePips: slipPips }, out, now()); return out;
  }
  // ---- Signal Audit: track any outside provider's signals against real prices ----
  let lastAudit = 0; const M15 = 900000;
  function auditAdd(o) {
    const src = String(o.source || '').trim(), n = x => Number(x);
    if (!src || src.length > 40) throw new Error('Source name is required (max 40 characters)');
    if (!INSTRUMENTS.includes(o.symbol)) throw new Error('Unsupported pair');
    if (!['BUY', 'SELL'].includes(o.dir)) throw new Error('Direction must be BUY or SELL');
    const a = { source: src, symbol: o.symbol, dir: o.dir, entry: n(o.entry), stop: n(o.stop), target: n(o.target), signal_t: n(o.signal_t), created_at: now() };
    if (![a.entry, a.stop, a.target, a.signal_t].every(Number.isFinite) || a.entry <= 0 || a.stop <= 0 || a.target <= 0) throw new Error('Enter valid numbers');
    const ok = a.dir === 'BUY' ? a.stop < a.entry && a.entry < a.target : a.target < a.entry && a.entry < a.stop;
    if (!ok) throw new Error(a.dir === 'BUY' ? 'For a BUY: stop < entry < target' : 'For a SELL: target < entry < stop');
    if (a.signal_t > now() + 60000) throw new Error('Signal time cannot be in the future');
    if (a.signal_t < now() - 14 * 86400000) throw new Error('Signals older than 14 days cannot be checked (not enough price history)');
    return store.addAudit(a);
  }
  async function auditTrack(force = false) {
    if (!force && now() - lastAudit < 900000) return 0; lastAudit = now(); let n = 0;
    const open = store.openAudit();
    for (const symbol of [...new Set(open.map(a => a.symbol))].slice(0, 5)) {
      let closed; try { closed = E.closedOnly(E.sanitize((await load(symbol, '15min', 2000)).candles).candles, '15min', now()); } catch { continue; }
      if (!closed.length) continue;
      for (const a of open.filter(x => x.symbol === symbol)) {
        if (a.signal_t < closed[0].t) { store.resolveAudit(a.id, 'untrackable', null, now()); n++; continue; }
        const k = closed.find(x => x.t <= a.signal_t && a.signal_t < x.t + M15);
        if (!k) { if (a.signal_t >= closed[closed.length - 1].t + M15) continue; store.resolveAudit(a.id, 'unverified', null, now()); n++; continue; } // market closed at that time
        const tol = k.h - k.l; // the stated entry must be near the price at that moment, else we cannot verify it
        if (a.entry < k.l - tol || a.entry > k.h + tol) { store.resolveAudit(a.id, 'unverified', null, now()); n++; continue; }
        const rr = (Math.abs(a.target - a.entry)) / Math.abs(a.entry - a.stop), fut = closed.filter(x => x.t >= k.t + M15);
        const r = E.resolve({ signal: a.dir, levels: { stop: a.stop, target: a.target, rr } }, fut, 480);
        if (r.status !== 'open') { store.resolveAudit(a.id, r.status, r.r == null ? null : Math.round(r.r * 100) / 100, fut[r.bars - 1].t); n++; }
      }
    }
    return n;
  }
  function auditOverview() {
    const by = {}; for (const r of store.listAudit()) (by[r.source] = by[r.source] || []).push(r);
    return Object.entries(by).map(([source, list]) => {
      const cnt = st => list.filter(s => s.status === st).length, from = Math.min(...list.map(s => s.signal_t)), to = Math.max(...list.map(s => s.signal_t));
      const mm = E.summarize(store.allSignals({ from, to }).map(s => ({ status: s.status, r: s.r, netR: s.r })));
      return { source, signals: list.length, open: cnt('open'), ambiguous: cnt('ambiguous'), expired: cnt('expired'), unverified: cnt('unverified') + cnt('untrackable'),
        metrics: E.metrics(list.filter(s => s.r != null).map(s => s.r)), pipwise: { signals: mm.signals, metrics: mm.gross, from, to }, list };
    });
  }
  // Runs one queued experiment: the strategy with the requested filters, and the plain rules on identical data for comparison.
  async function experimentRun(x) {
    const p = cleanParams(x.strategyParams), slipPips = Number(x.slippagePips ?? 0.5), slippage = slipPips * pipSize(x.symbol), spread = Number(x.spread || 0), has = Object.keys(x.filters || {}).length > 0;
    const d = await load(x.symbol, x.tf, 5000), san = E.sanitize(d.candles), closed = E.closedOnly(san.candles, x.tf, now());
    if (closed.length < 400) throw new Error('Not enough history (need 400+ closed candles)');
    let htfC = null; const htfTf = x.filters && x.filters.htf ? HTF[x.tf] : null; if (htfTf) htfC = E.closedOnly(E.sanitize((await load(x.symbol, htfTf, 5000)).candles).candles, htfTf, now());
    const run = cfg => E.backtest(closed, x.tf, p, { spread, slippage, maxBars: MAX_BARS, accept: E.buildAccept(closed, x.tf, cfg, htfC, htfTf) });
    const base = run({}), variant = has ? run(x.filters) : base, sum = r => ({ all: pack(r.all), development: pack(r.development), outOfSample: pack(r.outOfSample) });
    return { dataset: { provider: d.source, symbol: x.symbol, tf: x.tf, candles: closed.length, first: closed[0].t, last: closed[closed.length - 1].t, excludedCandles: san.excluded.length, higherTimeframe: htfTf, fromCache: !!d.fromCache },
      strategy: p.version, filters: x.filters || {}, spread, slippagePips: slipPips, slippage: Number(slippage.toPrecision(6)), assumptions: LAB_ASSUMPTIONS, baseline: sum(base), variant: sum(variant) };
  }
  // Runs one library strategy version on real candles: the shared backtester, the shared costs, plus a check of how steady the result is over time.
  const TYPICAL_SPREAD = { 'EUR/USD': 0.00008, 'GBP/USD': 0.0001, 'USD/JPY': 0.008, 'GBP/JPY': 0.02, 'XAU/USD': 0.3 }; // rough typical values, labelled as assumptions in every result
  async function strategyRun(x) {
    const S = require('./strategies'), def = S.find(x.strategy_id), ver = def && def.versions.find(v => v.label === x.version); if (!ver) throw new Error('Unknown strategy version');
    const slipPips = Number(x.slippagePips ?? 0.5), slippage = slipPips * pipSize(x.symbol), spread = Number(x.spread || 0);
    const d = await load(x.symbol, x.tf, 5000), san = E.sanitize(d.candles), closed = E.closedOnly(san.candles, x.tf, now()); if (closed.length < 400) throw new Error('Not enough history (need 400+ closed candles)');
    const res = S.backtestStrategy(closed, x.tf, def, ver.params, { spread, slippage, maxBars: MAX_BARS });
    return { dataset: { provider: d.source, symbol: x.symbol, tf: x.tf, candles: closed.length, first: closed[0].t, last: closed[closed.length - 1].t, excludedCandles: san.excluded.length, fromCache: !!d.fromCache },
      strategy: `${x.strategy_id}/${x.version}`, spread, slippagePips: slipPips, slippage: Number(slippage.toPrecision(6)), assumptions: LAB_ASSUMPTIONS + ' Every library strategy uses the same 1.5 x ATR stop and 2R target.',
      result: { all: pack(res.all), development: pack(res.development), outOfSample: pack(res.outOfSample) }, segments: S.segments(res.trades, closed), selectionSegments: S.segments(res.trades, closed, 4, res.split3.cutFinal),
      split3: { cutValidation: res.split3.cutValidation, cutFinal: res.split3.cutFinal, frozenAt: closed[closed.length - 1].t, selection: pack(res.split3.selection), development: pack(res.split3.development), validation: pack(res.split3.validation), final: pack(res.split3.final) } };
  }
  // ---- Approved strategies: only combinations YOU approved create live signals ----
  const lastSignalCheck = {}, sigAtt = {};
  function approveSetup(o = {}) {
    const S = require('./strategies'), def = S.find(o.strategy_id), ver = def && def.versions.find(x => x.label === o.version);
    if (!def || !ver) throw new Error('Unknown library strategy');
    if (!INSTRUMENTS.includes(o.symbol) || !E.TF_MIN[o.tf]) throw new Error('Unsupported pair or timeframe');
    if (!store.passedExperiment(def.id, ver.label, o.symbol, o.tf)) throw new Error('This combination has not passed the research tests, so it cannot be approved');
    const max = Number(maxApprovals); if (store.listApprovals().filter(a => a.status === 'active').length >= max) throw new Error(`You can have at most ${max} approved combinations sending signals. Stop one first.`);
    const id = store.approve({ strategy_id: def.id, strategy_version: ver.label, symbol: o.symbol, tf: o.tf }, now());
    if (id) return { id };
    const ex = store.listApprovals().find(a => a.strategy_id === def.id && a.strategy_version === ver.label && a.symbol === o.symbol && a.tf === o.tf);
    if (ex.status === 'active') throw new Error('Already approved'); store.setApproval(ex.id, 'active'); return { id: ex.id, resumed: true };
  }
  function setApproval(id, status) {
    const a = store.listApprovals().find(x => x.id === Number(id)); if (!a) throw new Error('Not found');
    if (status === 'active' && a.status !== 'active' && store.listApprovals().filter(x => x.status === 'active').length >= Number(maxApprovals)) throw new Error(`You can have at most ${maxApprovals} approved combinations sending signals. Stop one first.`);
    store.setApproval(a.id, status); return { id: a.id, status };
  }
  // Once per closed candle for each approved pair and timeframe: ask each approved strategy for a signal on the newest CLOSED candle.
  async function scanApproved() {
    const S = require('./strategies'), setups = store.listApprovals().filter(a => a.status === 'active'); let checked = 0, recorded = 0;
    for (const key of [...new Set(setups.map(a => `${a.symbol}|${a.tf}`))]) {
      const [symbol, tf] = key.split('|'), ms = E.TF_MIN[tf] * 60000, expected = Math.floor((now() - 15000) / ms) * ms - ms;
      if (lastSignalCheck[key] >= expected) continue; const at = sigAtt[key]; if (at && at.expected === expected && at.n >= 5) continue;
      sigAtt[key] = { expected, n: (at && at.expected === expected ? at.n : 0) + 1 };
      let d; try { d = await load(symbol, tf, 400); } catch { continue; } // a data failure never becomes a signal
      const clean = E.sanitize(d.candles), cc = clean.candles, lastGood = cc.length ? cc[cc.length - 1].t : -1;
      if (!cc.length || clean.excluded.some(x => x.t > lastGood)) continue;
      const closed = E.closedOnly(cc, tf, now()); if (!closed.length || E.isStale(closed, tf, now())) continue;
      const i = closed.length - 1, last = closed[i]; if (last.t < expected) continue; // provider is behind: try again shortly
      lastSignalCheck[key] = expected; checked++;
      const x = S.prep(closed), atr = x.ind.atr[i], raw = cc[cc.length - 1], livePx = raw.t + ms > now() ? raw.c : last.c;
      for (const a of setups.filter(s => s.symbol === symbol && s.tf === tf)) {
        const def = S.find(a.strategy_id), ver = def && def.versions.find(q => q.label === a.strategy_version); if (!ver || atr == null) continue;
        const dir = def.signal(x, i, ver.params); if (!dir) continue; const lv = E.levels(dir, last.c, atr, S.RISK); if (!lv) continue;
        const label = `${def.name} (${ver.label})`; if (store.openSignals(symbol, tf).some(s => s.dir === dir && (s.strategy === label || (def.id === 'ema-rsi-trend' && /^v1\|/.test(s.strategy))))) continue; // the original strategy's own signals count as the same idea: no double trade
        const id = store.addSignal({ symbol, tf, dir, strategy: label, params: { strategy_id: def.id, version: ver.label, params: ver.params, approved: a.id }, candle_t: last.t, provider: d.source, ...lv, indicators: { atr }, created_at: now() });
        if (id) { recorded++; const ec = E.entryCheck(dir, lv, livePx, { barsOld: 0 });
          store.addAlert(`sig:${id}`, 'new_signal', `${symbol} ${tf}: new ${dir} signal\nStrategy: ${def.name} (${ver.label}), approved by you\nEntry ${fmt(symbol, lv.entry)} · Stop ${fmt(symbol, lv.stop)} · Target ${fmt(symbol, lv.target)}\nReward:risk ${lv.rr}:1 · Entry check: ${ec.state}\nTested on past data only, not a prediction. Check the app before acting.`, now()); }
      }
      track(symbol, tf, closed);
    }
    return { checked, recorded };
  }
  const callsInLastMinute = () => { const t = now(); while (calls.length && t - calls[0] > 60000) calls.shift(); return calls.length; };
  const resetTracking = () => { for (const k of Object.keys(lastTracked)) delete lastTracked[k]; for (const k of Object.keys(att)) delete att[k]; }; // forces the next check to look at every open trade again
  return { approveSetup, setApproval, scanApproved, strategyRun, typicalSpread: s => TYPICAL_SPREAD[s] ?? 0, experimentRun, callsInLastMinute, resetTracking, lab, auditAdd, auditTrack, auditOverview, auditDelete: id => store.deleteAudit(Number(id)), trackAll, livePrice, enrich, scan, snapshot, backtest, performance, params, cleanParams, load };
}
module.exports = { createService, cleanParams, INSTRUMENTS, ASSUMPTIONS };
