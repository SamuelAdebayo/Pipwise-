'use strict';
// SQLite persistence (built-in node:sqlite, no dependencies). Signals are never rewritten except to record their outcome.
const { DatabaseSync } = require('node:sqlite');
const MIGRATIONS = [`
CREATE TABLE signals(id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, tf TEXT NOT NULL, dir TEXT NOT NULL CHECK(dir IN('BUY','SELL')),
 strategy TEXT NOT NULL, params TEXT NOT NULL, candle_t INTEGER NOT NULL, provider TEXT NOT NULL, entry REAL NOT NULL, stop REAL NOT NULL,
 target REAL NOT NULL, rr REAL NOT NULL, indicators TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
 r REAL, resolved_t INTEGER, assumptions TEXT, UNIQUE(symbol,tf,strategy,candle_t));
CREATE INDEX idx_sig_open ON signals(status,symbol,tf);
CREATE INDEX idx_sig_time ON signals(candle_t);
CREATE TABLE alerts(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE backtests(id INTEGER PRIMARY KEY, config TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);`,
`ALTER TABLE alerts ADD COLUMN sent INTEGER NOT NULL DEFAULT 0;`,
`CREATE TABLE audit_signals(id INTEGER PRIMARY KEY, source TEXT NOT NULL, symbol TEXT NOT NULL, dir TEXT NOT NULL CHECK(dir IN('BUY','SELL')), entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL,
 signal_t INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', r REAL, resolved_t INTEGER);
CREATE INDEX idx_audit_open ON audit_signals(status,symbol);`,
`CREATE TABLE strategies(id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE strategy_versions(id INTEGER PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES strategies(id), version TEXT NOT NULL, rules TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('approved','candidate','rejected','retired')), source_url TEXT, created_at INTEGER NOT NULL, UNIQUE(strategy_id,version));
CREATE TABLE experiments(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('manual','self_improvement','discovery')), objective TEXT NOT NULL, hypothesis TEXT, origin TEXT,
 strategy_id TEXT NOT NULL, strategy_version TEXT NOT NULL, symbol TEXT, tf TEXT, params TEXT, data_range TEXT, settings TEXT,
 status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN('proposed','queued','running','completed','rejected','blocked','awaiting_validation')),
 priority INTEGER NOT NULL DEFAULT 5, retry_count INTEGER NOT NULL DEFAULT 0, needs_validation INTEGER NOT NULL DEFAULT 1, result TEXT, error TEXT, rejection_reason TEXT,
 dedupe_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX idx_exp_status ON experiments(status,priority);`];
// The strategy Pipwise already uses, written down as data so new strategies can be compared with it. The live engine does not read this.
const BASELINE_RULES = { entry: { BUY: ['EMA50 > EMA200', 'EMA20 > EMA50', 'RSI14 inside the BUY range', 'close > EMA20'], SELL: ['EMA50 < EMA200', 'EMA20 < EMA50', 'RSI14 inside the SELL range', 'close < EMA20'] },
  stop: 'atrStop x ATR14 from the entry', target: 'rr x the stop distance', defaults: { rsiBull: [50, 70], rsiBear: [30, 50], atrStop: 1.5, rr: 2 }, timeframes: ['15min', '1h', '4h'] };

// Columns that make up a backup file. Order matters for restore.
const TABLES = {
  signals: ['id', 'symbol', 'tf', 'dir', 'strategy', 'params', 'candle_t', 'provider', 'entry', 'stop', 'target', 'rr', 'indicators', 'created_at', 'status', 'r', 'resolved_t', 'assumptions'],
  audit_signals: ['id', 'source', 'symbol', 'dir', 'entry', 'stop', 'target', 'signal_t', 'created_at', 'status', 'r', 'resolved_t'],
  alerts: ['id', 'key', 'type', 'message', 'created_at', 'read', 'sent'],
  settings: ['key', 'value'],
  backtests: ['id', 'config', 'result', 'created_at'],
  strategies: ['id', 'name', 'origin', 'description', 'created_at'],
  strategy_versions: ['id', 'strategy_id', 'version', 'rules', 'status', 'source_url', 'created_at'],
  experiments: ['id', 'kind', 'objective', 'hypothesis', 'origin', 'strategy_id', 'strategy_version', 'symbol', 'tf', 'params', 'data_range', 'settings', 'status', 'priority', 'retry_count', 'needs_validation', 'result', 'error', 'rejection_reason', 'dedupe_key', 'created_at', 'updated_at', 'started_at', 'finished_at'],
};
function open(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) { db.exec('BEGIN'); try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version=${i + 1}`); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const q = s => db.prepare(s);
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const api = {
    close: () => db.close(), tx,
    exportAll: () => ({ app: 'pipwise', format: 1, exportedAt: Date.now(), tables: Object.fromEntries(Object.entries(TABLES).map(([t, cols]) => [t, db.prepare(`SELECT ${cols.join(',')} FROM ${t}`).all()])) }),
    importAll(data) { // adds missing records only: never overwrites or deletes, and is all-or-nothing
      if (!data || data.app !== 'pipwise' || data.format !== 1 || typeof data.tables !== 'object' || !data.tables) throw new Error('This is not a Pipwise backup file');
      const out = { added: {}, found: {}, updated: {} }, SKIP_ID = ['signals', 'audit_signals', 'alerts', 'backtests', 'strategy_versions', 'experiments'];
      // Row ids are NOT copied: the app may already have recorded new rows using the same ids, so records are matched on what they are instead.
      const DUPE = { audit_signals: ['source', 'symbol', 'dir', 'entry', 'stop', 'target', 'signal_t'], backtests: ['created_at', 'config'] };
      const val = (r, c, t) => { const x = r[c]; if (x === undefined) return null; if (x === null || typeof x === 'number' || typeof x === 'string') return x; throw new Error(`Bad value in ${t}.${c}`); };
      tx(() => {
        for (const [t, all] of Object.entries(TABLES)) {
          const rows = data.tables[t]; if (rows === undefined) continue; if (!Array.isArray(rows)) throw new Error(`Bad backup: ${t}`);
          const cols = all.filter(c => !(SKIP_ID.includes(t) && c === 'id')), ins = db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`);
          const dupe = DUPE[t] && db.prepare(`SELECT 1 FROM ${t} WHERE ${DUPE[t].map(c => c + '=?').join(' AND ')}`); let n = 0, u = 0; out.found[t] = rows.length;
          // A record the app already has as OPEN, which the backup shows as finished, is completed from the backup. Nothing else is ever overwritten.
          const finish = r => r.status && r.status !== 'open';
          const updSig = t === 'signals' && db.prepare(`UPDATE signals SET status=?,r=?,resolved_t=?,assumptions=? WHERE symbol=? AND tf=? AND strategy=? AND candle_t=? AND status='open'`);
          const updAud = t === 'audit_signals' && db.prepare(`UPDATE audit_signals SET status=?,r=?,resolved_t=? WHERE source=? AND symbol=? AND dir=? AND entry=? AND stop=? AND target=? AND signal_t=? AND status='open'`);
          for (const r of rows) {
            if (!r || typeof r !== 'object') throw new Error(`Bad backup row in ${t}`);
            const row = { ...r }; if (t === 'alerts') { row.key = 'restored:' + String(r.key).replace(/^restored:/, ''); row.sent = 1; } // restored alerts are history: never re-sent to Telegram
            if (dupe && dupe.get(...DUPE[t].map(c => val(row, c, t)))) { if (updAud && finish(row)) u += updAud.run(...['status', 'r', 'resolved_t', 'source', 'symbol', 'dir', 'entry', 'stop', 'target', 'signal_t'].map(c => val(row, c, t))).changes; continue; }
            const ch = ins.run(...cols.map(c => val(row, c, t))).changes; n += ch;
            if (!ch && updSig && finish(row)) u += updSig.run(...['status', 'r', 'resolved_t', 'assumptions', 'symbol', 'tf', 'strategy', 'candle_t'].map(c => val(row, c, t))).changes;
          }
          out.added[t] = n; out.updated[t] = u;
        }
      });
      return out;
    },
    addSignal(s) {
      const r = q(`INSERT OR IGNORE INTO signals(symbol,tf,dir,strategy,params,candle_t,provider,entry,stop,target,rr,indicators,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(s.symbol, s.tf, s.dir, s.strategy, JSON.stringify(s.params), s.candle_t, s.provider, s.entry, s.stop, s.target, s.rr, JSON.stringify(s.indicators), s.created_at);
      return r.changes ? Number(r.lastInsertRowid) : null; // null = duplicate
    },
    openSignals: (symbol, tf) => q(`SELECT * FROM signals WHERE status='open' AND symbol=? AND tf=? ORDER BY candle_t`).all(symbol, tf),
    addAudit: a => Number(q(`INSERT INTO audit_signals(source,symbol,dir,entry,stop,target,signal_t,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(a.source, a.symbol, a.dir, a.entry, a.stop, a.target, a.signal_t, a.created_at).lastInsertRowid),
    listAudit: () => q(`SELECT * FROM audit_signals ORDER BY signal_t DESC LIMIT 500`).all(),
    openAudit: () => q(`SELECT * FROM audit_signals WHERE status='open'`).all(),
    resolveAudit: (id, status, r, t) => q(`UPDATE audit_signals SET status=?,r=?,resolved_t=? WHERE id=? AND status='open'`).run(status, r, t, id).changes,
    deleteAudit: id => q(`DELETE FROM audit_signals WHERE id=?`).run(id).changes,
    openPairs: () => q(`SELECT DISTINCT symbol,tf FROM signals WHERE status='open'`).all(),
    resolveSignal: (id, status, r, t, assumptions) => q(`UPDATE signals SET status=?,r=?,resolved_t=?,assumptions=? WHERE id=? AND status='open'`).run(status, r, t, assumptions, id).changes,
    listSignals({ status, limit = 100 } = {}) {
      const w = status === 'closed' ? `WHERE status!='open'` : status === 'open' ? `WHERE status='open'` : '';
      return q(`SELECT * FROM signals ${w} ORDER BY candle_t DESC LIMIT ?`).all(Math.min(limit, 500));
    },
    allSignals: ({ from = 0, to = 9e15 } = {}) => q(`SELECT * FROM signals WHERE candle_t>=? AND candle_t<=? ORDER BY candle_t`).all(from, to),
    addAlert: (key, type, message, now) => q(`INSERT OR IGNORE INTO alerts(key,type,message,created_at) VALUES(?,?,?,?)`).run(key, type, message, now).changes > 0,
    listAlerts: (limit = 50) => q(`SELECT * FROM alerts ORDER BY id DESC LIMIT ?`).all(limit),
    unsentAlerts: (limit = 10) => q(`SELECT * FROM alerts WHERE sent=0 ORDER BY id LIMIT ?`).all(limit),
    markSent: id => q(`UPDATE alerts SET sent=1 WHERE id=?`).run(id).changes,
    markAllSent: () => q(`UPDATE alerts SET sent=1 WHERE sent=0`).run().changes,
    markAlertsRead: () => q(`UPDATE alerts SET read=1 WHERE read=0`).run().changes,
    getSetting: k => (q(`SELECT value FROM settings WHERE key=?`).get(k) || {}).value,
    setSetting: (k, v) => q(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(v)),
    saveBacktest: (config, result, now) => Number(q(`INSERT INTO backtests(config,result,created_at) VALUES(?,?,?)`).run(JSON.stringify(config), JSON.stringify(result), now).lastInsertRowid),
    listStrategies: () => q(`SELECT * FROM strategies ORDER BY created_at`).all().map(st => ({ ...st, versions: q(`SELECT id,version,rules,status,source_url,created_at FROM strategy_versions WHERE strategy_id=? ORDER BY id`).all(st.id).map(v => ({ ...v, rules: JSON.parse(v.rules) })) })),
    addExperiment(e) { // records a research task; returns null if the same task (dedupe_key) already exists
      const t = e.now || Date.now(), r = q(`INSERT INTO experiments(kind,objective,hypothesis,origin,strategy_id,strategy_version,symbol,tf,params,data_range,settings,priority,needs_validation,dedupe_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .run(e.kind || 'manual', e.objective, e.hypothesis ?? null, e.origin ?? null, e.strategy_id, e.strategy_version, e.symbol ?? null, e.tf ?? null, e.params ? JSON.stringify(e.params) : null, e.data_range ? JSON.stringify(e.data_range) : null, e.settings ? JSON.stringify(e.settings) : null, e.priority ?? 5, e.needs_validation === false ? 0 : 1, e.dedupe_key, t, t);
      return r.changes ? Number(r.lastInsertRowid) : null;
    },
    listExperiments: (limit = 100) => q(`SELECT * FROM experiments ORDER BY id DESC LIMIT ?`).all(Math.min(limit, 500)),
    listBacktests: () => q(`SELECT id,config,created_at FROM backtests ORDER BY id DESC LIMIT 20`).all(),
  };
  if (!api.getSetting('db_created_at')) api.setSetting('db_created_at', Date.now()); // shows when this database file was first created
  const t0 = Date.now(); // register the existing strategy once (safe to repeat)
  db.prepare(`INSERT OR IGNORE INTO strategies(id,name,origin,description,created_at) VALUES(?,?,?,?,?)`).run('ema-rsi-trend', 'EMA / RSI / ATR trend follower', 'built-in', 'The original Pipwise rules. Signals record parameter variants as labels like v1|bull50-70|bear30-50|atr1.5|rr2.', t0);
  db.prepare(`INSERT OR IGNORE INTO strategy_versions(strategy_id,version,rules,status,source_url,created_at) VALUES(?,?,?,?,?,?)`).run('ema-rsi-trend', 'v1', JSON.stringify(BASELINE_RULES), 'approved', null, t0);
  return api;
}
module.exports = { open, MIGRATIONS };
