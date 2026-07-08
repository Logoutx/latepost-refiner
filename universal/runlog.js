// ===== Per-run log (time / tokens / estimated cost) =====
// Zero dependencies — Node builtins only. Appends one JSON line per run to a local JSONL file so
// duration/usage/cost can be reviewed across runs without re-deriving it from run.json manifests
// scattered across every run's own outputDir.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_LOG_PATH = path.join(os.homedir(), '.config', 'latepost-refiner', 'runs.jsonl')

// ---------- cost estimation ----------
// Prices are per 1,000,000 tokens, USD. Sources (retrieved 2026-07-08):
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//
// DeepSeek accounting (CRITICAL): engines/openai.js reports usage.input INCLUDING cacheRead as a subset
// (OpenAI-style prompt_tokens accounting) — so "fresh" (cache-miss) input = usage.input − usage.cacheRead.
//   cost = fresh × inMiss + cacheRead × inHit + output × out          (all ÷ 1e6)
// DeepSeek does not bill cache writes, so usage.cacheWrite has no term in this formula.
//
// Anthropic accounting: engines/api.js reports usage.input EXCLUDING cache reads/writes — they are
// separate counters. The rates below already bake in Anthropic's standard 5-minute cache multipliers
// (cacheRead ≈ 0.1× base input, cacheWrite ≈ 1.25× base input) on top of one flat per-token rate, because
// this provider's row is not tier-specific (see note on PRICES.anthropic below).
//   cost = input × in + cacheRead × cacheRead_rate + cacheWrite × cacheWrite_rate + output × out   (÷ 1e6)
export const PRICES = {
  deepseek: {
    'deepseek-v4-flash': { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
    'deepseek-v4-pro': { inMiss: 0.435, inHit: 0.003625, out: 0.87 },
    // Legacy default model id (deprecated 2026-07-24 per engines/providers.js); same price as v4-flash.
    'deepseek-chat': { inMiss: 0.14, inHit: 0.0028, out: 0.28 },
  },
  // Not tier-specific: one flat rate regardless of which Claude model (haiku/sonnet/opus/fable) a given
  // tier actually resolved to — so the `models` map passed to estimateCost() is simply unused here.
  anthropic: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
}

const round6 = (n) => Math.round(n * 1e6) / 1e6 // 6dp — sub-cent runs would otherwise show as 0
const round1 = (n) => Math.round(n * 10) / 10

const deepseekPrice = (modelId) => (PRICES.deepseek && PRICES.deepseek[modelId]) || null

// provider: 'anthropic' | 'deepseek' | ... ; models: tier→model-id map (e.g. PROVIDERS.deepseek.models)
// or null; usage: {input, output, cacheRead, cacheWrite, ...}.
// Returns {value, currency:'USD', note} — note is null for an exact per-model computation, or a short
// string (e.g. 'mixed-tier approximation') when the number is a documented approximation — or returns
// plain `null` when there is no price data at all for this provider/model.
export function estimateCost(provider, models, usage) {
  const u = usage || {}
  const input = u.input || 0
  const output = u.output || 0
  const cacheRead = u.cacheRead || 0
  const cacheWrite = u.cacheWrite || 0

  if (provider === 'anthropic') {
    const p = PRICES.anthropic
    const value = round6((input * p.in + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + output * p.out) / 1e6)
    return { value, currency: 'USD', note: null }
  }

  if (provider === 'deepseek') {
    if (!models || typeof models !== 'object') return null
    const ids = [...new Set(Object.values(models).filter(Boolean))]
    if (!ids.length) return null
    const rows = ids.map((id) => [id, deepseekPrice(id)])
    if (rows.some(([, row]) => !row)) return null // any tier's model has no price row → decline to guess

    const fresh = Math.max(0, input - cacheRead) // DeepSeek's usage.input includes cacheRead as a subset

    if (ids.length === 1) {
      const [, row] = rows[0]
      const value = round6((fresh * row.inMiss + cacheRead * row.inHit + output * row.out) / 1e6)
      return { value, currency: 'USD', note: null }
    }

    // Mixed tiers (e.g. flash for mechanical stages, pro for writing): usage is aggregated across the
    // whole run and cannot be split per model. Approximate with the WRITING-stage (opus tier) model's
    // rate for output tokens, and the cheaper of the models actually used for input tokens.
    const writingId = models.opus && deepseekPrice(models.opus) ? models.opus : ids[0]
    const writingRow = deepseekPrice(writingId)
    const cheaperRow = rows.map(([, row]) => row).reduce((a, b) => (b.inMiss < a.inMiss ? b : a))
    const value = round6((fresh * cheaperRow.inMiss + cacheRead * cheaperRow.inHit + output * writingRow.out) / 1e6)
    return { value, currency: 'USD', note: 'mixed-tier approximation' }
  }

  return null // no price data for this provider (glm/kimi/openai/router/injected/unknown)
}

// ---------- entry shape ----------
// Pure — builds the JSON-line entry recorded per run. `params` is runJob()'s raw input, `result` is its
// return value (already carries finishedAt/durationMs/usage/audit/outputDir by the time this is called).
// `provider`/`models` describe what actually served the run: `models` is the tier→model-id map used for
// cost estimation (e.g. PROVIDERS.deepseek.models) — null when it doesn't apply (anthropic's flat rate,
// or a router/injected engine where a single provider/model map isn't meaningful).
export function buildRunLogEntry({ params = {}, result = {}, provider = null, models = null } = {}) {
  const durationMs = result.durationMs || 0
  const usageSrc = result.usage || {}
  const usage = {
    input: usageSrc.input || 0,
    output: usageSrc.output || 0,
    cacheRead: usageSrc.cacheRead || 0,
    cacheWrite: usageSrc.cacheWrite || 0,
    agents: usageSrc.agents || 0,
  }
  const audit = result.audit
  const auditStatus = !audit ? 'unavailable' : (audit.status === 'fail' ? 'fail' : 'ok')

  return {
    finishedAt: result.finishedAt || new Date().toISOString(),
    topic: params.topic || 'untitled',
    engine: 'universal',
    provider,
    models,
    scope: params.scope || ['refine'],
    files: (params.files || []).length,
    durationMs,
    durationMin: round1(durationMs / 60000),
    usage,
    estCost: estimateCost(provider, models, usage),
    auditStatus,
    outputDir: result.outputDir || params.outputDir || null,
  }
}

// ---------- persistence ----------
// Appends ONE JSON line to the run log. Never throws — a logging failure must never fail a run; on any
// error this returns {ok:false, error} and the caller (universal/jobs.js) logs a one-line warning via its
// own notice() channel instead of letting an exception propagate.
export function appendRunLog(entry, { logPath } = {}) {
  const resolvedPath = logPath || DEFAULT_LOG_PATH
  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    fs.appendFileSync(resolvedPath, `${JSON.stringify(entry)}\n`, 'utf8')
    const content = fs.readFileSync(resolvedPath, 'utf8')
    const lineCount = content.split('\n').filter(Boolean).length
    return { ok: true, path: resolvedPath, lineCount }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}
