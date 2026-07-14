#!/usr/bin/env node
// ===== LatePost-Refiner Universal — local web app =====
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
import { runJob } from './jobs.js'
import { getIndexHtml } from './assets.js'

const HOST = '127.0.0.1'
const BASE_PORT = Number(process.env.PORT) || 8765
export const API_TOKEN_HEADER = 'x-transcriber-token'

// PWA manifest + icon so the GUI installs as a local app (Chrome "Install" / Safari "Add to Dock") — a real
// Dock icon and a chromeless standalone window. Served inline (Node built-ins only; no static-file dir).
const WEB_MANIFEST = JSON.stringify({
  name: '访谈转录精校', short_name: '访谈精校', description: '本地访谈转录精校工具',
  start_url: '/', scope: '/', display: 'standalone',
  background_color: '#f6f5f2', theme_color: '#f6f5f2',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
})
const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#b4532a"/>
  <g fill="#fff">
    <rect x="146" y="170" width="220" height="30" rx="15"/>
    <rect x="146" y="236" width="158" height="30" rx="15"/>
    <rect x="146" y="302" width="196" height="30" rx="15"/>
    <rect x="146" y="368" width="112" height="30" rx="15"/>
  </g>
</svg>`

// Chromium-family browsers all support --app=<url> for a chromeless standalone window. [.app folder, executable]
// — usually identical, listed explicitly so a rename can't silently break detection.
const CHROMIUM_APPS = [
  ['Google Chrome', 'Google Chrome'], ['Microsoft Edge', 'Microsoft Edge'],
  ['Brave Browser', 'Brave Browser'], ['Vivaldi', 'Vivaldi'], ['Chromium', 'Chromium'],
]
// Open the GUI as a local app: a chromeless --app window in the first installed Chromium browser; else a normal
// tab in the default browser (Safari/Firefox have no command-line app mode → they degrade to a tab, which is
// the prior behaviour). Set NO_APP_WINDOW=1 to force a plain tab. Returns the browser name, or null on fallback.
function openLocalApp(url) {
  if (!process.env.NO_APP_WINDOW) {
    for (const [app, exec] of CHROMIUM_APPS) {
      const bin = `/Applications/${app}.app/Contents/MacOS/${exec}`
      if (fs.existsSync(bin)) {
        try { const c = execFile(bin, [`--app=${url}`], { detached: true }, () => {}); c.unref(); return app } catch { /* fall through to a tab */ }
      }
    }
  }
  execFile('open', [url], () => {})
  return null
}

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
  return params
}

function rememberOpenable(openablePaths, result) {
  if (result && typeof result.outputDir === 'string') openablePaths.add(path.resolve(result.outputDir))
  if (result && typeof result.glossaryPath === 'string') openablePaths.add(path.resolve(result.glossaryPath))
  if (result && typeof result.reviewPath === 'string') openablePaths.add(path.resolve(result.reviewPath))
  if (result && typeof result.manifestPath === 'string') openablePaths.add(path.resolve(result.manifestPath))
}

export function createAppServer({ token = crypto.randomBytes(32).toString('hex'), runJobImpl = runJob, openImpl = (p) => execFile('open', [p], () => {}) } = {}) {
  let running = false // serialize runs (single-user local tool; avoids env races + contention)
  const openablePaths = new Set()
  const server = http.createServer(async (req, res) => {
    const { url, method } = req
    try {
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = injectToken(getIndexHtml(), token)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
      }
      if (method === 'GET' && url === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' })
        return res.end(WEB_MANIFEST)
      }
      if (method === 'GET' && url === '/icon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=86400' })
        return res.end(APP_ICON_SVG)
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
    // auto-open as a local app window (chromeless) for an interactive launch (terminal / .command), not when
    // run non-interactively (piped, CI, a preview harness) — and never when NO_OPEN is set.
    if (!process.env.NO_OPEN && process.stdout.isTTY) {
      const app = openLocalApp(u)
      console.error(app ? `  已用 ${app} 打开独立应用窗口（非浏览器标签页）。\n` : '  已在默认浏览器打开。\n')
    }
  })
  return server
}

// Auto-start when run directly as a Node script (`node universal/server.js`, the
// latepost-refiner-web bin, launch.command). Skipped under the Bun runtime: the compiled binary
// starts via universal/bin-web.js, and Bun makes this entry check match even for the imported
// module, which would otherwise bind a second server on the next port.
if (!process.isBun && process.argv[1] === fileURLToPath(import.meta.url)) listen(BASE_PORT)
