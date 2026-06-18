import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API_TOKEN_HEADER, createAppServer, sanitizeRunParams } from '../universal/server.js'

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
