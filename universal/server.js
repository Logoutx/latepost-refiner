#!/usr/bin/env node
// ===== Transcriber-Universal — local web app =====
// A tiny localhost-only HTTP server (Node built-ins only) that serves a browser UI and runs
// the same shared pipeline as the CLI. No Electron, no code-signing, no notarization —
// you just open a page. Bound to 127.0.0.1; the API key the user types stays in memory for
// the run and is never logged or written to disk.
//
//   node universal/server.js          # then open the printed http://127.0.0.1:8765
//   PORT=9000 node universal/server.js
//   NO_OPEN=1 node universal/server.js # don't auto-open the browser

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { runJob, PROVIDERS, PROVIDER_NAMES } from './jobs.js'
import { CATEGORIES } from '../engines/router.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(__dirname, 'web', 'index.html')
const HOST = '127.0.0.1'
const BASE_PORT = Number(process.env.PORT) || 8765
export const API_TOKEN_HEADER = 'x-transcriber-token'
const MODEL_FETCH_TIMEOUT_MS = 10_000
const ANTHROPIC_MODELS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' }

function readBody(req, limit = 96 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

function injectToken(html, token) {
  const boot = `<script>window.__TRANSCRIBER_TOKEN__=${JSON.stringify(token)}</script>`
  return html.replace('<script>', `${boot}\n<script>`)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.protocol === 'http:' && u.host === req.headers.host
  } catch {
    return false
  }
}

function requireApiRequest(req, res, token) {
  if (req.headers[API_TOKEN_HEADER] !== token) {
    json(res, { error: 'forbidden' }, 403)
    return false
  }
  if (!sameOrigin(req)) {
    json(res, { error: 'origin not allowed' }, 403)
    return false
  }
  const ct = String(req.headers['content-type'] || '')
  if (!/^application\/json(?:\s*;|$)/i.test(ct)) {
    json(res, { error: 'content-type must be application/json' }, 415)
    return false
  }
  return true
}

export function sanitizeRunParams(raw = {}) {
  const params = { ...raw }
  delete params.__engine
  delete params.skillDir
  if (params.categories && typeof params.categories === 'object') {
    params.categories = Object.fromEntries(Object.entries(params.categories).map(([key, value]) => {
      const c = value && typeof value === 'object' ? value : {}
      return [key, {
        provider: c.provider,
        apiKey: c.apiKey,
        modelOverride: c.modelOverride,
        tavilyKey: c.tavilyKey,
      }]
    }))
  }
  return params
}

function rememberOpenable(openablePaths, result) {
  if (result && typeof result.outputDir === 'string') openablePaths.add(path.resolve(result.outputDir))
  if (result && typeof result.glossaryPath === 'string') openablePaths.add(path.resolve(result.glossaryPath))
  if (result && typeof result.reviewPath === 'string') openablePaths.add(path.resolve(result.reviewPath))
  if (result && typeof result.manifestPath === 'string') openablePaths.add(path.resolve(result.manifestPath))
}

// provider metadata for the UI (no secrets). `models` = the tier→id map so the UI can
// suggest tool-capable model ids; `nativeSearch` flags whether the provider can do web
// search itself — used for the 联网搜索 hint.
const rawProviderMeta = [
  { name: 'anthropic', label: 'Anthropic', keyEnv: ['ANTHROPIC_API_KEY'], baseURL: '', note: '自带联网搜索。', nativeSearch: true, models: ANTHROPIC_MODELS, modelNote: '' },
  ...PROVIDER_NAMES.map((n) => {
    const ui = {
      deepseek: { note: '精校可用；联网核实需 Tavily。', modelNote: '避免 thinking / reasoner 模型，工具调用会受限。' },
      glm: { note: '自带联网搜索；高级设置可切换 endpoint。', modelNote: '' },
      kimi: { note: '自带联网搜索；.ai / .cn key 不通用。', modelNote: '' },
      openai: { note: '精校可用；联网核实需 Tavily。', modelNote: '' },
    }[n] || {}
    return { name: n, label: PROVIDERS[n].label, keyEnv: PROVIDERS[n].keyEnv, baseURL: PROVIDERS[n].baseURL, altBaseURL: PROVIDERS[n].altBaseURL || '', note: ui.note || PROVIDERS[n].note || '', nativeSearch: !!PROVIDERS[n].nativeSearch, models: PROVIDERS[n].models, modelNote: ui.modelNote || '' }
  }),
]

function uniqEntries(entries) {
  const seen = new Set()
  const out = []
  for (const entry of entries || []) {
    const id = String(entry && entry.id ? entry.id : '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: String(entry.label || entry.display_name || entry.name || id),
      ownedBy: entry.ownedBy || entry.owned_by || undefined,
      created: Number(entry.created || entry.created_at || 0) || undefined,
    })
  }
  return out
}

function modelEntriesFromTiers(models = {}) {
  return uniqEntries(Object.values(models).map((id) => ({ id })))
}

function isLikelyTextModel(id) {
  return !/(embedding|embed|whisper|tts|speech|audio|transcrib|dall|image|vision|moderation|rerank|clip|realtime)/i.test(id)
}

function roleScore(provider, role, id) {
  const s = String(id || '').toLowerCase()
  if (!s || !isLikelyTextModel(s)) return -1_000
  let score = 0

  if (/(deprecated|legacy|preview|beta)/.test(s)) score -= 10
  if (/(reasoner|thinking|r1|o1|o3|o4)/.test(s)) score -= provider === 'deepseek' ? 180 : 55
  if (/(opus|pro|max|ultra|large|5\.5|k2\.6)/.test(s)) score -= role === 'smart' ? 15 : 65
  if (/(haiku|flash(?!x)|nano|mini|lite|small|turbo|chat|k2\.5)/.test(s)) score += 45
  if (/(sonnet|flashx|plus|air)/.test(s)) score += role === 'cheap' ? 20 : 75

  if (role === 'cheap') {
    if (/(haiku|flash(?!x)|nano|mini|lite|small|turbo)/.test(s)) score += 80
    if (/(sonnet|plus|flashx)/.test(s)) score += 20
  } else if (role === 'balanced') {
    if (/(sonnet|flashx|mini|plus|air|chat|k2\.5)/.test(s)) score += 75
    if (/(haiku|flash(?!x)|nano|lite)/.test(s)) score += 45
  } else {
    if (/(sonnet|mini|flashx|plus|k2\.5|chat)/.test(s)) score += 90
    if (/(haiku|flash(?!x)|nano|lite)/.test(s)) score += 45
    if (/(opus|pro|5\.5|k2\.6)/.test(s)) score += 25
  }

  if (provider === 'anthropic') {
    if (/haiku/.test(s)) score += role === 'cheap' ? 100 : 35
    if (/sonnet/.test(s)) score += role === 'cheap' ? 45 : 115
    if (/opus/.test(s)) score += role === 'smart' ? 30 : -40
  } else if (provider === 'deepseek') {
    if (/v4-flash|flash/.test(s)) score += 115
    if (/deepseek-chat|chat/.test(s)) score += 85
    if (/v4-pro|pro/.test(s)) score += role === 'smart' ? 25 : -25
  } else if (provider === 'glm') {
    if (/flashx/.test(s)) score += role === 'cheap' ? 55 : 105
    if (/flash(?!x)/.test(s)) score += role === 'cheap' ? 115 : 60
  } else if (provider === 'kimi') {
    if (/k2\.5/.test(s)) score += 110
    if (/k2\.6/.test(s)) score += role === 'smart' ? 35 : -30
  } else if (provider === 'openai') {
    if (/mini/.test(s)) score += 120
    if (/nano/.test(s)) score += role === 'cheap' ? 105 : 35
  }

  return score
}

function sortByScore(provider, role, entries) {
  return [...entries]
    .map((entry) => ({ entry, score: roleScore(provider, role, entry.id) }))
    .filter((x) => x.score > -500)
    .sort((a, b) => b.score - a.score || (b.entry.created || 0) - (a.entry.created || 0) || b.entry.id.localeCompare(a.entry.id, 'en', { numeric: true }))
    .map((x) => x.entry)
}

function pickModel(provider, role, entries, fallback) {
  const ranked = sortByScore(provider, role, entries)
  return (ranked[0] && ranked[0].id) || fallback || (entries[0] && entries[0].id)
}

function costEffectiveDefaults(provider, entries, fallbackModels = {}) {
  const fallbackCheap = fallbackModels.haiku || fallbackModels.sonnet || fallbackModels.opus
  const fallbackBalanced = fallbackModels.sonnet || fallbackCheap
  const fallbackSmart = fallbackModels.sonnet || fallbackModels.opus || fallbackBalanced
  const cheap = pickModel(provider, 'cheap', entries, fallbackCheap)
  const balanced = pickModel(provider, 'balanced', entries, fallbackBalanced)
  const smart = pickModel(provider, 'smart', entries, fallbackSmart)
  return {
    stage: {
      scout: cheap,
      verify: balanced,
      dedup: balanced,
      refine: smart,
      logic: smart,
      summary: smart,
      timeline: smart,
    },
    category: {
      mechanical: cheap,
      web: balanced,
      correction: balanced,
      smart,
    },
  }
}

function withModelDefaults(meta) {
  const entries = modelEntriesFromTiers(meta.models)
  return { ...meta, costEffective: costEffectiveDefaults(meta.name, entries, meta.models) }
}

const providerMeta = rawProviderMeta.map(withModelDefaults)

function providerByName(name) {
  return providerMeta.find((p) => p.name === String(name || '').toLowerCase())
}

function normalizeFetchedModels(data) {
  const raw = Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : []
  return uniqEntries(raw.map((m) => ({
    id: m && (m.id || m.name || m.model),
    label: m && (m.display_name || m.label || m.name || m.id),
    ownedBy: m && m.owned_by,
    created: m && (m.created || (m.created_at ? Date.parse(m.created_at) / 1000 : 0)),
  }))).filter((m) => isLikelyTextModel(m.id))
}

function modelListRequest(meta, { apiKey, baseURL } = {}) {
  if (meta.name === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }
  }
  const rawBase = String(baseURL || meta.baseURL || '').trim()
  const base = new URL(rawBase)
  if (!/^https?:$/.test(base.protocol)) throw new Error('baseURL 只支持 http/https')
  const url = new URL(base.href.replace(/\/+$/, '') + '/models')
  return { url: url.href, headers: { Authorization: `Bearer ${apiKey}` } }
}

function fallbackModelCatalog(meta, warning) {
  const models = modelEntriesFromTiers(meta.models)
  return {
    provider: meta.name,
    source: 'fallback',
    models,
    defaults: costEffectiveDefaults(meta.name, models, meta.models),
    warning,
  }
}

export async function fetchProviderModels({ provider, apiKey, baseURL, fetchImpl = fetch } = {}) {
  const meta = providerByName(provider)
  if (!meta) throw new Error(`未知 provider「${provider || ''}」`)
  if (!apiKey) return fallbackModelCatalog(meta, '未填 API Key，使用内置推荐。')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS)
  try {
    const req = modelListRequest(meta, { apiKey, baseURL })
    const res = await fetchImpl(req.url, { method: 'GET', headers: req.headers, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const models = normalizeFetchedModels(data)
    if (!models.length) throw new Error('响应里没有文本模型')
    return {
      provider: meta.name,
      source: 'provider',
      models,
      defaults: costEffectiveDefaults(meta.name, models, meta.models),
    }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '请求超时' : e.message
    return fallbackModelCatalog(meta, `模型列表不可用，已使用内置推荐：${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

export function createAppServer({ token = crypto.randomBytes(32).toString('hex'), runJobImpl = runJob, openImpl = (p) => execFile('open', [p], () => {}), fetchImpl = fetch } = {}) {
  let running = false // serialize runs (single-user local tool; avoids env races + contention)
  const openablePaths = new Set()
  const server = http.createServer(async (req, res) => {
    const { url, method } = req
    try {
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = injectToken(fs.readFileSync(INDEX, 'utf8'), token)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
      }
      if (method === 'GET' && url === '/api/providers') return json(res, { providers: providerMeta, categories: CATEGORIES })

      if (method === 'POST' && url === '/api/models') {
        if (!requireApiRequest(req, res, token)) return
        const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'))
        const result = await fetchProviderModels({
          provider: body && body.provider,
          apiKey: body && body.apiKey,
          baseURL: body && body.baseURL,
          fetchImpl,
        })
        return json(res, result)
      }

      if (method === 'POST' && url === '/api/run') {
        if (!requireApiRequest(req, res, token)) return
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        if (running) { send('error', { message: '已有任务在运行，请等待其完成。' }); send('done', {}); return res.end() }
        running = true
        try {
          const params = sanitizeRunParams(JSON.parse((await readBody(req)).toString('utf8')))
          send('phase', { title: '启动' })
          const result = await runJobImpl(params, {
            onPhase: (t) => send('phase', { title: t }),
            onLog: (m) => send('log', { message: m }),
          })
          rememberOpenable(openablePaths, result)
          send('result', result)
        } catch (e) {
          send('error', { message: e.message })
        } finally {
          running = false
          send('done', {})
          res.end()
        }
        return
      }

      if (method === 'POST' && url === '/api/open') {
        if (!requireApiRequest(req, res, token)) return
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const p = body && body.path
        const abs = typeof p === 'string' ? path.resolve(p) : ''
        if (abs && openablePaths.has(abs) && fs.existsSync(abs)) { openImpl(abs); return json(res, { ok: true }) }
        return json(res, { ok: false, error: '路径不可打开或不存在' }, 400)
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (e) {
      json(res, { error: e.message }, 500)
    }
  })
  server.apiToken = token
  return server
}

// Bind, retrying a few ports if the default is taken.
export function listen(port, attempts = 10) {
  const server = createAppServer()
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempts > 0) { listen(port + 1, attempts - 1) }
    else { console.error('启动失败：', e.message); process.exit(1) }
  })
  server.listen(port, HOST, () => {
    const u = `http://${HOST}:${port}`
    console.error(`\n  访谈转录精校 · 本地网页版`)
    console.error(`  ${u}\n`)
    console.error('  打开上面的地址即可使用。Ctrl-C 退出。')
    console.error('  说明：API key 在你本机浏览器输入、只在本次运行内存中使用，不落盘、不外传、不记录。\n')
    // auto-open the browser only for an interactive launch (terminal / .command), not when
    // run non-interactively (piped, CI, a preview harness) — and never when NO_OPEN is set.
    if (!process.env.NO_OPEN && process.stdout.isTTY) execFile('open', [u], () => {})
  })
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) listen(BASE_PORT)
