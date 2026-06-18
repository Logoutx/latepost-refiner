// ===== OpenAI-compatible engine (Universal build, non-Anthropic providers) =====
// Satisfies core's 5-primitive engine interface against any OpenAI-compatible Chat
// Completions API (DeepSeek / GLM / Kimi / OpenAI — see engines/providers.js). Mirrors
// engines/api.js (the Anthropic engine) so the same core/ prompts, schemas, and pipeline
// run unchanged; only the wire format and a few per-provider quirks differ.
//
// Client tools Read/Write/Edit share fileops.js. Online stages either use a provider
// native search tool (where available) or CLIENT-side web_search (Tavily, gated on
// TAVILY_API_KEY) + web_fetch (plain fetch). Offline stages never receive web tools.
//
// Structured output: a `structured_output` function tool the model is told to call. When
// it ends a turn without calling it: nudge, then (forceStructured providers) force it via
// tool_choice, else (Kimi) a final response_format:json_object call. Schemas carry no
// `required` (core's lesson), so partial output degrades rather than loops.

import os from 'node:os'
import OpenAI from 'openai'
import pLimit from 'p-limit'
import { TOOL_SPECS, runFileTool, makeFilePolicy } from './fileops.js'

const MAX_TURNS = 100
const toFn = (s) => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } })
const FILE_TOOLS = TOOL_SPECS.map(toFn)
const WEB_SEARCH_TOOL = toFn({ name: 'web_search', description: '联网搜索，返回若干结果（标题 / 网址 / 摘要）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词' } }, required: ['query'] } })
const WEB_FETCH_TOOL = toFn({ name: 'web_fetch', description: '抓取一个网页 URL，返回正文文本（截断）。', parameters: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } })
const WEB_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]
// Online stages (verify/timeline) are the only ones that should search; gating native-search
// injection to them limits blast radius if a vendor tool shape is off (scout/refine still run).
const ONLINE_LABEL = /^(verify|timeline)/
const structuredTool = (schema) => ({
  type: 'function',
  function: { name: 'structured_output', description: '提交最终结构化结果（符合所需 schema）。完成全部工作后调用一次；不要用普通文字给出最终结果。', parameters: schema },
})

// big outputs (refine/logic/summary/timeline write whole docs via tool args / content)
const BIG_LABEL = /^(refine|logic|summary|timeline)/i
const maxTokensFor = (label = '') => (BIG_LABEL.test(label) ? 64000 : 16000)

function parseJSON(s) {
  if (s == null) return null
  if (typeof s === 'object') return s
  let t = String(s).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  try { return JSON.parse(t) } catch { /* try to extract */ }
  const m = t.match(/[{[][\s\S]*[}\]]/)
  if (m) { try { return JSON.parse(m[0]) } catch { /* give up */ } }
  return null
}

async function webSearch(query) {
  const key = process.env.TAVILY_API_KEY
  if (!key) return 'web_search 不可用：未配置 TAVILY_API_KEY（当前 provider 未使用原生联网搜索；联网核实需设 TAVILY_API_KEY，或改用带原生搜索的 provider）。'
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 5 }),
    })
    if (!r.ok) return `web_search 出错：HTTP ${r.status}`
    const j = await r.json()
    const results = (j.results || []).map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${(x.content || '').slice(0, 500)}`).join('\n')
    return (j.answer ? `摘要：${j.answer}\n\n` : '') + (results || '无结果')
  } catch (e) { return `web_search 出错：${e.message}` }
}

async function webFetch(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 transcriber' } })
    if (!r.ok) return `web_fetch 出错：HTTP ${r.status}`
    const html = await r.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    return text.slice(0, 8000) || '(页面无可提取文本)'
  } catch (e) { return `web_fetch 出错：${e.message}` }
}

export function makeOpenAIEngine(opts = {}) {
  const {
    apiKey, baseURL,
    models = {}, // { haiku, sonnet, opus } → provider model id
    maxTokensParam = 'max_tokens',
    forceStructured = true,
    nativeSearch = null, // provider native web search: { tool, echo? } — used on online stages
    concurrency = Math.max(2, Math.min(16, (os.cpus().length || 4) - 2)),
    filePolicy,
    onPhase, onLog,
  } = opts
  if (!opts.client && !apiKey) throw new Error('makeOpenAIEngine: 缺少 API key')

  const client = opts.client || new OpenAI({ apiKey, baseURL, timeout: 600000, maxRetries: 4 })
  const limit = pLimit(concurrency)
  const safeFilePolicy = makeFilePolicy(filePolicy)
  const usage = { input: 0, output: 0, agents: 0, failed: 0 }
  const resolveModel = (m) => models[m] || m || models.opus || 'gpt-4o'

  const phase = (title) => (onPhase ? onPhase(title) : process.stderr.write(`\n▸ ${title}\n`))
  const log = (msg) => (onLog ? onLog(msg) : process.stderr.write(`  ${msg}\n`))

  async function create(params) {
    const comp = await client.chat.completions.create(params)
    if (comp && comp.usage) { usage.input += comp.usage.prompt_tokens || 0; usage.output += comp.usage.completion_tokens || 0 }
    return comp
  }

  async function execTool(call) {
    const name = call.function && call.function.name
    const args = parseJSON(call.function && call.function.arguments) || {}
    if (name === 'web_search') return await webSearch(args.query || '')
    if (name === 'web_fetch') return await webFetch(args.url || '')
    return runFileTool(name, args, safeFilePolicy).text // Read / Write / Edit
  }

  // Last-resort structured output when the model won't call the tool on its own.
  async function forceStructured_(messages, schema, modelId, label) {
    try {
      if (forceStructured) {
        const comp = await create({
          model: modelId,
          messages: [...messages, { role: 'user', content: '请调用 structured_output 工具提交结果。' }],
          tools: [structuredTool(schema)],
          tool_choice: { type: 'function', function: { name: 'structured_output' } },
          [maxTokensParam]: maxTokensFor(label),
        })
        const c = (comp.choices?.[0]?.message?.tool_calls || []).find((x) => x.function?.name === 'structured_output')
        const v = c && parseJSON(c.function.arguments)
        if (v) return v
      }
      // JSON fallback (Kimi, or if forcing failed) — works on every provider (all support json_object).
      const comp2 = await create({
        model: modelId,
        messages: [...messages, { role: 'user', content: '仅输出一个符合要求的 JSON 对象（不要任何解释、不要代码围栏）。' }],
        tools: [...FILE_TOOLS],
        tool_choice: 'none',
        response_format: { type: 'json_object' },
        [maxTokensParam]: maxTokensFor(label),
      })
      return parseJSON(comp2.choices?.[0]?.message?.content)
    } catch (e) {
      log(`⚠ ${label || 'agent'} 结构化兜底失败：${e.message}`)
      return null
    }
  }

  async function runAgent(prompt, { model, schema, label } = {}) {
    const modelId = resolveModel(model)
    const tools = [...FILE_TOOLS]
    const online = ONLINE_LABEL.test(label || '')
    if (online) {
      if (nativeSearch && nativeSearch.tool) tools.push(nativeSearch.tool, WEB_FETCH_TOOL) // provider native search + client fetch
      else tools.push(...WEB_TOOLS) // client Tavily search + fetch
    }
    if (schema) tools.push(structuredTool(schema))
    const content = schema
      ? `${prompt}\n\n【提交方式】完成全部工作后，必须调用 structured_output 工具提交结构化结果；不要用普通文字给出最终结果。`
      : prompt
    const messages = [{ role: 'user', content }]
    let nudges = 0

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const comp = await create({ model: modelId, messages, tools, [maxTokensParam]: maxTokensFor(label) })
      const choice = comp.choices?.[0]
      if (!choice) return null
      const m = choice.message || {}
      if (m.refusal) { log(`⚠ ${label || 'agent'} 被拒：${m.refusal}`); return null }

      const asst = { role: 'assistant', content: m.content ?? '' }
      const calls = m.tool_calls || []
      if (calls.length) asst.tool_calls = calls
      messages.push(asst)

      const so = calls.find((c) => c.function?.name === 'structured_output')
      if (schema && so) { const v = parseJSON(so.function.arguments); if (v) return v }

      if (calls.length) {
        for (const c of calls) {
          const fname = c.function && c.function.name
          if (nativeSearch && nativeSearch.echo && fname === nativeSearch.echo) {
            // Kimi $web_search: echo the arguments back to trigger server-side execution
            messages.push({ role: 'tool', tool_call_id: c.id, name: fname, content: (c.function && c.function.arguments) || '{}' })
            continue
          }
          const text = fname === 'structured_output'
            ? 'structured_output 参数解析失败，请重新以合法 JSON 调用。'
            : await execTool(c)
          messages.push({ role: 'tool', tool_call_id: c.id, content: String(text) })
        }
        continue
      }

      // No tool calls → the model ended its turn.
      if (choice.finish_reason === 'content_filter') { log(`⚠ ${label || 'agent'} content_filter`); return null }
      if (!schema) return (m.content || '').trim()
      if (nudges < 2) {
        nudges++
        messages.push({ role: 'user', content: '请现在调用 structured_output 工具提交最终结构化结果（不要用普通文字回复）。' })
        continue
      }
      return await forceStructured_(messages, schema, modelId, label)
    }
    log(`⚠ ${label || 'agent'} 达到工具循环上限（${MAX_TURNS}）`)
    return schema ? await forceStructured_(messages, schema, modelId, label) : null
  }

  // Limiter wraps each agent (leaf unit); nested parallel shares one global cap, no deadlock.
  function agent(prompt, agentOpts = {}) {
    return limit(async () => {
      usage.agents++
      try {
        return await runAgent(prompt, agentOpts)
      } catch (e) {
        usage.failed++
        log(`⚠ ${agentOpts.label || 'agent'} 失败：${e.message}`)
        return null
      }
    })
  }

  function parallel(thunks) {
    return Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)))
  }

  function pipeline(items, ...stages) {
    return Promise.all(
      (items || []).map(async (item, i) => {
        let v = item
        for (const stage of stages) {
          try { v = await stage(v, item, i) } catch { return null }
          if (!v) return null
        }
        return v
      })
    )
  }

  return { agent, parallel, pipeline, phase, log, usage: () => ({ ...usage }) }
}
