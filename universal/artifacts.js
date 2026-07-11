import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json')

function readPackage() {
  try {
    const p = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
    return { name: p.name, version: p.version }
  } catch {
    return { name: 'interview-transcriber', version: null }
  }
}

function gitDir() {
  const dotgit = path.join(REPO_ROOT, '.git')
  try {
    const stat = fs.statSync(dotgit)
    if (stat.isDirectory()) return dotgit
    const text = fs.readFileSync(dotgit, 'utf8').trim()
    const m = text.match(/^gitdir:\s*(.+)$/)
    if (m) return path.resolve(REPO_ROOT, m[1])
  } catch {
    return null
  }
  return null
}

function gitCommit() {
  const dir = gitDir()
  if (!dir) return null
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/i.test(head)) return head
    const m = head.match(/^ref:\s*(.+)$/)
    if (!m) return null
    const refPath = path.join(dir, m[1])
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim()
    const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8')
    const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${m[1]}`))
    return line ? line.split(' ')[0] : null
  } catch {
    return null
  }
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex')
}

function relOrAbs(p, base) {
  if (!p) return p
  const abs = path.resolve(String(p))
  const rel = path.relative(base, abs)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs
}

function jsonLine(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function formatSuspect(s) {
  const members = (s && s.members && s.members.length) ? s.members.join(' / ') : jsonLine(s)
  return s && s.why ? `${members} — ${s.why}` : members
}

function formatNetworkItem(x) {
  if (typeof x === 'string') return x
  if (!x) return ''
  return [x.query || x.name || x.term || jsonLine(x), x.note].filter(Boolean).join(' — ')
}

function formatLogicGap(l) {
  const missing = (l.missingSections || []).join(' / ')
  return `${l.label || l.path || 'unknown'}${missing ? ` — 疑漏小标题：${missing}` : ''}`
}

function formatAudit(f) {
  const parts = []
  const failed = f.failed || []
  if (failed.includes('content_gap')) parts.push((f.gaps || []).filter((g) => g.severity === 'hard').map((g) => `内容缺口 第 ${g.startLine}-${g.endLine} 行 约 ${g.chars} 字（疑被无声略过）`).join('、'))
  if (failed.includes('compression_risk')) parts.push(`疑似压缩成摘要（charRatio ${f.metrics ? f.metrics.charRatio : '?'}）`)
  if (failed.includes('under_refined')) parts.push('欠精校（口癖未删净）')
  if (failed.includes('ending_missing')) parts.push('结尾缺失')
  const hard = (f.findings || []).filter((x) => x.severity === 'hard' && x.count).map((x) => `${x.name}×${x.count}`)
  if (hard.length) parts.push(hard.join('、'))
  if (f.long_paragraphs && f.long_paragraphs.length) parts.push(`超 900 字段×${f.long_paragraphs.length}`)
  return `${path.basename(f.file || '')} — ${parts.join('；') || (failed.join('/') || 'fail')}`
}

// M5: one review line per FLAGGED refined section (empty-flags sections are trusted, omitted). Aggregates the
// audit's per-file sections[] into human 逐节复核 lines: 「§标题 — 源 L340-L360 · 15:17-16:02 — 存疑数字 2 处（样例…）/
// 未核实名 1 个 / 语气弱化 1 处 → 对照录音」. Chinese typesetting throughout (全角弯引号, Arabic numerals, Pangu spacing).
const M5_FLAG_LABEL = {
  number_drift: '存疑数字',
  hedge_loss: '语气弱化',
  content_gap_soft: '疑似漏段',
  ghost_name: '残留错写名',
  missing_yin: '未核实名裸写',
  weak_anchor: '定位弱（未对上源）',
}
function formatSectionFlag(flag) {
  const label = M5_FLAG_LABEL[flag.kind] || flag.kind
  if (flag.kind === 'number_drift') return `${label} ${flag.count} 处${flag.sample ? `（${flag.sample}）` : ''}`
  if (flag.kind === 'weak_anchor') return label
  const unit = flag.kind === 'ghost_name' || flag.kind === 'missing_yin' ? '个' : '处'
  return `${label} ${flag.count} ${unit}`
}
function formatSectionLine(sec) {
  const src = sec.sourceRange ? `源 L${sec.sourceRange.startLine}-L${sec.sourceRange.endLine}${sec.ts ? ` · ${sec.ts}` : ''}` : '源定位未对上'
  const flags = (sec.flags || []).map(formatSectionFlag).join(' / ')
  return `§${sec.title} — ${src} — ${flags} → 对照录音`
}
// Collect flagged sections across all audited files. When >1 file, prefix the file basename so lines stay
// unambiguous. Returns [] when no section carries a flag (or the audit predates sections[]).
export function sectionReviewItems(result = {}) {
  const files = (result.audit && result.audit.files) || []
  const items = []
  for (const f of files) {
    const flagged = (f.sections || []).filter((s) => (s.flags || []).length)
    const prefix = files.length > 1 && f.file ? `${path.basename(f.file)} ` : ''
    for (const s of flagged) items.push(prefix + formatSectionLine(s))
  }
  return items
}
// Count summary (total flagged / total sections) for the CLI one-liner + manifest.
export function sectionReviewSummary(result = {}) {
  const files = (result.audit && result.audit.files) || []
  let total = 0, flagged = 0
  for (const f of files) { const ss = f.sections || []; total += ss.length; flagged += ss.filter((s) => (s.flags || []).length).length }
  return { flagged, total }
}

// M8: one review line per cross-file numeric conflict. Format (Chinese typesetting: “” quotes, Arabic numerals,
// Pangu spacing — the unit carries its own 盘古 space when CJK, none for %/symbol/Latin): 「实体“云洲仪器”：文件 A
// 第 3 行作“2019 年”，文件 B 第 3 行作“2020 年”——请对照录音确认哪个是对的」. Reused by review.md and the CLI count.
function xfileUnitLabel(value, unit) {
  if (!unit) return String(value)
  // symbol/Latin units hug the number (30%, 5B); CJK units take a 盘古 space (2019 年, 8000 万, 3 个月).
  return /^[%$]/.test(unit) || /^[A-Za-z]/.test(unit) ? `${value}${unit}` : `${value} ${unit}`
}
export function formatCrossFileConflict(c) {
  const entity = c.entity || '(未定实体)'
  const parts = (c.values || []).map((v) => `文件 ${v.label} 第 ${v.line} 行作“${xfileUnitLabel(v.value, c.unit)}”`)
  return `实体“${entity}”：${parts.join('，')}——请对照录音确认哪个是对的`
}
export function crossFileConflictItems(result = {}) {
  return (result.crossFileConflicts || []).map(formatCrossFileConflict)
}

// P6: one review line per WITHIN-document numeric conflict (same measured noun + unit, disjoint values in ONE
// file). Chinese typesetting (“” quotes, Pangu spacing on CJK units). 「成稿.md：“毛利率”自相矛盾——第 3 行作
// “30%”，第 7 行作“45%”，请对照录音确认」. Reads both the 成稿 audit and the 时间线/总结 derivative audit.
export function formatNumericConflict(base, c) {
  const parts = (c.values || []).map((v) => `第 ${v.line} 行作“${xfileUnitLabel(v.value, c.unit)}”`)
  return `${base ? `${base}：` : ''}“${c.keyNoun}”自相矛盾——${parts.join('，')}，请对照录音确认`
}
export function numericConsistencyItems(result = {}) {
  const out = []
  for (const f of (result.audit && result.audit.files) || []) {
    const base = path.basename(f.file || '')
    for (const c of f.numericConflicts || []) out.push(formatNumericConflict(base, c))
  }
  for (const f of (result.derivativeAudit && result.derivativeAudit.files) || []) {
    const base = path.basename(f.file || '')
    for (const c of f.numericConflicts || []) out.push(formatNumericConflict(base, c))
  }
  return out
}

// P1: derivative-attribution review lines. Hard items (fabricated 访谈 figures) are high-priority; reporter-verify
// (public·待记者核实) and review (unlabeled / non-magnitude) items are medium. Each cites the derivative + line.
function derivativeItems(result = {}, pick) {
  const out = []
  for (const f of (result.derivativeAudit && result.derivativeAudit.files) || []) {
    const base = path.basename(f.file || '')
    for (const x of f[pick] || []) out.push(`${base} 第 ${x.line} 行：${x.text}${x.snippet ? `（${x.snippet}）` : ''}`)
  }
  return out
}
export function derivativeHardItems(result = {}) { return derivativeItems(result, 'hardFail') }
export function derivativeReporterItems(result = {}) {
  const out = []
  for (const f of (result.derivativeAudit && result.derivativeAudit.files) || []) {
    const base = path.basename(f.file || '')
    for (const x of f.reporterVerify || []) out.push(`${base} 第 ${x.line} 行：${x.text}（公开来源·待记者核实）`)
    for (const x of f.review || []) out.push(`${base} 第 ${x.line} 行：${x.text}（${x.note || '复核'}）`)
    for (const x of f.contextReview || []) out.push(`${base} 第 ${x.line} 行：${x.text}（${x.note || '语境复核'}）`)
  }
  return out
}

// M10: one review line per escalated file. Chinese typesetting throughout (全角引号, Arabic numerals,
// Pangu spacing). 「甲.md — 首档未过（compression_risk）→ 升级 anthropic 已过审，替换成稿」 /
// 「… → 升级后仍未过（两档均未过审，保留升级档：ending_missing）」 (loud on both-fail).
function formatEscalationFile(f, provider) {
  const label = f.label || path.basename(f.outPath || '')
  const cheapFailed = (f.cheapAudit && f.cheapAudit.failed) || f.reason || []
  const head = `${label} — 首档未过审（${cheapFailed.join('/') || 'fail'}）→ 升级 ${provider}`
  if (f.premiumAudit == null) return `${head} 精校失败，保留首档成稿（仍未过审）`
  if (!f.bothFailed) return `${head} 已过审，替换成稿`
  const premiumFailed = (f.premiumAudit.failed || [])
  const keptLabel = f.kept === 'premium' ? '保留升级档' : '回退首档'
  return `${head} 后仍未过审——两档均未过审，${keptLabel}（升级档 ${premiumFailed.join('/') || 'fail'}）`
}
export function escalationItems(result = {}) {
  const esc = result.escalation
  if (!esc || !Array.isArray(esc.files) || !esc.files.length) return []
  return esc.files.map((f) => formatEscalationFile(f, esc.provider))
}

// P2b: the source-label findings are listings (one line PER offending row), rendered in their own review section
// below — so the thin-table lint (one summary line per finding) must not also echo them.
const GLOSSARY_SOURCE_FINDINGS = new Set(['glossary_source_mislabel', 'glossary_source_unlabeled'])

// E13: fired 校对表 lint warnings → one review line each (each finding's sample text carries the counts).
function glossaryLintItems(result) {
  const lint = result.glossaryLint
  if (!lint || !Array.isArray(lint.findings)) return []
  return lint.findings
    .filter((f) => f && f.count && !GLOSSARY_SOURCE_FINDINGS.has(f.name))
    .map((f) => (f.samples && f.samples[0] && f.samples[0].text) ? f.samples[0].text : f.name)
}

// P2b: 校对表 source-label review — one line per row that either (a) cites an external/public source but isn't
// marked public (公开事实当访谈亲述), or (b) lacks a source label once the table is using the 【…】 convention.
export function glossarySourceItems(result = {}) {
  const lint = result.glossaryLint
  if (!lint || !Array.isArray(lint.findings)) return []
  const out = []
  for (const f of lint.findings) {
    if (!GLOSSARY_SOURCE_FINDINGS.has(f.name) || !f.count) continue
    for (const s of f.samples || []) out.push(s.text)
  }
  return out
}

// Provider-budget auto-split notice — one plain-language line per file, purely informational (no action needed).
// 「甲 — 约 53576 字，超过 deepseek-v4-pro 忠实处理长度 28000 字，已按发言轮边界分为 2 段精校」.
export function autoChunkItems(result = {}) {
  return (result.autoChunk || []).map((a) =>
    (a.requestedChunkSize
      ? `${a.label || ''} — 约 ${a.contentLength} 字，按显式分块大小 ${a.requestedChunkSize} 字/块，已按发言轮边界分为 ${a.parts} 段精校`
      : `${a.label || path.basename(a.model || '')} — 约 ${a.contentLength} 字，超过 ${a.model} 忠实处理长度 ${a.budget} 字，已按发言轮边界分为 ${a.parts} 段精校`))
}

export function reviewSections(result = {}, warnings = []) {
  const logic = result.logic || []
  const sections = [
    { title: '审计未能运行——本次运行失败，产物未经审计（不可采信，请人工运行 audit_refined.mjs 核验）', items: (result.auditUnavailable || []).map((x) => `${x.label ? `${x.label} — ` : ''}${x.path || x}`), priority: 'high' },
    { title: '未完成，需要补做', items: result.failed || [], priority: 'high' },
    { title: '疑似中途截断，需要检查结尾', items: (result.incomplete || []).map((x) => `${x.path || x}${x.note ? ` — ${x.note}` : ''}`), priority: 'high' },
    { title: '结尾完整性未核，需要人工抽查', items: result.unchecked || [], priority: 'high' },
    { title: '成稿质量抽查未过（内容缺口/压缩/欠精校/残留口癖/超长段）', items: ((result.audit && result.audit.files) || []).filter((f) => f.status === 'fail').map(formatAudit), priority: 'high' },
    { title: '升级重跑（首档未过审 → 升级 provider 从源重跑；两档均未过审的需人工核对）', items: escalationItems(result), priority: 'high' },
    { title: '跨文件互证（同一实体在不同文件里数值冲突，每份内部都合规——请对照录音确认）', items: crossFileConflictItems(result), priority: 'high' },
    { title: '派生件溯源：时间线/总结把公开或臆造数字标成【访谈】（源文无对应，疑炮制——须改标注或删除）', items: derivativeHardItems(result), priority: 'high' },
    { title: '派生件待核：时间线/总结的公开来源数字（待记者核实）与未标注/复核数字', items: derivativeReporterItems(result), priority: 'medium' },
    { title: '文档内数值自相矛盾（同一量在同一文件里出现两个不同数值——请对照录音确认哪个是对的）', items: numericConsistencyItems(result), priority: 'medium' },
    { title: '逐节复核清单（存疑数字/语气弱化/未核实名——请逐节对照录音）', items: sectionReviewItems(result), priority: 'medium' },
    { title: '已在成稿中插入内容缺口标记（总结/时间线/逻辑稿基于插标前文本，补回内容后需重出）', items: (result.annotations || []).map((a) => `${path.basename(a.path || '')} — 插入 ${a.inserted.length} 处标记`), priority: 'medium' },
    { title: '侦察疑似损坏，校对表该份不可靠', items: result.scoutSuspect || [], priority: 'medium' },
    { title: '校对表偏薄，建议人工复核（条目数/身份线索/变体比例）', items: glossaryLintItems(result), priority: 'medium' },
    { title: '校对表来源标注（公开/外部事实勿当访谈亲述；未标来源的行请补标【访谈】或【公开·待记者核实】）', items: glossarySourceItems(result), priority: 'medium' },
    { title: '源文件已带小标题，需决定保留或重做', items: result.headingConflicts || [], priority: 'medium' },
    { title: '疑似同指，待人工确认', items: (result.suspectedDuplicates || []).map(formatSuspect), priority: 'medium' },
    { title: '因网络故障未核实，可网络恢复后补查', items: (result.networkUnverified || []).map(formatNetworkItem), priority: 'medium' },
    { title: '逻辑顺序稿失败', items: logic.filter((l) => !l.path).map((l) => l.label || jsonLine(l)), priority: 'medium' },
    { title: '逻辑顺序稿疑漏小标题', items: logic.filter((l) => l.missingSections && l.missingSections.length).map(formatLogicGap), priority: 'medium' },
    { title: '收尾待问', items: (result.openQuestions || []).map(jsonLine), priority: 'medium' },
    { title: '已自动分段精校（文件超出该模型忠实处理长度，已按发言轮边界切分——仅告知，无需处理）', items: autoChunkItems(result), priority: 'low' },
    { title: '预检提示', items: warnings, priority: 'low' },
  ]
  if (result.error) sections.unshift({ title: '流水线未执行', items: [result.error], priority: 'high' })
  return sections.map((s) => ({ ...s, items: (s.items || []).filter(Boolean) })).filter((s) => s.items.length)
}

export function qualityScorecard(result = {}) {
  const auditFiles = (result.audit && result.audit.files) || []
  const auditFailed = result.auditFailed || []
  const sectionSummary = sectionReviewSummary(result)
  const hardFiles = new Set()
  for (const f of auditFiles) if (f.status === 'fail' || (f.failed || []).length) hardFiles.add(f.file || f.refinedFile || '')
  for (const f of auditFailed) hardFiles.add(f.path || '')
  const incomplete = result.incomplete || []
  const unchecked = result.unchecked || []
  const networkUnverified = result.networkUnverified || []
  const openQuestions = result.openQuestions || []
  const glossaryWarnings = result.glossaryLint
    ? (result.glossaryLint.findings || []).filter((f) => f && f.count).map((f) => f.name)
    : []
  const logicFailed = result.logicFailed || []
  const auditUnavailable = result.auditUnavailable || []
  // P7: an audit that could not run blocks the run — the deliverables are unaudited, which is worse than a
  // known hard finding, so it must never grade below "blocked".
  const blocked = hardFiles.size || incomplete.length || logicFailed.length || auditUnavailable.length
  const reviewNeeded = blocked || unchecked.length || sectionSummary.flagged || networkUnverified.length || openQuestions.length || glossaryWarnings.length
  const status = blocked ? 'blocked' : reviewNeeded ? 'review_needed' : 'ready'
  const label = status === 'ready' ? 'Ready' : status === 'blocked' ? 'Blocked' : 'Review Needed'
  return {
    status,
    label,
    metrics: {
      auditedFiles: auditFiles.length,
      hardFiles: hardFiles.size,
      incomplete: incomplete.length,
      unchecked: unchecked.length,
      auditUnavailable: auditUnavailable.length,
      flaggedSections: sectionSummary.flagged,
      totalSections: sectionSummary.total,
      networkUnverified: networkUnverified.length,
      openQuestions: openQuestions.length,
      logicFailed: logicFailed.length,
      glossaryWarnings: glossaryWarnings.length,
    },
    glossaryWarnings,
  }
}

export function buildReviewMarkdown(result = {}, context = {}) {
  const outputDir = path.resolve(context.outputDir || result.outputDir || process.cwd())
  const sections = reviewSections(result, context.warnings || result.warnings || [])
  const score = qualityScorecard(result)
  const lines = [
    '# Review Queue',
    '',
    `生成时间：${context.finishedAt || new Date().toISOString()}`,
    `主题：${context.topic || context.A?.topic || 'untitled'}`,
    `输出目录：${outputDir}`,
    '',
    '## 质量摘要',
    '',
    `- 状态：${score.label}`,
    `- 硬问题文件：${score.metrics.hardFiles} / 已审计文件：${score.metrics.auditedFiles}`,
    `- 结尾缺失：${score.metrics.incomplete}；未完成核对：${score.metrics.unchecked}`,
    `- 逐节复核：${score.metrics.flaggedSections} / ${score.metrics.totalSections}`,
    `- 联网未核实：${score.metrics.networkUnverified}；收尾待问：${score.metrics.openQuestions}`,
    score.glossaryWarnings.length ? `- 校对表提示：${score.glossaryWarnings.join('、')}` : '- 校对表提示：0',
    '',
  ]

  if (!sections.length) {
    lines.push('当前没有需要人工处理的提醒。')
  } else {
    lines.push(`共有 ${sections.reduce((n, s) => n + s.items.length, 0)} 个待处理项。`, '')
    for (const section of sections) {
      lines.push(`## ${section.title}`, '')
      for (const item of section.items) lines.push(`- ${item}`)
      lines.push('')
    }
  }

  lines.push('## 已生成产物', '')
  if (result.glossaryPath) lines.push(`- 校对表：${relOrAbs(result.glossaryPath, outputDir)}`)
  for (const r of result.refined || []) lines.push(`- 精校稿：${relOrAbs(r.outPath || r.path, outputDir)}`)
  for (const l of result.logic || []) if (l.path) lines.push(`- 逻辑顺序稿：${relOrAbs(l.path, outputDir)}`)
  if (result.summary) lines.push(`- 访谈总结：${result.summary.path ? relOrAbs(result.summary.path, outputDir) : '已请求生成'}`)
  if (result.timeline) lines.push(`- 时间线：${result.timeline.path ? relOrAbs(result.timeline.path, outputDir) : '已请求生成'}`)
  if (!result.glossaryPath && !(result.refined || []).length && !(result.logic || []).some((l) => l.path) && !result.summary && !result.timeline) lines.push('- 暂无')
  lines.push('')
  return lines.join('\n')
}

function sanitizeProviderInfo(info = {}) {
  if (!info || typeof info !== 'object') return info || null
  const out = {}
  for (const [k, v] of Object.entries(info)) {
    if (/apiKey|key|secret|token/i.test(k) && k !== 'keyVar') continue
    out[k] = v
  }
  return out
}

function manifestFiles(files = []) {
  return files.map((f) => ({
    label: f.label,
    title: f.title,
    path: f.path,
    outPath: f.outPath,
    lines: f.lines,
    bytes: f.bytes,
    sha256: f.path ? sha256File(f.path) : null,
  }))
}

export function buildRunManifest(result = {}, context = {}) {
  const A = context.A || {}
  const pkg = readPackage()
  const outputDir = path.resolve(context.outputDir || result.outputDir || A.outputDir || process.cwd())
  const reviewPath = context.reviewPath || result.reviewPath || path.join(outputDir, 'review.md')
  const manifestPath = context.manifestPath || result.manifestPath || path.join(outputDir, 'run.json')
  const usage = context.usage || result.usage || null
  const files = manifestFiles(A.files || [])

  return {
    schemaVersion: 1,
    generatedAt: context.finishedAt || new Date().toISOString(),
    startedAt: context.startedAt || null,
    finishedAt: context.finishedAt || null,
    durationMs: context.durationMs ?? null,
    app: { ...pkg, gitCommit: gitCommit() },
    provider: {
      name: context.provider || result.provider || null,
      info: sanitizeProviderInfo(context.providerInfo || result.providerInfo || {}),
    },
    config: {
      topic: A.topic || context.topic || null,
      date: A.date || null,
      scope: A.scope || [],
      verifyDepth: A.verifyDepth || null,
      headingPolicy: A.headingPolicy || null,
      fresh: !!A.fresh,
      models: A.models || null,
      outputDir,
      skillDir: A.skillDir || null,
      backgroundLength: A.background ? String(A.background).length : 0,
      backgroundSha256: A.background ? sha256Text(A.background) : null,
      files,
    },
    artifacts: {
      outputDir,
      manifestPath,
      reviewPath,
      glossaryPath: result.glossaryPath || null,
      refined: (result.refined || []).map((r) => r.outPath || r.path).filter(Boolean),
      logic: (result.logic || []).map((l) => l.path).filter(Boolean),
      summary: result.summary || null,
      timeline: result.timeline || null,
    },
    issues: Object.fromEntries(reviewSections(result, context.warnings || result.warnings || []).map((s) => [s.title, s.items.length])),
    quality: qualityScorecard(result),
    result: {
      error: result.error || null,
      failed: result.failed || [],
      incomplete: result.incomplete || [],
      unchecked: result.unchecked || [],
      // P7 fail-loud: files whose audit could not run — the run is failed, products unaudited.
      auditUnavailable: result.auditUnavailable || [],
      headingConflicts: result.headingConflicts || [],
      scoutSuspect: result.scoutSuspect || [],
      suspectedDuplicates: result.suspectedDuplicates || [],
      networkUnverified: result.networkUnverified || [],
      openQuestions: result.openQuestions || [],
      // M8: cross-file numeric conflicts (same entity + unit, disjoint values across ≥2 files). Structured so a
      // downstream tool can jump to the exact file+line; the human-readable lines are in review.md「跨文件互证」.
      crossFileConflicts: (result.crossFileConflicts || []).map((c) => ({ entity: c.entity, unit: c.unit, values: (c.values || []).map((v) => ({ label: v.label, value: v.value, line: v.line })) })),
      // P6: within-document numeric conflicts (same measured noun + unit, disjoint values in ONE file), across
      // both the 成稿 audit and the 时间线/总结 derivative audit — the human-readable lines are in review.md「文档内数值自相矛盾」.
      numericConflicts: [
        ...(((result.audit && result.audit.files) || []).flatMap((f) => (f.numericConflicts || []).map((c) => ({ file: path.basename(f.file || ''), keyNoun: c.keyNoun, unit: c.unit, values: (c.values || []).map((v) => ({ value: v.value, line: v.line })) })))),
        ...(((result.derivativeAudit && result.derivativeAudit.files) || []).flatMap((f) => (f.numericConflicts || []).map((c) => ({ file: path.basename(f.file || ''), keyNoun: c.keyNoun, unit: c.unit, values: (c.values || []).map((v) => ({ value: v.value, line: v.line })) })))),
      ],
    },
    // P1: derivative-attribution audit of 时间线/总结 (fabricated 访谈 figures → hard; public·待核 / unlabeled → soft).
    derivativeAudit: result.derivativeAudit ? {
      status: result.derivativeAudit.status,
      files: (result.derivativeAudit.files || []).map((f) => ({
        file: f.file, kind: f.kind, status: f.status,
        hardFail: f.hardFail || [], reporterVerify: f.reporterVerify || [], review: f.review || [], contextReview: f.contextReview || [],
      })),
    } : null,
    audit: result.audit ? {
      status: result.audit.status,
      // M5 sections summary: total flagged vs total ## sections across all audited files (the 逐节复核 headline).
      sections: sectionReviewSummary(result),
      files: (result.audit.files || []).map((f) => ({
        file: f.file, status: f.status, failed: f.failed || [], metrics: f.metrics || null,
        gaps: f.gaps || [], modelMarkers: f.modelMarkers || [],
        // Only flagged sections are persisted (a trusted section carries no actionable info for the manifest).
        sections: (f.sections || []).filter((s) => (s.flags || []).length).map((s) => ({ title: s.title, refinedLines: s.refinedLines, sourceRange: s.sourceRange, ts: s.ts, flags: s.flags })),
      })),
    } : null,
    // M10: cheap-first escalation outcome — the premium provider + per-file records (cheap vs premium audit,
    // which draft was kept, and whether BOTH tiers failed). Null unless --escalate ran. The shipped 成稿's
    // final audit is already reflected in `audit` above; this block preserves the cheap-vs-premium comparison.
    escalation: (context.escalation || result.escalation) ? (context.escalation || result.escalation) : null,
    // E13: 校对表 structural lint (all soft) — metrics + only the warnings that fired.
    glossaryLint: result.glossaryLint ? {
      metrics: result.glossaryLint.metrics || null,
      warnings: (result.glossaryLint.findings || []).filter((f) => f && f.count).map((f) => f.name),
    } : null,
    annotations: (result.annotations || []).map((a) => ({ path: a.path, inserted: (a.inserted || []).map((g) => ({ startLine: g.startLine, endLine: g.endLine, chars: g.chars })) })),
    anchors: (result.anchors || []).map((a) => ({ path: a.path, sections: (a.updated || []).length })),
    // Provider-aware auto-chunking: files auto-split because their 字数 exceeded the refine model's faithful
    // length. Empty unless a budgeted provider (e.g. DeepSeek) hit the cap. Human-readable lines in review.md.
    autoChunk: (result.autoChunk || []).map((a) => ({ label: a.label, model: a.model, budget: a.budget, contentLength: a.contentLength, parts: a.parts, ...(a.requestedChunkSize ? { requestedChunkSize: a.requestedChunkSize } : {}) })),
    usage,
  }
}

export function writeRunArtifacts(result = {}, context = {}) {
  const outputDir = path.resolve(context.outputDir || result.outputDir || context.A?.outputDir || process.cwd())
  fs.mkdirSync(outputDir, { recursive: true })
  const reviewPath = path.join(outputDir, 'review.md')
  const manifestPath = path.join(outputDir, 'run.json')
  const review = buildReviewMarkdown(result, { ...context, outputDir, reviewPath, manifestPath })
  fs.writeFileSync(reviewPath, review, 'utf8')
  const manifest = buildRunManifest(result, { ...context, outputDir, reviewPath, manifestPath })
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { reviewPath, manifestPath }
}
