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

// E13: fired 校对表 lint warnings → one review line each (each finding's sample text carries the counts).
function glossaryLintItems(result) {
  const lint = result.glossaryLint
  if (!lint || !Array.isArray(lint.findings)) return []
  return lint.findings
    .filter((f) => f && f.count)
    .map((f) => (f.samples && f.samples[0] && f.samples[0].text) ? f.samples[0].text : f.name)
}

export function reviewSections(result = {}, warnings = []) {
  const logic = result.logic || []
  const sections = [
    { title: '未完成，需要补做', items: result.failed || [], priority: 'high' },
    { title: '疑似中途截断，需要检查结尾', items: (result.incomplete || []).map((x) => `${x.path || x}${x.note ? ` — ${x.note}` : ''}`), priority: 'high' },
    { title: '结尾完整性未核，需要人工抽查', items: result.unchecked || [], priority: 'high' },
    { title: '成稿质量抽查未过（内容缺口/压缩/欠精校/残留口癖/超长段）', items: ((result.audit && result.audit.files) || []).filter((f) => f.status === 'fail').map(formatAudit), priority: 'high' },
    { title: '已在成稿中插入内容缺口标记（总结/时间线/逻辑稿基于插标前文本，补回内容后需重出）', items: (result.annotations || []).map((a) => `${path.basename(a.path || '')} — 插入 ${a.inserted.length} 处标记`), priority: 'medium' },
    { title: '侦察疑似损坏，校对表该份不可靠', items: result.scoutSuspect || [], priority: 'medium' },
    { title: '校对表偏薄，建议人工复核（条目数/身份线索/变体比例）', items: glossaryLintItems(result), priority: 'medium' },
    { title: '源文件已带小标题，需决定保留或重做', items: result.headingConflicts || [], priority: 'medium' },
    { title: '疑似同指，待人工确认', items: (result.suspectedDuplicates || []).map(formatSuspect), priority: 'medium' },
    { title: '因网络故障未核实，可网络恢复后补查', items: (result.networkUnverified || []).map(formatNetworkItem), priority: 'medium' },
    { title: '逻辑顺序稿失败', items: logic.filter((l) => !l.path).map((l) => l.label || jsonLine(l)), priority: 'medium' },
    { title: '逻辑顺序稿疑漏小标题', items: logic.filter((l) => l.missingSections && l.missingSections.length).map(formatLogicGap), priority: 'medium' },
    { title: '收尾待问', items: (result.openQuestions || []).map(jsonLine), priority: 'medium' },
    { title: '预检提示', items: warnings, priority: 'low' },
  ]
  if (result.error) sections.unshift({ title: '流水线未执行', items: [result.error], priority: 'high' })
  return sections.map((s) => ({ ...s, items: (s.items || []).filter(Boolean) })).filter((s) => s.items.length)
}

export function buildReviewMarkdown(result = {}, context = {}) {
  const outputDir = path.resolve(context.outputDir || result.outputDir || process.cwd())
  const sections = reviewSections(result, context.warnings || result.warnings || [])
  const lines = [
    '# Review Queue',
    '',
    `生成时间：${context.finishedAt || new Date().toISOString()}`,
    `主题：${context.topic || context.A?.topic || 'untitled'}`,
    `输出目录：${outputDir}`,
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
  if (result.summary) lines.push('- 访谈总结：已请求生成')
  if (result.timeline) lines.push('- 时间线：已请求生成')
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
    result: {
      error: result.error || null,
      failed: result.failed || [],
      incomplete: result.incomplete || [],
      unchecked: result.unchecked || [],
      headingConflicts: result.headingConflicts || [],
      scoutSuspect: result.scoutSuspect || [],
      suspectedDuplicates: result.suspectedDuplicates || [],
      networkUnverified: result.networkUnverified || [],
      openQuestions: result.openQuestions || [],
    },
    audit: result.audit ? {
      status: result.audit.status,
      files: (result.audit.files || []).map((f) => ({ file: f.file, status: f.status, failed: f.failed || [], metrics: f.metrics || null, gaps: f.gaps || [], modelMarkers: f.modelMarkers || [] })),
    } : null,
    // E13: 校对表 structural lint (all soft) — metrics + only the warnings that fired.
    glossaryLint: result.glossaryLint ? {
      metrics: result.glossaryLint.metrics || null,
      warnings: (result.glossaryLint.findings || []).filter((f) => f && f.count).map((f) => f.name),
    } : null,
    annotations: (result.annotations || []).map((a) => ({ path: a.path, inserted: (a.inserted || []).map((g) => ({ startLine: g.startLine, endLine: g.endLine, chars: g.chars })) })),
    anchors: (result.anchors || []).map((a) => ({ path: a.path, sections: (a.updated || []).length })),
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
