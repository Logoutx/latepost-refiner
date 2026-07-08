import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API_TOKEN_HEADER, createAppServer, fetchProviderModels, sanitizeRunParams } from '../universal/server.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-server-'))
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function request(port, method, url, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('sanitizeRunParams drops web-only dangerous fields', () => {
  const params = sanitizeRunParams({
    skillDir: '/',
    __engine: { anything: true },
    categories: {
      web: { provider: 'openai', apiKey: 'k', modelOverride: 'm', tavilyKey: 't', baseURL: 'http://attacker.test', extra: 'x' },
    },
  })
  assert.equal(params.skillDir, undefined)
  assert.equal(params.__engine, undefined)
  assert.deepEqual(params.categories.web, { provider: 'openai', apiKey: 'k', modelOverride: 'm', tavilyKey: 't' })
})

test('served HTML embeds the per-session API token', async () => {
  const server = createAppServer({ token: 'test-token' })
  const port = await listen(server)
  try {
    const res = await request(port, 'GET', '/')
    assert.equal(res.status, 200)
    assert.match(res.body, /window\.__TRANSCRIBER_TOKEN__="test-token"/)
  } finally {
    await close(server)
  }
})

test('serves a PWA manifest and an SVG icon so the GUI installs as a local app', async () => {
  const server = createAppServer({ token: 't' })
  const port = await listen(server)
  try {
    const m = await request(port, 'GET', '/manifest.webmanifest')
    assert.equal(m.status, 200)
    assert.match(m.headers['content-type'], /manifest\+json/)
    const mf = JSON.parse(m.body)
    assert.equal(mf.display, 'standalone')
    assert.ok(mf.name && mf.icons.length, 'manifest has a name and icons')
    assert.equal(mf.icons[0].src, '/icon.svg')
    const i = await request(port, 'GET', '/icon.svg')
    assert.equal(i.status, 200)
    assert.match(i.headers['content-type'], /image\/svg\+xml/)
    assert.match(i.body, /^<svg/)
  } finally {
    await close(server)
  }
})

test('served HTML links the manifest, icon and theme-color (installable head)', async () => {
  const server = createAppServer({ token: 't' })
  const port = await listen(server)
  try {
    const res = await request(port, 'GET', '/')
    assert.match(res.body, /rel="manifest" href="\/manifest\.webmanifest"/)
    assert.match(res.body, /rel="icon" href="\/icon\.svg"/)
    assert.match(res.body, /name="theme-color"/)
  } finally {
    await close(server)
  }
})

test('API rejects untokened, non-JSON, and cross-origin run requests', async () => {
  let called = false
  const token = 'secret-token'
  const server = createAppServer({ token, runJobImpl: async () => { called = true; return { refined: [], outputDir: tmpdir() } } })
  const port = await listen(server)
  try {
    const noToken = await request(port, 'POST', '/api/run', { headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(noToken.status, 403)

    const textPlain = await request(port, 'POST', '/api/run', { headers: { [API_TOKEN_HEADER]: token, 'Content-Type': 'text/plain' }, body: '{}' })
    assert.equal(textPlain.status, 415)

    const wrongOrigin = await request(port, 'POST', '/api/run', {
      headers: { [API_TOKEN_HEADER]: token, 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: '{}',
    })
    assert.equal(wrongOrigin.status, 403)
    assert.equal(called, false)
  } finally {
    await close(server)
  }
})

test('fetchProviderModels calls OpenAI-compatible /models and picks cost-effective defaults', async () => {
  let called
  const result = await fetchProviderModels({
    provider: 'openai',
    apiKey: 'sk-test',
    fetchImpl: async (url, options) => {
      called = { url, options }
      return {
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'text-embedding-3-large', object: 'model' },
            { id: 'gpt-5.5', object: 'model', created: 200 },
            { id: 'gpt-5.4-mini', object: 'model', created: 100 },
          ],
        }),
      }
    },
  })

  assert.equal(called.url, 'https://api.openai.com/v1/models')
  assert.equal(called.options.headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(result.models.map((m) => m.id), ['gpt-5.5', 'gpt-5.4-mini'])
  // smart (精校与总结) must land on the provider's strong chat tier (opus = gpt-5.5), not the
  // cheaper gpt-5.4-mini — cheap tiers over-compress long transcripts in the refine stage.
  assert.equal(result.defaults.stage.refine, 'gpt-5.5')
  assert.equal(result.defaults.category.smart, 'gpt-5.5')
})

test('fetchProviderModels uses Anthropic model-list headers', async () => {
  let called
  const result = await fetchProviderModels({
    provider: 'anthropic',
    apiKey: 'anthropic-key',
    fetchImpl: async (url, options) => {
      called = { url, options }
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-opus-4-8', display_name: 'Claude Opus' },
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet' },
            { id: 'claude-haiku-4-5', display_name: 'Claude Haiku' },
          ],
        }),
      }
    },
  })

  assert.equal(called.url, 'https://api.anthropic.com/v1/models')
  assert.equal(called.options.headers['x-api-key'], 'anthropic-key')
  assert.equal(called.options.headers['anthropic-version'], '2023-06-01')
  assert.equal(result.defaults.stage.scout, 'claude-haiku-4-5')
  // smart must be the strong tier (opus = claude-opus-4-8), never the cheaper sonnet pick.
  assert.equal(result.defaults.stage.refine, 'claude-opus-4-8')
  assert.equal(result.defaults.category.smart, 'claude-opus-4-8')
})

test('built-in cost-effective defaults keep cheap GLM flash separate from flashx', async () => {
  const result = await fetchProviderModels({ provider: 'glm' })

  assert.equal(result.source, 'fallback')
  assert.equal(result.defaults.stage.scout, 'glm-4.7-flash')
  // smart (精校与总结) must never default to the cheapest/flash-class pick when a stronger chat
  // model (the provider registry's opus tier, glm-5.2) is present in the catalog — this is the
  // regression this fix targets: 更新默认模型 used to fill smart with the cheapest flash tier.
  assert.equal(result.defaults.stage.refine, 'glm-5.2')
  assert.equal(result.defaults.category.smart, 'glm-5.2')
  assert.notEqual(result.defaults.category.smart, result.defaults.stage.scout)
})

test('smart-category default picks the stronger chat model over a flash-class model in a live catalog', async () => {
  // A live/fetched catalog containing both a flash-class model and a stronger chat model: the
  // smart default must resolve to the stronger one, never the cheapest pick — this is the core
  // regression check for the 更新默认模型 bug (mixed/按任务分配 mode filled all four categories,
  // including 精校与总结, with the provider's cheapest flash tier).
  const result = await fetchProviderModels({
    provider: 'glm',
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'glm-4.7-flash', object: 'model' },
          { id: 'glm-4.7-flashx', object: 'model' },
          { id: 'glm-5.2', object: 'model' },
        ],
      }),
    }),
  })

  assert.equal(result.source, 'provider')
  assert.equal(result.defaults.category.mechanical, 'glm-4.7-flash')
  assert.equal(result.defaults.category.smart, 'glm-5.2')
  assert.notEqual(result.defaults.category.smart, result.defaults.category.mechanical)
})

test('API exposes protected model catalog without leaking keys', async () => {
  const token = 'secret-token'
  let sawAuth
  const server = createAppServer({
    token,
    fetchImpl: async (_url, options) => {
      sawAuth = options.headers.Authorization
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'deepseek-v4-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] }),
      }
    },
  })
  const port = await listen(server)
  const headers = { [API_TOKEN_HEADER]: token, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }
  try {
    const blocked = await request(port, 'POST', '/api/models', { headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(blocked.status, 403)

    const ok = await request(port, 'POST', '/api/models', {
      headers,
      body: JSON.stringify({ provider: 'deepseek', apiKey: 'deepseek-key' }),
    })
    assert.equal(ok.status, 200)
    const body = JSON.parse(ok.body)
    assert.equal(sawAuth, 'Bearer deepseek-key')
    assert.equal(body.defaults.stage.refine, 'deepseek-v4-pro') // registry default since 2026-07-07: writing stages ride v4-pro
    assert.equal(ok.body.includes('deepseek-key'), false)
  } finally {
    await close(server)
  }
})

test('API accepts same-origin tokened run requests and only opens returned output paths', async () => {
  const token = 'secret-token'
  const outputDir = tmpdir()
  const otherDir = tmpdir()
  let capturedParams
  let openedPath
  const server = createAppServer({
    token,
    runJobImpl: async (params) => {
      capturedParams = params
      return {
        refined: [],
        failed: [],
        incomplete: [],
        unchecked: [],
        scoutSuspect: [],
        headingConflicts: [],
        suspectedDuplicates: [],
        networkUnverified: [],
        outputDir,
        provider: 'mock',
        providerInfo: { label: 'Mock' },
        usage: { agents: 0, input: 0, output: 0 },
      }
    },
    openImpl: (p) => { openedPath = p },
  })
  const port = await listen(server)
  const headers = { [API_TOKEN_HEADER]: token, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }
  try {
    const run = await request(port, 'POST', '/api/run', {
      headers,
      body: JSON.stringify({ topic: 'T', skillDir: '/', categories: { web: { provider: 'openai', apiKey: 'k', baseURL: 'http://attacker.test' } } }),
    })
    assert.equal(run.status, 200)
    assert.match(run.body, /event: result/)
    assert.equal(capturedParams.skillDir, undefined)
    assert.equal(capturedParams.categories.web.baseURL, undefined)

    const blockedOpen = await request(port, 'POST', '/api/open', { headers, body: JSON.stringify({ path: otherDir }) })
    assert.equal(blockedOpen.status, 400)

    const okOpen = await request(port, 'POST', '/api/open', { headers, body: JSON.stringify({ path: outputDir }) })
    assert.equal(okOpen.status, 200)
    assert.equal(openedPath, outputDir)
  } finally {
    await close(server)
  }
})
