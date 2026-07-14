// ===== DeepSeek engine (Universal build) =====
// Satisfies core's 5-primitive engine interface against DeepSeek's OpenAI-compatible Chat
// Completions API, so the same core/ prompts, schemas, and pipeline run unchanged. DeepSeek is
// the ONLY API provider the Universal edition supports — Claude runs via the Claude Code skill,
// not this engine. Everything here is hard-wired to DeepSeek; there is no provider selection.
//
// Fixed setup:
//   • Endpoint  https://api.deepseek.com ; key from DEEPSEEK_API_KEY.
//   • Models    deepseek-v4-flash for the mechanical tiers (scout/check/dedup/stitch → haiku/sonnet),
//               deepseek-v4-pro for the judgment tiers (refine/logic/summary/timeline → opus).
//               Non-thinking tiers on purpose: DeepSeek's thinking mode disables function calling.
//   • Web       Tavily ONLY (TAVILY_API_KEY), a CLIENT-side web_search + web_fetch pair injected on
//               the online stages (verify/timeline). Absent key → graceful degrade to no-verify.
//   • Structured output via a forced function call (tool_choice), which DeepSeek supports.
//
// Client tools Read/Write/Edit share fileops.js. Offline stages never receive web tools.

import os from 'node:os'
import OpenAI from 'openai'
import pLimit from 'p-limit'
import { TOOL_SPECS, runFileTool, makeFilePolicy } from './fileops.js'

// DeepSeek's OpenAI-compatible endpoint. Fixed — there is no --base-url anymore.
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// Tier word (core passes 'haiku'/'sonnet'/'opus') → DeepSeek model id. FIXED, no selection.
// Validated 2026-07-07 on a real 34K-char interview: the old all-deepseek-chat default failed the
// hard gates (compression + a real dropped section); the flash/pro split passed everything.
export const DEEPSEEK_MODELS = { haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', opus: 'deepseek-v4-pro' }

// Per-model faithful-refine budget, in 正文字数 (content chars). A model that silently compresses a long
// transcript into a summary must be auto-split BELOW the length where it starts folding content — the refine
// pipeline chunks any file whose 字数 exceeds this, at speaker-turn boundaries (see splitForRefine). Keyed by
// model id. Evidence from real single-agent refine runs (retention = 成稿字数 ÷ 源正文字数; hard floor 0.55,
// healthy ≈ 0.79–0.83):
//   deepseek-v4-pro — 34,769 字 → 0.827 (healthy); 53,576 字 / 4 speakers, single-shot → 0.552 (scraped the
//     floor, ~2,665 字 folded away). A controlled chunk-size experiment on that same 53.6K file (2026-07-10):
//     3 chunks ≈ 18K → 0.607; 6 chunks ≈ 8.9K via --chunk-size 10000 → 0.729 with only 661 字 lost and no
//     sub-heading fragmentation. 10000 (owner-set, 2026-07-10) locks in the winning size; costs ~+31% output
//     tokens and ~+40% wall-clock vs 3 chunks — retention is the metric this tool exists for.
//   deepseek-v4-flash — thinner evidence: at 34,769 字 it kept only 0.714 and silently dropped a section, so a
//     bigger safety margin → 18000. TUNABLE: raise it as clean-run data accumulates.
export const REFINE_CHAR_BUDGET = { 'deepseek-v4-pro': 10000, 'deepseek-v4-flash': 18000 }

// Source-protection notice: DeepSeek is operated by a PRC company, so the FULL transcript is processed
// server-side under local law (content screening included — screening means the content was read). Shown at
// the CLI start banner and in the web UI. Deliberately always-on; we ship no sensitive-topic keyword list
// (incompleteable, and itself a liability) — the honest statement is that the whole transcript is processed.
export const SOURCE_PROTECTION_NOTE = '信源保护提示：DeepSeek 由中国境内公司运营，转录全文将传输至其服务器处理并受当地法规约束（含内容审查——审查即意味着内容被服务端读取）。涉敏感话题或需保护信源的访谈请慎用。'

const MAX_TURNS = 100
const toFn = (s) => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } })
const FILE_TOOLS = TOOL_SPECS.map(toFn)
const WEB_SEARCH_TOOL = toFn({ name: 'web_search', description: '联网搜索，返回若干结果（标题 / 网址 / 摘要）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词' } }, required: ['query'] } })
const WEB_FETCH_TOOL = toFn({ name: 'web_fetch', description: '抓取一个网页 URL，返回正文文本（截断）。', parameters: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } })
const WEB_TOOLS = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]
// Online stages (verify/timeline) are the only ones that should search; gating web-tool injection to them
// limits blast radius if Tavily is down (scout/refine still run).
const ONLINE_LABEL = /^(verify|timeline)/
const structuredTool = (schema) => ({
  type: 'function',
  function: { name: 'structured_output', description: '提交最终结构化结果（符合所需 schema）。完成全部工作后调用一次；不要用普通文字给出最终结果。', parameters: schema },
})

// big outputs (refine/logic/summary/timeline write whole docs via tool args / content)
const BIG_LABEL = /^(refine|logic|summary|timeline)/i
const maxTokensFor = (label = '') => (BIG_LABEL.test(label) ? 64000 : 16000)

// ---- Cache observability -----------------------------------------------------
// DeepSeek caches the prompt prefix server-side automatically, so there are no request-side knobs to set —
// we only READ how many prompt tokens were served from cache and fold them into cacheRead. DeepSeek reports
// this as usage.prompt_cache_hit_tokens (miss-tokens are just plain input); the OpenAI-style
// prompt_tokens_details.cached_tokens is also handled so the accounting is robust to either dialect.
// Defensive: any missing field → 0, never throws. Pure + exported for unit testing.
export function parseCachedTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  const openaiStyle = usage.prompt_tokens_details?.cached_tokens
  const deepseekStyle = usage.prompt_cache_hit_tokens
  return (openaiStyle ?? deepseekStyle ?? 0) || 0
}

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
  if (!key) return 'web_search 不可用：未配置 TAVILY_API_KEY（联网核实需设 TAVILY_API_KEY；未设时本次按不联网处理）。'
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
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 latepost-refiner' } })
    if (!r.ok) return `web_fetch 出错：HTTP ${r.status}`
    const html = await r.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    return text.slice(0, 8000) || '(页面无可提取文本)'
  } catch (e) { return `web_fetch 出错：${e.message}` }
}

// Tier word / raw id → DeepSeek model id. Unknown tier → v4-pro (the safe, faithful writing model).
const resolveModel = (m) => DEEPSEEK_MODELS[m] || m || DEEPSEEK_MODELS.opus

export function makeDeepSeekEngine(opts = {}) {
  const {
    apiKey,
    concurrency = Math.max(2, Math.min(16, (os.cpus().length || 4) - 2)),
    filePolicy,
    onPhase, onLog,
  } = opts
  if (!opts.client && !apiKey) throw new Error('makeDeepSeekEngine: 缺少 DEEPSEEK_API_KEY')

  const client = opts.client || new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL, timeout: 600000, maxRetries: 4 })
  const limit = pLimit(concurrency)
  const safeFilePolicy = makeFilePolicy(filePolicy)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }

  const phase = (title) => (onPhase ? onPhase(title) : process.stderr.write(`\n▸ ${title}\n`))
  const log = (msg) => (onLog ? onLog(msg) : process.stderr.write(`  ${msg}\n`))

  async function create(params) {
    const comp = await client.chat.completions.create(params)
    if (comp && comp.usage) {
      // OpenAI-style prompt_tokens INCLUDES cached tokens, so cacheRead is a subset of
      // input reported for observability — we do not subtract it from input.
      usage.input += comp.usage.prompt_tokens || 0
      usage.output += comp.usage.completion_tokens || 0
      usage.cacheRead += parseCachedTokens(comp.usage)
    }
    return comp
  }

  async function execTool(call) {
    const name = call.function && call.function.name
    const args = parseJSON(call.function && call.function.arguments) || {}
    if (name === 'web_search') return await webSearch(args.query || '')
    if (name === 'web_fetch') return await webFetch(args.url || '')
    return runFileTool(name, args, safeFilePolicy).text // Read / Write / Edit
  }

  // Last-resort structured output when the model won't call the tool on its own: force the specific
  // function via tool_choice (DeepSeek supports this). Returns the parsed args, or null on failure.
  async function forceStructured_(messages, schema, modelId, label) {
    try {
      const comp = await create({
        model: modelId,
        messages: [...messages, { role: 'user', content: '请调用 structured_output 工具提交结果。' }],
        tools: [structuredTool(schema)],
        tool_choice: { type: 'function', function: { name: 'structured_output' } },
        max_tokens: maxTokensFor(label),
      })
      const c = (comp.choices?.[0]?.message?.tool_calls || []).find((x) => x.function?.name === 'structured_output')
      const v = c && parseJSON(c.function.arguments)
      return v || null
    } catch (e) {
      log(`⚠ ${label || 'agent'} 结构化兜底失败：${e.message}`)
      return null
    }
  }

  async function runAgent(prompt, { model, schema, label } = {}) {
    const modelId = resolveModel(model)
    const tools = [...FILE_TOOLS]
    if (ONLINE_LABEL.test(label || '')) tools.push(...WEB_TOOLS) // client Tavily search + fetch
    if (schema) tools.push(structuredTool(schema))
    const content = schema
      ? `${prompt}\n\n【提交方式】完成全部工作后，必须调用 structured_output 工具提交结构化结果；不要用普通文字给出最终结果。`
      : prompt
    const messages = [{ role: 'user', content }]
    let nudges = 0

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const comp = await create({ model: modelId, messages, tools, max_tokens: maxTokensFor(label) })
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

  // Faithful-refine budget for the model a refine tier resolves to. Returns { model, budget } when the model
  // declares a budget, else undefined — the pipeline reads it to decide auto-chunking, and undefined means
  // "no cap". Pure lookup, no network.
  function refineBudget(tier) {
    const model = resolveModel(tier)
    const budget = REFINE_CHAR_BUDGET[model]
    return (typeof budget === 'number' && budget > 0) ? { model, budget } : undefined
  }

  return { agent, parallel, pipeline, phase, log, usage: () => ({ ...usage }), refineBudget }
}
