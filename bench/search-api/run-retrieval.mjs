#!/usr/bin/env node
// ===== Level 1: deterministic retrieval eval =====
// Runs every case × provider through the normalized adapters and scores the TOP-K snippets against the
// case file — no model in the loop, so the numbers are reproducible. Answers: which backend surfaces the
// right 中文实体 in its top-k, avoids affirming known-wrong writings, and stays honest on the unfindable.
//
//   node bench/search-api/run-retrieval.mjs --cases <path.json> --providers tavily,serper --k 5 --out <dir>
//
// Case file schema (see README):
//   { cases: [ { id, query, kind:'expect'|'trap'|'unverifiable', expect:[…], traps:[…], hints:[…], group, note } ] }
//   group (optional string) buckets cases (e.g. a 敏感词 set) — the summary adds a per-group × provider table,
//   which is the headline comparison. Missing group → "default".
//
// Writes into <dir>:  <provider>.raw.jsonl  (one line per case)  +  summary.md  (tables).
// Providers run one at a time (serial); within a provider, cases run in parallel capped at 3.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pLimit from 'p-limit'
import { getAdapter, PROVIDERS, KEY_ENV, UNVERIFIED } from './adapters.js'
import { loadEnvFile } from './env-file.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Auto-load a repo-root / cwd .env if present (keys not already set). The owner's search-API keys live in a
// keys.env inside the research vault instead — pass it with --keys-file (handled in main, before adapters run).
for (const f of [path.join(REPO_ROOT, '.env'), path.join(process.cwd(), '.env')]) {
  if (fs.existsSync(f)) loadEnvFile(f)
}

// ---- args ----------------------------------------------------------------------------------------
// NOTE: the flag is --keys-file, NOT --env-file. `--env-file` is a Node.js BUILT-IN option that Node
// intercepts even after the script path (aborting on a missing file before our code runs), so we use a
// collision-free name. --env-file is accepted as a best-effort alias for environments where Node passes
// it through, but --keys-file is the reliable, documented flag.
function parseArgs(argv) {
  const a = { k: 5, providers: null, cases: null, out: null, keysFile: null }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--cases') a.cases = argv[++i]
    else if (t === '--providers') a.providers = argv[++i]
    else if (t === '--k') a.k = Number(argv[++i])
    else if (t === '--out') a.out = argv[++i]
    else if (t === '--keys-file' || t === '--env-file') a.keysFile = argv[++i]
    else if (t === '--help' || t === '-h') a.help = true
  }
  return a
}

const USAGE = 'usage: node bench/search-api/run-retrieval.mjs --cases <path.json> [--keys-file <keys.env>] --providers tavily,serper --k 5 --out <dir>'

// Load an explicit keys file into process.env. Prints COUNTS and bad LINE NUMBERS only — never any value.
function applyKeysFile(keysFile) {
  const p = path.resolve(keysFile)
  if (!fs.existsSync(p)) { console.error(`--keys-file 不存在：${p}`); process.exit(2) }
  const { loaded, skipped, badLines } = loadEnvFile(p)
  if (badLines.length) console.error(`⚠ keys 文件第 ${badLines.join(', ')} 行无法解析（已跳过）`)
  process.stderr.write(`· keys 文件载入 ${loaded} 个变量（${skipped} 个已存在、未覆盖）\n`) // counts only, no keys/values
}

// ---- scoring (deterministic) ---------------------------------------------------------------------
// NFKC folds full-width ASCII/digits to half-width; strip all whitespace (pangu spaces, ASR spacing);
// lowercase ASCII. Substring match on the joined top-k title+snippet text.
export const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const joinedText = (results) => results.map((x) => `${x.title || ''}\n${x.snippet || ''}`).join('\n')
const countOcc = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0)

export function scoreCase(c, results) {
  const hay = norm(joinedText(results))
  if (c.kind === 'trap') {
    let occ = 0
    const hitTraps = []
    for (const t of c.traps || []) {
      const n = norm(t)
      const cnt = countOcc(hay, n)
      if (cnt > 0) { occ += cnt; hitTraps.push(t) }
    }
    return { kind: 'trap', hit: occ > 0, occurrences: occ, hitTraps } // hit = a trap writing appeared (affirmatively; over-counting accepted)
  }
  if (c.kind === 'unverifiable') {
    const present = (c.hints || []).map(norm).filter(Boolean).filter((s) => hay.includes(s))
    // honest = returned nothing, or none of the hint terms surfaced (no fabricated-looking answer text)
    return { kind: 'unverifiable', honest: results.length === 0 || present.length === 0, present }
  }
  // expect: ALL expected writings must be present in the top-k text
  const need = (c.expect || []).map(norm).filter(Boolean)
  const missing = need.filter((s) => !hay.includes(s))
  return { kind: 'expect', hit: need.length > 0 && missing.length === 0, missing }
}

// ---- per-provider run ----------------------------------------------------------------------------
async function runProvider(name, cases, k, outDir) {
  const adapter = getAdapter(name)
  const limit = pLimit(3) // cases in parallel, capped at 3
  const rows = await Promise.all(cases.map((c) => limit(async () => {
    const results = await adapter(c.query, { k })
    const clean = results.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet }))
    return {
      id: c.id, query: c.query, kind: c.kind, group: c.group || 'default', provider: name,
      latencyMs: results.latencyMs, status: results.status, error: results.error,
      shapeError: results.shapeError, score: scoreCase(c, clean), results: clean,
    }
  })))
  fs.writeFileSync(path.join(outDir, `${name}.raw.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return rows
}

// ---- aggregate + render --------------------------------------------------------------------------
export function aggregate(name, rows) {
  const agg = { provider: name, expect: [0, 0], trap: [0, 0], unv: [0, 0], failures: 0, shapeError: false, missingKey: false, latencies: [] }
  for (const r of rows) {
    if (typeof r.latencyMs === 'number' && r.latencyMs > 0) agg.latencies.push(r.latencyMs)
    if (r.error) agg.failures += 1
    if (r.shapeError) agg.shapeError = true
    if (r.error && String(r.error).startsWith('MISSING_KEY')) agg.missingKey = true
    if (r.kind === 'expect') { agg.expect[1] += 1; if (r.score.hit) agg.expect[0] += 1 }
    else if (r.kind === 'trap') { agg.trap[1] += 1; if (r.score.hit) agg.trap[0] += 1 }
    else if (r.kind === 'unverifiable') { agg.unv[1] += 1; if (r.score.honest) agg.unv[0] += 1 }
  }
  agg.meanLatency = agg.latencies.length ? Math.round(agg.latencies.reduce((a, b) => a + b, 0) / agg.latencies.length) : null
  return agg
}

const frac = ([hit, tot]) => (tot ? `${hit}/${tot} (${Math.round((hit / tot) * 100)}%)` : '—')

// Distinct group labels in first-seen order (missing group → "default").
export function distinctGroups(cases) {
  const seen = new Set()
  const out = []
  for (const c of cases) { const g = c.group || 'default'; if (!seen.has(g)) { seen.add(g); out.push(g) } }
  return out
}

// One markdown table (header + a row per provider aggregate). Shared by the overall and per-group tables.
function aggTable(aggs) {
  const L = ['| 搜索源 | 期望命中（该出现的都出现） | 陷阱命中（越低越好） | 查不到题保持诚实 | 平均延迟(ms) | 失败次数 | 备注 |', '|---|---|---|---|---|---|---|']
  for (const a of aggs) {
    const note = a.missingKey ? `缺 key（${KEY_ENV[a.provider]}）` : (a.shapeError ? '⚠ 形状不符，需修 adapters.js' : (UNVERIFIED.has(a.provider) ? '形状未证实' : ''))
    L.push(`| ${a.provider} | ${frac(a.expect)} | ${frac(a.trap)} | ${frac(a.unv)} | ${a.meanLatency ?? '—'} | ${a.failures} | ${note} |`)
  }
  return L
}

function renderSummary(caseFile, cases, k, providers, aggs, rowsByProvider) {
  const counts = { expect: 0, trap: 0, unverifiable: 0 }
  for (const c of cases) counts[c.kind] = (counts[c.kind] || 0) + 1
  const groups = distinctGroups(cases)
  const groupCount = (g) => cases.filter((c) => (c.group || 'default') === g).length
  const L = []
  L.push('# 搜索 API 检索评测（不带模型，可复现）', '')
  L.push(`- 用例文件：\`${caseFile}\``)
  L.push(`- 共 ${cases.length} 条：期望题 ${counts.expect} · 陷阱题 ${counts.trap} · 查不到题 ${counts.unverifiable}`)
  L.push(`- 分组 ${groups.length} 个：${groups.map((g) => `${g}(${groupCount(g)})`).join(' · ')}`)
  L.push(`- 每题取前 ${k} 条结果 · 生成时间 ${new Date().toISOString()}`, '')

  // Headline: per-group × provider. This is the comparison that matters (e.g. a 敏感词 group's per-provider deltas).
  L.push('## 分组对比（各组 × 各家）— headline', '')
  for (const g of groups) {
    L.push(`### 组：${g}（${groupCount(g)} 题）`, '')
    const groupAggs = providers.map((p) => aggregate(p, rowsByProvider[p].filter((r) => r.group === g)))
    L.push(...aggTable(groupAggs), '')
  }

  L.push('## 全部用例汇总（每家一行）', '')
  L.push(...aggTable(aggs))
  L.push('')

  // per-case detail: one row per case, one column per provider, a symbol per cell
  L.push('## 逐题明细', '')
  L.push('符号：`✓` 期望全中 / 查不到保持诚实；`✗` 期望缺项；`⚠` 陷阱出现 / 查不到题泄漏；`✱` 调用失败', '')
  const header = ['用例', '类型', ...aggs.map((a) => a.provider)]
  L.push('| ' + header.join(' | ') + ' |')
  L.push('|' + header.map(() => '---').join('|') + '|')
  const byId = new Map()
  for (const a of aggs) for (const r of rowsByProvider[a.provider]) byId.set(`${a.provider}::${r.id}`, r)
  for (const c of cases) {
    const cells = aggs.map((a) => {
      const r = byId.get(`${a.provider}::${c.id}`)
      if (!r) return ' '
      if (r.error) return '✱'
      if (r.kind === 'expect') return r.score.hit ? '✓' : '✗'
      if (r.kind === 'trap') return r.score.hit ? `⚠×${r.score.occurrences}` : '○'
      return r.score.honest ? '✓' : '⚠'
    })
    L.push(`| ${c.id} | ${c.kind} | ${cells.join(' | ')} |`)
  }
  L.push('')
  L.push('> 每家的逐条原始结果见同目录 `<搜索源>.raw.jsonl`。')
  return L.join('\n') + '\n'
}

// ---- main ----------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.cases || !args.out) { console.log(USAGE); process.exit(args.help ? 0 : 2) }
  if (!Number.isFinite(args.k) || args.k <= 0) { console.error(`--k 需为正整数`); process.exit(2) }

  // Load the owner's keys.env (from the vault) BEFORE any adapter reads a key. Counts/line-numbers only, no values.
  if (args.keysFile) applyKeysFile(args.keysFile)

  const caseText = fs.readFileSync(path.resolve(args.cases), 'utf8')
  const parsed = JSON.parse(caseText)
  const cases = parsed.cases
  if (!Array.isArray(cases) || !cases.length) { console.error('用例文件需含非空 cases[]（schema 见 README）'); process.exit(2) }
  for (const c of cases) {
    if (!c.id || !c.query || !['expect', 'trap', 'unverifiable'].includes(c.kind)) {
      console.error(`用例格式错误（需 id / query / kind∈{expect,trap,unverifiable}）：${JSON.stringify(c)}`); process.exit(2)
    }
    if (c.group !== undefined && typeof c.group !== 'string') {
      console.error(`用例 ${c.id} 的 group 需为字符串`); process.exit(2)
    }
  }

  const providers = (args.providers ? args.providers.split(',') : PROVIDERS).map((s) => s.trim()).filter(Boolean)
  for (const p of providers) if (!PROVIDERS.includes(p)) { console.error(`未知 provider：${p}（可选：${PROVIDERS.join(', ')}）`); process.exit(2) }

  const outDir = path.resolve(args.out)
  fs.mkdirSync(outDir, { recursive: true })

  const aggs = []
  const rowsByProvider = {}
  for (const name of providers) { // serial per provider
    process.stderr.write(`▸ ${name} …\n`)
    const rows = await runProvider(name, cases, args.k, outDir)
    rowsByProvider[name] = rows
    aggs.push(aggregate(name, rows))
  }

  const summary = renderSummary(path.resolve(args.cases), cases, args.k, providers, aggs, rowsByProvider)
  const summaryPath = path.join(outDir, 'summary.md')
  fs.writeFileSync(summaryPath, summary, 'utf8')

  // console recap + first-contact shape/key warnings
  process.stderr.write('\n')
  for (const a of aggs) {
    process.stderr.write(`${a.provider.padEnd(8)} 期望 ${frac(a.expect)} · 陷阱 ${frac(a.trap)} · 诚实 ${frac(a.unv)} · 延迟 ${a.meanLatency ?? '—'}ms · 失败 ${a.failures}\n`)
  }
  const shapeBad = aggs.filter((a) => a.shapeError).map((a) => a.provider)
  const noKey = aggs.filter((a) => a.missingKey).map((a) => `${a.provider}(${KEY_ENV[a.provider]})`)
  if (shapeBad.length) process.stderr.write(`\n⚠ 首次接触形状不符，需按真实响应修正 adapters.js：${shapeBad.join(', ')}\n`)
  if (noKey.length) process.stderr.write(`\n· 缺 key 已跳过：${noKey.join(', ')}\n`)
  process.stderr.write(`\n✓ 汇总写入 ${summaryPath}\n`)
}

// Run as a CLI; stay importable (scoreCase/norm) for tests without executing main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
