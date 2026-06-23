#!/usr/bin/env node
// ===== LatePost-Refiner Universal CLI =====
// Standalone command-line shell over the shared pipeline. Parses argv into the same `A`
// the Claude Code edition assembles in its Step 0 pre-flight, builds the Anthropic-SDK
// engine, runs runPipeline, and handles the return value (write glossary, report flags).
//
//   latepost-refiner --files a.docx b.docx --topic "示例公司" --date 2025-02 \
//     --background-file bg.txt --scope refine,summary --verify key --out ./out
//
// Output is identical to the Claude Code edition: <out>/校对表.md, <out>/Transcripts/*.md,
// <out>/逻辑顺序/*.md, <out>/<topic>访谈总结.md, <out>/<topic>时间线.md.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPipeline } from '../core/pipeline.js'
import { SINGLE_FILE_GLOSSARY } from '../core/spec.js'
import { selectEngine, prepareFile, buildFilePolicy, auditAndRepairRefined } from './jobs.js'
import { writeRunArtifacts } from './artifacts.js'

// re-exported for tests (definitions live in jobs.js, the shared runtime)
export { deriveTitle, HEADING_RE } from './jobs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

// ---------- argv ----------
// Flags take one value, except --files (variadic) and boolean --fresh.
export function parseArgs(argv) {
  const out = { files: [] }
  const variadic = { '--files': 'files' }
  const booleans = { '--fresh': 'fresh', '--help': 'help', '-h': 'help' }
  const aliases = {
    '--out': 'outputDir', '--outputDir': 'outputDir', '--output-dir': 'outputDir',
    '--skill-dir': 'skillDir', '--skillDir': 'skillDir',
    '--verify': 'verifyDepth', '--heading-policy': 'headingPolicy',
    '--background-file': 'backgroundFile', '--base-url': 'baseURL',
  }
  let i = 0
  while (i < argv.length) {
    const tok = argv[i]
    if (booleans[tok]) { out[booleans[tok]] = true; i++; continue }
    if (variadic[tok]) {
      const key = variadic[tok]; i++
      while (i < argv.length && !argv[i].startsWith('--')) { out[key].push(argv[i]); i++ }
      continue
    }
    if (tok.startsWith('--')) {
      const key = aliases[tok] || tok.replace(/^--/, '')
      out[key] = argv[i + 1]; i += 2; continue
    }
    i++ // stray positional — ignore
  }
  return out
}

export const parseScope = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : ['refine'])
export const parseModels = (s) => {
  if (!s) return undefined
  const m = {}
  for (const pair of s.split(',')) { const [k, v] = pair.split('='); if (k && v) m[k.trim()] = v.trim() }
  return m
}

async function main() {
  const a = parseArgs(process.argv.slice(2))

  if (a.help || process.argv.length <= 2) {
    process.stdout.write(`latepost-refiner — 访谈转录精校流水线（Anthropic SDK 版）

用法:
  latepost-refiner --files <文件...> --topic <主题> --date <YYYY-MM> [选项]

必填:
  --files <路径...>      一或多份转录（.txt/.md/.docx/.pptx/.xlsx/.pdf；docx/pdf 自动转 md）
  --topic <主题>         公司/人物主题（用于交付物文件名）

常用:
  --out <目录>           输出根目录（默认 ~/Downloads/<主题>）
  --date <YYYY-MM>       采访时间（写入抬头）
  --background <文本>     采访背景（指导侦察/核实）
  --background-file <路径> 从文件读取背景（背景较长时用）
  --scope <清单>         refine,logic,summary,timeline（逗号分隔；默认 refine）
  --verify <档>          key | deep | none（默认 key）
  --heading-policy <策略> none | keep | regenerate（默认 none）
  --models <映射>        如 scout=haiku,refine=opus（覆盖默认分层）
  --skill-dir <目录>     references/ 所在目录（默认仓库 claude-code-skill/）
  --concurrency <N>      并发上限（默认 min(16, 核数-2)）
  --fresh                忽略既有 校对表.md，从零重建

模型来源:
  --provider <名>        anthropic（默认）| deepseek | glm | kimi | openai
  --base-url <URL>       覆盖 provider 默认 endpoint（如 GLM 国际站 api.z.ai、Kimi 国内 .cn）
  key 环境变量           anthropic→ANTHROPIC_API_KEY · deepseek→DEEPSEEK_API_KEY ·
                         glm→ZHIPUAI_API_KEY/ZAI_API_KEY · kimi→MOONSHOT_API_KEY · openai→OPENAI_API_KEY
  联网核实              Anthropic/GLM/Kimi 用 provider 原生搜索；DeepSeek/OpenAI 需 TAVILY_API_KEY
`)
    process.exit(process.argv.length <= 2 ? 1 : 0)
  }

  if (!a.files.length) { console.error('错误：至少需要一个 --files'); process.exit(2) }
  const topic = a.topic || 'untitled'
  const outputDir = path.resolve(a.outputDir && a.outputDir.trim() ? a.outputDir : `${process.env.HOME}/Downloads/${topic}`)
  const skillDir = path.resolve(a.skillDir || path.join(REPO_ROOT, 'claude-code-skill'))
  const date = a.date || ''
  let background = a.background || ''
  if (a.backgroundFile) background = fs.readFileSync(path.resolve(a.backgroundFile), 'utf8').trim()

  // Resolve references/ (summary/timeline/logic agents Read deliverables.md from skillDir).
  if (!fs.existsSync(path.join(skillDir, 'references', 'deliverables.md'))) {
    console.error(`警告：${skillDir}/references/deliverables.md 不存在——总结/时间线/逻辑稿的结构模板将读不到。用 --skill-dir 指向含 references/ 的目录。`)
  }

  // Build files[] via the shared runtime (convert docx/pdf, count lines/bytes, detect headings).
  const workDir = path.join(outputDir, '.converted')
  const headingPolicy = a.headingPolicy || 'none'
  const files = []
  const warnings = []
  for (const raw of a.files) {
    const src = path.resolve(raw)
    if (!fs.existsSync(src)) { console.error(`错误：找不到文件 ${src}`); process.exit(2) }
    let prepared
    try { prepared = await prepareFile(src, { topic, date, headingPolicy, outputDir, workDir }) }
    catch (e) { console.error('错误：' + e.message); process.exit(2) }
    if (prepared.headingWarning) { warnings.push(prepared.headingWarning); console.error('提示：' + prepared.headingWarning) }
    files.push(prepared.entry)
  }

  // Persistent per-company glossary (P1): seed from an existing 校对表.md unless --fresh.
  const glossaryPath = path.join(outputDir, '校对表.md')
  let priorGlossaryText
  if (!a.fresh && fs.existsSync(glossaryPath)) {
    priorGlossaryText = fs.readFileSync(glossaryPath, 'utf8')
    console.error(`沿用既有校对表：${glossaryPath}`)
  }

  const A = {
    topic, date, background, outputDir, skillDir,
    scope: parseScope(a.scope),
    verifyDepth: a.verifyDepth || 'key',
    headingPolicy,
    models: parseModels(a.models),
    priorGlossaryText,
    fresh: !!a.fresh,
    files,
  }

  // Engine: anthropic (native server-side web search) or an OpenAI-compatible provider,
  // selected by the shared runtime (reads the right key env; --base-url overrides endpoint).
  const concurrency = a.concurrency ? Number(a.concurrency) : undefined
  const filePolicy = buildFilePolicy({ outputDir, skillDir, files })
  let sel
  try { sel = selectEngine({ provider: a.provider, baseURL: a.baseURL, concurrency, filePolicy }) }
  catch (e) { console.error('错误：' + e.message); process.exit(2) }
  const engine = sel.engine
  if (sel.provider !== 'anthropic') {
    console.error(`provider=${sel.provider}（${sel.info.label}）· baseURL=${sel.info.baseURL} · key=${sel.info.keyVar}`)
    if (sel.info.note) console.error(`注意：${sel.info.note}`)
    if (!process.env.TAVILY_API_KEY && (A.scope.includes('timeline') || A.verifyDepth !== 'none')) {
      console.error('提示：未设 TAVILY_API_KEY——非 anthropic provider 的联网核实/时间线将降级（refine 不受影响）。')
    }
  }

  const t0 = Date.now()
  const startedAt = new Date(t0).toISOString()
  console.error(`\n开始：${files.length} 份文件 · scope=${A.scope.join(',')} · verify=${A.verifyDepth} · 输出 ${outputDir}\n`)
  const r = await runPipeline(A, engine)
  let finishedMs = Date.now()
  let finishedAt = new Date(finishedMs).toISOString()
  let durationMs = finishedMs - t0
  let mins = (durationMs / 60000).toFixed(1)
  let usage = engine.usage()
  const result = { ...r, outputDir, glossaryPath: null, provider: sel.provider, providerInfo: sel.info, warnings, usage: null }

  // ---------- return handling (mirrors SKILL.md “返回处理”) ----------
  if (r.error) {
    const artifacts = writeRunArtifacts(result, { A, outputDir, startedAt, finishedAt, durationMs, provider: sel.provider, providerInfo: sel.info, warnings, usage })
    console.error(`\n流水线未执行：${r.error}`)
    console.error(`Review queue：${artifacts.reviewPath}`)
    console.error(`Run manifest：${artifacts.manifestPath}`)
    process.exit(1)
  }

  // Glossary is pure-JS output (no agent writes it) → persist it here. Cumulative across runs.
  if (r.glossary && r.glossary !== SINGLE_FILE_GLOSSARY) {
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(glossaryPath, r.glossary, 'utf8')
    result.glossaryPath = glossaryPath
    console.error(`\n校对表已写入：${glossaryPath}`)
  }
  await auditAndRepairRefined({ A, result, engine })
  finishedMs = Date.now()
  finishedAt = new Date(finishedMs).toISOString()
  durationMs = finishedMs - t0
  mins = (durationMs / 60000).toFixed(1)
  usage = engine.usage()
  result.usage = usage
  const badAudit = result.audit && result.audit.files ? result.audit.files.filter((f) => f.status === 'fail') : []
  if (badAudit.length) console.error(`\n⚠ 成稿质量抽查未过 ${badAudit.length} 份：` + badAudit.map((f) => `${path.basename(f.file)}（${f.failed.join('/')}）`).join('、'))
  const artifacts = writeRunArtifacts(result, { A, outputDir, startedAt, finishedAt, durationMs, provider: sel.provider, providerInfo: sel.info, warnings, usage })

  const list = (xs) => xs.map((x) => (typeof x === 'string' ? x : (x.path || JSON.stringify(x)))).join('、')
  console.error(`\n===== 完成（${mins} 分钟）=====`)
  console.error(`精校成稿：${r.refined.length} 份`)
  for (const rr of r.refined) console.error(`  ✓ ${rr.outPath || rr.path}`)
  if (r.failed.length) console.error(`⚠ 未完成（需手动补做）：${list(r.failed)}`)
  if (r.incomplete.length) console.error(`⚠ 疑似中途截断（需检查结尾）：${r.incomplete.map((x) => `${x.path}${x.note ? `（${x.note}）` : ''}`).join('；')}`)
  if (r.unchecked.length) console.error(`⚠ 结尾完整性未核（核对代理失败，请人工抽查结尾）：${list(r.unchecked)}`)
  if (r.scoutSuspect.length) console.error(`⚠ 侦察疑损坏（成稿正常，但校对表该份不可靠，网络稳定后可重扫）：${r.scoutSuspect.join('、')}`)
  if (r.headingConflicts.length) console.error(`⚠ 源文件已带小标题但 headingPolicy=none：${r.headingConflicts.join('、')}——可用 --heading-policy keep|regenerate 重跑该份`)
  if (r.suspectedDuplicates.length) console.error(`⚠ 疑似同指（已写入校对表“疑似同指”节，待人工确认，未自动合并）：${r.suspectedDuplicates.map((s) => (s.members || []).join('／')).join('；')}`)
  if (r.networkUnverified.length) console.error(`⚠ 因网络故障未核实 ${r.networkUnverified.length} 项——网络恢复后可重跑核实`)
  if (r.logic && r.logic.length) {
    console.error(`逻辑顺序稿：${r.logic.filter((l) => l.path).length}/${r.logic.length} 份`)
    for (const l of r.logic) if (l.path) console.error(`  ✓ ${l.path}`)
    const miss = r.logic.filter((l) => l.missingSections && l.missingSections.length)
    if (miss.length) console.error(`  ⚠ 疑漏小标题：${miss.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
  }
  if (r.summary) console.error(`访谈总结：${typeof r.summary === 'string' ? r.summary.split('\n')[0] : '已生成'}`)
  if (r.timeline) console.error(`时间线：${typeof r.timeline === 'string' ? r.timeline.split('\n')[0] : '已生成'}`)
  if (r.openQuestions.length) {
    console.error(`\n收尾待问（${r.openQuestions.length} 项）：`)
    for (const q of r.openQuestions) console.error(`  · ${typeof q === 'string' ? q : JSON.stringify(q)}`)
  }
  console.error(`\nReview queue：${artifacts.reviewPath}`)
  console.error(`Run manifest：${artifacts.manifestPath}`)

  const u = usage
  console.error(`\n用量：${u.agents} 个代理调用${u.failed ? `（${u.failed} 失败）` : ''} · 输入 ${u.input.toLocaleString()} / 输出 ${u.output.toLocaleString()} tok · 缓存读 ${(u.cacheRead || 0).toLocaleString()}`)
  process.exit(0)
}

// Run only when invoked as the entry script (so tests can import the helpers above).
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main().catch((e) => { console.error('\n致命错误：', e.stack || e.message); process.exit(1) })
