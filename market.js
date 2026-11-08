'use strict';
// When markets are open. Forex trades from Sunday 17:00 to Friday 17:00 New York time; the New York clock takes care of daylight saving
// (so the Friday close is 21:00 UTC in summer and 22:00 UTC in winter). Gold (XAU/USD) has the same week but opens Sunday 18:00
// and pauses 17:00-18:00 New York time, Monday to Thursday. Not modelled: public holidays and shortened holiday sessions.
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const offsets = new Map();
function nyOffset(t) { // New York minus UTC, in milliseconds, cached per hour (daylight saving changes on the hour)
  const k = Math.floor(t / 3600000); let o = offsets.get(k);
  if (o === undefined) { const p = Object.fromEntries(FMT.formatToParts(new Date(k * 3600000)).map(x => [x.type, x.value])); o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - k * 3600000; if (offsets.size > 5000) offsets.clear(); offsets.set(k, o); }
  return o;
}
const RULES = { default: { sunOpen: 17 * 60, friClose: 17 * 60, dailyBreak: null }, 'XAU/USD': { sunOpen: 18 * 60, friClose: 17 * 60, dailyBreak: [17 * 60, 18 * 60] } };
function isOpen(symbol, t) {
  const r = RULES[symbol] || RULES.default, d = new Date(t + nyOffset(t)), dow = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (dow === 6) return false; if (dow === 0) return m >= r.sunOpen; if (dow === 5) return m < r.friClose;
  return !(r.dailyBreak && m >= r.dailyBreak[0] && m < r.dailyBreak[1]);
}
const STEP = 300000; // sessions start and end on 5-minute marks
function openMs(symbol, t0, t1) { // market-open time between two moments (looks back at most 14 days)
  if (t1 <= t0) return 0; t0 = Math.max(t0, t1 - 14 * 86400000); let total = 0;
  for (let t = Math.floor(t0 / STEP) * STEP; t < t1; t += STEP) if (isOpen(symbol, t)) total += Math.min(t + STEP, t1) - Math.max(t, t0);
  return total;
}
const closedMs = (symbol, t0, t1) => Math.max(0, t1 - t0 - openMs(symbol, t0, t1));
// Open time of the newest candle that could exist at moment t: the last whole candle that had any market-open time in it.
function lastCandleOpen(symbol, tfMin, t) { const ms = tfMin * 60000; let b = Math.floor(t / ms) * ms - ms; for (let i = 0; i < 2000 && openMs(symbol, b, b + ms) === 0; i++) b -= ms; return b; }
// A candle that ended while the market was shut (for example the 4h candle that runs 20:00-24:00 UTC on a Friday) is not a trading opportunity.
const closedWhileOpen = (symbol, candleOpen, ms) => isOpen(symbol, candleOpen + ms - 1);
function nextOpen(symbol, t) { if (isOpen(symbol, t)) return t; for (let u = Math.ceil(t / STEP) * STEP, i = 0; i < 8 * 288; u += STEP, i++) if (isOpen(symbol, u)) return u; return null; }
// A market that never closes: used by tests with made-up candle times, and usable for 24/7 markets.
const alwaysOpen = { isOpen: () => true, openMs: (s, a, b) => Math.max(0, b - a), closedMs: () => 0, lastCandleOpen: (s, tfMin, t) => { const ms = tfMin * 60000; return Math.floor(t / ms) * ms - ms; }, closedWhileOpen: () => true, nextOpen: (s, t) => t };
module.exports = { isOpen, openMs, closedMs, lastCandleOpen, closedWhileOpen, nextOpen, alwaysOpen };
