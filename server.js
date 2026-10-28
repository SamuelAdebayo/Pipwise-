'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = require('./engine'), { INSTRUMENTS, cleanParams } = require('./service');

function createApp({ service, store, config }) {
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
      if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Pipwise"' }); return res.end('Authentication required'); }
      const u = new URL(req.url, 'http://x'), p = u.pathname;
      if (req.method === 'GET' && p === '/') return send(res, 200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/api/config') return send(res, 200, { instruments: INSTRUMENTS, timeframes: Object.keys(E.TF_MIN), tz: tz(), hasKey: config.hasKey, storage: { path: (config.storage || {}).path || '', isDefault: !!(config.storage || {}).isDefault, createdAt: Number(store.getSetting('db_created_at')) || null }, telegram: { token: !!(config.telegram || {}).token, chat: !!(config.telegram || {}).chat, problems: (config.telegram || {}).problems || [] }, params: service.params(), note: 'XAU/USD works only if your data plan includes it.' });
      if (req.method === 'GET' && p === '/api/snapshot') { if (!config.hasKey) return send(res, 200, { setup: true }); return send(res, 200, await service.snapshot(...pair(u), u.searchParams.get('force') === '1')); }
      if (req.method === 'GET' && p === '/api/signals') { const s = u.searchParams.get('status'); if (s && !['open', 'closed'].includes(s)) throw new Error('Bad status'); if (config.hasKey) await service.trackAll(); return send(res, 200, await service.enrich(store.listSignals({ status: s }))); }
      if (req.method === 'GET' && p === '/api/scan') { const sy = u.searchParams.get('symbol'); if (!INSTRUMENTS.includes(sy)) throw new Error('Unsupported symbol'); return send(res, 200, config.hasKey ? await service.scan(sy) : []); }
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
      if (req.method === 'POST' && p === '/api/import') return send(res, 200, store.importAll(await body(req, 20000000)));
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
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'pipwise.db'); // if this fails the server stops loudly; it never switches to temporary storage
  const store = require('./store').open(dbPath);
  const provider = require('./provider'), { createService } = require('./service'), { createScheduler, parseWatchlist } = require('./scheduler'), N = require('./notifier'), env = process.env;
  const tgCheck = N.checkToken(env.TELEGRAM_BOT_TOKEN), tgToken = tgCheck.token, tgChat = String(env.TELEGRAM_CHAT_ID || '').replace(/\s+/g, ''), tgRaw = !!String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const tgFail = () => { throw new Error(`TELEGRAM_BOT_TOKEN problem: ${tgCheck.problems.join('; ')}. Copy it again from BotFather.`); };
  const config = { password: env.PIPWISE_PASSWORD || '', tz: env.TIMEZONE || 'Africa/Lagos', hasKey: !!env.TWELVEDATA_API_KEY,
    storage: { path: dbPath, isDefault: !env.DB_PATH }, telegram: { token: tgRaw, chat: !!tgChat, problems: tgCheck.problems, discover: () => (tgToken ? N.discoverChatId(tgToken) : tgFail()), test: () => (tgToken ? N.send({ token: tgToken, chatId: tgChat }, 'Pipwise test message: alerts are working.') : tgFail()) } };
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 3000);
  if (host !== '127.0.0.1' && !config.password) { console.error('Refusing to listen on a public address without PIPWISE_PASSWORD.'); process.exit(1); }
  const service = createService({ store, fetchCandles: provider.fetchCandles });
  if (tgToken && tgChat && !store.getSetting('tg_baseline')) { store.markAllSent(); store.setSetting('tg_baseline', '1'); } // never send old alerts when Telegram is first enabled
  const deliver = N.createDelivery({ store, token: tgToken, chatId: tgChat, types: (env.TELEGRAM_TYPES || 'new_signal,outcome,api_error').split(',').map(x => x.trim()) });
  const watch = parseWatchlist(env.WATCHLIST), sch = createScheduler({ watch, snapshot: service.snapshot, deliver: async () => { await service.trackAll().catch(() => {}); await service.auditTrack().catch(() => {}); return deliver(); } });
  let busy = false; const run = async () => { if (busy) return; busy = true; try { await sch.tick(); } catch { console.error('Background check failed'); } finally { busy = false; } };
  if (config.hasKey && watch.length) { setTimeout(run, 5000); setInterval(run, 60000); }
  http.createServer(createApp({ service, store, config })).listen(port, host, () => console.log(`Pipwise on http://${host}:${port} | data key: ${config.hasKey ? 'set' : 'MISSING'} | watching: ${watch.map(w => w.symbol + ':' + w.tf).join(', ') || 'none'} | telegram: ${tgToken && tgChat ? 'on' : tgCheck.problems.length ? 'token problem: ' + tgCheck.problems.join('; ') : 'off'} | db: ${dbPath}${env.DB_PATH ? '' : ' (TEMPORARY on most hosts: set DB_PATH to a persistent disk)'}`));
}
