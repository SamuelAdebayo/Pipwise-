'use strict';
// Background checker: looks for each watched pair/timeframe once per candle close. A late candle is asked for again with growing waits until the next candle closes; if it never arrives the miss is reported.
const E = require('./engine'), { INSTRUMENTS } = require('./service'), MARKET = require('./market'), { retryDelay } = require('./retry');
function parseWatchlist(s) {
  return String(s || 'EUR/USD:1h,EUR/USD:4h,GBP/USD:1h,GBP/USD:4h').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => { const [symbol, tf] = x.split(':'); return { symbol, tf }; }).filter(w => INSTRUMENTS.includes(w.symbol) && E.TF_MIN[w.tf]);
}
function createScheduler({ market: M = MARKET, watch, snapshot, deliver = async () => 0, now = Date.now, settleMs = 15000, onMiss = () => {} }) {
  const done = {}, pending = {};
  async function tick() {
    let calls = 0;
    for (const w of watch) {
      const ms = E.TF_MIN[w.tf] * 60000, key = `${w.symbol}|${w.tf}`, expected = M.lastCandleOpen(w.symbol, E.TF_MIN[w.tf], now()), prev = pending[key]; // expected = newest candle that could exist (none are formed while the market is shut)
      if (prev && prev.expected !== expected) { if (!(done[key] >= prev.expected)) onMiss({ symbol: w.symbol, tf: w.tf, expected: prev.expected, reason: prev.reason, attempts: prev.n }); delete pending[key]; } // the next candle closed and this one was never evaluated
      if (done[key] >= expected || now() < expected + ms + settleMs) continue;
      const cur = pending[key]; if (cur && now() < cur.nextAt) continue;
      calls++; const r = await snapshot(w.symbol, w.tf, true).catch(() => ({ ok: false }));
      if (r.ok && r.latestCandleT >= expected) { done[key] = expected; delete pending[key]; }
      else { const n = (cur ? cur.n : 0) + 1; pending[key] = { expected, n, nextAt: now() + retryDelay(n), reason: r.ok ? 'provider_late' : 'data_unavailable' }; }
    }
    await deliver(); return calls;
  }
  return { tick, done, state: () => ({ done, pending }) };
}
module.exports = { createScheduler, parseWatchlist };
