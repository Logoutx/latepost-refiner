import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWebRuntime, normalizeSearchQuery, canonicalWebUrl, isPublicIp, validateUrlShape, WEB_TELEMETRY_FIELDS } from '../engines/web.js'

function headers(values = {}) {
  const map = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return { get: (k) => map.get(String(k).toLowerCase()) || null }
}
function response({ status = 200, json, text = '', headers: hs = {} } = {}) {
  return {
    status, ok: status >= 200 && status < 300, headers: headers(hs),
    json: async () => (typeof json === 'function' ? json() : json),
    text: async () => text,
  }
}
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }]

test('query normalization is NFKC/trim/collapse/lower; fragments are removed from canonical URLs', () => {
  assert.equal(normalizeSearchQuery('  ＡI   Agent  '), 'ai agent')
  assert.equal(canonicalWebUrl('https://example.com/a?q=1#part'), 'https://example.com/a?q=1')
  assert.equal(canonicalWebUrl('file:///etc/passwd'), null)
  assert.equal(canonicalWebUrl('https://user:pass@example.com/'), null)
})

test('Serper request contract, successful-empty caching, in-flight/cache dedupe, and telemetry', async () => {
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    await gate
    return response({ json: { organic: [{ title: '结果', link: 'https://example.com/a#x', snippet: '摘要' }] } })
  }
  const rt = makeWebRuntime({ searchApiKey: 'serper-secret', fetchImpl, dnsLookup: publicDns })
  const p1 = rt.search('  示例   查询 ')
  const p2 = rt.search('示例 查询')
  release()
  assert.match(await p1, /结果/)
  assert.match(await p2, /结果/)
  assert.equal(calls.length, 1, 'concurrent normalized duplicate shares one HTTP request')
  assert.equal(calls[0].url, 'https://google.serper.dev/search')
  assert.equal(calls[0].init.headers['X-API-KEY'], 'serper-secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), { q: '  示例   查询 ', num: 5, gl: 'cn', hl: 'zh-cn' })
  assert.deepEqual(rt.allowedUrls(), ['https://example.com/a'])
  const t = rt.telemetry()
  assert.equal(t.searchCalls, 2)
  assert.equal(t.searchAttempts, 1)
  assert.equal(t.searchBilled, 1)
  assert.equal(t.searchCacheHits, 1)
  assert.deepEqual(Object.keys(t), [...WEB_TELEMETRY_FIELDS])

  let emptyCalls = 0
  const empty = makeWebRuntime({ searchApiKey: 'k', fetchImpl: async () => { emptyCalls++; return response({ json: { organic: [] } }) } })
  assert.equal(await empty.search('none'), '无结果')
  assert.equal(await empty.search(' NONE '), '无结果')
  assert.equal(emptyCalls, 1, 'successful empty result is cached')
})

test('Serper retries network/429/5xx once, but never retries 400/401/403', async () => {
  let n = 0
  const rt = makeWebRuntime({ searchApiKey: 'k', fetchImpl: async () => {
    n++
    if (n === 1) return response({ status: 429, headers: { 'retry-after': '0' } })
    return response({ json: { organic: [] } })
  } })
  await rt.search('retry')
  assert.equal(n, 2)
  assert.equal(rt.telemetry().searchAttempts, 2)

  let bad = 0
  const noRetry = makeWebRuntime({ searchApiKey: 'k', fetchImpl: async () => { bad++; return response({ status: 401 }) } })
  assert.match(await noRetry.search('bad key'), /HTTP 401/)
  assert.equal(bad, 1)
})

test('malformed 2xx is billed+failed and not cached; injected searchFn is budgeted/cached but not HTTP-billed', async () => {
  let malformedCalls = 0
  const malformed = makeWebRuntime({ searchApiKey: 'k', fetchImpl: async () => { malformedCalls++; return response({ json: { nope: [] } }) } })
  await malformed.search('x')
  await malformed.search('x')
  assert.equal(malformedCalls, 2, 'malformed success is never cached')
  assert.equal(malformed.telemetry().searchBilled, 2)
  assert.equal(malformed.telemetry().searchFailures, 2)

  let injectedCalls = 0
  const injected = makeWebRuntime({ searchFn: async () => { injectedCalls++; return [] }, maxSearchRequestsPerJob: 1 })
  assert.equal(await injected.search('a'), '无结果')
  assert.equal(await injected.search('A'), '无结果')
  assert.match(await injected.search('b'), /预算/)
  assert.equal(injectedCalls, 1)
  assert.equal(injected.telemetry().searchAttempts, 0)
  assert.equal(injected.telemetry().searchBilled, 0)
  assert.equal(injected.telemetry().searchBudgetRejected, 1)
})

test('budget reservation happens before concurrent unique searches', async () => {
  let calls = 0
  const rt = makeWebRuntime({ maxSearchRequestsPerJob: 1, searchFn: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return [] } })
  const [a, b] = await Promise.all([rt.search('a'), rt.search('b')])
  assert.equal(calls, 1)
  assert.ok([a, b].some((x) => /预算/.test(x)))
})

test('web_fetch requires search allow-set, uses Jina with markdown/auth, truncates and caches as untrusted content', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('google.serper.dev')) return response({ json: { organic: [{ title: 'A', link: 'https://example.com/page#section', snippet: 's' }] } })
    return response({ text: '正文'.repeat(5000) })
  }
  const rt = makeWebRuntime({ searchApiKey: 's', readerApiKey: 'j', fetchImpl, dnsLookup: publicDns })
  assert.match(await rt.fetch('https://example.com/page'), /allow-set/)
  await rt.search('q')
  const first = await rt.fetch('https://example.com/page#other')
  const second = await rt.fetch('https://example.com/page')
  assert.match(first, /不可信网页内容/)
  assert.ok(first.length < 8200, 'reader body is capped near 8,000 chars plus notice')
  assert.equal(first, second)
  const jina = calls.find((x) => x.url.startsWith('https://r.jina.ai/'))
  assert.equal(jina.url, 'https://r.jina.ai/https://example.com/page')
  assert.equal(jina.init.headers.Accept, 'text/markdown')
  assert.equal(jina.init.headers.Authorization, 'Bearer j')
  const t = rt.telemetry()
  assert.equal(t.fetchCalls, 3)
  assert.equal(t.fetchCacheHits, 1)
  assert.equal(t.fetchJinaAttempts, 1)
  assert.equal(t.fetchJinaSuccess, 1)
})

test('Jina failure falls back once to local fetch; failures are not cached', async () => {
  let local = 0
  const rt = makeWebRuntime({
    searchFn: async () => [{ title: 'A', url: 'https://example.com/a', snippet: '' }],
    fetchImpl: async () => response({ status: 503 }), dnsLookup: publicDns,
    localFetchFn: async () => { local++; return '本地正文' },
  })
  await rt.search('q')
  assert.match(await rt.fetch('https://example.com/a'), /本地正文/)
  assert.equal(local, 1)
  const t = rt.telemetry()
  assert.equal(t.fetchJinaAttempts, 1)
  assert.equal(t.fetchLocalAttempts, 1)
  assert.equal(t.fetchLocalSuccess, 1)

  let empty = 0
  const broken = makeWebRuntime({ searchFn: async () => [{ title: 'A', url: 'https://example.com/a', snippet: '' }], fetchImpl: async () => response({ status: 500 }), dnsLookup: publicDns, localFetchFn: async () => { empty++; return '' } })
  await broken.search('q')
  await broken.fetch('https://example.com/a')
  await broken.fetch('https://example.com/a')
  assert.equal(empty, 2, 'failed fetch is not cached')
})

test('SSRF guards reject credentials, local names, private/reserved literals, and DNS rebinding targets', async () => {
  assert.throws(() => validateUrlShape('https://u:p@example.com/a'), /账号|http/)
  assert.throws(() => validateUrlShape('http://localhost/a'), /本地/)
  assert.throws(() => validateUrlShape('http://svc.internal/a'), /内部/)
  assert.throws(() => validateUrlShape('http://[::1]/a'), /私有|环回|保留/)
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.0.2.1', '::1', 'fc00::1']) assert.equal(isPublicIp(ip), false, ip)
  assert.equal(isPublicIp('8.8.8.8'), true)
  assert.equal(isPublicIp('2606:4700:4700::1111'), true)

  const rt = makeWebRuntime({ searchFn: async () => [{ title: 'bad', url: 'https://evil.example/a', snippet: '' }], dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }], fetchImpl: async () => response({ text: 'should not run' }) })
  await rt.search('q')
  assert.match(await rt.fetch('https://evil.example/a'), /DNS|公网/)
  assert.equal(rt.telemetry().fetchJinaAttempts, 0, 'private DNS is rejected before Jina can launder it')
})
