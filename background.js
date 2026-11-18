'use strict';
// Runs the background steps one after another. A step that fails is recorded (name, message, time) and raises an alert, and the other steps still run.
// Cycles never overlap. snapshot() is what the health page shows.
function createBackground({ store, steps, now = Date.now }) {
  const state = { startedAt: now(), cycles: 0, lastCycleAt: null, lastCycleMs: null, steps: Object.fromEntries(steps.map(s => [s.name, { runs: 0, errors: 0, lastOk: null, lastError: null, lastStart: null, lastEnd: null, lastMs: null }])) };
  let running = false;
  async function cycle() {
    if (running) return { skipped: 'busy' }; running = true; const t0 = now();
    try {
      for (const s of steps) {
        const st = state.steps[s.name]; st.lastStart = now();
        try { await s.run(); st.lastOk = true; st.lastError = null; }
        catch (e) { st.lastOk = false; st.errors++; st.lastError = String((e && e.message) || e).slice(0, 300); store.addAlert(`system:${s.name}:${Math.floor(now() / 3600000)}`, 'system_error', `Background step "${s.name}" failed: ${st.lastError}`, now()); }
        finally { st.runs++; st.lastEnd = now(); st.lastMs = st.lastEnd - st.lastStart; }
      }
      state.cycles++; state.lastCycleAt = now(); state.lastCycleMs = now() - t0;
    } finally { running = false; }
    return { ok: true };
  }
  return { cycle, snapshot: () => ({ ...state, running }) };
}
module.exports = { createBackground };
