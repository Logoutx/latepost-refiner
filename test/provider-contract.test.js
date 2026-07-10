import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeOpenAIEngine } from '../engines/openai.js'
import { PROVIDERS, resolveKey, jurisdictionNote, refineCharBudgetFor } from '../engines/providers.js'

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

test('provider registry preserves known per-provider contracts', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['deepseek', 'glm', 'kimi', 'openai'])

  assert.equal(PROVIDERS.deepseek.maxTokensParam, 'max_tokens')
  assert.equal(PROVIDERS.deepseek.forceStructured, true)
  assert.equal(PROVIDERS.deepseek.nativeSearch, undefined)

  assert.equal(PROVIDERS.glm.maxTokensParam, 'max_tokens')
  assert.equal(PROVIDERS.glm.forceStructured, true)
  assert.equal(PROVIDERS.glm.nativeSearch.tool.type, 'web_search')

  assert.equal(PROVIDERS.kimi.maxTokensParam, 'max_completion_tokens')
  assert.equal(PROVIDERS.kimi.forceStructured, false)
  assert.equal(PROVIDERS.kimi.nativeSearch.echo, '$web_search')

  assert.equal(PROVIDERS.openai.maxTokensParam, 'max_completion_tokens')
  assert.equal(PROVIDERS.openai.forceStructured, true)
  assert.equal(PROVIDERS.openai.nativeSearch, undefined)

  // source-protection surface: jurisdiction must be declared for every provider
  assert.deepEqual(
    Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.jurisdiction])),
    { deepseek: 'PRC', glm: 'PRC', kimi: 'PRC', openai: 'US' },
  )
})

test('refineCharBudgetFor: only the two DeepSeek refine models declare a faithful-refine budget; all else unset', () => {
  assert.equal(refineCharBudgetFor('deepseek', 'deepseek-v4-pro'), 25000)
  assert.equal(refineCharBudgetFor('deepseek', 'deepseek-v4-flash'), 18000)
  assert.equal(refineCharBudgetFor('deepseek', 'deepseek-chat'), undefined, 'an un-listed DeepSeek id has no budget')
  for (const p of ['glm', 'kimi', 'openai']) {
    for (const id of Object.values(PROVIDERS[p].models)) {
      assert.equal(refineCharBudgetFor(p, id), undefined, `${p}/${id} is unset → no cap → unchanged behaviour`)
    }
  }
  assert.equal(refineCharBudgetFor('anthropic', 'claude-opus-4-8'), undefined, 'Anthropic is not in this registry → no budget')
  assert.equal(refineCharBudgetFor('nonexistent', 'x'), undefined, 'unknown provider → undefined, no throw')
})

test('engine.refineBudget resolves the refine tier to a model id and returns its budget (respects --models)', () => {
  const engine = makeOpenAIEngine({ client: {}, models: PROVIDERS.deepseek.models, refineCharBudget: PROVIDERS.deepseek.refineCharBudget, concurrency: 1 })
  assert.deepEqual(engine.refineBudget('opus'), { model: 'deepseek-v4-pro', budget: 25000 }, 'the smart/opus tier → v4-pro budget')
  assert.deepEqual(engine.refineBudget('haiku'), { model: 'deepseek-v4-flash', budget: 18000 })
  assert.deepEqual(engine.refineBudget('deepseek-v4-pro'), { model: 'deepseek-v4-pro', budget: 25000 }, 'a raw --models id resolves too')
  assert.equal(engine.refineBudget('deepseek-chat'), undefined, 'a model with no declared budget → undefined')
  const noBudget = makeOpenAIEngine({ client: {}, models: PROVIDERS.kimi.models, concurrency: 1 })
  assert.equal(noBudget.refineBudget('opus'), undefined, 'a provider with no budget map → always undefined')
})

test('jurisdictionNote warns for PRC operators and stays silent otherwise', () => {
  assert.match(jurisdictionNote('deepseek'), /信源保护提示/, 'PRC provider gets the notice')
  assert.match(jurisdictionNote('glm'), /运营方/, 'endpoint choice does not change the operator')
  assert.equal(jurisdictionNote('openai'), '', 'US provider — no notice')
  assert.equal(jurisdictionNote('nonexistent'), '', 'unknown provider — no notice, no throw')
})

test('resolveKey uses provider env var priority order', () => {
  assert.deepEqual(resolveKey('glm', { ZAI_API_KEY: 'zai', GLM_API_KEY: 'glm' }), { key: 'zai', varName: 'ZAI_API_KEY' })
  assert.deepEqual(resolveKey('glm', { GLM_API_KEY: 'glm' }), { key: 'glm', varName: 'GLM_API_KEY' })
  assert.deepEqual(resolveKey('openai', {}), { key: undefined, varName: 'OPENAI_API_KEY' })
  assert.deepEqual(resolveKey('missing', {}), { key: undefined, varName: undefined })
})

test('schema agents return structured_output tool arguments directly', async () => {
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeOpenAIEngine({ client, models: { opus: 'mock-opus' }, concurrency: 1 })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'scout:file' })

  assert.deepEqual(result, { ok: true })
  assert.equal(client.calls[0].model, 'mock-opus')
  assert.equal(client.calls[0].max_tokens, 16000)
  assert.deepEqual(toolNames(client.calls[0]).sort(), ['Concat', 'Edit', 'Read', 'Write', 'structured_output'].sort())
})

test('file tool calls feed local tool results back to the model', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-provider-contract-'))
  const source = path.join(base, 'source.txt')
  fs.writeFileSync(source, 'hello from transcript\n', 'utf8')
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('read1', 'Read', { file_path: source })] }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeOpenAIEngine({
    client,
    models: { opus: 'mock-opus' },
    concurrency: 1,
    filePolicy: { readRoots: [], writeRoots: [base], readPaths: [source] },
  })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })

  assert.deepEqual(result, { ok: true })
  const toolMessage = client.calls[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'read1')
  assert.match(toolMessage.content, /hello from transcript/)
})

test('web tools are only exposed to online labels', async () => {
  const offlineClient = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const offlineEngine = makeOpenAIEngine({ client: offlineClient, models: { opus: 'mock-opus' }, concurrency: 1 })
  await offlineEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })
  assert.equal(toolNames(offlineClient.calls[0]).includes('web_search'), false)
  assert.equal(toolNames(offlineClient.calls[0]).includes('web_fetch'), false)

  const onlineClient = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const onlineEngine = makeOpenAIEngine({ client: onlineClient, models: { sonnet: 'mock-sonnet' }, concurrency: 1 })
  await onlineEngine.agent('prompt', { model: 'sonnet', schema: SIMPLE_SCHEMA, label: 'verify:file' })
  assert.equal(toolNames(onlineClient.calls[0]).includes('web_search'), true)
  assert.equal(toolNames(onlineClient.calls[0]).includes('web_fetch'), true)
})

test('native-search providers expose provider search plus client fetch only on online labels', async () => {
  const nativeSearch = { tool: { type: 'web_search', web_search: { enable: true, search_result: true } } }
  const offlineClient = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const offlineEngine = makeOpenAIEngine({ client: offlineClient, models: { opus: 'mock-opus' }, nativeSearch, concurrency: 1 })
  await offlineEngine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'refine:file' })
  assert.equal(toolNames(offlineClient.calls[0]).includes('web_search'), false)
  assert.equal(toolNames(offlineClient.calls[0]).includes('web_fetch'), false)

  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeOpenAIEngine({ client, models: { sonnet: 'mock-sonnet' }, nativeSearch, concurrency: 1 })

  await engine.agent('prompt', { model: 'sonnet', schema: SIMPLE_SCHEMA, label: 'timeline:company' })

  const names = toolNames(client.calls[0])
  assert.equal(names.includes('web_search'), true)
  assert.equal(names.includes('web_fetch'), true)
})

test('Kimi native search calls are echoed instead of executed locally', async () => {
  const client = mockClient([
    completion({ content: '', tool_calls: [toolCall('search1', '$web_search', { query: 'company funding' })] }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeOpenAIEngine({
    client,
    models: { sonnet: 'mock-kimi' },
    nativeSearch: { tool: { type: 'builtin_function', function: { name: '$web_search' } }, echo: '$web_search' },
    concurrency: 1,
  })

  const result = await engine.agent('prompt', { model: 'sonnet', schema: SIMPLE_SCHEMA, label: 'verify:file' })

  assert.deepEqual(result, { ok: true })
  const echoed = client.calls[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'search1')
  assert.equal(echoed.name, '$web_search')
  assert.equal(echoed.content, JSON.stringify({ query: 'company funding' }))
})

test('Kimi-style structured fallback uses json_object without forced tool_choice', async () => {
  const client = mockClient([
    completion({ content: 'plain answer' }),
    completion({ content: 'still plain' }),
    completion({ content: 'still no tool' }),
    completion({ content: '{"ok":true}' }),
  ])
  const engine = makeOpenAIEngine({
    client,
    models: { opus: 'mock-kimi' },
    maxTokensParam: 'max_completion_tokens',
    forceStructured: false,
    concurrency: 1,
  })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'summary:run' })

  assert.deepEqual(result, { ok: true })
  const fallback = client.calls.at(-1)
  assert.equal(fallback.tool_choice, 'none')
  assert.deepEqual(fallback.response_format, { type: 'json_object' })
  assert.equal(fallback.max_completion_tokens, 64000)
  assert.equal('max_tokens' in fallback, false)
})

test('forceStructured providers force structured_output after nudges', async () => {
  const client = mockClient([
    completion({ content: 'plain answer' }),
    completion({ content: 'still plain' }),
    completion({ content: 'still no tool' }),
    completion({ content: '', tool_calls: [toolCall('so1', 'structured_output', { ok: true })] }),
  ])
  const engine = makeOpenAIEngine({
    client,
    models: { opus: 'mock-openai' },
    maxTokensParam: 'max_completion_tokens',
    forceStructured: true,
    concurrency: 1,
  })

  const result = await engine.agent('prompt', { model: 'opus', schema: SIMPLE_SCHEMA, label: 'summary:run' })

  assert.deepEqual(result, { ok: true })
  const forced = client.calls.at(-1)
  assert.deepEqual(forced.tool_choice, { type: 'function', function: { name: 'structured_output' } })
  assert.equal(forced.max_completion_tokens, 64000)
  assert.equal('max_tokens' in forced, false)
})
