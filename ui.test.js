// Screen regression test: loads the real index.html script in a stand-in browser and drives every page against the real server code.
const test = require('node:test'), assert = require('node:assert/strict'), http = require('http'), vm = require('vm'), fs = require('fs'), path = require('path');
const Store = require('../store'), { createService } = require('../service'), { createApp } = require('../server'), X = require('../experiments'), M = require('../market');
const MS = 900000, N = 1500, base = Math.floor(Date.now() / MS) * MS - N * MS, candles = []; { let p = 100; for (let i = 0; i < N; i++) { const o = p; p += i % 2 ? 1.2 : -1; candles.push({ t: base + i * MS, o, h: Math.max(o, p) + 0.3, l: Math.min(o, p) - 0.3, c: p }); } }
const src = /<script>([\s\S]*)<\/script>/.exec(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'))[1];
async function boot(o = {}) {
  const store = Store.open(); X.register(store); const svc = createService({ market: M.alwaysOpen, store, fetchCandles: async () => ({ source: 'twelvedata', fetchedAt: Date.now(), candles }), minForceMs: 0, maxCallsPerMin: o.maxCalls || 1000 });
  const runner = X.createRunner({ store, service: svc, dailyLimit: 100, callBudget: 100, minDbAgeMs: 0 }), srv = http.createServer(createApp({ service: svc, store, runner, config: { password: '', tz: 'Africa/Lagos', hasKey: true, telegram: { token: false, chat: false } } }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const st = { base: `http://127.0.0.1:${srv.address().port}`, patch: null }, els = {}, mkEl = () => ({ value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, dataset: {}, classList: { toggle() {} }, onclick: null, onchange: null });
  const ctx = { document: { querySelector: s => els[s] || (els[s] = mkEl()), querySelectorAll: () => [], hidden: false }, window: { addEventListener() {}, scrollTo() {} }, location: { hash: '#home' }, localStorage: { getItem: () => JSON.stringify({ sym: 'EUR/USD', tf: '15min' }), setItem() {} },
    fetch: async (p, op) => { const r = await fetch(st.base + p, op); if (st.patch && p.startsWith('/api/snapshot')) { const j = await r.json(); return { ok: true, json: async () => st.patch(j) }; } return r; }, setInterval() {}, setTimeout, console, Intl, Date, Math, JSON, Promise, URLSearchParams, Set, Object, Number, String, Array };
  vm.createContext(ctx); vm.runInContext(src, ctx); for (let i = 0; i < 60 && !vm.runInContext('typeof CFG!=="undefined"&&!!CFG', ctx); i++) await new Promise(r => setTimeout(r, 50));
  const run = c => vm.runInContext(c, ctx), view = () => els['#view'].innerHTML, el = s => ctx.document.querySelector(s);
  const go = async h => { ctx.location.hash = h; await run('route()'); assert.ok(!/card err/.test(view()) && view().length > 50, `${h}: ${view().slice(0, 200)}`); return view(); };
  return { store, svc, runner, st, els, el, run, view, go, close: () => srv.close() };
}
// Every test closes its server even when an assertion fails, so a failure can never hang the run.
const withUi = (o, fn) => async () => { const u = await boot(o); try { await fn(u); } finally { u.close(); } };
test('Home, all-timeframes panel, trades pages', withUi({}, async u => {
  await u.go('#home'); await u.run('loadHome(false)'); await u.run('loadScan()');
  assert.match(u.els['#sig'].innerHTML, /BUY|SELL|WAIT/); assert.match(u.els['#sig'].innerHTML, /original rules/); assert.match(u.els['#cht'].innerHTML, /<svg/); assert.match(u.els['#stat'].innerHTML, /FRESH|STALE|CACHED/); assert.match(u.els['#scan'].innerHTML, /15min/);
  for (const h of ['#trades/open', '#trades/closed', '#trades/all']) await u.go(h);
}));
test('a closed market is shown as MARKET CLOSED with the reopen time', withUi({}, async u => {
  u.st.patch = j => ({ ...j, market: { open: false, nextOpen: Date.UTC(2026, 10, 8, 22) }, entryCheck: { state: 'CLOSED', text: 'The market is closed. This cannot be entered until it reopens.' } });
  await u.go('#home'); await u.run('loadHome(false)'); assert.match(u.els['#stat'].innerHTML, /MARKET CLOSED/); assert.match(u.els['#stat'].innerHTML, /(23:00|11:00\s?PM)/); assert.match(u.els['#sig'].innerHTML, /CLOSED/);
}));
test('Lab: four cards, slippage note, run all pairs', withUi({}, async u => {
  await u.go('#lab'); u.el('#sp').value = '0.1'; u.el('#sl').value = '0.5'; await u.els['#go'].onclick(); const o = u.els['#out'].innerHTML;
  assert.ok(/Plain rules/.test(o) && /ADX/.test(o) && /Room to move/.test(o) && !/London|Pullback|All filters/.test(o) && /slippage 0\.5 pips/.test(o), o.slice(0, 300));
  u.run('PAIR_WAIT=10'); await u.els['#all'].onclick(); const a = u.els['#out'].innerHTML; assert.ok(/EUR\/USD/.test(a) && /GBP\/USD/.test(a) && /USD\/JPY/.test(a) && !/Rate limit/.test(a) && (a.match(/Plain rules/g) || []).length === 3);
}));
test('Lab: a rate limit is reported clearly and the run stops', withUi({ maxCalls: 2 }, async u => {
  await u.go('#lab'); u.run('PAIR_WAIT=10'); await u.els['#all'].onclick(); assert.match(u.els['#out'].innerHTML, /Rate limit reached/); assert.match(u.els['#out'].innerHTML, /Wait about a minute/);
}));
test('Audit: add a signal and see it compared with Pipwise; More pages', withUi({}, async u => {
  await u.go('#audit'); const k = candles[candles.length - 3], when = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Lagos', dateStyle: 'short', timeStyle: 'short' }).format(new Date(k.t + 60000)).replace(' ', 'T');
  Object.entries({ '#au-src': 'Channel A', '#au-sym': 'EUR/USD', '#au-dir': 'BUY', '#au-en': String(k.c), '#au-st': String(k.c - 50), '#au-tp': String(k.c + 50), '#au-t': when }).forEach(([s, v]) => { u.el(s).value = v; });
  await u.els['#au-add'].onclick(); assert.equal(u.els['#au-msg'].textContent, ''); await u.go('#audit'); assert.match(u.view(), /Channel A/); assert.match(u.view(), /Pipwise, same period/);
  await u.go('#more/performance'); await u.go('#more/alerts'); await u.go('#more/settings'); assert.match(u.view(), /Storage and backup/);
}));
test('Research: sweep, progress, passed strategies, approval, own strategy, and approved strategies next to the original on Home', withUi({}, async u => {
  await u.go('#more/research'); await u.els['#sw'].onclick(); assert.match(u.els['#sw-msg'].textContent, /Queued 150 tests/); assert.equal((await u.runner.runBatch(6)).length, 6); await u.go('#more/research');
  for (const t of [/tests finished/, /Strategies that passed/, /Latest tests/, /Progress by pair and timeframe/, /Add your own strategy/]) assert.match(u.view(), t);
  u.store.addExperiment({ objective: 'x', strategy_id: 'bollinger-reversion', strategy_version: 'k2', symbol: 'EUR/USD', tf: '15min', params: { mode: 'library', crit: 2 }, dedupe_key: 'ui-pass', priority: 1, status: 'queued', now: 1 }); const e = u.store.claimExperiment(Date.now() + 1e7);
  u.store.finishExperiment(e.id, { status: 'awaiting_validation', result: { result: { all: { net: { resolved: 150, avgR: 0.2 } }, outOfSample: { net: { avgR: 0.1 } } }, segments: [], split3: { final: { net: { resolved: 20, avgR: 0.1 } } }, judgement: { reasons: ['passes_single_pair_tests'], criteria: { minTrades: 1 } } }, now: Date.now() });
  await u.go('#more/research'); assert.match(u.view(), /Approve for signals/); let refused = ''; try { await u.run("post('/api/approvals',{strategy_id:'donchian-breakout',version:'n55',symbol:'XAU/USD',tf:'4h'})"); } catch (x) { refused = x.message; } assert.match(refused, /has not passed/);
  assert.ok((await u.run("post('/api/approvals',{strategy_id:'bollinger-reversion',version:'k2',symbol:'EUR/USD',tf:'15min'})")).id > 0); await u.go('#more/research'); assert.match(u.view(), /sending signals/);
  u.el('#ns-json').value = u.run('NS_EXAMPLE'); await u.els['#ns-go'].onclick(); assert.match(u.els['#ns-msg'].textContent, /Added "my-ema-dip".*EMA 50 > EMA 200 AND RSI 14 < 40/); u.el('#ns-json').value = '{ not json'; await u.els['#ns-go'].onclick(); assert.match(u.els['#ns-msg'].textContent, /not valid JSON/);
  await u.go('#home'); await u.run('loadHome(false)'); assert.match(u.els['#oth'].innerHTML, /Approved strategies on EUR\/USD 15min/); assert.match(u.els['#oth'].innerHTML, /never merged/); assert.match(u.els['#oth'].innerHTML, /Why this result\?/); await u.run('loadScan()'); assert.match(u.els['#scan'].innerHTML, /Bollinger band reversion/);
}));
