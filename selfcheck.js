'use strict';
// Runs when the server starts. Pipwise is updated by pasting files into GitHub by hand, so a file can easily be missing or out of date.
// Instead of crashing on one problem at a time, this lists every problem at once, in plain words.
const fs = require('fs'), path = require('path');
const REQUIRED = {
  'engine.js': ['decide', 'indicators', 'backtest', 'buildAccept', 'entryCheck', 'sanitize', 'adx', 'resolve'],
  'store.js': ['open', 'MIGRATIONS'], 'provider.js': ['fetchCandles'], 'service.js': ['createService', 'INSTRUMENTS'], 'scheduler.js': ['createScheduler', 'parseWatchlist'],
  'notifier.js': ['DEFAULT_TYPES', 'createDelivery', 'checkToken', 'send', 'discoverChatId'], 'experiments.js': ['createRunner', 'register', 'candidates', 'judgeStrategyV2'],
  'strategies.js': ['STRATEGIES', 'resolve', 'explain'], 'rules.js': ['validateSpec', 'explain', 'mirror'], 'market.js': ['isOpen', 'lastCandleOpen', 'alwaysOpen'],
  'background.js': ['createBackground'], 'version.js': ['fingerprint', 'summary', 'describe', 'REQUIRED'], 'retry.js': ['retryDelay'],
};
function check(dir = __dirname, required = REQUIRED) {
  const problems = [];
  for (const [file, names] of Object.entries(required)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) { problems.push(`${file} is missing. Add it to GitHub.`); continue; }
    let m; try { m = require(p); } catch (e) { problems.push(`${file} cannot be loaded (${String(e.message).split('\n')[0]}). Paste the latest ${file}.`); continue; }
    const lacking = names.filter(n => m[n] === undefined); if (lacking.length) problems.push(`${file} is out of date: it does not have ${lacking.join(', ')}. Paste the latest ${file}.`);
  }
  if (!fs.existsSync(path.join(dir, 'index.html'))) problems.push('index.html is missing. Add it to GitHub.');
  return problems;
}
// The service object is built at start-up, so an outdated service.js is caught by asking it for the functions server.js uses.
const SERVICE_FUNCTIONS = ['snapshot', 'scan', 'live', 'trackAll', 'scanApproved', 'recordMiss', 'evaluationState', 'callsInLastMinute', 'auditTrack'];
function checkService(service) { const lacking = SERVICE_FUNCTIONS.filter(n => typeof service[n] !== 'function'); return lacking.length ? [`service.js is out of date: it does not have ${lacking.join(', ')}. Paste the latest service.js.`] : []; }
module.exports = { check, checkService, REQUIRED };
