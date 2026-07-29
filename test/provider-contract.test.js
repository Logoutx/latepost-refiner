import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeDeepSeekEngine, DEEPSEEK_MODELS, DEEPSEEK_BASE_URL, REFINE_CHAR_BUDGET, SOURCE_PROTECTION_NOTE, formatSearchResults } from '../engines/deepseek.js'

// The Universal edition supports exactly ONE API provider — DeepSeek — with two FIXED models: v4-flash for the
// mechanical tiers (scout/check/dedup/stitch → haiku/sonnet) and v4-pro for the writing tiers (refine/logic/
// summary/timeline → opus). There is no model/provider/base-url selection anywhere. These tests pin that contract
// and the engine's wire behaviour (forced structured output, fixed web tools on online stages).

function completion(message, finishReason = 'stop') {
  return {
    choices: [{ message, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }
}

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function mockClient(responses) {
  const calls = []
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params)
          const next = responses.shift()
          assert.ok(next, `unexpected model call #${calls.length}`)
          return typeof next === 'function' ? next(params, calls) : next
        },
      },
    },
  }
}

function toolNames(params) {
  return (params.tools || []).map((tool) => tool.function?.name || tool.type)
}

const SIMPLE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
}

test('DeepSeek constants are fixed: endpoint, flash/pro model split, faithful-refine budgets', () => {
  assert.equal(DEEPSEEK_BASE_URL, 'https://api.deepseek.com')
  assert.deepEqual(DEEPSEEK_MODELS, { haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', opus: 'deepseek-v4-pro' })
  assert.deepEqual(REFINE_CHAR_BUDGET, { 'deepseek-v4-pro': 10000, 'deepseek-v4-flash': 18000 })
})

test('SOURCE_PROTECTION_NOTE surfaces the PRC-operator caveat', () => {
  assert.match(SOURCE_PROTECTION_NOTE, /信源保护提示/)
  assert.match(SOURCE_PROTECTION_NOTE, /DeepSeek/)
  assert.match(SOURCE_PROTECTION_NOTE, /境内/)
})

test('engine.refineBudget resolves the fixed tier→model map to its faithful-refine budget', () => {
  const engine = makeDeepSeekEngine({ client: {}, concurrency: 1 })
  assert.deepEqual(engine.refineBudget('opus'), { model: 'deepseek-v4-pro', budget: 10000 }, 'the writing/opus tier → v4-pro budget')
  assert.deepEqual(engine.refineBudget('sonnet'), { model: 'deepseek-v4-flash', budget: 18000 })
  assert.deepEqual(engine.refineBudget('haiku'), { model: 'deepseek-v4-flash', budget: 18000 })
  assert.deepEqual(engine.refineBudget('deepseek-v4-pro'), { model: 'deepseek-v4-pro', budget: 10000 }, 'a raw model id resolves too')
  assert.equal(engine.refineBudget('deepseek-chat'), undefined, 'a model with no declared budget → undefined')
})

test('engine requires a key unless a client is injected', () => {
  assert.throws(() => makeDeepSeekEngine({}), /DEEPSEEK_API_KEY/)
  assert.doesNotThrow(() => makeDeepSeekEngine({ client: {}, concurrency: 1 }))
})

test('tier words resolve to the fixed DeepSeek model ids on the wire', async () => {
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
    completion({ content: '', tool_calls: [toolCall('so2', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1 })

  await engine.agent('p', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })
  assert.equal(client.calls[0].model, 'deepseek-v4-pro', 'opus → v4-pro')

  await engine.agent('p', { model: 'haiku', schema: SIMPLE_SCHEMA, label: 'scout:file' })
  assert.equal(client.calls[1].model, 'deepseek-v4-flash', 'haiku → v4-flash')
})

test('schema agents return structured_output tool arguments directly', async () => {
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1 })

  const result = await engine.agent('prompt', { model: 'haiku', schema: SIMPLE_SCHEMA, label: 'scout:file' })

  assert.deepEqual(result, { ok: true })
  assert.equal(client.calls[0].model, 'deepseek-v4-flash')
  assert.equal(client.calls[0].max_tokens, 16000)
  assert.equal('max_completion_tokens' in client.calls[0], false, 'DeepSeek uses max_tokens')
  assert.deepEqual(toolNames(client.calls[0]).sort(), ['Concat', 'Edit', 'Read', 'Write', 'structured_output'].sort())
})

test('file tool calls feed local tool results back to the model', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-deepseek-'))
  const source = path.join(base, 'source.txt')
  fs.writeFileSync(source, 'hello from transcript\n', 'utf8')
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('read1', 'Read', { file_path: source })] }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({
    client,
    concurrency: 1,
    filePolicy: { readRoots: [], writeRoots: [base], readPaths: [source] },
  })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })

  assert.deepEqual(result, { ok: true })
  const toolMessage = client.calls[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'read1')
  assert.match(toolMessage.content, /hello from transcript/)
})

test('a denied write cannot be masked by structured_output; the agent must create the declared artifact', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-deepseek-write-contract-'))
  const outputPath = path.join(base, 'Transcripts', 'A.md.part3')
  const scratch = path.join(base, 'Transcripts', 'scratch.md')
  const events = []
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('bad-write', 'Write', { file_path: scratch, content: '临时文件' })] }),
    completion({ content: '', tool_calls: [toolCall('too-early', 'structured_output', { ok: true })] }),
    completion({ content: '', tool_calls: [toolCall('good-write', 'Write', { file_path: outputPath, content: '采访者：问题\n\n受访者：回答\n' })] }),
    completion({ content: '', tool_calls: [toolCall('final', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({
    client,
    concurrency: 1,
    onToolEvent: (event) => events.push(event),
    filePolicy: {
      readRoots: [base], writeRoots: [base], writePaths: [path.join(base, 'Transcripts', 'A.md')],
      writePartBases: [path.join(base, 'Transcripts', 'A.md')],
    },
  })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:A#3/3', outputPath })

  assert.deepEqual(result, { ok: true })
  assert.equal(fs.existsSync(scratch), false)
  assert.match(fs.readFileSync(outputPath, 'utf8'), /受访者：回答/)
  assert.equal(client.calls.length, 4, 'premature structured_output was rejected instead of ending the agent')
  assert.equal(events[0].code, 'TOOL_PATH_DENIED')
  assert.equal(events.at(-1).ok, true)
  assert.deepEqual(engine.failures(), [], 'a recovered tool denial is observable but does not fail the agent')
})

test('an agent-scoped file policy can narrow the job allowlist to one repair candidate', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-deepseek-repair-scope-'))
  const finalPath = path.join(base, 'Transcripts', 'A.md')
  const candidatePath = path.join(base, '.repair-candidates', 'A.round-1.md')
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true })
  fs.writeFileSync(finalPath, '正式稿：不得改动\n', 'utf8')
  fs.writeFileSync(candidatePath, '候选稿：待修复\n', 'utf8')
  const events = []
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('bad-final-write', 'Write', { file_path: finalPath, content: '越权覆盖\n' })] }),
    completion({ content: '', tool_calls: [toolCall('candidate-write', 'Write', { file_path: candidatePath, content: '候选稿：已修复\n' })] }),
    completion({ content: 'done' }),
  ])
  const engine = makeDeepSeekEngine({
    client,
    concurrency: 1,
    onToolEvent: (event) => events.push(event),
    filePolicy: {
      readRoots: [base],
      writeRoots: [base],
      writePaths: [finalPath, candidatePath],
    },
  })

  const result = await engine.agent('prompt', {
    model: 'opus',
    label: 'repair:A:round1',
    outputPath: candidatePath,
    filePolicy: {
      readRoots: [],
      writeRoots: [base],
      readPaths: [candidatePath],
      writePaths: [candidatePath],
      writePartBases: [],
    },
  })

  assert.equal(result, 'done')
  assert.equal(fs.readFileSync(finalPath, 'utf8'), '正式稿：不得改动\n')
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), '候选稿：已修复\n')
  assert.equal(events[0].code, 'TOOL_PATH_DENIED')
  assert.equal(events[0].path, finalPath)
  assert.equal(events[1].ok, true)
})

test('structured_output without the declared artifact becomes a typed non-retryable agent failure', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-deepseek-missing-output-'))
  const outputPath = path.join(base, 'Transcripts', 'A.md')
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('early-1', 'structured_output', { ok: true })] }),
    completion({ content: '', tool_calls: [toolCall('early-2', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1, filePolicy: { readRoots: [base], writeRoots: [base], writePaths: [outputPath] } })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:A', outputPath })

  assert.equal(result, null)
  assert.equal(engine.usage().failed, 1)
  assert.deepEqual(engine.failures(), [{
    label: 'refine:A', code: 'OUTPUT_MISSING', retryable: false, message: `声明产物未生成：${outputPath}`,
    providerSignal: { provider: 'deepseek', finishReason: 'stop', refusalPresent: false, choiceCount: 1, httpStatus: null, requestId: null },
  }])
})

test('explicit refusal and content_filter become non-retryable failures with sanitized provider evidence', async () => {
  const refusalEvents = []
  const refusal = completion({ content: '', refusal: '原始拒绝正文不应进入失败记录' })
  refusal._request_id = 'req_refusal-1'
  const refusalEngine = makeDeepSeekEngine({ client: mockClient([refusal]), concurrency: 1, onAgentEvent: (event) => refusalEvents.push(event) })

  assert.equal(await refusalEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:sensitive' }), null)
  const refusalFailure = refusalEngine.failures()[0]
  assert.equal(refusalFailure.code, 'MODEL_REFUSAL')
  assert.equal(refusalFailure.retryable, false)
  assert.deepEqual(refusalFailure.providerSignal, {
    provider: 'deepseek', finishReason: 'stop', refusalPresent: true, choiceCount: 1, httpStatus: null, requestId: 'req_refusal-1',
  })
  assert.doesNotMatch(JSON.stringify(refusalFailure), /原始拒绝正文/)
  assert.deepEqual(refusalEvents.at(-1).providerSignal, refusalFailure.providerSignal)

  const filtered = completion({ content: '' }, 'content_filter')
  filtered._request_id = 'req_filter-1'
  const filterEngine = makeDeepSeekEngine({ client: mockClient([filtered]), concurrency: 1 })
  assert.equal(await filterEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'summary' }), null)
  assert.deepEqual(filterEngine.failures()[0], {
    label: 'summary', code: 'CONTENT_FILTER', retryable: false, message: 'summary 被内容过滤',
    providerSignal: { provider: 'deepseek', finishReason: 'content_filter', refusalPresent: false, choiceCount: 1, httpStatus: null, requestId: 'req_filter-1' },
  })
})

test('silent empty responses remain cause-unknown and carry request metadata without being mislabeled as censorship', async () => {
  const noChoice = { choices: [], usage: { prompt_tokens: 3, completion_tokens: 0 }, _request_id: 'req_empty-choice' }
  const noChoiceEngine = makeDeepSeekEngine({ client: mockClient([noChoice]), concurrency: 1 })
  assert.equal(await noChoiceEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:empty' }), null)
  assert.deepEqual(noChoiceEngine.failures()[0].providerSignal, {
    provider: 'deepseek', finishReason: null, refusalPresent: null, choiceCount: 0, httpStatus: null, requestId: 'req_empty-choice',
  })
  assert.equal(noChoiceEngine.failures()[0].code, 'MODEL_EMPTY_RESPONSE')

  const emptyContent = completion({ content: '' })
  emptyContent._request_id = 'req_empty-content'
  const emptyContentEngine = makeDeepSeekEngine({ client: mockClient([emptyContent]), concurrency: 1 })
  assert.equal(await emptyContentEngine.agent('prompt', { model: 'haiku', label: 'audit:file' }), null)
  assert.equal(emptyContentEngine.failures()[0].code, 'MODEL_EMPTY_CONTENT')
  assert.equal(emptyContentEngine.failures()[0].providerSignal.refusalPresent, false)
  assert.doesNotMatch(JSON.stringify(emptyContentEngine.failures()), /CONTENT_FILTER|MODEL_REFUSAL/)
})

test('API errors retain only status/request id metadata and classify transient transport errors', async () => {
  const apiError = Object.assign(new Error('provider response body must not be persisted'), { status: 429, requestID: 'req_rate-1' })
  const engine = makeDeepSeekEngine({ client: mockClient([() => { throw apiError }]), concurrency: 1 })

  assert.equal(await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:rate' }), null)
  const failure = engine.failures()[0]
  assert.equal(failure.code, 'API_TRANSIENT')
  assert.equal(failure.retryable, true)
  assert.deepEqual(failure.providerSignal, {
    provider: 'deepseek', finishReason: null, refusalPresent: null, choiceCount: null, httpStatus: 429, requestId: 'req_rate-1',
  })
  assert.doesNotMatch(JSON.stringify(failure), /provider response body/)
})

test('an unchanged stale artifact cannot satisfy the output postcondition', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-deepseek-stale-output-'))
  const outputPath = path.join(base, 'A.md')
  fs.writeFileSync(outputPath, '旧产物\n', 'utf8')
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('stale-1', 'structured_output', { ok: true })] }),
    completion({ content: '', tool_calls: [toolCall('stale-2', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1, filePolicy: { readRoots: [base], writeRoots: [base], writePaths: [outputPath] } })

  assert.equal(await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:A', outputPath }), null)
  assert.equal(engine.failures()[0].code, 'OUTPUT_NOT_UPDATED')
})

test('web tools are only exposed to online (verify/timeline) labels', async () => {
  const offlineClient = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const offlineEngine = makeDeepSeekEngine({ client: offlineClient, concurrency: 1 })
  await offlineEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })
  assert.equal(toolNames(offlineClient.calls[0]).includes('web_search'), false)
  assert.equal(toolNames(offlineClient.calls[0]).includes('web_fetch'), false)

  const onlineClient = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const onlineEngine = makeDeepSeekEngine({ client: onlineClient, concurrency: 1 })
  await onlineEngine.agent('prompt', { model: 'sonnet', schema: SIMPLE_SCHEMA, label: 'verify:1/2' })
  assert.equal(toolNames(onlineClient.calls[0]).includes('web_search'), true)
  assert.equal(toolNames(onlineClient.calls[0]).includes('web_fetch'), true)

  const tlClient = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const tlEngine = makeDeepSeekEngine({ client: tlClient, concurrency: 1 })
  await tlEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'timeline:company' })
  assert.equal(toolNames(tlClient.calls[0]).includes('web_search'), true)
})

// ---- searchFn override (bench/tests): same job-scoped budget/cache seam as Serper -------------------------

test('searchFn override: online web_search routes to the injected adapter with (query, {k}); results reach the model', async () => {
  const calls = []
  const searchFn = async (query, opts) => {
    calls.push({ query, opts })
    return [{ title: '沈其安', url: 'https://example.com/team', snippet: '云洲仪器 创始人 沈其安 简介' }]
  }
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('ws1', 'web_search', { query: '沈其安 云洲仪器' })] }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1, searchFn, searchK: 5 })

  const result = await engine.agent('p', { model: 'sonnet', schema: SIMPLE_SCHEMA, label: 'verify:1/1' })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1, 'searchFn called exactly once')
  assert.deepEqual(calls[0], { query: '沈其安 云洲仪器', opts: { k: 5 } }, 'searchFn got the query and {k}')
  // The adapter's normalized result is formatted and fed back to the model as the web_search tool result.
  const toolMsg = client.calls[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'ws1')
  assert.match(toolMsg.content, /沈其安/, 'the adapter snippet reached the model')
  assert.match(toolMsg.content, /example\.com\/team/, 'the adapter url is rendered')
})

test('default (no searchFn): web_search uses the fixed Serper path and fails cleanly without a key', async () => {
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('ws1', 'web_search', { query: '任意查询' })] }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1 })
  await engine.agent('p', { model: 'sonnet', schema: SIMPLE_SCHEMA, label: 'verify:1/1' })
  const toolMsg = client.calls[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'ws1')
  assert.match(toolMsg.content, /SERPER_API_KEY/, 'fixed Serper runtime reports its missing key without network')
})

test('formatSearchResults renders the normalized search contract (empty → 无结果)', () => {
  assert.equal(formatSearchResults([]), '无结果')
  assert.equal(formatSearchResults(null), '无结果')
  const txt = formatSearchResults([{ title: 'T1', url: 'https://a', snippet: 'S1' }, { title: 'T2', url: 'https://b', snippet: 'S2' }])
  assert.match(txt, /^1\. T1\n   https:\/\/a\n   S1\n2\. T2\n   https:\/\/b\n   S2$/, 'numbered title/url/snippet block')
  // snippet is capped at 500 chars
  assert.equal(formatSearchResults([{ title: 't', url: 'u', snippet: 'x'.repeat(600) }]).includes('x'.repeat(500)), true)
  assert.equal(formatSearchResults([{ title: 't', url: 'u', snippet: 'x'.repeat(600) }]).includes('x'.repeat(501)), false)
})

test('DeepSeek forces structured_output via tool_choice after two nudges', async () => {
  const client = mockClient([
    completion({ content: 'plain answer' }),
    completion({ content: 'still plain' }),
    completion({ content: 'still no tool' }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1 })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'summary:run' })

  assert.deepEqual(result, { ok: true })
  const forced = client.calls.at(-1)
  assert.deepEqual(forced.tool_choice, { type: 'function', function: { name: 'structured_output' } })
  assert.equal(forced.max_tokens, 64000, 'summary is a big-output label')
  assert.equal('max_completion_tokens' in forced, false)
  // No Kimi-style json_object fallback: forcing the tool is the only last resort DeepSeek uses.
  assert.equal(forced.response_format, undefined)
})

test('usage accounting folds DeepSeek cache-hit tokens into cacheRead', async () => {
  const client = mockClient([
    (params) => ({
      choices: [{ message: { content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 60 },
    }),
  ])
  const engine = makeDeepSeekEngine({ client, concurrency: 1 })
  await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })
  const u = engine.usage()
  assert.equal(u.input, 100)
  assert.equal(u.output, 40)
  assert.equal(u.cacheRead, 60)
})
