#!/usr/bin/env node
// ===== Universal CLI =====
// Thin command-line shell over the shared runJob runtime.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JobConfigError, runJob } from './jobs.js'

// re-exported for tests (definitions live in jobs.js, the shared runtime)
export { deriveTitle, HEADING_RE } from './jobs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

export const HELP_TEXT = `latepost-refiner — 访谈转录精校流水线（Anthropic SDK 版）

用法:
  latepost-refiner --files <文件...> --topic <主题> --date <YYYY-MM> [选项]

必填:
  --files <路径...>      一或多份转录（.txt/.md/.srt/.docx/.pptx/.xlsx/.pdf；srt/docx/pdf 自动转 md）
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
  --chunk <模式>         speed | cost（默认 cost=每份单代理；speed 把大文件拆块并行，多文件批量提速、更费额度）
  --refine-mode <模式>   agentic | single-shot（默认 agentic=Read/Write 工具循环精校；single-shot 每份一次成型：
                         把源文整篇塞进 prompt、模型一次返回成稿，更省更快，仅适合 ≤45000 字的文件、超限会被拒；
                         审计门禁照跑，兜住单请求的静默压缩风险）
  --effort <映射>        如 refine=medium,summary=low（推理力度，仅 refine/logic/summary/timeline 生效、仅 opus/
                         sonnet/fable 支持；档位 low|medium|high|xhigh|max；不设=默认 high）
  --skill-dir <目录>     references/ 所在目录（默认仓库 claude-code-skill/）
  --prior-glossary <路径> 外部校对表作为往次记忆种子（默认自动读 <输出>/校对表.md；累积仍写回 <输出>/校对表.md）
  --concurrency <N>      并发上限（默认 min(16, 核数-2)）
  --fresh                忽略既有 校对表.md，从零重建
  --no-annotate          检出内容缺口时不往成稿里插「内容缺口」标记（默认会插，便于读者看到缺失）
  --no-anchors           不往成稿各小节插源锚点注释（默认会插：<!-- 源 L25-L38 · 08:00-12:05 -->，
                         渲染不可见；引文可循此跳回源文件行号与录音时间）
  --no-run-log           不记录本次运行（默认会追加一行到 ~/.config/latepost-refiner/runs.jsonl：
                         时间/token 用量/估算成本）
  --allow-audit-fail     审计门禁未过（内容缺口/引号，自动修复后仍 hard）时，若成稿等产物已生成，仍以退出码 0 结束
                         （默认退出 1）。产物照样落盘；请查 review.md / run.json 的 auditFailed 字段逐份核对

模型来源:
  --provider <名>        anthropic（默认）| deepseek | glm | kimi | openai
  --base-url <URL>       覆盖 provider 默认 endpoint（如 GLM 国际站 api.z.ai、Kimi 国内 .cn）
  key 环境变量           anthropic→ANTHROPIC_API_KEY · deepseek→DEEPSEEK_API_KEY ·
                         glm→ZHIPUAI_API_KEY/ZAI_API_KEY · kimi→MOONSHOT_API_KEY · openai→OPENAI_API_KEY
  联网核实              Anthropic/GLM/Kimi 用 provider 原生搜索；DeepSeek/OpenAI 需 TAVILY_API_KEY

升级重跑（cheap-first，可选、默认关闭）:
  --escalate <名>        指定「升级」provider。给出后即启用便宜档优先：--provider 做第一遍（便宜）精校，
                         凡审计门禁未过（压缩/charRatio、内容缺口、结尾缺失、引号等）的文件，用本 provider
                         从【源文件】重跑精校再复审。质量由确定性门禁判定，不靠对 provider 的信任。
                         不给 --escalate 时行为与既有完全一致（逐字节等价）。
  --escalate-base-url <URL>  升级 provider 的 endpoint 覆盖
  --escalate-models <映射>   升级 provider 的模型覆盖（如 refine=claude-opus-4-8；只用 refine 档）
  ⚠ 信源提醒            升级会把【源文件原文】也发送给升级 provider。两个 provider 都要有意识地选择——
                         尤其当便宜档或升级档任一为中国境内运营方时（见启动时的信源保护提示）。
                         本工具不做“敏感话题自动识别”（那是不可靠的承诺）——用不用升级由你判断。
`

// ---------- argv ----------
// Flags take one value, except --files (variadic) and boolean --fresh.
export function parseArgs(argv) {
  const out = { files: [] }
  const variadic = { '--files': 'files' }
  const booleans = { '--fresh': 'fresh', '--no-annotate': 'noAnnotate', '--no-anchors': 'noAnchors', '--no-run-log': 'noRunLog', '--allow-audit-fail': 'allowAuditFail', '--help': 'help', '-h': 'help' }
  const aliases = {
    '--out': 'outputDir', '--outputDir': 'outputDir', '--output-dir': 'outputDir',
    '--skill-dir': 'skillDir', '--skillDir': 'skillDir',
    '--verify': 'verifyDepth', '--heading-policy': 'headingPolicy',
    '--background-file': 'backgroundFile', '--base-url': 'baseURL',
    '--chunk': 'chunkMode', '--prior-glossary': 'priorGlossaryPath',
    // M10 cheap-first escalation: --escalate names the premium provider for files that fail the audit gate.
    '--escalate': 'escalate', '--escalate-models': 'escalateModels', '--escalate-base-url': 'escalateBaseURL',
    '--refine-mode': 'refineMode', '--effort': 'effort',
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
// M12: `--effort refine=medium,summary=low`. Only the smart-tier categories (refine/logic/summary/timeline)
// take effort; unknown keys and unknown levels are dropped (the API engine also guards by model, so a stray
// value is harmless). Levels mirror the SDK's OutputConfig.effort enum.
const EFFORT_CATS = new Set(['refine', 'logic', 'summary', 'timeline'])
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export const parseEffort = (s) => {
  if (!s) return undefined
  const m = {}
  for (const pair of s.split(',')) {
    const [k, v] = pair.split('=')
    const key = k && k.trim(), val = v && v.trim()
    if (EFFORT_CATS.has(key) && EFFORT_LEVELS.has(val)) m[key] = val
  }
  return Object.keys(m).length ? m : undefined
}

export function buildRunParams(a, { env = process.env } = {}) {
  const topic = a.topic || 'untitled'
  const outputDir = path.resolve(a.outputDir && a.outputDir.trim() ? a.outputDir : `${env.HOME}/Downloads/${topic}`)
  const skillDir = path.resolve(a.skillDir || path.join(REPO_ROOT, 'claude-code-skill'))
  const date = a.date || ''
  let background = a.background || ''
  if (a.backgroundFile) {
    const backgroundPath = path.resolve(a.backgroundFile)
    try {
      background = fs.readFileSync(backgroundPath, 'utf8').trim()
    } catch (e) {
      throw new JobConfigError(`无法读取背景文件 ${backgroundPath}：${e.message}`)
    }
  }

  return {
    topic,
    date,
    background,
    outputDir,
    skillDir,
    scope: parseScope(a.scope),
    verifyDepth: a.verifyDepth || 'key',
    headingPolicy: a.headingPolicy || 'none',
    models: parseModels(a.models),
    chunkMode: a.chunkMode === 'speed' ? 'speed' : undefined,
    refineMode: a.refineMode === 'single-shot' ? 'single-shot' : undefined,   // M11a; default agentic
    effort: parseEffort(a.effort),                                            // M12: per-category reasoning effort

    fresh: !!a.fresh,
    annotate: a.noAnnotate ? false : undefined,
    anchors: a.noAnchors ? false : undefined,   // default on: sections get invisible source anchors
    runLog: a.noRunLog ? false : undefined,     // default on: appends one line to ~/.config/latepost-refiner/runs.jsonl
    priorGlossaryPath: a.priorGlossaryPath ? path.resolve(a.priorGlossaryPath) : undefined,
    files: (a.files || []).map((p) => ({ path: path.resolve(p) })),
    provider: a.provider,
    baseURL: a.baseURL,
    concurrency: a.concurrency ? Number(a.concurrency) : undefined,
    // M10: presence of --escalate enables cheap-first semantics — the normal --provider does the first
    // (cheap) pass; this names the premium engine re-run on files that FAIL the deterministic audit gate.
    escalate: a.escalate ? { provider: a.escalate, baseURL: a.escalateBaseURL, models: parseModels(a.escalateModels) } : undefined,
  }
}

const list = (xs) => xs.map((x) => (typeof x === 'string' ? x : (x.path || JSON.stringify(x)))).join('、')

// SF-6 — the process exit code, factored out so it is unit-testable without spawning the CLI.
//   · a pipeline error → always 1
//   · audit gate left a file still-hard after auto-repair → 1 by default; with allowAuditFail AND ≥1 成稿 produced
//     (so the ONLY failure is auditFailed and the run otherwise succeeded) → 0
//   · otherwise → 0
// The products are written to disk regardless of the exit code; callers should inspect run.json / review.md's
// auditFailed field, not the exit code, to decide per-file follow-up.
export function computeExitCode(result, { allowAuditFail = false } = {}) {
  if (result.error) return 1
  // P7 fail-loud: an audit that could NOT run (deliverables unaudited) always exits 1. This is NOT bypassable
  // by --allow-audit-fail: that flag means "the audit ran and found a hard issue I accept", a different decision
  // from "the audit never ran, so nothing was verified". An unverified run must never masquerade as success.
  if ((result.auditUnavailable || []).length > 0) return 1
  const auditFailed = (result.auditFailed || []).length > 0
  if (!auditFailed) return 0
  const producedOutput = (result.refined || []).length > 0
  return (allowAuditFail && producedOutput) ? 0 : 1
}

export function printRunSummary(r) {
  if (r.error) {
    console.error(`\n流水线未执行：${r.error}`)
    console.error(`Review queue：${r.reviewPath}`)
    console.error(`Run manifest：${r.manifestPath}`)
    return
  }

  if (r.glossaryPath) console.error(`\n校对表已写入：${r.glossaryPath}`)

  if (r.audit && r.audit.files) {
    const bad = r.audit.files.filter((f) => f.status === 'fail')
    if (bad.length) console.error(`\n⚠ 成稿质量抽查未过 ${bad.length} 份：` + bad.map((f) => `${path.basename(f.file)}（${f.failed.join('/')}）`).join('、'))
    // M5: 逐节复核 headline — how many ## sections carry a soft mutation/name flag needing manual cross-check.
    let flagged = 0, total = 0
    for (const f of r.audit.files) { const ss = f.sections || []; total += ss.length; flagged += ss.filter((s) => (s.flags || []).length).length }
    if (flagged > 0) console.error(`\n逐节复核：${flagged} 节需人工对照（共 ${total} 节）——见 review.md「逐节复核清单」`)
  }
  // M10: cheap-first escalation summary. 「升级重跑：N 份未过审已升级 <provider>，M 份通过」 + a loud both-fail line.
  if (r.escalation && r.escalation.escalated) {
    const e = r.escalation
    console.error(`\n升级重跑：${e.escalated} 份未过审已升级 ${e.provider}，${e.passed} 份通过`)
    if (e.bothFailed) console.error(`⚠ 其中 ${e.bothFailed} 份两档均未过审——请对照源文件人工核对（见 review.md「升级重跑」）：` + e.files.filter((f) => f.bothFailed).map((f) => f.label).join('、'))
  }
  if ((r.crossFileConflicts || []).length) console.error(`\n⚠ 跨文件互证：${r.crossFileConflicts.length} 处同实体数值冲突（各份内部都合规，疑跨文件口径不一）——见 review.md「跨文件互证」`)
  if ((r.auditUnavailable || []).length) console.error(`\n⛔ 审计未能运行 ${r.auditUnavailable.length} 份——本次运行判定为失败：这些成稿及其派生的总结/时间线均未经审计，不可视为通过。产物已落盘但未经核验，请人工运行 audit_refined.mjs 核验后再采信：` + r.auditUnavailable.map((x) => x.label || path.basename(x.path || '')).join('、') + `\n  （退出码 1，且 --allow-audit-fail 不能豁免——“审计没跑”与“审计跑了但有硬伤”是两回事）`)
  if ((r.auditFailed || []).length) console.error(`\n⚠ 审计门禁未过（自动修复后仍 hard）：` + r.auditFailed.map((x) => `${path.basename(x.path)}（${x.findings.join('/')}）`).join('、') + `\n  （成稿等产物已生成、照常落盘；默认退出码 1，加 --allow-audit-fail 则退出 0——请查 review.md / run.json 的 auditFailed 字段逐份核对）`)
  for (const an of r.annotations || []) {
    if (an.inserted && an.inserted.length) {
      console.error(`⚠ 内容缺口：${path.basename(an.path)} 已插入 ${an.inserted.length} 处标记（` + an.inserted.map((g) => `源第 ${g.startLine}-${g.endLine} 行 约 ${g.chars} 字`).join('；') + '）——疑被模型无声略过，可对照源文件补回或换 provider 重精校该段')
    }
  }

  if ((r.anchors || []).length) {
    const n = r.anchors.reduce((s, a) => s + a.updated.length, 0)
    console.error(`源锚点：${r.anchors.length} 份成稿共 ${n} 个小节已标注源行号${r.anchors.some((a) => a.updated.some((u) => u.ts)) ? '与录音时间' : ''}`)
  }

  const mins = ((r.durationMs || 0) / 60000).toFixed(1)
  console.error(`\n===== 完成（${mins} 分钟）=====`)
  console.error(`精校成稿：${(r.refined || []).length} 份`)
  for (const rr of r.refined || []) console.error(`  ✓ ${rr.outPath || rr.path}`)
  if ((r.failed || []).length) console.error(`⚠ 未完成（需手动补做）：${list(r.failed)}`)
  if ((r.incomplete || []).length) console.error(`⚠ 疑似中途截断（需检查结尾）：${r.incomplete.map((x) => `${x.path}${x.note ? `（${x.note}）` : ''}`).join('；')}`)
  if ((r.unchecked || []).length) console.error(`⚠ 结尾完整性未核（核对代理失败，请人工抽查结尾）：${list(r.unchecked)}`)
  if ((r.scoutSuspect || []).length) console.error(`⚠ 侦察疑损坏（成稿正常，但校对表该份不可靠，网络稳定后可重扫）：${r.scoutSuspect.join('、')}`)
  if ((r.headingConflicts || []).length) console.error(`⚠ 源文件已带小标题但 headingPolicy=none：${r.headingConflicts.join('、')}——可用 --heading-policy keep|regenerate 重跑该份`)
  if ((r.suspectedDuplicates || []).length) console.error(`⚠ 疑似同指（已写入校对表“疑似同指”节，待人工确认，未自动合并）：${r.suspectedDuplicates.map((s) => (s.members || []).join('／')).join('；')}`)
  if ((r.networkUnverified || []).length) console.error(`⚠ 因网络故障未核实 ${r.networkUnverified.length} 项——网络恢复后可重跑核实`)
  if (r.logic && r.logic.length) {
    console.error(`逻辑顺序稿：${r.logic.filter((l) => l.path).length}/${r.logic.length} 份`)
    for (const l of r.logic) if (l.path) console.error(`  ✓ ${l.path}`)
    const miss = r.logic.filter((l) => l.missingSections && l.missingSections.length)
    if (miss.length) console.error(`  ⚠ 疑漏小标题：${miss.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
  }
  if (r.summary) console.error(`访谈总结：${typeof r.summary === 'string' ? r.summary.split('\n')[0] : '已生成'}`)
  if (r.timeline) console.error(`时间线：${typeof r.timeline === 'string' ? r.timeline.split('\n')[0] : '已生成'}`)
  if ((r.openQuestions || []).length) {
    console.error(`\n收尾待问（${r.openQuestions.length} 项）：`)
    for (const q of r.openQuestions) console.error(`  · ${typeof q === 'string' ? q : JSON.stringify(q)}`)
  }
  console.error(`\nReview queue：${r.reviewPath}`)
  console.error(`Run manifest：${r.manifestPath}`)

  const u = r.usage || { agents: 0, input: 0, output: 0, cacheRead: 0, failed: 0 }
  console.error(`\n用量：${u.agents} 个代理调用${u.failed ? `（${u.failed} 失败）` : ''} · 输入 ${u.input.toLocaleString()} / 输出 ${u.output.toLocaleString()} tok · 缓存读 ${(u.cacheRead || 0).toLocaleString()}`)
  if (u.escalation) { const e = u.escalation; console.error(`  其中升级重跑：${e.agents || 0} 个代理调用 · 输入 ${(e.input || 0).toLocaleString()} / 输出 ${(e.output || 0).toLocaleString()} tok`) }

  if (r.runLog && r.runLog.path) console.error(`运行日志：已追加 ${r.runLog.path}（第 ${r.runLog.lineCount} 行）`)
}

async function main() {
  const a = parseArgs(process.argv.slice(2))

  if (a.help || process.argv.length <= 2) {
    process.stdout.write(HELP_TEXT)
    process.exit(process.argv.length <= 2 ? 1 : 0)
  }

  if (!a.files.length) { console.error('错误：至少需要一个 --files'); process.exit(2) }

  let params
  try {
    params = buildRunParams(a)
  } catch (e) {
    if (e && e.code === 'CONFIG_ERROR') { console.error('错误：' + e.message); process.exit(2) }
    throw e
  }

  let result
  try {
    result = await runJob(params, {
      onPhase: (t) => process.stderr.write(`\n▸ ${t}\n`),
      onLog: (m) => process.stderr.write(`  ${m}\n`),
      onNotice: (m) => console.error(m),
    })
  } catch (e) {
    if (e && e.code === 'CONFIG_ERROR') { console.error('错误：' + e.message); process.exit(2) }
    throw e
  }

  printRunSummary(result)
  process.exit(computeExitCode(result, { allowAuditFail: !!a.allowAuditFail }))
}

// Run only when invoked as the entry script (so tests can import the helpers above).
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main().catch((e) => { console.error('\n致命错误：', e.stack || e.message); process.exit(1) })
