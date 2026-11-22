'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = require('./engine'), { INSTRUMENTS, cleanParams } = require('./service');

function createApp({ service, store, config, runner, health, backup }) {
  const pj = s => { try { return s == null ? null : JSON.parse(s); } catch { return s; } };
  const page = fs.readFileSync(path.join(__dirname, 'index.html'));
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const authed = req => {
    if (!config.password) return true;
    const m = /^Basic (.+)$/.exec(req.headers.authorization || ''); if (!m) return false;
    const got = Buffer.from(Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':')), want = Buffer.from(config.password);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const body = (req, max = 10000) => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > max) { no(new Error('Body too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('Invalid JSON')); } }); });
  const pair = u => { const symbol = u.searchParams.get('symbol'), tf = u.searchParams.get('tf'); if (!INSTRUMENTS.includes(symbol) || !E.TF_MIN[tf]) throw new Error('Unsupported symbol or timeframe'); return [symbol, tf]; };
  const tz = () => store.getSetting('tz') || config.tz;
  return async (req, res) => {
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && (req.url || '').split('?')[0] === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : 'ok'); } // public and tiny: lets a free uptime monitor keep the app awake; reveals nothing
      if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Pipwise"' }); return res.end('Authentication required'); }
      const u = new URL(req.url, 'http://x'), p = u.pathname;
      if (req.method === 'GET' && p === '/') return send(res, 200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/api/config') return send(res, 200, { instruments: INSTRUMENTS, timeframes: Object.keys(E.TF_MIN), tz: tz(), hasKey: config.hasKey, storage: { path: (config.storage || {}).path || '', isDefault: !!(config.storage || {}).isDefault, createdAt: Number(store.getSetting('db_created_at')) || null }, telegram: { token: !!(config.telegram || {}).token, chat: !!(config.telegram || {}).chat, problems: (config.telegram || {}).problems || [] }, params: service.params(), note: 'XAU/USD works only if your data plan includes it.' });
      if (req.method === 'GET' && p === '/api/live') { if (!config.hasKey) return send(res, 200, { ok: false, setup: true }); const [symbol, tf] = pair(u); return send(res, 200, await service.live(symbol, tf, { force: u.searchParams.get('force') === '1' })); }
      if (req.method === 'GET' && p === '/api/snapshot') { if (!config.hasKey) return send(res, 200, { setup: true }); return send(res, 200, await service.snapshot(...pair(u), u.searchParams.get('force') === '1')); }
      if (req.method === 'GET' && p === '/api/signals') { const s = u.searchParams.get('status'); if (s && !['open', 'closed'].includes(s)) throw new Error('Bad status'); if (config.hasKey) await service.trackAll(); return send(res, 200, await service.enrich(store.listSignals({ status: s }))); }
      if (req.method === 'GET' && p === '/api/scan') { const sy = u.searchParams.get('symbol'); if (!INSTRUMENTS.includes(sy)) throw new Error('Unsupported symbol'); return send(res, 200, config.hasKey ? await service.scan(sy) : []); }
      if (req.method === 'GET' && p === '/api/strategies') return send(res, 200, store.listStrategies());
      if (req.method === 'POST' && p === '/api/strategies') { const R = require('./rules'), S = require('./strategies'), d = R.validateStrategyInput(await body(req, 50000), store.listStrategies().map(s => s.id).concat(S.STRATEGIES.map(s => s.id))); store.registerDataStrategy(d, 'user'); return send(res, 200, { id: d.id, versions: d.versions.length, rules: d.versions.map(v => ({ version: v.label, ...R.describe(v.spec) })) }); }
      if (req.method === 'GET' && p === '/api/research/overview') return send(res, 200, { counts: store.experimentCounts(), progress: store.experimentProgress(), lastSweep: store.getSetting('last_sweep') || null, ...require('./experiments').candidates(store) });
      if (req.method === 'POST' && p === '/api/research/sweep') { if (!runner) throw new Error('The research runner is not available'); return send(res, 200, runner.planSweep(await body(req))); }
      if (req.method === 'GET' && p === '/api/experiments') return send(res, 200, (u.searchParams.get('view') === '1' ? store.listExperimentsView : store.listExperiments)(Math.min(Number(u.searchParams.get('limit')) || 100, 200)).map(e => ({ ...e, params: pj(e.params), settings: pj(e.settings), result: pj(e.result) })));
      if (req.method === 'POST' && p === '/api/experiments') { if (!runner) throw new Error('The research runner is not available'); return send(res, 200, runner.enqueue(await body(req))); }
      if (req.method === 'POST' && p === '/api/experiments/requeue') return send(res, 200, { requeued: store.requeueExperiment(Number((await body(req)).id), Date.now()) });
      if (req.method === 'GET' && p === '/api/approvals') return send(res, 200, store.listApprovals().map(a => ({ ...a, name: (require('./strategies').resolve(store, a.strategy_id) || {}).name || a.strategy_id })));
      if (req.method === 'POST' && p === '/api/approvals') { const b = await body(req); return send(res, 200, service.approveSetup({ strategy_id: b.strategy_id, version: b.version, symbol: b.symbol, tf: b.tf })); }
      if (req.method === 'POST' && (p === '/api/approvals/stop' || p === '/api/approvals/resume')) return send(res, 200, service.setApproval((await body(req)).id, p.endsWith('stop') ? 'stopped' : 'active'));
      if (req.method === 'POST' && p === '/api/backup/telegram') { if (!backup) throw new Error('Backup is not set up'); return send(res, 200, await backup.run({ force: true })); }
      if (req.method === 'GET' && p === '/api/health') return send(res, 200, { now: Date.now(), storage: { path: (config.storage || {}).path || '', isDefault: !!(config.storage || {}).isDefault, createdAt: Number(store.getSetting('db_created_at')) || null }, queue: store.experimentCounts(), approvals: store.listApprovals().filter(a => a.status === 'active').length, telegram: { token: !!(config.telegram || {}).token, chat: !!(config.telegram || {}).chat }, ...(health ? health() : {}) });
      if (req.method === 'GET' && p === '/api/alerts') return send(res, 200, store.listAlerts());
      if (req.method === 'POST' && p === '/api/alerts/read') return send(res, 200, { updated: store.markAlertsRead() });
      if (req.method === 'GET' && p === '/api/performance') { const n = k => (u.searchParams.get(k) ? Number(u.searchParams.get(k)) : undefined); return send(res, 200, service.performance({ from: n('from'), to: n('to') })); }
      if (req.method === 'POST' && p === '/api/settings') {
        const b = await body(req);
        if (b.params) store.setSetting('params', JSON.stringify(service.cleanParams(b.params)));
        if (b.tz) { new Intl.DateTimeFormat([], { timeZone: String(b.tz) }); store.setSetting('tz', b.tz); }
        return send(res, 200, { params: service.params(), tz: tz() });
      }
      if (req.method === 'GET' && p === '/api/telegram/chat-id') { const t = config.telegram || {}; if (!t.token) throw new Error('TELEGRAM_BOT_TOKEN is not set'); const id = await t.discover(); if (!id) throw new Error('No message found. Send any message to your bot in Telegram first, then try again.'); return send(res, 200, { chatId: id }); }
      if (req.method === 'POST' && p === '/api/telegram/test') { const t = config.telegram || {}; if (!t.token || !t.chat) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first'); await t.test(); return send(res, 200, { sent: true }); }
      if (req.method === 'GET' && p === '/api/export') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="pipwise-backup.json"', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(store.exportAll())); }
      if (req.method === 'POST' && p === '/api/import') {
        const done = store.importAll(await body(req, 20000000)); let rechecked = 0;
        if (config.hasKey) { // after a restore, check every open trade against real prices straight away, so results that happened while the app was away show up
          const open = () => store.listSignals({ status: 'open', limit: 500 }).length + store.openAudit().length, before = open();
          service.resetTracking(); await service.trackAll().catch(() => {}); await service.auditTrack(true).catch(() => {}); rechecked = Math.max(0, before - open());
        }
        return send(res, 200, { ...done, rechecked });
      }
      if (req.method === 'POST' && p === '/api/lab') { if (!config.hasKey) throw new Error('No data provider configured'); return send(res, 200, await service.lab(await body(req))); }
      if (req.method === 'GET' && p === '/api/audit') { if (config.hasKey) await service.auditTrack(true).catch(() => {}); return send(res, 200, service.auditOverview()); }
      if (req.method === 'POST' && p === '/api/audit') { const id = service.auditAdd(await body(req)); if (config.hasKey) await service.auditTrack(true).catch(() => {}); return send(res, 200, { id }); }
      if (req.method === 'POST' && p === '/api/audit/delete') return send(res, 200, { deleted: service.auditDelete((await body(req)).id) });
      if (req.method === 'POST' && p === '/api/backtest') { if (!config.hasKey) throw new Error('No data provider configured'); return send(res, 200, await service.backtest(await body(req))); }
      send(res, 404, { error: 'Not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  };
}
module.exports = { createApp };

if (require.main === module) {
  const problems = require('./selfcheck').check(); // list every missing or outdated file at once instead of crashing on one
  if (problems.length) { console.error('Pipwise cannot start because some files are missing or out of date:\n - ' + problems.join('\n - ')); process.exit(1); }
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'pipwise.db'); // if this fails the server stops loudly; it never switches to temporary storage
  const store = require('./store').open(dbPath);
  const provider = require('./provider'), { createService } = require('./service'), { createScheduler, parseWatchlist } = require('./scheduler'), N = require('./notifier'), env = process.env;
  const tgCheck = N.checkToken(env.TELEGRAM_BOT_TOKEN), tgToken = tgCheck.token, tgChat = String(env.TELEGRAM_CHAT_ID || '').replace(/\s+/g, ''), tgRaw = !!String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const tgFail = () => { throw new Error(`TELEGRAM_BOT_TOKEN problem: ${tgCheck.problems.join('; ')}. Copy it again from BotFather.`); };
  const config = { password: env.PIPWISE_PASSWORD || '', tz: env.TIMEZONE || 'Africa/Lagos', hasKey: !!env.TWELVEDATA_API_KEY,
    storage: { path: dbPath, isDefault: !env.DB_PATH }, telegram: { token: tgRaw, chat: !!tgChat, problems: tgCheck.problems, discover: () => (tgToken ? N.discoverChatId(tgToken) : tgFail()), test: () => (tgToken ? N.send({ token: tgToken, chatId: tgChat }, 'Pipwise test message: alerts are working.') : tgFail()) } };
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 3000);
  if (host !== '127.0.0.1' && !config.password) { console.error('Refusing to listen on a public address without PIPWISE_PASSWORD.'); process.exit(1); }
  const service = createService({ store, fetchCandles: provider.fetchCandles, maxApprovals: Number(env.MAX_APPROVALS || 5), liveDailyBudget: Number(env.LIVE_DAILY_BUDGET) || 300 });
  { const p = require('./selfcheck').checkService(service); if (p.length) { console.error('Pipwise cannot start because some files are out of date:\n - ' + p.join('\n - ')); process.exit(1); } }
  if (tgToken && tgChat && !store.getSetting('tg_baseline')) { store.markAllSent(); store.setSetting('tg_baseline', '1'); } // never send old alerts when Telegram is first enabled
  const deliver = N.createDelivery({ store, token: tgToken, chatId: tgChat, types: (env.TELEGRAM_TYPES || N.DEFAULT_TYPES.join(',')).split(',').map(x => x.trim()) });
  let backup = null; try { backup = require('./backup').createBackup({ store, token: tgToken, chatId: tgChat }); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } // optional: automatic backup of the database to the owner's Telegram chat; the app runs the same without backup.js
  const runner = require('./experiments').createRunner({ store, service, dailyLimit: Number(env.EXPERIMENT_DAILY_LIMIT || 200) }); require('./experiments').register(store); runner.recover(); // tests interrupted by a restart go back in the queue
  const watch = parseWatchlist(env.WATCHLIST), sch = createScheduler({ watch, snapshot: service.snapshot, onMiss: m => service.recordMiss(m.symbol, m.tf, m.expected, m.reason, m.attempts) });
  // Each step is isolated: one failing step is recorded (with its name and message) and the others still run. Alerts are delivered before research starts.
  const bg = require('./background').createBackground({ store, steps: [
    { name: 'watchlist', run: () => sch.tick() }, { name: 'approved-strategies', run: () => service.scanApproved() }, { name: 'outcome-tracking', run: () => service.trackAll() }, { name: 'audit-tracking', run: () => service.auditTrack() },
    { name: 'telegram', run: () => deliver() }, ...(backup ? [{ name: 'telegram-backup', run: () => backup.run() }] : []), { name: 'research-planning', run: async () => { if (env.AUTO_RESEARCH !== '0') runner.autoPlan(); } }, { name: 'research-tests', run: () => runner.runBatch(5) }] });
  if (config.hasKey) { setTimeout(() => bg.cycle(), 5000); setInterval(() => bg.cycle(), 60000); }
  http.createServer(createApp({ service, store, config, runner, backup, health: () => ({ backup: backup ? backup.state() : null, background: bg.snapshot(), evaluations: service.evaluationState(), watchlist: sch.state(), calls: service.callsInLastMinute() }) })).listen(port, host, () => console.log(`Pipwise on http://${host}:${port} | data key: ${config.hasKey ? 'set' : 'MISSING'} | watching: ${watch.map(w => w.symbol + ':' + w.tf).join(', ') || 'none'} | telegram: ${tgToken && tgChat ? 'on' : tgCheck.problems.length ? 'token problem: ' + tgCheck.problems.join('; ') : 'off'} | db: ${dbPath}${env.DB_PATH ? '' : ' (TEMPORARY on most hosts: set DB_PATH to a persistent disk)'}`));
}
