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
import { TOOL_SPECS, runFileTool, makeFilePolicy } from './fileops.js'

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

// M12 reasoning-effort knob. The SDK carries effort in `output_config.effort`
// (MessageCreateParams.output_config.effort — SDK 0.104.2 resources/messages/messages.d.ts:825-830,
// values 'low'|'medium'|'high'|'xhigh'|'max'), a field SEPARATE from `thinking`, so effort and adaptive
// thinking COMPOSE — we can set both on a request. GUARD (mirrors thinkingFor's allowlist exactly): only the
// adaptive-thinking tiers (opus/sonnet/fable) may carry effort; Haiku 4.5 is the ONLY excluded tier because
// output_config.effort 400-errors on it (see maxTokensFor's note). An out-of-allowlist model, an absent effort,
// or an unrecognised value → no output_config emitted (today's default 'high' behaviour, byte-for-byte).
const EFFORT_ALLOWED = /opus|sonnet|fable/
const EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export function outputConfigFor(modelId, effort) {
  if (!effort || !EFFORT_VALUES.has(effort) || !EFFORT_ALLOWED.test(modelId)) return undefined
  return { effort }
}

// Server-side web tools (GA, dynamic filtering, no beta header). Only verify/timeline
// agents receive these tools; offline stages should not be able to browse.
const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search' },
  { type: 'web_fetch_20260209', name: 'web_fetch' },
]
const ONLINE_LABEL = /^(verify|timeline)/

// Client-side tools (shared logic in fileops.js), in Anthropic tool shape.
const CLIENT_TOOLS = TOOL_SPECS.map((s) => ({ name: s.name, description: s.description, input_schema: s.parameters }))

const MAX_TURNS = 100 // tool-loop ceiling per agent (reads + writes + edits + searches + nudges)

// ---- Prompt caching (Anthropic ephemeral breakpoints) -----------------------
// Agent loops re-send the whole growing conversation every turn. Without cache
// breakpoints Anthropic bills the full prefix at 1× each turn (the 24:1 input:output
// we measured). We place exactly TWO `cache_control` breakpoints per request:
//   1) the tools+system prefix (shared across every agent in a run), and
//   2) the last block of the last message (the running conversation).
// Each turn then re-reads the cached prefix at 0.1× and writes only the new suffix
// at 1.25×. Anthropic allows up to 4 breakpoints; because `messages` is reused
// across turns, a breakpoint we set on turn N would still be there on turn N+1, so
// we STRIP any cache_control we previously added to message blocks before re-adding
// one — this keeps the count pinned at 2 and never trips the 4-breakpoint limit.
const EPHEMERAL = { type: 'ephemeral' }

// Return a shallow clone of a content block with cache_control removed.
const stripCC = (block) => {
  if (!block || typeof block !== 'object' || !('cache_control' in block)) return block
  const { cache_control, ...rest } = block
  return rest
}

// Set cache_control on the LAST content block of a message's content.
// - string content → wrap into a single text block carrying the breakpoint
// - array content  → clone, mark the last block (works for text and tool_result)
// Returns new content; never mutates the input.
function markLastBlock(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: EPHEMERAL }]
  }
  if (Array.isArray(content) && content.length) {
    const out = content.map(stripCC) // drop any breakpoint left from a previous turn
    const last = out[out.length - 1]
    out[out.length - 1] = { ...last, cache_control: EPHEMERAL }
    return out
  }
  return content // empty/absent content → nothing to cache
}

// Pure: given Messages request params, return a NEW params object with two cache
// breakpoints (system prefix + last message). Unit-testable without any API call.
export function withCacheBreakpoints(params = {}) {
  const out = { ...params }

  // 1) System prompt breakpoint. String → single cached text block; array → mark last block.
  if (typeof out.system === 'string') {
    out.system = [{ type: 'text', text: out.system, cache_control: EPHEMERAL }]
  } else if (Array.isArray(out.system) && out.system.length) {
    const sys = out.system.map(stripCC)
    const last = sys[sys.length - 1]
    sys[sys.length - 1] = { ...last, cache_control: EPHEMERAL }
    out.system = sys
  }

  // 2) Conversation breakpoint on the last block of the last message. Also strip any
  //    stale breakpoints from EARLIER messages so the total stays at 2, not 2-per-turn.
  if (Array.isArray(out.messages) && out.messages.length) {
    const msgs = out.messages.map((m) => {
      if (!m || typeof m !== 'object') return m
      if (Array.isArray(m.content)) return { ...m, content: m.content.map(stripCC) }
      return m
    })
    const lastIdx = msgs.length - 1
    const lastMsg = msgs[lastIdx]
    if (lastMsg && typeof lastMsg === 'object') {
      msgs[lastIdx] = { ...lastMsg, content: markLastBlock(lastMsg.content) }
    }
    out.messages = msgs
  }

  return out
}

function execTool(tu, filePolicy) {
  const r = runFileTool(tu.name, tu.input || {}, filePolicy)
  const block = { type: 'tool_result', tool_use_id: tu.id, content: r.text }
  if (!r.ok) block.is_error = true
  return block
}

export function makeApiEngine(opts = {}) {
  const {
    apiKey = process.env.ANTHROPIC_API_KEY,
    concurrency = Math.max(2, Math.min(16, (os.cpus().length || 4) - 2)),
    models, // optional tier→model-id override (e.g. {opus:'claude-fable-5'}); else MODEL_IDS
    filePolicy,
    onPhase,
    onLog,
  } = opts
  const resolveModelFor = (m) => (models && models[m]) || resolveModel(m)
  // opts.client lets tests inject a mock; production constructs from apiKey.
  if (!opts.client && !apiKey) throw new Error('makeApiEngine: 缺少 ANTHROPIC_API_KEY（传入 opts.apiKey 或设环境变量）')

  const client = opts.client || new Anthropic({ apiKey, maxRetries: 4 })
  const limit = pLimit(concurrency)
  const safeFilePolicy = makeFilePolicy(filePolicy)
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
  // withCacheBreakpoints adds the ephemeral cache_control breakpoints just before the
  // wire call, so every request in the tool loop reuses the cached tools+system prefix.
  async function create(params) {
    const stream = client.messages.stream(withCacheBreakpoints(params))
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

  async function runAgent(prompt, { model, schema, label, effort, maxTokens } = {}) {
    const modelId = resolveModelFor(model)
    const thinking = thinkingFor(modelId)
    const outputConfig = outputConfigFor(modelId, effort)
    const tools = [...CLIENT_TOOLS]
    if (ONLINE_LABEL.test(label || '')) tools.push(...WEB_TOOLS)
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
    const base = { model: modelId, max_tokens: maxTokens || maxTokensFor(modelId), tools }
    if (thinking) base.thinking = thinking
    if (outputConfig) base.output_config = outputConfig

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
        messages.push({ role: 'user', content: clientUses.map((tu) => execTool(tu, safeFilePolicy)) })
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
        output_config: undefined, // and effort rides with adaptive thinking — drop it for the forced call too
        tool_choice: { type: 'tool', name: 'structured_output' },
        messages,
      })
      const f = (forced.content || []).find((b) => b.type === 'tool_use' && b.name === 'structured_output')
      return f ? f.input : null
    }
    log(`⚠ ${label || 'agent'} 达到工具循环上限（${MAX_TURNS}）未提交`)
    return null
  }

  // M11a single-shot refine: ONE non-tool request whose response text IS the deliverable (no Read/Write/Edit
  // tool loop, no structured_output). Used by the single-shot refine mode — the prompt inlines the full source
  // and the model returns the refined document directly; JS writes it to disk. maxTokens is computed by the
  // caller from source size (singleShotMaxTokens), effort/thinking apply exactly as in runAgent (they compose).
  // Returns the response text, or null on refusal/empty. Shares the same streaming create() (cache breakpoints,
  // usage tally) as every other request.
  async function completeOnce(prompt, { model, effort, maxTokens, label } = {}) {
    const modelId = resolveModelFor(model)
    const thinking = thinkingFor(modelId)
    const outputConfig = outputConfigFor(modelId, effort)
    const params = { model: modelId, max_tokens: maxTokens || maxTokensFor(modelId), messages: [{ role: 'user', content: prompt }] }
    if (thinking) params.thinking = thinking
    if (outputConfig) params.output_config = outputConfig
    const msg = await create(params)
    if (msg.stop_reason === 'refusal') { log(`⚠ ${label || 'single-shot'} 被安全策略拒绝（refusal）`); return null }
    const text = textOf(msg)
    return text || null
  }

  // Wrapped in the concurrency limiter like agent(), so a batch of single-shot files respects the global cap.
  function complete(prompt, completeOpts = {}) {
    return limit(async () => {
      usage.agents++
      try {
        return await completeOnce(prompt, completeOpts)
      } catch (e) {
        usage.failed++
        log(`⚠ ${completeOpts.label || 'single-shot'} 失败：${e.message}`)
        return null
      }
    })
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

  return { agent, complete, parallel, pipeline, phase, log, usage: () => ({ ...usage }) }
}
