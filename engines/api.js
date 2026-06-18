// ===== API Engine (Universal build) =====
// runPipeline(A, engine) in core/pipeline.js is written against a 5-primitive engine
// interface; the Claude Code build lets the global Workflow object satisfy it directly
// (see build/bootstrap-cc.js). This module satisfies the SAME interface with the
// Anthropic SDK, so everything in core/ — prompts, schemas, pure logic, the pipeline —
// is reused verbatim. See ../universal/BRIEF.md.
//
// The trick that makes ~90% code sharing possible: implement Read / Write / Edit as
// client-side tools (the model calls them → we run them locally → feed results back),
// so core prompts that say “用 Read 分页读…”, “Write 到 …”, “用 Edit …” work unmodified.
// Web verification uses Anthropic's GA server-side tools (web_search / web_fetch) — no
// extra search-API key, and the API surfaces retrieval errors back to the model so the
// prompt's own circuit-breaker (“连续 2 次报错→停止”) can fire.
//
// Provides:
//   agent(prompt, { label, model, schema, phase }) -> Promise<obj | string | null>
//   parallel(thunks) -> Promise<arr>          // barrier; a failing thunk resolves to null
//   pipeline(items, ...stages) -> Promise<arr> // per-item, no barrier; a failing/empty stage → null for that item
//   phase(title) -> void
//   log(msg) -> void
//
// Usage (inside universal/cli.js):
//   import { runPipeline } from '../core/pipeline.js'
//   const engine = makeApiEngine({ apiKey: process.env.ANTHROPIC_API_KEY, models, concurrency })
//   const result = await runPipeline(A, engine)

import os from 'node:os'
import Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'
import { TOOL_SPECS, runFileTool } from './fileops.js'

// Tier name → model id. core/pipeline.js passes tier names ('haiku','sonnet','opus')
// plus the literal 'haiku' for completeness checks; a full id passes through unchanged.
const MODEL_IDS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
}
const resolveModel = (m) => MODEL_IDS[m] || m || MODEL_IDS.opus

// Output ceilings. Refine/summary/timeline/logic write a whole transcript or doc inside
// a single tool call, so opus/fable get generous headroom (streaming → no HTTP timeout).
// Scout/check are small structured returns. (Effort is left at its default 'high'; we do
// not set output_config.effort — it errors on Haiku 4.5.)
function maxTokensFor(modelId) {
  if (/haiku/.test(modelId)) return 16000
  if (/opus|fable/.test(modelId)) return 96000
  return 32000 // sonnet (verify/dedup)
}
// Adaptive thinking helps the high-judgment tiers; Haiku 4.5 is left without a thinking config.
const thinkingFor = (modelId) => (/opus|sonnet|fable/.test(modelId) ? { type: 'adaptive' } : undefined)

// Server-side web tools (GA, dynamic filtering, no beta header). Given to every agent;
// the prompts that must not search ("不联网") simply don't — same as the Claude Code build,
// where subagents carry the full toolset and the prompt governs use.
const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
]

// Client-side tools (shared logic in fileops.js), in Anthropic tool shape.
const CLIENT_TOOLS = TOOL_SPECS.map((s) => ({ name: s.name, description: s.description, input_schema: s.parameters }))

const MAX_TURNS = 100 // tool-loop ceiling per agent (reads + writes + edits + searches + nudges)

function execTool(tu) {
  const r = runFileTool(tu.name, tu.input || {})
  const block = { type: 'tool_result', tool_use_id: tu.id, content: r.text }
  if (!r.ok) block.is_error = true
  return block
}

export function makeApiEngine(opts = {}) {
  const {
    apiKey = process.env.ANTHROPIC_API_KEY,
    concurrency = Math.max(2, Math.min(16, (os.cpus().length || 4) - 2)),
    models, // optional tier→model-id override (e.g. {opus:'claude-fable-5'}); else MODEL_IDS
    onPhase,
    onLog,
  } = opts
  const resolveModelFor = (m) => (models && models[m]) || resolveModel(m)
  // opts.client lets tests inject a mock; production constructs from apiKey.
  if (!opts.client && !apiKey) throw new Error('makeApiEngine: 缺少 ANTHROPIC_API_KEY（传入 opts.apiKey 或设环境变量）')

  const client = opts.client || new Anthropic({ apiKey, maxRetries: 4 })
  const limit = pLimit(concurrency)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }

  const phase = (title) => (onPhase ? onPhase(title) : process.stderr.write(`\n▸ ${title}\n`))
  const log = (msg) => (onLog ? onLog(msg) : process.stderr.write(`  ${msg}\n`))

  function tally(u) {
    if (!u) return
    usage.input += u.input_tokens || 0
    usage.output += u.output_tokens || 0
    usage.cacheRead += u.cache_read_input_tokens || 0
    usage.cacheWrite += u.cache_creation_input_tokens || 0
  }

  // One streamed Messages request (streaming avoids HTTP timeouts on large outputs).
  async function create(params) {
    const stream = client.messages.stream(params)
    const msg = await stream.finalMessage()
    tally(msg.usage)
    return msg
  }

  const textOf = (msg) =>
    (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()

  async function runAgent(prompt, { model, schema, label } = {}) {
    const modelId = resolveModelFor(model)
    const thinking = thinkingFor(modelId)
    const tools = [...CLIENT_TOOLS, ...WEB_TOOLS]
    if (schema) {
      tools.push({
        name: 'structured_output',
        description: '提交最终结构化结果（严格符合所需 schema）。完成全部工作后调用本工具恰好一次；不要用普通文字回复最终结果。',
        input_schema: schema,
      })
    }
    const sys = schema
      ? `${prompt}\n\n【提交方式】完成全部工作后，必须调用 structured_output 工具提交结构化结果；不要用普通文字给出最终结果。`
      : prompt

    const messages = [{ role: 'user', content: sys }]
    const base = { model: modelId, max_tokens: maxTokensFor(modelId), tools }
    if (thinking) base.thinking = thinking

    let nudges = 0
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const msg = await create({ ...base, messages })
      if (msg.stop_reason === 'refusal') {
        log(`⚠ ${label || 'agent'} 被安全策略拒绝（refusal）`)
        return null
      }
      messages.push({ role: 'assistant', content: msg.content })

      const toolUses = (msg.content || []).filter((b) => b.type === 'tool_use')
      const structured = toolUses.find((b) => b.name === 'structured_output')
      if (schema && structured) return structured.input

      const clientUses = toolUses.filter((b) => b.name !== 'structured_output')
      if (clientUses.length) {
        messages.push({ role: 'user', content: clientUses.map(execTool) })
        continue
      }

      // No client tool calls this turn.
      if (msg.stop_reason === 'pause_turn') continue // server tool (web_search) paused — resume

      // The model ended its turn.
      if (!schema) return textOf(msg)
      // Schema agent finished without submitting — nudge, then force as a last resort.
      if (nudges < 2) {
        nudges++
        messages.push({ role: 'user', content: '请现在调用 structured_output 工具提交最终结构化结果（不要用普通文字回复）。' })
        continue
      }
      const forced = await create({
        ...base,
        thinking: undefined, // forced tool_choice is incompatible with adaptive thinking
        tool_choice: { type: 'tool', name: 'structured_output' },
        messages,
      })
      const f = (forced.content || []).find((b) => b.type === 'tool_use' && b.name === 'structured_output')
      return f ? f.input : null
    }
    log(`⚠ ${label || 'agent'} 达到工具循环上限（${MAX_TURNS}）未提交`)
    return null
  }

  // The concurrency limiter wraps each agent (the leaf unit of work). Nested parallel
  // (verify chunks inside the outer Verify parallel) therefore shares one global cap;
  // the parallel/pipeline wrappers hold no slot themselves → no deadlock.
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

  // Barrier: await all thunks; a throwing thunk resolves to null (core .filter(Boolean)s).
  function parallel(thunks) {
    return Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)))
  }

  // Per-item, no barrier: each item flows through all stages independently. A stage that
  // throws — or returns null/undefined/false — drops that item to null and skips the rest.
  // Stages receive (prevResult, originalItem, index); the first stage's prevResult is the item.
  function pipeline(items, ...stages) {
    return Promise.all(
      (items || []).map(async (item, i) => {
        let v = item
        for (const stage of stages) {
          try {
            v = await stage(v, item, i)
          } catch {
            return null
          }
          if (!v) return null
        }
        return v
      })
    )
  }

  return { agent, parallel, pipeline, phase, log, usage: () => ({ ...usage }) }
}
