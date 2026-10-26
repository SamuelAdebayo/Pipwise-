'use strict';
// Twelve Data adapter (server-side). Key comes from TWELVEDATA_API_KEY. Not yet verified against the live API.
const INTERVAL = { '15min': '15min', '1h': '1h', '4h': '4h' };
class ProviderError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
async function fetchCandles({ symbol, tf, outputsize = 400, apiKey = process.env.TWELVEDATA_API_KEY, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!apiKey) throw new ProviderError('no_credentials', 'TWELVEDATA_API_KEY is not set');
  if (!INTERVAL[tf] || !/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol)) throw new ProviderError('bad_input', 'Unsupported symbol or timeframe');
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${INTERVAL[tf]}&outputsize=${outputsize}&order=ASC&timezone=UTC&apikey=${apiKey}`;
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try { res = await fetchImpl(url, { signal: ac.signal }); }
  catch (e) { throw new ProviderError(e.name === 'AbortError' ? 'timeout' : 'network', e.name === 'AbortError' ? 'Provider timed out' : 'Network error'); }
  finally { clearTimeout(timer); }
  if (res.status === 429) throw new ProviderError('rate_limit', 'Rate limit reached');
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'Provider rejected credentials');
  const body = await res.json();
  if (body.status === 'error' || !Array.isArray(body.values)) {
    const kind = body.code === 429 ? 'rate_limit' : body.code === 401 ? 'auth' : 'provider';
    throw new ProviderError(kind, `Provider error: ${body.message || 'unexpected response'}`);
  }
  const candles = body.values.map(v => ({ t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
  return { source: 'twelvedata', symbol, tf, fetchedAt: Date.now(), candles };
}
module.exports = { fetchCandles, ProviderError };
