// score-external.mjs — score search results collected OUTSIDE the adapter path (e.g. a Claude Code
// session's built-in WebSearch tool, gathered by subagents) with the exact same deterministic scorer
// as run-retrieval.mjs, so the numbers are comparable.
//
//   node bench/search-api/score-external.mjs --cases <cases.json> --raw <a.jsonl,b.jsonl,...> \
//        --provider claude --out <dir>
//
// Each raw line: {id, query, kind, group, provider, results: [{title,url,snippet}], error}
// Output: <out>/<provider>.raw.jsonl (rescored rows) + a per-group markdown table on stdout.
import fs from 'node:fs'
import path from 'node:path'
import { scoreCase, aggregate } from './run-retrieval.mjs'

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--cases') a.cases = argv[++i]
    else if (t === '--raw') a.raw = argv[++i]
    else if (t === '--provider') a.provider = argv[++i]
    else if (t === '--out') a.out = argv[++i]
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
if (!args.cases || !args.raw || !args.provider) {
  console.error('usage: score-external.mjs --cases <cases.json> --raw <a.jsonl,...> --provider <name> [--out <dir>]')
  process.exit(2)
}

const caseById = new Map(JSON.parse(fs.readFileSync(args.cases, 'utf8')).cases.map((c) => [c.id, c]))
const rows = []
for (const f of args.raw.split(',')) {
  for (const line of fs.readFileSync(f.trim(), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    const c = caseById.get(r.id)
    if (!c) { console.error(`跳过：用例文件里没有 id=${r.id}`); continue }
    const results = Array.isArray(r.results) ? r.results : []
    // This environment's session WebSearch returns titles+urls plus ONE synthesized prose answer and no
    // per-result snippets; the verify agent consumes that answer, so it belongs in the scoring haystack.
    // Fold it in as a pseudo-result so scoreCase() stays identical to the adapter path.
    const scored = r.answer ? results.concat([{ title: '', url: '', snippet: String(r.answer) }]) : results
    rows.push({
      id: c.id, query: c.query, kind: c.kind, group: c.group || 'default', provider: args.provider,
      latencyMs: null, status: r.error ? 'error' : 200, error: r.error || null, shapeError: false,
      score: scoreCase(c, scored), results, answer: r.answer || '',
    })
  }
}

const missing = [...caseById.keys()].filter((id) => !rows.some((r) => r.id === id))
if (missing.length) console.error(`⚠ 缺 ${missing.length} 条用例结果: ${missing.join(', ')}`)

if (args.out) {
  fs.mkdirSync(args.out, { recursive: true })
  fs.writeFileSync(path.join(args.out, `${args.provider}.raw.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// Per-group + overall, same aggregate() as the runner.
const groups = [...new Set(rows.map((r) => r.group))].sort()
const frac = ([hit, tot]) => (tot ? `${hit}/${tot} (${Math.round((hit / tot) * 100)}%)` : '—')
const fmt = (agg) => `期望 ${frac(agg.expect)} · 陷阱 ${frac(agg.trap)} · 诚实 ${frac(agg.unv)} · 失败 ${agg.failures}`
for (const g of groups) {
  const agg = aggregate(args.provider, rows.filter((r) => r.group === g))
  console.log(`[${g}] ${fmt(agg)}`)
}
console.log(`[TOTAL] ${fmt(aggregate(args.provider, rows))}`)
