// ===== Search-API adapters (bench only) =====
// One normalized web-search adapter per provider, so the retrieval eval (run-retrieval.mjs) and the
// end-to-end verify replay (run-verify-replay.mjs, via engines/deepseek.js searchFn) can compare
// backends on the SAME contract. Not shipped in the product path — the Universal edition still uses
// Tavily only (engines/deepseek.js); these adapters exist to answer "is Tavily the right pick?".
//
// Contract (every adapter):
//   async search(query, { k = 5 }) → Array<{ title, url, snippet }>   (empty array on any failure)
// The array also carries, as NON-enumerable properties the runner reads (JSON.stringify still emits a
// clean [{title,url,snippet}] because arrays serialize index keys only):
//   .latencyMs  wall-clock ms of the HTTP call        .status   HTTP status (or null)
//   .error      a message string, or null on success  .shapeError  true iff HTTP 200 but the body did
//                                                                   NOT match the expected shape
//   .provider   the adapter name
//
// Confidence per shape (be honest — the runner flags shapeError adapters on first contact):
//   tavily  VERIFIED         — byte-for-byte the call engines/deepseek.js already ships (proven live).
//   serper  verified-from-knowledge — google.serper.dev, a stable well-known shape.
//   brave   verified-from-knowledge — Brave Search API, a stable well-known shape.
//   bocha   UNVERIFIED SHAPE — 博查, Bing-like nesting assumed; validate on first live run.
//   jina    UNVERIFIED SHAPE — s.jina.ai JSON mode assumed; validate on first live run.
//   exa     UNVERIFIED SHAPE — exa.ai params/response assumed; neural, weak on Chinese — validate.
//
// Node 20 built-in fetch only, no new dependency. Timeout 15s via AbortSignal.timeout.

const TIMEOUT_MS = 15000

// Which env var holds each provider's key (for docs + the runner's "missing key" report).
export const KEY_ENV = {
  tavily: 'TAVILY_API_KEY',
  serper: 'SERPER_API_KEY',
  bocha: 'BOCHA_API_KEY',
  jina: 'JINA_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
}

// Shapes I could not confirm from training knowledge — the runner prints these when they hit shapeError
// so a first live run tells you exactly which adapters to correct against the real response.
export const UNVERIFIED = new Set(['bocha', 'jina', 'exa'])

// Attach the run metadata to the results array without polluting its JSON serialization.
function annotate(results, meta) {
  const arr = Array.isArray(results) ? results : []
  Object.defineProperties(arr, {
    latencyMs: { value: meta.latencyMs ?? null, enumerable: false, configurable: true },
    status: { value: meta.status ?? null, enumerable: false, configurable: true },
    error: { value: meta.error ?? null, enumerable: false, configurable: true },
    shapeError: { value: !!meta.shapeError, enumerable: false, configurable: true },
    provider: { value: meta.provider, enumerable: false, configurable: true },
  })
  return arr
}

// AbortSignal.timeout raises TimeoutError; a manual abort raises AbortError. Report both as a timeout.
function errMsg(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `TIMEOUT ${TIMEOUT_MS / 1000}s 超时`
  return (e && e.message) || String(e)
}

function missingKey(provider) {
  return annotate([], { provider, error: `MISSING_KEY: ${KEY_ENV[provider]} 未设置`, latencyMs: 0 })
}

// ---------------------------------------------------------------------------------------------------
// tavily — VERIFIED. Same request/response as engines/deepseek.js:webSearch (api_key in body, results[].content).
async function tavily(query, { k = 5 } = {}) {
  const key = process.env.TAVILY_API_KEY
  if (!key) return missingKey('tavily')
  const t0 = Date.now()
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: k }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = Date.now() - t0
    if (!r.ok) return annotate([], { provider: 'tavily', status: r.status, error: `HTTP ${r.status}`, latencyMs })
    const j = await r.json()
    if (!Array.isArray(j.results)) {
      return annotate([], { provider: 'tavily', status: r.status, latencyMs, shapeError: true, error: `SHAPE_MISMATCH: tavily — 期望 results[]，实际顶层键 [${Object.keys(j || {}).join(', ')}]` })
    }
    const out = j.results.slice(0, k).map((x) => ({ title: x.title || '', url: x.url || '', snippet: x.content || '' }))
    return annotate(out, { provider: 'tavily', status: r.status, latencyMs })
  } catch (e) {
    return annotate([], { provider: 'tavily', error: errMsg(e), latencyMs: Date.now() - t0 })
  }
}

// ---------------------------------------------------------------------------------------------------
// serper — verified-from-knowledge. Google via serper.dev: POST {q,num,gl,hl}; resp { organic:[{title,link,snippet}] }.
// gl=cn / hl=zh-cn bias toward the Chinese web (this workload is 中文实体核实).
async function serper(query, { k = 5 } = {}) {
  const key = process.env.SERPER_API_KEY
  if (!key) return missingKey('serper')
  const t0 = Date.now()
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: k, gl: 'cn', hl: 'zh-cn' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = Date.now() - t0
    if (!r.ok) return annotate([], { provider: 'serper', status: r.status, error: `HTTP ${r.status}`, latencyMs })
    const j = await r.json()
    if (!Array.isArray(j.organic)) {
      return annotate([], { provider: 'serper', status: r.status, latencyMs, shapeError: true, error: `SHAPE_MISMATCH: serper — 期望 organic[]，实际顶层键 [${Object.keys(j || {}).join(', ')}]` })
    }
    const out = j.organic.slice(0, k).map((x) => ({ title: x.title || '', url: x.link || '', snippet: x.snippet || '' }))
    return annotate(out, { provider: 'serper', status: r.status, latencyMs })
  } catch (e) {
    return annotate([], { provider: 'serper', error: errMsg(e), latencyMs: Date.now() - t0 })
  }
}

// ---------------------------------------------------------------------------------------------------
// bocha — UNVERIFIED SHAPE — validate on first live run.
// Assumed: POST {query,count,summary}; header Authorization: Bearer; resp { data:{ webPages:{ value:[{name,url,snippet,summary}] } } } (Bing-like).
async function bocha(query, { k = 5 } = {}) {
  const key = process.env.BOCHA_API_KEY
  if (!key) return missingKey('bocha')
  const t0 = Date.now()
  try {
    const r = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count: k, summary: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = Date.now() - t0
    if (!r.ok) return annotate([], { provider: 'bocha', status: r.status, error: `HTTP ${r.status}`, latencyMs })
    const j = await r.json()
    const rows = j?.data?.webPages?.value
    if (!Array.isArray(rows)) {
      return annotate([], { provider: 'bocha', status: r.status, latencyMs, shapeError: true, error: `SHAPE_MISMATCH: bocha — 期望 data.webPages.value[]（UNVERIFIED）；实际顶层键 [${Object.keys(j || {}).join(', ')}]` })
    }
    const out = rows.slice(0, k).map((x) => ({ title: x.name || x.title || '', url: x.url || '', snippet: x.summary || x.snippet || '' }))
    return annotate(out, { provider: 'bocha', status: r.status, latencyMs })
  } catch (e) {
    return annotate([], { provider: 'bocha', error: errMsg(e), latencyMs: Date.now() - t0 })
  }
}

// ---------------------------------------------------------------------------------------------------
// jina — UNVERIFIED SHAPE — validate on first live run.
// Assumed: GET https://s.jina.ai/?q=... with Accept: application/json + Authorization: Bearer;
// resp { data:[{title,url,description,content}] }. X-Respond-With: no-content asks for snippets, not full pages.
async function jina(query, { k = 5 } = {}) {
  const key = process.env.JINA_API_KEY
  if (!key) return missingKey('jina')
  const t0 = Date.now()
  try {
    const u = new URL('https://s.jina.ai/')
    u.searchParams.set('q', query)
    const r = await fetch(u, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'X-Respond-With': 'no-content' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = Date.now() - t0
    if (!r.ok) return annotate([], { provider: 'jina', status: r.status, error: `HTTP ${r.status}`, latencyMs })
    const j = await r.json()
    const rows = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.results) ? j.results : null)
    if (!rows) {
      return annotate([], { provider: 'jina', status: r.status, latencyMs, shapeError: true, error: `SHAPE_MISMATCH: jina — 期望 data[]（UNVERIFIED）；实际顶层键 [${Object.keys(j || {}).join(', ')}]` })
    }
    const out = rows.slice(0, k).map((x) => ({
      title: x.title || '',
      url: x.url || '',
      snippet: x.description || x.snippet || (x.content ? String(x.content).slice(0, 500) : ''),
    }))
    return annotate(out, { provider: 'jina', status: r.status, latencyMs })
  } catch (e) {
    return annotate([], { provider: 'jina', error: errMsg(e), latencyMs: Date.now() - t0 })
  }
}

// ---------------------------------------------------------------------------------------------------
// brave — verified-from-knowledge. GET ?q&count; header X-Subscription-Token; resp { web:{ results:[{title,url,description}] } }.
async function brave(query, { k = 5 } = {}) {
  const key = process.env.BRAVE_API_KEY
  if (!key) return missingKey('brave')
  const t0 = Date.now()
  try {
    const u = new URL('https://api.search.brave.com/res/v1/web/search')
    u.searchParams.set('q', query)
    u.searchParams.set('count', String(k))
    const r = await fetch(u, {
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = Date.now() - t0
    if (!r.ok) return annotate([], { provider: 'brave', status: r.status, error: `HTTP ${r.status}`, latencyMs })
    const j = await r.json()
    const rows = j?.web && Array.isArray(j.web.results) ? j.web.results : null
    if (!rows) {
      return annotate([], { provider: 'brave', status: r.status, latencyMs, shapeError: true, error: `SHAPE_MISMATCH: brave — 期望 web.results[]，实际顶层键 [${Object.keys(j || {}).join(', ')}]` })
    }
    const out = rows.slice(0, k).map((x) => ({ title: x.title || '', url: x.url || '', snippet: x.description || '' }))
    return annotate(out, { provider: 'brave', status: r.status, latencyMs })
  } catch (e) {
    return annotate([], { provider: 'brave', error: errMsg(e), latencyMs: Date.now() - t0 })
  }
}

// ---------------------------------------------------------------------------------------------------
// exa — UNVERIFIED SHAPE — validate on first live run.
// Assumed: POST {query,numResults,type,contents:{text:{maxCharacters}}}; header x-api-key;
// resp { results:[{title,url,text,highlights}] }. Exa is neural-first and weaker on Chinese entity lookups.
async function exa(query, { k = 5 } = {}) {
  const key = process.env.EXA_API_KEY
  if (!key) return missingKey('exa')
  const t0 = Date.now()
  try {
    const r = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, numResults: k, type: 'auto', contents: { text: { maxCharacters: 500 } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = Date.now() - t0
    if (!r.ok) return annotate([], { provider: 'exa', status: r.status, error: `HTTP ${r.status}`, latencyMs })
    const j = await r.json()
    if (!Array.isArray(j?.results)) {
      return annotate([], { provider: 'exa', status: r.status, latencyMs, shapeError: true, error: `SHAPE_MISMATCH: exa — 期望 results[]（UNVERIFIED）；实际顶层键 [${Object.keys(j || {}).join(', ')}]` })
    }
    const out = j.results.slice(0, k).map((x) => {
      const hl = Array.isArray(x.highlights) ? x.highlights.join(' … ') : ''
      return { title: x.title || '', url: x.url || '', snippet: hl || (x.text ? String(x.text).slice(0, 500) : '') }
    })
    return annotate(out, { provider: 'exa', status: r.status, latencyMs })
  } catch (e) {
    return annotate([], { provider: 'exa', error: errMsg(e), latencyMs: Date.now() - t0 })
  }
}

export const ADAPTERS = { tavily, serper, bocha, jina, brave, exa }
export const PROVIDERS = Object.keys(ADAPTERS)

// Resolve a provider name to its adapter, or throw a listing error.
export function getAdapter(name) {
  const fn = ADAPTERS[name]
  if (!fn) throw new Error(`未知 provider：${name}（可选：${PROVIDERS.join(', ')}）`)
  return fn
}
