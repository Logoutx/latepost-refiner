// ===== Router engine =====
// Dispatches each pipeline stage to a per-category sub-engine, so different functional
// buckets can run on different providers/models (e.g. cheap models for the mechanical
// bulk, the strongest model only for 精校). Routing is by the agent's `label` — every
// core stage already labels its agent() calls distinctly — so NO change to core is needed.

// The four categories and which stages each owns. tierHint is the default strength.
export const CATEGORIES = [
  { key: 'mechanical', label: '机械工作（基础模型）', stages: ['scout', 'check'], tierHint: 'haiku' },
  { key: 'web', label: '联网核实（中等，需联网）', stages: ['verify'], tierHint: 'sonnet', needsWeb: true },
  { key: 'correction', label: '错误纠正（中等模型）', stages: ['dedup'], tierHint: 'sonnet' },
  { key: 'smart', label: '精校+总结（最聪明）', stages: ['refine', 'logic', 'summary', 'timeline'], tierHint: 'opus' },
]
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key)

// label → category key. Labels look like 'scout:fileA', 'scout-retry:fileA', 'verify:1/2',
// 'dedup:semantic', 'check:fileA', 'refine:fileA', 'logic:fileA', 'summary', 'timeline'.
const STAGE_TO_CAT = {}
for (const c of CATEGORIES) for (const s of c.stages) STAGE_TO_CAT[s] = c.key
export function labelToCategory(label = '') {
  const stage = String(label).split(':')[0].split('-')[0] // 'scout-retry' → 'scout'
  return STAGE_TO_CAT[stage] || 'smart' // unknown (incl. single-pass refine) → smart
}

// engines: { mechanical, web, correction, smart } (instances may be shared if configs match)
export function makeRouterEngine({ engines, onPhase, onLog }) {
  if (!engines) throw new Error('makeRouterEngine: 缺少 engines')
  const phase = (title) => (onPhase ? onPhase(title) : process.stderr.write(`\n▸ ${title}\n`))
  const log = (msg) => (onLog ? onLog(msg) : process.stderr.write(`  ${msg}\n`))
  const pick = (label) => engines[labelToCategory(label)] || engines.smart

  function agent(prompt, opts = {}) {
    return pick(opts.label).agent(prompt, opts)
  }
  function parallel(thunks) {
    // sub-engines own the concurrency limit; the router just orchestrates.
    return Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)))
  }
  function pipeline(items, ...stages) {
    return Promise.all((items || []).map(async (item, i) => {
      let v = item
      for (const stage of stages) {
        try { v = await stage(v, item, i) } catch { return null }
        if (!v) return null
      }
      return v
    }))
  }
  function usage() {
    // sum over UNIQUE sub-engine instances (categories may share one), + per-category map
    const seen = new Set()
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
    const byCategory = {}
    for (const key of CATEGORY_KEYS) {
      const e = engines[key]
      if (!e || typeof e.usage !== 'function') continue
      const u = e.usage()
      byCategory[key] = u
      if (!seen.has(e)) {
        seen.add(e)
        for (const k of Object.keys(total)) total[k] += u[k] || 0
      }
    }
    return { ...total, byCategory }
  }
  return { agent, parallel, pipeline, phase, log, usage }
}
