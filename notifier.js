'use strict';
// Telegram delivery. The bot token stays on the server and is never logged or returned to the browser.
async function tg(method, token, body, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) { // never include the URL or token in the message
    const why = res.status === 401 ? 'the bot token was rejected' : res.status === 404 ? 'the bot was not found: the token is mistyped, incomplete or revoked' : (j.description || 'request failed');
    throw new Error(`Telegram error ${res.status}: ${why}`);
  }
  return j.result;
}
const send = (o, text) => tg('sendMessage', o.token, { chat_id: o.chatId, text: String(text).slice(0, 3500) }, o.fetchImpl);
async function discoverChatId(token, fetchImpl) {
  const u = await tg('getUpdates', token, {}, fetchImpl), m = [...u].reverse().find(x => x.message && x.message.chat);
  return m ? String(m.message.chat.id) : null;
}
// Cleans the token from the environment (quotes, spaces, a leading "bot") and says what is wrong without ever repeating it.
function checkToken(raw) {
  let t = String(raw || '').replace(/\s+/g, '').replace(/^["']+|["']+$/g, '').replace(/^bot/i, ''); const problems = [];
  if (t) {
    const i = t.indexOf(':');
    if (i < 0) problems.push('there is no colon (a token is digits, a colon, then letters and digits)');
    else { if (!/^\d{5,}$/.test(t.slice(0, i))) problems.push('the part before the colon should be only digits'); if (!/^[A-Za-z0-9_-]{30,}$/.test(t.slice(i + 1))) problems.push('the part after the colon is too short or has odd characters (copy the whole token)'); }
  }
  return { token: problems.length ? '' : t, problems };
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
module.exports = { checkToken, send, discoverChatId, createDelivery };
