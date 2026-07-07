// Offline unit tests for M11 (single-shot refine + Anthropic Batch client + batch submit/resume) and M12
// (reasoning-effort knob + CC bootstrap passthrough). NO live API calls, NO API keys — every seam is injected
// (fake fetch, mock engine, mock capabilities). All names/data are FICTIONAL (hard rule: no real subjects).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { outputConfigFor, makeApiEngine } from '../engines/api.js'
import { singleShotPrompt } from '../core/prompts.js'
import {
  SINGLE_SHOT_MAX_CHARS, singleShotMaxTokens, SINGLE_SHOT_TOK_CEILING, SINGLE_SHOT_TOK_MIN,
  contentLength,
} from '../core/spec.js'
import { runPipeline } from '../core/pipeline.js'
import { BatchClient, resolveBaseURL, parseJSONL, resultToOutput, DEFAULT_BASE_URL } from '../engines/batch.js'
import { runSubmit, runResume } from '../scripts/batch_refine.mjs'

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'refiner-ssb-')) }

const F = (over = {}) => ({ path: '/s/A.txt', label: 'A', lines: 40, chars: 1200, title: '示例访谈', subtitle: '*示例项目访谈 · 采访时间 2025-03*', outPath: '/o/Transcripts/A.md', ...over })
const A = (over = {}) => ({ topic: '示例', date: '2025-03', background: '虚构公司背景', outputDir: '/o', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [F()], ...over })

// ======================================================================================
// M11a — single-shot prompt + max_tokens formula + size gate
// ======================================================================================

test('singleShotPrompt inlines the FULL source text and demands pure-document output', () => {
  const src = '记者：请介绍一下你自己。\n受访者：我在一家虚构的检测公司做研发，入行十年。'
  const p = singleShotPrompt(F(), A(), src, '', '')
  assert.ok(p.includes(src), 'the entire source text is inlined into the prompt')
  assert.ok(p.includes('<源转录>') && p.includes('</源转录>'), 'source is fenced in the 源转录 block')
  assert.ok(p.includes('# 示例访谈'), 'the H1 抬头 is specified')
  assert.ok(p.includes('原样写入成稿文件') || p.includes('成稿正文本身'), 'instructs pure-document output (no preamble/fence)')
  // The single-shot OUTPUT instruction must not route the model through a Write-to-path tool call — the response
  // itself is the doc. (RULES boilerplate is embedded verbatim and mentions the Write/Edit tools generically; we
  // check the single-shot-specific output directive, which is "直接输出…成稿正文本身".)
  assert.ok(/直接输出.*成稿正文本身/s.test(p), 'the single-shot output directive says to return the document directly, not Write it to a path')
})

test('singleShotPrompt folds in the rendered glossary when provided, else a self-glossary instruction', () => {
  const withG = singleShotPrompt(F(), A(), '正文', '# 校对表\n- **沈其安** ← 陈总', '')
  assert.ok(withG.includes('统一校对表') && withG.includes('沈其安'), 'glossary block is injected verbatim')
  const without = singleShotPrompt(F(), A(), '正文', '', '')
  assert.ok(without.includes('迷你校对表'), 'no glossary → the self-built mini-glossary instruction (mirrors singlePassPrompt)')
})

test('singleShotMaxTokens follows ceil(chars × 2.2) + 2048, clamped to [8000, 96000]', () => {
  // small file → floor MIN
  assert.equal(singleShotMaxTokens(100), SINGLE_SHOT_TOK_MIN, 'tiny file clamps up to the MIN floor (8000)')
  // mid file → the curve: ceil(10000×2.2)+2048 = 24048
  assert.equal(singleShotMaxTokens(10000), Math.ceil(10000 * 2.2) + 2048)
  // at the size gate → clamps to the ceiling (this is WHY the gate is 45000: the curve exceeds 96000 there)
  assert.equal(singleShotMaxTokens(SINGLE_SHOT_MAX_CHARS), SINGLE_SHOT_TOK_CEILING, 'at the gate the formula saturates the 96000 ceiling')
  assert.equal(singleShotMaxTokens(999999), SINGLE_SHOT_TOK_CEILING, 'never exceeds the ceiling')
  assert.equal(singleShotMaxTokens(0), SINGLE_SHOT_TOK_MIN, 'zero → MIN floor')
  // monotonic non-decreasing
  assert.ok(singleShotMaxTokens(5000) <= singleShotMaxTokens(6000))
})

// Mock engine that records every complete()/agent() call, so a single-shot run can be driven with zero tokens.
function ssEngine(rec) {
  return {
    complete: async (prompt, opts = {}) => { rec.complete.push({ prompt, opts }); return '# 示例访谈\n*示例项目访谈 · 采访时间 2025-03*\n\n## 开场\n\n记者：请介绍一下你自己。\n\n受访者：我在一家虚构的检测公司做研发，入行十年。\n' },
    agent: async (prompt, opts = {}) => { rec.agent.push({ prompt, opts }); if (/^refine/.test(opts.label || '')) return { path: 'x', headings: ['开场'], key_fixes: [], open_questions: [] }; return null },
    parallel: (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all((items || []).map(async (item, i) => { let v = item; for (const s of stages) { try { v = await s(v, item, i) } catch { return null } if (!v) return null } return v })),
    phase: () => {}, log: () => {},
  }
}

test('refineMode:single-shot uses engine.complete + writeFile capability; the response IS the 成稿', async () => {
  const rec = { complete: [], agent: [] }
  const writes = []
  const src = '记者：请介绍一下你自己。\n受访者：我在一家虚构的检测公司做研发，入行十年。这句是结尾。'
  const caps = { readFile: async () => src, writeFile: (p, text) => writes.push({ p, text }) }
  // Two files so we skip the one-pass branch and exercise refineFile → single-shot.
  const r = await runPipeline(A({
    refineMode: 'single-shot', capabilities: caps,
    files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })],
  }), ssEngine(rec))
  assert.equal(rec.complete.length, 2, 'one complete() per file (no agentic refine agent)')
  assert.ok(rec.complete[0].prompt.includes(src), 'the source text was inlined into the single-shot prompt')
  assert.ok(rec.complete[0].opts.maxTokens > 0, 'a computed max_tokens is passed')
  assert.equal(writes.length, 2, 'both refined files written via the writeFile capability')
  assert.equal(r.refineMode, 'single-shot', 'run-level refineMode recorded')
  assert.ok(r.refined.every((x) => x.singleShot), 'each refined entry is marked singleShot')
})

test('single-shot REFUSES a file over SINGLE_SHOT_MAX_CHARS (no silent truncation) and routes it to open_questions', async () => {
  const rec = { complete: [], agent: [] }
  const big = '记者：问。\n受访者：' + '答'.repeat(SINGLE_SHOT_MAX_CHARS + 500) + '\n'
  assert.ok(contentLength(big) > SINGLE_SHOT_MAX_CHARS, 'fixture is genuinely oversize')
  const caps = { readFile: async () => big, writeFile: () => { throw new Error('should not write a refused file') } }
  const r = await runPipeline(A({
    refineMode: 'single-shot', capabilities: caps,
    files: [F({ chars: SINGLE_SHOT_MAX_CHARS + 500 }), F({ path: '/s/B.txt', label: 'B', chars: SINGLE_SHOT_MAX_CHARS + 500, outPath: '/o/Transcripts/B.md' })],
  }), ssEngine(rec))
  assert.equal(rec.complete.length, 0, 'an oversize file is never sent to complete()')
  assert.ok(r.openQuestions.some((q) => /超过 single-shot 上限|agentic/.test(q)), 'refusal surfaces in openQuestions with an agentic-mode hint')
})

test('single-shot degrades to agentic when the runtime lacks fs/complete (e.g. the CC sandbox)', async () => {
  const rec = { complete: [], agent: [] }
  // Engine WITHOUT complete(); no readFile/writeFile capability → refineFileSingleShot returns {degrade:true}.
  const eng = ssEngine(rec); delete eng.complete
  const r = await runPipeline(A({ refineMode: 'single-shot', files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })] }), eng)
  assert.ok(rec.agent.some((c) => /^refine/.test(c.opts.label || '')), 'fell back to the agentic refine agent')
  assert.ok(r.refined.length >= 1, 'still produced output via the agentic path')
})

test('DEFAULT mode is byte-equivalent: no complete(), refinePrompt via agentic agent, no single-shot markers', async () => {
  const rec = { complete: [], agent: [] }
  const r = await runPipeline(A({ files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })] }), ssEngine(rec))
  assert.equal(rec.complete.length, 0, 'default (agentic) never calls complete()')
  assert.ok(rec.agent.some((c) => /^refine/.test(c.opts.label || '')), 'default uses the refine AGENT (tool loop)')
  assert.equal(r.refineMode, 'agentic', 'run-level refineMode defaults to agentic')
  assert.ok(r.refined.every((x) => !x.singleShot), 'no single-shot markers on the default path')
})

// ======================================================================================
// M12 — effort: output_config only for allowed models; CC bootstrap passthrough
// ======================================================================================

test('outputConfigFor emits { effort } ONLY for allowed models (opus/sonnet/fable), NEVER haiku', () => {
  assert.deepEqual(outputConfigFor('claude-opus-4-8', 'medium'), { effort: 'medium' })
  assert.deepEqual(outputConfigFor('claude-fable-5', 'high'), { effort: 'high' })
  assert.deepEqual(outputConfigFor('claude-sonnet-4-6', 'low'), { effort: 'low' })
  assert.equal(outputConfigFor('claude-haiku-4-5', 'medium'), undefined, 'haiku NEVER carries effort (it 400-errors)')
  assert.equal(outputConfigFor('claude-opus-4-8', undefined), undefined, 'absent effort → no output_config')
  assert.equal(outputConfigFor('claude-opus-4-8', 'turbo'), undefined, 'unknown level → no output_config')
})

// A fake Anthropic client capturing the exact params handed to messages.stream — asserts the request the SDK
// would send carries output_config.effort exactly when allowed, and composes with adaptive thinking.
function fakeAnthropic(captured) {
  return {
    messages: {
      stream: (params) => {
        captured.push(params)
        return { finalMessage: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }) }
      },
    },
  }
}

test('api engine sets output_config.effort on the wire for opus (and composes with adaptive thinking)', async () => {
  const captured = []
  const eng = makeApiEngine({ client: fakeAnthropic(captured), concurrency: 1 })
  await eng.agent('精校这段', { label: 'refine:A', model: 'opus', effort: 'medium' })
  const req = captured[0]
  assert.deepEqual(req.output_config, { effort: 'medium' }, 'output_config.effort on the request')
  assert.deepEqual(req.thinking, { type: 'adaptive' }, 'effort composes with adaptive thinking (both present)')
})

test('api engine omits output_config for haiku even when effort is requested', async () => {
  const captured = []
  const eng = makeApiEngine({ client: fakeAnthropic(captured), concurrency: 1 })
  await eng.agent('侦察这段', { label: 'scout:A', model: 'haiku', effort: 'medium' })
  assert.equal(captured[0].output_config, undefined, 'no output_config on a haiku request')
})

test('api engine complete() honors effort + a computed max_tokens for the single-shot path', async () => {
  const captured = []
  const eng = makeApiEngine({ client: fakeAnthropic(captured), concurrency: 1 })
  const text = await eng.complete('把整段精校成成稿', { label: 'refine:A', model: 'opus', effort: 'low', maxTokens: 24048 })
  assert.equal(text, 'ok')
  const req = captured[0]
  assert.equal(req.max_tokens, 24048, 'the caller-computed max_tokens is used, not the tier default')
  assert.deepEqual(req.output_config, { effort: 'low' })
  assert.ok(!req.tools, 'single-shot request carries NO tools')
})

test('CC bootstrap bundle forwards opts.effort into the Workflow agent()', () => {
  // Assert on the generated bundle: the bootstrap wraps agent() so opts.effort is passed through to the sandbox
  // Workflow agent(). (Also proven behaviourally by the api-engine tests above; this pins the CC edition mapping.)
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const boot = fs.readFileSync(path.join(root, 'build/bootstrap-cc.js'), 'utf8')
  assert.ok(/opts\.effort/.test(boot), 'bootstrap references opts.effort')
  assert.ok(/agent\(prompt,\s*opts\.effort\s*\?/.test(boot), 'bootstrap forwards effort onto the agent() call')
  const bundle = fs.readFileSync(path.join(root, 'claude-code-skill/workflow.js'), 'utf8')
  assert.ok(/opts\.effort/.test(bundle), 'the built bundle contains the effort passthrough (build:cc ran)')
})

// ======================================================================================
// M11b — Batch client (fake fetch): base URL, headers, submit shape, poll, jsonl mapping
// ======================================================================================

// A fake fetch driven by a route table: (method, url|matcher) → { status, json?/text? }. Records every call.
function fakeFetch(routes, calls) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body })
    for (const r of routes) {
      const m = (init.method || 'GET') === (r.method || 'GET')
      const u = typeof r.match === 'function' ? r.match(url) : String(url).includes(r.match)
      if (m && u) {
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          json: async () => r.json,
          text: async () => (r.text != null ? r.text : JSON.stringify(r.json || {})),
        }
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'no route' }
  }
}

test('resolveBaseURL: env override wins, trailing slash stripped, default is the public endpoint', () => {
  assert.equal(resolveBaseURL(undefined, {}), DEFAULT_BASE_URL)
  assert.equal(resolveBaseURL(undefined, { ANTHROPIC_BASE_URL: 'https://proxy.example.com/' }), 'https://proxy.example.com')
  assert.equal(resolveBaseURL('https://explicit.example.com///', { ANTHROPIC_BASE_URL: 'https://env.example.com' }), 'https://explicit.example.com', 'explicit arg beats env')
})

test('submitBatch POSTs to /v1/messages/batches with x-api-key + anthropic-version headers and honors ANTHROPIC_BASE_URL', async () => {
  const calls = []
  const routes = [{ method: 'POST', match: '/v1/messages/batches', json: { id: 'batch_123', processing_status: 'in_progress' } }]
  const client = new BatchClient({ apiKey: 'sk-test', fetch: fakeFetch(routes, calls), env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } })
  const batch = await client.submitBatch([
    { custom_id: 'fileA', params: { model: 'claude-opus-4-8', max_tokens: 1000, messages: [{ role: 'user', content: 'x' }] } },
    { custom_id: 'fileB', params: { model: 'claude-opus-4-8', max_tokens: 1000, messages: [{ role: 'user', content: 'y' }] } },
  ])
  assert.equal(batch.id, 'batch_123')
  const c = calls[0]
  assert.equal(c.method, 'POST')
  assert.equal(c.url, 'https://proxy.example.com/v1/messages/batches', 'base URL override is honored on the endpoint')
  assert.equal(c.headers['x-api-key'], 'sk-test')
  assert.equal(c.headers['anthropic-version'], '2023-06-01')
  assert.equal(c.headers['content-type'], 'application/json')
  const sent = JSON.parse(c.body)
  assert.equal(sent.requests.length, 2)
  assert.equal(sent.requests[0].custom_id, 'fileA')
})

test('submitBatch rejects missing or duplicate custom_ids before hitting the wire', async () => {
  const calls = []
  const client = new BatchClient({ apiKey: 'k', fetch: fakeFetch([], calls) })
  await assert.rejects(() => client.submitBatch([{ params: {} }]), /custom_id/)
  await assert.rejects(() => client.submitBatch([{ custom_id: 'dup', params: {} }, { custom_id: 'dup', params: {} }]), /重复|唯一/)
  assert.equal(calls.length, 0, 'no network call on a validation failure')
})

test('pollBatch reflects in_progress → ended transitions', async () => {
  const calls = []
  let n = 0
  const routes = [{ method: 'GET', match: (u) => u.includes('/v1/messages/batches/batch_x'), get json() { n += 1; return n < 2 ? { id: 'batch_x', processing_status: 'in_progress', results_url: null } : { id: 'batch_x', processing_status: 'ended', results_url: 'https://x/results.jsonl' } } }]
  const client = new BatchClient({ apiKey: 'k', baseURL: 'https://api.anthropic.com', fetch: fakeFetch(routes, calls) })
  const first = await client.pollBatch('batch_x')
  assert.equal(first.processing_status, 'in_progress')
  const second = await client.pollBatch('batch_x')
  assert.equal(second.processing_status, 'ended')
  assert.equal(second.results_url, 'https://x/results.jsonl')
})

test('fetchResults parses JSONL and maps custom_id → text / per-item error', async () => {
  const jsonl = [
    JSON.stringify({ custom_id: 'ok1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '# 成稿\n正文' }] } } }),
    JSON.stringify({ custom_id: 'err1', result: { type: 'errored', error: { error: { type: 'invalid_request_error', message: '坏了' } } } }),
    JSON.stringify({ custom_id: 'exp1', result: { type: 'expired' } }),
  ].join('\n') + '\n'
  const calls = []
  const routes = [{ method: 'GET', match: 'results.jsonl', text: jsonl }]
  const client = new BatchClient({ apiKey: 'k', fetch: fakeFetch(routes, calls) })
  const { byCustomId } = await client.fetchResults('https://x/results.jsonl')
  assert.equal(byCustomId.get('ok1').ok, true)
  assert.equal(byCustomId.get('ok1').text, '# 成稿\n正文')
  assert.equal(byCustomId.get('err1').ok, false)
  assert.match(byCustomId.get('err1').error, /errored: 坏了/)
  assert.equal(byCustomId.get('exp1').ok, false)
  assert.match(byCustomId.get('exp1').error, /expired/)
})

test('parseJSONL skips blanks and resultToOutput handles the succeeded/errored/expired union', () => {
  const rows = parseJSONL('{"a":1}\n\n  \n{"b":2}\n')
  assert.deepEqual(rows, [{ a: 1 }, { b: 2 }])
  assert.equal(resultToOutput({ custom_id: 'c', result: { type: 'canceled' } }).ok, false)
})

// ======================================================================================
// M11b — resume flow: writes refined files + runs the deterministic audit gate (offline)
// ======================================================================================

// A source whose distinctive last sentence the batch result KEEPS, so the audit passes ending_missing; the
// refined text faithfully covers it. Fictional throughout.
const SRC = [
  '记者：先请你介绍一下自己。',
  '受访者：我在一家虚构的工业检测公司做研发，主要负责视觉算法。',
  '记者：最后一个问题，明年重点是什么？',
  '受访者：明年重点是把冷链仓配补齐，这是结尾锚点句。',
].join('\n') + '\n'
const REFINED = [
  '# 示例访谈',
  '*示例项目访谈 · 采访时间 2025-03*',
  '',
  '## 开场',
  '',
  '记者：先请你介绍一下自己。',
  '',
  '受访者：我在一家虚构的工业检测公司做研发，主要负责视觉算法。',
  '',
  '## 明年重点',
  '',
  '记者：最后一个问题，明年重点是什么？',
  '',
  '受访者：明年重点是把冷链仓配补齐，这是结尾锚点句。',
  '',
].join('\n')

test('runResume polls until ended, writes each refined file, runs the audit gate + anchors + artifacts', async () => {
  const dir = tmpdir()
  const src = path.join(dir, 'A-src.txt')
  fs.writeFileSync(src, SRC, 'utf8')
  const outPath = path.join(dir, 'Transcripts', 'A.md')
  // Seed a state file as submit would have written it (glossary optional).
  fs.writeFileSync(path.join(dir, 'batch-state.json'), JSON.stringify({
    version: 1, batchId: 'batch_r', outputDir: dir, baseURL: 'https://api.anthropic.com',
    topic: '示例', date: '2025-03', background: 'bg', glossaryPath: path.join(dir, '校对表.md'),
    files: [{ label: 'A', sourcePath: src, outPath, title: '示例访谈', subtitle: '*示例项目访谈 · 采访时间 2025-03*' }],
    refused: [], params: { verify: 'none', headingPolicy: 'none', effort: null, anchors: true, annotate: true },
  }, null, 2), 'utf8')

  const jsonl = JSON.stringify({ custom_id: 'A', result: { type: 'succeeded', message: { content: [{ type: 'text', text: REFINED }] } } }) + '\n'
  const calls = []
  let polls = 0
  const routes = [
    { method: 'GET', match: (u) => u.includes('/v1/messages/batches/batch_r'), get json() { polls += 1; return polls < 2 ? { id: 'batch_r', processing_status: 'in_progress', results_url: null } : { id: 'batch_r', processing_status: 'ended', results_url: 'https://x/results.jsonl' } } },
    { method: 'GET', match: 'results.jsonl', text: jsonl },
  ]
  const clientFactory = () => new BatchClient({ apiKey: 'k', baseURL: 'https://api.anthropic.com', fetch: fakeFetch(routes, calls) })
  const res = await runResume({ dir }, { env: { ANTHROPIC_API_KEY: 'k' }, clientFactory, sleeper: async () => {} })

  assert.ok(fs.existsSync(outPath), 'the refined file was written to disk')
  assert.equal(fs.readFileSync(outPath, 'utf8').split('\n')[0], '# 示例访谈', 'batch result text written verbatim as the 成稿')
  assert.ok(res.audit && res.audit.files && res.audit.files.length === 1, 'the deterministic audit ran on the written file')
  assert.equal(res.failed.length, 0, 'no per-file failures for a clean result')
  assert.ok(fs.existsSync(res.reviewPath) && fs.existsSync(res.manifestPath), 'review.md + run.json artifacts written')
  assert.ok(polls >= 2, 'polled at least twice (in_progress then ended)')
})

test('runResume surfaces a per-request batch error: leaves the file unrefined + lists it in openQuestions/failed', async () => {
  const dir = tmpdir()
  const src = path.join(dir, 'B-src.txt'); fs.writeFileSync(src, SRC, 'utf8')
  const outPath = path.join(dir, 'Transcripts', 'B.md')
  fs.writeFileSync(path.join(dir, 'batch-state.json'), JSON.stringify({
    version: 1, batchId: 'batch_e', outputDir: dir, baseURL: 'https://api.anthropic.com', glossaryPath: path.join(dir, '校对表.md'),
    files: [{ label: 'B', sourcePath: src, outPath, title: 'B', subtitle: '*x*' }], refused: [],
    params: { anchors: true, annotate: true },
  }, null, 2), 'utf8')
  const jsonl = JSON.stringify({ custom_id: 'B', result: { type: 'errored', error: { error: { message: '模型侧报错' } } } }) + '\n'
  const routes = [
    { method: 'GET', match: (u) => u.includes('/v1/messages/batches/batch_e'), json: { id: 'batch_e', processing_status: 'ended', results_url: 'https://x/results.jsonl' } },
    { method: 'GET', match: 'results.jsonl', text: jsonl },
  ]
  const clientFactory = () => new BatchClient({ apiKey: 'k', fetch: fakeFetch(routes, []) })
  const res = await runResume({ dir }, { env: { ANTHROPIC_API_KEY: 'k' }, clientFactory, sleeper: async () => {} })
  assert.ok(!fs.existsSync(outPath), 'an errored request leaves no 成稿 on disk')
  assert.ok(res.failed.includes('B'), 'the errored file is listed in failed')
  assert.ok(res.openQuestions.some((q) => /批处理精校失败|agentic/.test(q)), 'the error is surfaced in openQuestions with an agentic-retry hint')
})

// ======================================================================================
// M11b — submit flow: reuses the pipeline (scout/verify/glossary) + captureSingleShot, builds batch requests
// ======================================================================================

test('runSubmit --dry-run builds one batch request per file (unique custom_ids, effort into output_config) without touching the network', async () => {
  const dir = tmpdir()
  const a = path.join(dir, '甲.txt'), b = path.join(dir, '乙.txt')
  fs.writeFileSync(a, '记者：请介绍一下自己。\n受访者：我在一家虚构公司做产品，入行八年，团队 12 个人。\n', 'utf8')
  fs.writeFileSync(b, '记者：今年的重点？\n受访者：把 GPT-4 那套流程跑顺，覆盖 80% 场景。\n', 'utf8')

  // Mock engine so scout/verify/glossary run offline (no API key). captureSingleShot intercepts before complete()
  // is ever called, so the engine needs no complete(). verify='none' means no verify agents fire.
  const mockEngine = {
    agent: async (_p, o = {}) => {
      if (/^scout/.test(o.label || '')) return { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 2, text: '完' }, special_notes: [] }
      if (/^dedup/.test(o.label || '')) return { suspects: [] }
      return null
    },
    parallel: (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all((items || []).map(async (item, i) => { let v = item; for (const s of stages) { try { v = await s(v, item, i) } catch { return null } if (!v) return null } return v })),
    phase: () => {}, log: () => {}, usage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }),
  }
  // Capture stdout (the dry-run prints the payload JSON).
  const chunks = []
  const origWrite = process.stdout.write
  process.stdout.write = (s) => { chunks.push(String(s)); return true }
  let out
  try {
    out = await runSubmit({
      files: [a, b], topic: '示例', outputDir: dir, verify: 'none', dryRun: true, effort: 'refine=medium',
    }, { env: { HOME: dir }, __engine: mockEngine })
  } finally { process.stdout.write = origWrite }

  assert.ok(out.dryRun, 'dry-run returns without submitting')
  assert.equal(out.requests.length, 2, 'one request per file')
  const ids = out.requests.map((r) => r.custom_id)
  assert.equal(new Set(ids).size, 2, 'custom_ids are unique')
  // Each request is a single-shot payload: inlined source, no tools, effort → output_config.
  const r0 = out.requests[0]
  assert.ok(r0.params.messages[0].content.includes('<源转录>'), 'the source is inlined into the request prompt')
  assert.deepEqual(r0.params.output_config, { effort: 'medium' }, '--effort refine=medium lands in output_config.effort')
  assert.deepEqual(r0.params.thinking, { type: 'adaptive' }, 'batch request carries adaptive thinking (quality-equivalent to interactive single-shot)')
  assert.ok(r0.params.max_tokens > 0, 'a computed max_tokens is set per request')
  assert.ok(!r0.params.stream && !r0.params.tools, 'batch request is non-streaming and tool-less')
  assert.ok(chunks.join('').includes('"dryRun": true'), 'the payload JSON was printed to stdout')
})
