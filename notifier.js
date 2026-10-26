'use strict';
// Telegram delivery. The bot token stays on the server and is never logged or returned to the browser.
async function tg(method, token, body, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`Telegram error ${res.status}`);
  return j.result;
}
const send = (o, text) => tg('sendMessage', o.token, { chat_id: o.chatId, text: String(text).slice(0, 3500) }, o.fetchImpl);
async function discoverChatId(token, fetchImpl) {
  const u = await tg('getUpdates', token, {}, fetchImpl), m = [...u].reverse().find(x => x.message && x.message.chat);
  return m ? String(m.message.chat.id) : null;
}
function createDelivery({ store, token, chatId, types = ['new_signal', 'outcome', 'api_error'], fetchImpl }) {
  return async function deliver() {
    if (!token || !chatId) return 0; let n = 0;
    for (const a of store.unsentAlerts(10)) {
      if (!types.includes(a.type)) { store.markSent(a.id); continue; } // in-app only
      try { await send({ token, chatId, fetchImpl }, `Pipwise: ${a.message}`); store.markSent(a.id); n++; } catch { break; } // retry on the next tick
    }
    return n;
  };
}
module.exports = { send, discoverChatId, createDelivery };
