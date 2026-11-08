'use strict';
// Background checker: looks for each watched pair/timeframe once per candle close (plus a few retries), so it uses few API requests.
const E = require('./engine'), { INSTRUMENTS } = require('./service'), MARKET = require('./market');
function parseWatchlist(s) {
  return String(s || 'EUR/USD:1h,EUR/USD:4h,GBP/USD:1h,GBP/USD:4h').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => { const [symbol, tf] = x.split(':'); return { symbol, tf }; }).filter(w => INSTRUMENTS.includes(w.symbol) && E.TF_MIN[w.tf]);
}
function createScheduler({ market: M = MARKET, watch, snapshot, deliver = async () => 0, now = Date.now, maxRetries = 5, settleMs = 15000 }) {
  const done = {}, tries = {};
  async function tick() {
    let calls = 0;
    for (const w of watch) {
      const ms = E.TF_MIN[w.tf] * 60000, key = `${w.symbol}|${w.tf}`, expected = M.lastCandleOpen(w.symbol, E.TF_MIN[w.tf], now()); // open time of the newest candle that could exist (none are formed while the market is shut)
      if (done[key] >= expected || now() < expected + ms + settleMs) continue;
      calls++; const r = await snapshot(w.symbol, w.tf, true).catch(() => ({ ok: false }));
      tries[key] = (tries[key] || 0) + 1;
      if ((r.ok && r.latestCandleT >= expected) || tries[key] >= maxRetries) { done[key] = expected; tries[key] = 0; } // gives up after retries (e.g. weekends)
    }
    await deliver(); return calls;
  }
  return { tick, done };
}
module.exports = { createScheduler, parseWatchlist };
