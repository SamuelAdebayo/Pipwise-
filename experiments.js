'use strict';
// Research queue: validates test requests, runs them one at a time with the existing backtester, and records every outcome.
const { INSTRUMENTS } = require('./service'), E = require('./engine');
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
    async runNext() {
      const t = now();
      if (store.finishedSince(t - 86400000) >= dailyLimit) return { skipped: 'daily_limit' };
      if (service.callsInLastMinute() > callBudget) return { skipped: 'api_busy' }; // leave headroom for live signal checks
      const exp = store.claimExperiment(t); if (!exp) return null;
      try {
        const p = JSON.parse(exp.params), r = await service.experimentRun({ symbol: exp.symbol, tf: exp.tf, filters: p.filters, spread: p.spread, slippagePips: p.slippagePips, strategyParams: p.strategy });
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
module.exports = { createRunner, judge, cleanFilters, MIN_TRADES };
