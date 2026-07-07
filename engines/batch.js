// ===== Anthropic Message Batches client (M11b) =====
// Zero-dependency HTTP client over the Message Batches API, used by scripts/batch_refine.mjs to run single-shot
// refine payloads at the batch tier (50% price; results typically < 1h). Deliberately NOT the SDK: batching is a
// long-lived, out-of-band, resumable flow (submit → persist state → poll for up to an hour → fetch a .jsonl),
// so a tiny explicit client keeps the state-file contract and the offline-testability obvious. The fetcher is
// INJECTABLE (constructor param, default globalThis.fetch) so every test runs offline with a fake fetch and no
// API key. Endpoints (docs.claude.com/en/api/creating-message-batches):
//   POST /v1/messages/batches          → { id, processing_status, results_url, request_counts, ... }
//   GET  /v1/messages/batches/{id}     → same shape; processing_status ∈ 'in_progress'|'canceling'|'ended'
//   GET  results_url                   → JSONL, one {custom_id, result:{type, message|error}} per line
// Headers mirror the SDK: x-api-key, anthropic-version: 2023-06-01, content-type: application/json.

export const ANTHROPIC_VERSION = '2023-06-01'
export const DEFAULT_BASE_URL = 'https://api.anthropic.com'

// Resolve the base URL exactly as the SDK does (client.js:68/88): the ANTHROPIC_BASE_URL env var if set, else
// the public endpoint — with any trailing slashes stripped so path joining never doubles a '/'. A test that
// wants determinism passes baseURL explicitly and never depends on the ambient env.
export function resolveBaseURL(baseURL, env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = baseURL || (env && env.ANTHROPIC_BASE_URL) || DEFAULT_BASE_URL
  return String(raw).replace(/\/+$/, '')
}

// Parse a JSONL body (batch results file) into an array of objects. Blank lines are skipped; a malformed line
// throws (a truncated results file is a real error we must surface, not silently drop). Exported for tests.
export function parseJSONL(text) {
  const out = []
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim()
    if (!line) continue
    out.push(JSON.parse(line))
  }
  return out
}

// Extract the plain response text from a batch individual-response `result`. Mirrors the succeeded/errored/
// canceled/expired union (batches.d.ts MessageBatchResult). Returns { customId, ok, text?, error? } — text is the
// concatenation of the message's `text` content blocks (what a single-shot refine returns); a non-succeeded
// result yields ok:false with a human-readable error string.
export function resultToOutput(row) {
  const customId = row && row.custom_id
  const result = row && row.result
  const type = result && result.type
  if (type === 'succeeded') {
    const blocks = (result.message && result.message.content) || []
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim()
    return { customId, ok: true, text }
  }
  if (type === 'errored') {
    const err = result.error && (result.error.error || result.error)
    const msg = (err && (err.message || err.type)) || 'unknown error'
    return { customId, ok: false, error: `errored: ${msg}` }
  }
  return { customId, ok: false, error: type ? `${type}` : 'unknown result' }
}

export class BatchClient {
  // opts: { apiKey, baseURL?, fetch?, version? }. fetch defaults to globalThis.fetch (real HTTP); tests inject a
  // fake. apiKey is required only for real calls — a fake fetch ignores it, so offline tests may pass anything.
  constructor(opts = {}) {
    this.apiKey = opts.apiKey
    this.baseURL = resolveBaseURL(opts.baseURL, opts.env)
    this.version = opts.version || ANTHROPIC_VERSION
    this.fetch = opts.fetch || (typeof globalThis !== 'undefined' && globalThis.fetch)
    if (typeof this.fetch !== 'function') throw new Error('BatchClient: 无可用 fetch（请注入 opts.fetch 或在支持 global fetch 的运行时里运行）')
  }

  headers(extra) {
    return Object.assign({
      'x-api-key': this.apiKey || '',
      'anthropic-version': this.version,
      'content-type': 'application/json',
    }, extra || {})
  }

  // Shared request helper: throws on a non-2xx (with status + body snippet), else returns the parsed JSON.
  async request(method, url, body) {
    const res = await this.fetch(url, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(`Anthropic Batches ${method} ${url} → HTTP ${res.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`)
    }
    return res.json()
  }

  // submitBatch(requests): POST /v1/messages/batches. `requests` = [{ custom_id, params }] where params is a
  // Messages create body (a single-shot refine payload). Returns the created MessageBatch ({ id, ... }). Guards
  // that custom_ids are present + unique (a dup silently collapses two files' results — catch it before the wire).
  async submitBatch(requests) {
    const list = requests || []
    if (!list.length) throw new Error('submitBatch: requests 为空')
    const seen = new Set()
    for (const r of list) {
      const id = r && r.custom_id
      if (!id) throw new Error('submitBatch: 每个 request 必须有 custom_id')
      if (seen.has(id)) throw new Error(`submitBatch: custom_id 重复「${id}」（每个请求的 custom_id 必须唯一）`)
      seen.add(id)
    }
    return this.request('POST', `${this.baseURL}/v1/messages/batches`, { requests: list })
  }

  // pollBatch(id): GET /v1/messages/batches/{id}. Returns the MessageBatch; caller inspects processing_status
  // ('in_progress' | 'canceling' | 'ended') and results_url (populated once ended).
  async pollBatch(id) {
    if (!id) throw new Error('pollBatch: 缺少 batch id')
    return this.request('GET', `${this.baseURL}/v1/messages/batches/${encodeURIComponent(id)}`)
  }

  // fetchResults(resultsUrl): GET the .jsonl results file and map each line → { customId, ok, text|error } via
  // resultToOutput. results_url is an absolute URL returned by the API; we fetch it with the same auth headers.
  // Returns { byCustomId: Map, rows: [...] } so callers can look up per-file output and iterate errors.
  async fetchResults(resultsUrl) {
    if (!resultsUrl) throw new Error('fetchResults: 缺少 results_url')
    const res = await this.fetch(resultsUrl, { method: 'GET', headers: this.headers() })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* ignore */ }
      throw new Error(`Anthropic Batches GET ${resultsUrl} → HTTP ${res.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`)
    }
    const text = await res.text()
    const rows = parseJSONL(text).map(resultToOutput)
    const byCustomId = new Map()
    for (const r of rows) if (r.customId != null) byCustomId.set(r.customId, r)
    return { byCustomId, rows }
  }
}
