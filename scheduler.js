'use strict';
// Background checker: looks for each watched pair/timeframe once per candle close (plus a few retries), so it uses few API requests.
const E = require('./engine'), { INSTRUMENTS } = require('./service');
function parseWatchlist(s) {
  return String(s || 'EUR/USD:1h,EUR/USD:4h,GBP/USD:1h,GBP/USD:4h').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => { const [symbol, tf] = x.split(':'); return { symbol, tf }; }).filter(w => INSTRUMENTS.includes(w.symbol) && E.TF_MIN[w.tf]);
}
function createScheduler({ watch, snapshot, deliver = async () => 0, now = Date.now, maxRetries = 5, settleMs = 15000 }) {
  const done = {}, tries = {};
  async function tick() {
    let calls = 0;
    for (const w of watch) {
      const ms = E.TF_MIN[w.tf] * 60000, key = `${w.symbol}|${w.tf}`, expected = Math.floor(now() / ms) * ms - ms; // open time of the last closed candle
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
