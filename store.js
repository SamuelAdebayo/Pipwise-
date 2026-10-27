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
CREATE INDEX idx_audit_open ON audit_signals(status,symbol);`];

function open(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) { db.exec('BEGIN'); try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version=${i + 1}`); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const q = s => db.prepare(s);
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  return {
    close: () => db.close(), tx,
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
    listBacktests: () => q(`SELECT id,config,created_at FROM backtests ORDER BY id DESC LIMIT 20`).all(),
  };
}
module.exports = { open };
