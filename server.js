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
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 10000) { no(new Error('Body too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('Invalid JSON')); } }); });
  const pair = u => { const symbol = u.searchParams.get('symbol'), tf = u.searchParams.get('tf'); if (!INSTRUMENTS.includes(symbol) || !E.TF_MIN[tf]) throw new Error('Unsupported symbol or timeframe'); return [symbol, tf]; };
  const tz = () => store.getSetting('tz') || config.tz;
  return async (req, res) => {
    try {
      if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Pipwise"' }); return res.end('Authentication required'); }
      const u = new URL(req.url, 'http://x'), p = u.pathname;
      if (req.method === 'GET' && p === '/') return send(res, 200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && p === '/api/config') return send(res, 200, { instruments: INSTRUMENTS, timeframes: Object.keys(E.TF_MIN), tz: tz(), hasKey: config.hasKey, params: service.params(), note: 'XAU/USD works only if your data plan includes it.' });
      if (req.method === 'GET' && p === '/api/snapshot') { if (!config.hasKey) return send(res, 200, { setup: true }); return send(res, 200, await service.snapshot(...pair(u), u.searchParams.get('force') === '1')); }
      if (req.method === 'GET' && p === '/api/signals') { const s = u.searchParams.get('status'); if (s && !['open', 'closed'].includes(s)) throw new Error('Bad status'); return send(res, 200, store.listSignals({ status: s })); }
      if (req.method === 'GET' && p === '/api/alerts') return send(res, 200, store.listAlerts());
      if (req.method === 'POST' && p === '/api/alerts/read') return send(res, 200, { updated: store.markAlertsRead() });
      if (req.method === 'GET' && p === '/api/performance') { const n = k => (u.searchParams.get(k) ? Number(u.searchParams.get(k)) : undefined); return send(res, 200, service.performance({ from: n('from'), to: n('to') })); }
      if (req.method === 'POST' && p === '/api/settings') {
        const b = await body(req);
        if (b.params) store.setSetting('params', JSON.stringify(service.cleanParams(b.params)));
        if (b.tz) { new Intl.DateTimeFormat([], { timeZone: String(b.tz) }); store.setSetting('tz', b.tz); }
        return send(res, 200, { params: service.params(), tz: tz() });
      }
      if (req.method === 'POST' && p === '/api/backtest') { if (!config.hasKey) throw new Error('No data provider configured'); return send(res, 200, await service.backtest(await body(req))); }
      send(res, 404, { error: 'Not found' });
    } catch (e) { send(res, 400, { error: e.message }); }
  };
}
module.exports = { createApp };

if (require.main === module) {
  const store = require('./store').open(process.env.DB_PATH || path.join(__dirname, 'pipwise.db'));
  const provider = require('./provider'), { createService } = require('./service');
  const config = { password: process.env.PIPWISE_PASSWORD || '', tz: process.env.TIMEZONE || 'Africa/Lagos', hasKey: !!process.env.TWELVEDATA_API_KEY };
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3000);
  if (host !== '127.0.0.1' && !config.password) { console.error('Refusing to listen on a public address without PIPWISE_PASSWORD.'); process.exit(1); }
  const service = createService({ store, fetchCandles: provider.fetchCandles });
  http.createServer(createApp({ service, store, config })).listen(port, host, () => console.log(`Pipwise on http://${host}:${port} | data key: ${config.hasKey ? 'set' : 'MISSING (setup screen shown)'}`));
}
