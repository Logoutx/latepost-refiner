#!/usr/bin/env node
// ===== Transcriber-Universal CLI =====
// Standalone command-line shell over the shared pipeline. Parses argv into the same `A`
// the Claude Code edition assembles in its Step 0 pre-flight, builds the Anthropic-SDK
// engine, runs runPipeline, and handles the return value (write glossary, report flags).
//
//   transcriber --files a.docx b.docx --topic "蜜雪冰城" --date 2025-02 \
//     --background-file bg.txt --scope refine,summary --verify key --out ./out
//
// Output is identical to the Claude Code edition: <out>/校对表.md, <out>/Transcripts/*.md,
// <out>/逻辑顺序/*.md, <out>/<topic>访谈总结.md, <out>/<topic>时间线.md.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runPipeline } from '../core/pipeline.js'
import { SINGLE_FILE_GLOSSARY } from '../core/spec.js'
import { makeApiEngine } from '../engines/api.js'

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
    '--background-file': 'backgroundFile',
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

// ---------- pre-flight: docx/pdf → md ----------
const CONVERT_EXT = new Set(['.docx', '.pptx', '.xlsx', '.pdf'])

function convertToMarkdown(src, workDir) {
  const ext = path.extname(src).toLowerCase()
  if (!CONVERT_EXT.has(ext)) return src // .txt / .md used as-is
  fs.mkdirSync(workDir, { recursive: true })
  const dest = path.join(workDir, path.basename(src, ext) + '.md')
  // markitdown handles docx/pptx/xlsx/pdf (per the user's document-conversion convention).
  try {
    const md = execFileSync('markitdown', [src], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    fs.writeFileSync(dest, md, 'utf8')
    return dest
  } catch (e) {
    throw new Error(`无法转换 ${path.basename(src)} → markdown：需要 markitdown（pipx install markitdown，置于 PATH）。原始错误：${e.message}`)
  }
}

export const HEADING_RE = /^(#{1,3}\s|【.+】\s*$|第[一二三四五六七八九十0-9]+[、.．]\s*\S)/m

// Strip a leading date prefix (2025-02-21_ / 2025-02-21 ) from a filename stem for the title.
export const deriveTitle = (src) => path.basename(src, path.extname(src)).replace(/^\d{4}-\d{2}-\d{2}[_\s]+/, '').trim()

async function main() {
  const a = parseArgs(process.argv.slice(2))

  if (a.help || process.argv.length <= 2) {
    process.stdout.write(`transcriber — 访谈转录精校流水线（Anthropic SDK 版）

用法:
  transcriber --files <文件...> --topic <主题> --date <YYYY-MM> [选项]

必填:
  --files <路径...>      一或多份转录（.txt/.md/.docx/.pptx/.xlsx/.pdf；docx/pdf 自动转 md）
  --topic <主题>         公司/人物主题（用于交付物文件名）

常用:
  --date <YYYY-MM>       采访时间（写入抬头）
  --background <文本>     采访背景（指导侦察/核实）
  --background-file <路径> 从文件读取背景（背景较长时用）
  --scope <清单>         refine,logic,summary,timeline（逗号分隔；默认 refine）
  --verify <档>          key | deep | none（默认 key）
  --heading-policy <策略> none | keep | regenerate（默认 none）
  --out <目录>           输出根目录（默认 ./<topic>）
  --models <映射>        如 scout=haiku,refine=opus（覆盖默认分层）
  --skill-dir <目录>     references/ 所在目录（默认仓库 claude-code-skill/）
  --concurrency <N>      并发上限（默认 min(16, 核数-2)）
  --fresh                忽略既有 校对表.md，从零重建
`)
    process.exit(process.argv.length <= 2 ? 1 : 0)
  }

  if (!a.files.length) { console.error('错误：至少需要一个 --files'); process.exit(2) }
  const topic = a.topic || 'untitled'
  const outputDir = path.resolve(a.outputDir || `./${topic}`)
  const skillDir = path.resolve(a.skillDir || path.join(REPO_ROOT, 'claude-code-skill'))
  const date = a.date || ''
  let background = a.background || ''
  if (a.backgroundFile) background = fs.readFileSync(path.resolve(a.backgroundFile), 'utf8').trim()

  // Resolve references/ (summary/timeline/logic agents Read deliverables.md from skillDir).
  if (!fs.existsSync(path.join(skillDir, 'references', 'deliverables.md'))) {
    console.error(`警告：${skillDir}/references/deliverables.md 不存在——总结/时间线/逻辑稿的结构模板将读不到。用 --skill-dir 指向含 references/ 的目录。`)
  }

  // Build files[] (convert, count lines/bytes, detect headings).
  const workDir = path.join(outputDir, '.converted')
  const headingPolicy = a.headingPolicy || 'none'
  const files = []
  for (const raw of a.files) {
    const src = path.resolve(raw)
    if (!fs.existsSync(src)) { console.error(`错误：找不到文件 ${src}`); process.exit(2) }
    const mdPath = convertToMarkdown(src, workDir)
    const content = fs.readFileSync(mdPath, 'utf8')
    const lines = content.split('\n').length
    const bytes = Buffer.byteLength(content, 'utf8')
    const hasHeadings = HEADING_RE.test(content)
    if (hasHeadings && headingPolicy === 'none') {
      console.error(`提示：${path.basename(src)} 疑似已带小标题，而 --heading-policy=none；流水线会在 headingConflicts 中提示，按需用 --heading-policy keep|regenerate 重跑。`)
    }
    const title = deriveTitle(src)
    files.push({
      path: mdPath,
      label: title,
      title,
      subtitle: `*${topic}访谈${date ? ` · 采访时间 ${date}` : ''}*`,
      outPath: path.join(outputDir, 'Transcripts', `${title}.md`),
      lines,
      bytes,
    })
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

  const engine = makeApiEngine({
    apiKey: process.env.ANTHROPIC_API_KEY,
    concurrency: a.concurrency ? Number(a.concurrency) : undefined,
  })

  const t0 = Date.now()
  console.error(`\n开始：${files.length} 份文件 · scope=${A.scope.join(',')} · verify=${A.verifyDepth} · 输出 ${outputDir}\n`)
  const r = await runPipeline(A, engine)
  const mins = ((Date.now() - t0) / 60000).toFixed(1)

  // ---------- return handling (mirrors SKILL.md “返回处理”) ----------
  if (r.error) { console.error(`\n流水线未执行：${r.error}`); process.exit(1) }

  // Glossary is pure-JS output (no agent writes it) → persist it here. Cumulative across runs.
  if (r.glossary && r.glossary !== SINGLE_FILE_GLOSSARY) {
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(glossaryPath, r.glossary, 'utf8')
    console.error(`\n校对表已写入：${glossaryPath}`)
  }

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

  const u = engine.usage()
  console.error(`\n用量：${u.agents} 个代理调用${u.failed ? `（${u.failed} 失败）` : ''} · 输入 ${u.input.toLocaleString()} / 输出 ${u.output.toLocaleString()} tok · 缓存读 ${u.cacheRead.toLocaleString()}`)
  process.exit(0)
}

// Run only when invoked as the entry script (so tests can import the helpers above).
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main().catch((e) => { console.error('\n致命错误：', e.stack || e.message); process.exit(1) })
