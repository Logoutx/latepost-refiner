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
const providerMeta = [
  { name: 'anthropic', label: 'Anthropic（默认，自带联网搜索）', keyEnv: ['ANTHROPIC_API_KEY'], baseURL: '', note: '', nativeSearch: true, models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' }, modelNote: '' },
  ...PROVIDER_NAMES.map((n) => ({ name: n, label: PROVIDERS[n].label, keyEnv: PROVIDERS[n].keyEnv, baseURL: PROVIDERS[n].baseURL, altBaseURL: PROVIDERS[n].altBaseURL || '', note: PROVIDERS[n].note || '', nativeSearch: !!PROVIDERS[n].nativeSearch, models: PROVIDERS[n].models, modelNote: n === 'deepseek' ? '只用 deepseek-chat（支持工具调用）；v4-pro/flash 默认思考模式、不支持工具，本流程勿用' : '' })),
]

export function createAppServer({ token = crypto.randomBytes(32).toString('hex'), runJobImpl = runJob, openImpl = (p) => execFile('open', [p], () => {}) } = {}) {
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
