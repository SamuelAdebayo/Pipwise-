'use strict';
// Research queue: validates test requests, runs them one at a time with the existing backtester, and records every outcome.
const { INSTRUMENTS } = require('./service'), E = require('./engine'), S = require('./strategies');
const FILTERS = { htf: 'bool', session: 'bool', adx: [10, 50], sr: [0.5, 5], pullback: [1, 20, true] }; // only filters the engine really supports
const MIN_TRADES = 30, RETRYABLE = new Set(['rate_limit', 'timeout', 'network', 'provider']);

function cleanFilters(f = {}) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('filters must be an object');
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    const rule = FILTERS[k]; if (!rule) throw new Error(`Unknown filter "${k}". Allowed: ${Object.keys(FILTERS).join(', ')}`);
    if (rule === 'bool') { if (v === true) out[k] = true; else if (v !== false && v != null) throw new Error(`Filter ${k} must be true or false`); }
    else if (v !== false && v != null && v !== '') { const n = Number(v); if (!Number.isFinite(n) || n < rule[0] || n > rule[1] || (rule[2] && !Number.isInteger(n))) throw new Error(`Filter ${k} must be a ${rule[2] ? 'whole ' : ''}number from ${rule[0]} to ${rule[1]}`); out[k] = n; }
  }
  return Object.fromEntries(Object.entries(out).sort());
}
// Fixed acceptance rules, written down before any result is seen. "Better" means higher average R after costs, in BOTH periods.
function judge(base, variant, hasFilters) {
  const criteria = { minTradesPerPeriod: MIN_TRADES, rule: 'Must beat the plain rules on average R after costs in BOTH the development and the out-of-sample period, with at least 30 finished trades in each.' };
  if (!hasFilters) return { decision: 'completed', reasons: ['baseline_measurement'], criteria };
  const d = variant.development.net, o = variant.outOfSample.net;
  if (d.resolved < MIN_TRADES || o.resolved < MIN_TRADES) return { decision: 'rejected', reasons: ['too_few_trades'], criteria };
  const a = d.avgR > (base.development.net.avgR ?? -Infinity), b = o.avgR > (base.outOfSample.net.avgR ?? -Infinity);
  if (a && b) return { decision: 'awaiting_validation', reasons: ['better_in_both_periods', 'needs_walk_forward_and_paper_trading'], criteria };
  return { decision: 'rejected', reasons: [a || b ? 'better_in_only_one_period' : 'not_better_than_baseline'], criteria };
}

// Fixed pass rules for library strategies, written before any result is seen. A pass is still only "needs more validation".
const STRATEGY_CRITERIA = { minTrades: 100, minOutOfSampleTrades: 30, minAvgR: 0.05, minProfitFactor: 1.1, minPositiveSegments: 3, segments: 4 };
function judgeStrategy(res, segs) {
  const c = STRATEGY_CRITERIA, a = res.all.net, o = res.outOfSample.net, fails = [];
  if (a.resolved < c.minTrades) fails.push('too_few_trades');
  if (o.resolved < c.minOutOfSampleTrades) fails.push('too_few_out_of_sample_trades');
  if (!(a.avgR >= c.minAvgR)) fails.push('average_not_above_costs');
  if (!((a.profitFactor ?? Infinity) >= c.minProfitFactor)) fails.push('profit_factor_low');
  if (!(o.avgR > 0)) fails.push('out_of_sample_not_positive');
  if (segs.filter(s => s.avgR > 0).length < c.minPositiveSegments) fails.push('not_stable_across_periods');
  return fails.length ? { decision: 'rejected', reasons: fails, criteria: c } : { decision: 'awaiting_validation', reasons: ['passes_single_pair_tests', 'needs_other_pairs_and_paper_trading'], criteria: c };
}
// Version 2 rules: decided ONLY on the development (first 50%) and validation (next 25%) periods. The final 25% is recorded but never used to decide.
const CRITERIA_V2 = { version: 2, minSelectionTrades: 80, minValidationTrades: 25, minAvgR: 0.05, minProfitFactor: 1.1, minPositiveSlices: 3, slices: 4, split: 'development 50% / validation 25% / final 25% (final never used to decide)' };
function judgeStrategyV2(r, segs) {
  const c = CRITERIA_V2, d = r.split3.development.net, v = r.split3.validation.net, sel = r.split3.selection.net, fin = r.split3.final.net, fails = [];
  if (sel.resolved < c.minSelectionTrades) fails.push('too_few_trades');
  if (v.resolved < c.minValidationTrades) fails.push('too_few_validation_trades');
  if (!(sel.avgR >= c.minAvgR)) fails.push('average_not_above_costs');
  if (!((sel.profitFactor ?? Infinity) >= c.minProfitFactor)) fails.push('profit_factor_low');
  if (!(d.avgR > 0)) fails.push('development_not_positive');
  if (!(v.avgR > 0)) fails.push('validation_not_positive');
  if (segs.filter(s => s.avgR > 0).length < c.minPositiveSlices) fails.push('not_stable_across_periods');
  const final = { resolved: fin.resolved, avgR: fin.avgR, usedToDecide: false };
  return fails.length ? { decision: 'rejected', reasons: fails, criteria: c, final } : { decision: 'awaiting_validation', reasons: ['passes_single_pair_tests', 'needs_other_pairs_and_paper_trading'], criteria: c, final };
}
// Strategy versions that passed on at least one pair. Passing on several different pairs is the main protection against luck.
function candidates(store) {
  const g = {}; let tested = 0, legacyPassed = 0; const finalCheck = { positive: 0, total: 0 };
  for (const e of store.listExperiments(500)) {
    let p; try { p = JSON.parse(e.params); } catch { continue; } if (!p || p.mode !== 'library' || !['awaiting_validation', 'rejected'].includes(e.status)) continue;
    if (p.crit !== 2) { if (e.status === 'awaiting_validation') legacyPassed++; continue; } // judged under the older, looser rules: kept on record, no longer counted
    tested++;
    const k = `${e.strategy_id}|${e.strategy_version}|${e.tf}`, row = g[k] || (g[k] = { strategy_id: e.strategy_id, version: e.strategy_version, tf: e.tf, tested: 0, passed: [] }); row.tested++;
    if (e.status === 'awaiting_validation') { let r = null; try { r = JSON.parse(e.result); } catch { /* keep going */ } const f = r && r.split3 && r.split3.final.net; row.passed.push({ symbol: e.symbol, trades: r && r.result.all.net.resolved, avgR: r && r.result.all.net.avgR, oosAvgR: r && r.result.outOfSample.net.avgR, finalAvgR: f ? f.avgR : null, finalTrades: f ? f.resolved : null }); if (f && f.resolved > 0) { finalCheck.total++; if (f.avgR > 0) finalCheck.positive++; } }
  }
  const list = Object.values(g).filter(r => r.passed.length).map(r => ({ ...r, name: (S.find(r.strategy_id) || {}).name || r.strategy_id, promising: r.passed.length >= 2 })).sort((a, b) => b.passed.length - a.passed.length || (b.passed[0].oosAvgR ?? 0) - (a.passed[0].oosAvgR ?? 0));
  return { tested, legacyPassed, finalCheck, candidates: list };
}
function register(store) { for (const d of S.STRATEGIES) for (const v of d.versions) store.registerStrategy(d, v); } // idempotent

function createRunner({ store, service, now = Date.now, maxRetries = 3, dailyLimit = 10, backoffMs = 300000, callBudget = 3 }) {
  return {
    enqueue(spec = {}) {
      if (!INSTRUMENTS.includes(spec.symbol) || !E.TF_MIN[spec.tf]) throw new Error('Unsupported pair or timeframe');
      const sid = spec.strategy_id || 'ema-rsi-trend', sv = spec.strategy_version || 'v1';
      if (!store.hasStrategyVersion(sid, sv)) throw new Error('Unknown strategy or version');
      const filters = cleanFilters(spec.filters), spread = Number(spec.spread ?? 0), slip = Number(spec.slippagePips ?? 0.5), priority = Number(spec.priority ?? 5);
      if (!(spread >= 0)) throw new Error('Invalid spread'); if (!(slip >= 0 && slip <= 50)) throw new Error('Invalid slippage'); if (!Number.isInteger(priority) || priority < 1 || priority > 9) throw new Error('Priority must be a whole number from 1 to 9');
      const { rsiBull, rsiBear, atrStop, rr } = service.params(), strategy = { rsiBull, rsiBear, atrStop, rr }; // pinned now, so a later settings change cannot alter this test
      const names = Object.entries(filters).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(', ') || 'no filters (plain rules)';
      const objective = String(spec.objective || '').trim().slice(0, 200) || `Test ${sid} ${sv} on ${spec.symbol} ${spec.tf} with ${names}`;
      const key = ['exp1', sid, sv, spec.symbol, spec.tf, JSON.stringify(filters), spread, slip, JSON.stringify(strategy)].join('|');
      const id = store.addExperiment({ kind: 'manual', objective, hypothesis: spec.hypothesis ? String(spec.hypothesis).slice(0, 500) : null, origin: 'user', strategy_id: sid, strategy_version: sv, symbol: spec.symbol, tf: spec.tf,
        params: { filters, spread, slippagePips: slip, strategy }, settings: { maxBars: 48, split: '70/30', costs: 'spread + slippage charged as cost/risk in R' }, priority, dedupe_key: key, status: 'queued', now: now() });
      return id ? { id, status: 'queued' } : { id: null, duplicate: true, message: 'This exact test is already recorded.' };
    },
    recover: () => store.recoverInterrupted(now(), maxRetries), // anything still "running" after a restart was interrupted
    // Queues every library strategy version on every pair and timeframe, grouped by pair and timeframe so consecutive tests share the same downloaded candles.
    planSweep(o = {}) {
      const symbols = o.symbols || INSTRUMENTS, tfs = o.tfs || Object.keys(E.TF_MIN);
      if (!Array.isArray(symbols) || symbols.some(s => !INSTRUMENTS.includes(s)) || !Array.isArray(tfs) || tfs.some(t => !E.TF_MIN[t])) throw new Error('Unsupported pair or timeframe');
      const round = new Date(now()).toISOString().slice(0, 7); let queued = 0, existing = 0;
      for (const symbol of symbols) for (const tf of tfs) for (const def of S.STRATEGIES) for (const ver of def.versions) {
        const spread = service.typicalSpread(symbol), slip = 0.5;
        const id = store.addExperiment({ kind: 'discovery', objective: `${def.name} (${ver.label}) on ${symbol} ${tf}`, hypothesis: def.description, origin: 'library', strategy_id: def.id, strategy_version: ver.label, symbol, tf,
          params: { mode: 'library', crit: 2, round, spread, slippagePips: slip, strategy: ver.params }, settings: { maxBars: 48, split: '70/30', segments: 4, costs: 'typical spread + 0.5 pip slippage, charged as cost/risk in R' }, priority: 6,
          dedupe_key: ['sweep', round, 'v2', def.id, ver.label, symbol, tf, spread, slip].join('|'), status: 'queued', now: now() });
        id ? queued++ : existing++;
      }
      store.setSetting('last_sweep', `${round}|v2`); return { queued, existing, round };
    },
    autoPlan() { // once a month, when nothing is waiting, plan a fresh sweep on newer data
      const round = new Date(now()).toISOString().slice(0, 7), c = store.experimentCounts ? store.experimentCounts() : {};
      if (store.getSetting('last_sweep') === `${round}|v2` || (c.queued || 0) + (c.running || 0) > 0) return null; return this.planSweep();
    },
    async runBatch(max = 5) { const out = []; for (let i = 0; i < max; i++) { const r = await this.runNext(); if (!r || r.skipped) break; out.push(r); if (r.failed) break; } return out; },
    async runNext() {
      const t = now();
      if (store.finishedSince(t - 86400000) >= dailyLimit) return { skipped: 'daily_limit' };
      if (service.callsInLastMinute() > callBudget) return { skipped: 'api_busy' }; // leave headroom for live signal checks
      const exp = store.claimExperiment(t); if (!exp) return null;
      try {
        const p = JSON.parse(exp.params);
        if (p.mode === 'library') {
          const lr = await service.strategyRun({ symbol: exp.symbol, tf: exp.tf, strategy_id: exp.strategy_id, version: exp.strategy_version, spread: p.spread, slippagePips: p.slippagePips }), lj = judgeStrategyV2(lr, lr.selectionSegments);
          store.finishExperiment(exp.id, { status: lj.decision, result: { ...lr, judgement: lj }, rejection_reason: lj.decision === 'rejected' ? lj.reasons.join(',') : null, now: now() });
          return { ran: exp.id, status: lj.decision };
        }
        const r = await service.experimentRun({ symbol: exp.symbol, tf: exp.tf, filters: p.filters, spread: p.spread, slippagePips: p.slippagePips, strategyParams: p.strategy });
        const j = judge(r.baseline, r.variant, Object.keys(p.filters).length > 0);
        store.finishExperiment(exp.id, { status: j.decision, result: { ...r, judgement: j }, rejection_reason: j.decision === 'rejected' ? j.reasons.join(',') : null, now: now() });
        return { ran: exp.id, status: j.decision };
      } catch (e) {
        const kind = e.kind || 'error'; store.failExperiment(exp.id, { error: `${kind}: ${e.message}`, retryable: RETRYABLE.has(kind), maxRetries, backoffMs, now: now() });
        return { ran: exp.id, failed: kind };
      }
    },
  };
}
module.exports = { createRunner, judge, judgeStrategy, judgeStrategyV2, CRITERIA_V2, candidates, register, cleanFilters, MIN_TRADES, STRATEGY_CRITERIA };
