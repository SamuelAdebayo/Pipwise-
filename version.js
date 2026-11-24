'use strict';
// Build fingerprint: WHICH code is running. Computed once at start-up from the files on disk.
// Every file on REQUIRED must exist, be readable and be non-empty; otherwise the fingerprint is INCOMPLETE and no combined hash is produced.
// Returns only a fixed set of fields. It never reads or returns environment variables other than the two Render git variables.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const REQUIRED = ['server.js', 'service.js', 'engine.js', 'rules.js', 'strategies.js', 'experiments.js', 'store.js', 'provider.js', 'scheduler.js', 'notifier.js', 'market.js', 'background.js', 'retry.js', 'selfcheck.js', 'version.js', 'index.html', 'package.json'];
const OPTIONAL = ['backup.js'];
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
function fingerprint({ dir = __dirname, env = process.env, now = Date.now, required = REQUIRED, optional = OPTIONAL } = {}) {
  const files = {}, missing = [], problems = [], opt = {};
  for (const f of required) {
    let b; try { b = fs.readFileSync(path.join(dir, f)); } catch (e) { missing.push(f); problems.push(`${f} ${e && e.code === 'ENOENT' ? 'is missing' : 'cannot be read'}`); continue; }
    if (!b.length) { missing.push(f); problems.push(`${f} is empty`); continue; }
    files[f] = { sha256: sha(b), bytes: b.length };
  }
  for (const f of optional) { try { const b = fs.readFileSync(path.join(dir, f)); opt[f] = { present: true, sha256: sha(b), bytes: b.length }; } catch { opt[f] = { present: false }; } }
  const listed = new Set([...required, ...optional]); let unlisted = []; try { unlisted = fs.readdirSync(dir).filter(f => /\.(js|html|json)$/.test(f) && !listed.has(f)).sort(); } catch { /* an unreadable folder shows up as missing files above */ }
  const complete = missing.length === 0, combined = complete ? sha([...required].sort().map(f => `${f}:${files[f].sha256}`).join('\n')) : null;
  const c = String((env && env.RENDER_GIT_COMMIT) || ''), commit = /^[0-9a-f]{7,64}$/i.test(c) ? c.toLowerCase() : null, b = String((env && env.RENDER_GIT_BRANCH) || ''), branch = /^[A-Za-z0-9._\/-]{1,100}$/.test(b) ? b : null;
  return { complete, problems, missing, files, optional: opt, unlistedFiles: unlisted, fingerprint: combined, short: combined ? combined.slice(0, 8) : null, fileCount: Object.keys(files).length, commit, commitShort: commit ? commit.slice(0, 7) : null, branch, node: process.version, startedAt: now() };
}
const summary = fp => ({ complete: fp.complete, problems: fp.problems, fileCount: fp.fileCount, commitShort: fp.commitShort, fingerprintShort: fp.short, startedAt: fp.startedAt });
const describe = s => s.complete ? `Build ${s.commitShort || 'commit unknown'} · ${s.fileCount} files · fingerprint ${s.fingerprintShort}` : `Build fingerprint INCOMPLETE: ${s.problems.join('; ')} · commit ${s.commitShort || 'unknown'}`;
module.exports = { fingerprint, summary, describe, REQUIRED, OPTIONAL };
