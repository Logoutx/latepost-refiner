// ===== Shared runtime layer =====
// Engine selection + file prep + a one-call runJob(), used by BOTH the CLI (cli.js) and
// the local web server (server.js) so provider quirks and docx-conversion live in one place.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import mammoth from 'mammoth'
import { resolveSkillDir } from './assets.js'
import { runPipeline, DEFAULT_STAGE_MODELS, QUALITY_REPAIR_MAX_ROUNDS } from '../core/pipeline.js'
import { RULES, SINGLE_FILE_GLOSSARY, PUBLICATION_BLOCK_GATES, partPath, contentLength, stitchPartsWithReport, parseTurns, safeName, collapseAdjacentDuplicateHeadings } from '../core/spec.js'
import { auditPairs, annotateFile, annotateAnchorsFile, auditGlossary, auditLogicFile, checkCrossFileClaims, parseGlossaryLite, normalizeSrtTranscript, auditDerivativeFile, normalizeQuoteStyleText } from '../scripts/audit_refined.mjs'
import { summaryDeliverableName, timelineDeliverableName } from '../core/prompts.js'
import { makeDeepSeekEngine, DEEPSEEK_MODEL_IDS, DEEPSEEK_BASE_URL, SOURCE_PROTECTION_NOTE, resolveDeepSeekRouting } from '../engines/deepseek.js'
import { writeRunArtifacts } from './artifacts.js'
import { buildRunLogEntry, appendRunLog } from './runlog.js'
import { makeRunTrace } from './trace.js'
import { makeSpeakerTrace } from './speaker-trace.js'
import { extractTranscriptMetadata } from '../core/transcript-metadata.js'
import {
  detectDeclaredAiSummary,
  enforceCanonicalSpeakerLabels,
  parseSpeakerDocument,
  resolveSpeakerMapping,
  rewriteSpeakerLabels,
} from '../scripts/speaker-resolver.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SKILL_DIR = path.join(REPO_ROOT, 'claude-code-skill')

export class JobConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JobConfigError'
    this.code = 'CONFIG_ERROR'
  }
}

const MODEL_VALUES = new Set(['haiku', 'sonnet', 'opus', ...DEEPSEEK_MODEL_IDS])
export function normalizeModelOverrides(models) {
  if (models == null) return {}
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new JobConfigError('models 必须是 stage→model 对象')
  const out = {}
  for (const [stage, model] of Object.entries(models)) {
    if (!Object.hasOwn(DEFAULT_STAGE_MODELS, stage)) throw new JobConfigError(`未知模型阶段「${stage}」`)
    if (!MODEL_VALUES.has(model)) throw new JobConfigError(`阶段 ${stage} 的模型「${model}」无效；仅支持 haiku/sonnet/opus 或 DeepSeek v4 flash/pro`)
    out[stage] = model
  }
  return out
}

export function loadDotEnv(filePath = path.join(REPO_ROOT, '.env'), env = process.env) {
  if (!fs.existsSync(filePath)) return false
  const text = fs.readFileSync(filePath, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m || env[m[1]] !== undefined) continue
    let value = m[2].trim()
    const quoted = value.match(/^(['"])([\s\S]*)\1$/)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '').trim()
    env[m[1]] = value
  }
  return true
}
loadDotEnv()
loadDotEnv(path.join(process.cwd(), '.env')) // also pick up a .env beside a launched binary

export const CONVERT_EXT = new Set(['.docx', '.pptx', '.xlsx', '.pdf'])
export const HEADING_RE = /^(#{1,3}\s|【.+】\s*$|第[一二三四五六七八九十0-9]+[、.．]\s*\S)/m
// Strip a leading date prefix (2025-02-21_ / 2025-02-21 ) from a filename stem for the title.
export const deriveTitle = (src) => path.basename(src, path.extname(src)).replace(/^\d{4}-\d{2}-\d{2}[_\s]+/, '').trim()

export async function convertToMarkdown(src, workDir) {
  const ext = path.extname(src).toLowerCase()
  if (ext === '.srt') {
    fs.mkdirSync(workDir, { recursive: true })
    const dest = path.join(workDir, path.basename(src, ext) + '.md')
    const normalized = normalizeSrtTranscript(fs.readFileSync(src, 'utf8'), { sourceFile: src })
    fs.writeFileSync(dest, normalized, 'utf8')
    return dest
  }
  if (!CONVERT_EXT.has(ext)) return src // .txt / .md used as-is
  fs.mkdirSync(workDir, { recursive: true })
  const dest = path.join(workDir, path.basename(src, ext) + '.md')
  if (ext === '.docx') {
    // Pure-JS docx → text (mammoth), so the standalone binary needs no external tool.
    const { value } = await mammoth.extractRawText({ path: src })
    fs.writeFileSync(dest, value, 'utf8')
    return dest
  }
  try {
    const md = execFileSync('markitdown', [src], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    fs.writeFileSync(dest, md, 'utf8')
    return dest
  } catch (e) {
    throw new Error(`无法转换 ${path.basename(src)} → markdown：.pptx/.xlsx/.pdf 需要 markitdown（跑一次 scripts/setup-converters.sh 装好，或 pipx install markitdown，置于 PATH）；.docx 已内置 mammoth、无需外部工具。原始错误：${e.message}`)
  }
}

// Build one file entry from a source path (convert, count lines/bytes, detect headings,
// derive title / subtitle / outPath). Returns { entry, hasHeadings, headingWarning }.
export async function prepareFile(src, { topic, date, headingPolicy, outputDir, workDir }) {
  const mdPath = await convertToMarkdown(src, workDir)
  const content = fs.readFileSync(mdPath, 'utf8')
  const sourceKind = path.extname(src).toLowerCase() === '.srt' ? 'srt' : 'text'
  const lines = content.split('\n').length
  const bytes = Buffer.byteLength(content, 'utf8')
  const chars = contentLength(content)   // 正文字数 (汉字 + 英文词/数字)；文档长度以此衡量，行数仅供 Read 分页
  const hasHeadings = HEADING_RE.test(content)
  const speakerShape = parseSpeakerDocument(content)
  const speakerBase = resolveSpeakerMapping(content, [])
  const sourceDeclaration = detectDeclaredAiSummary(content)
  const title = deriveTitle(src)
  const entry = {
    path: mdPath, label: title, title,
    originalPath: path.resolve(src),
    sourceKind,
    sourceDocumentKind: sourceDeclaration.kind,
    sourceDeclaration,
    speakerMode: speakerShape.speakerMode,
    speakerResolution: {
      speakerMode: speakerShape.speakerMode,
      mappings: speakerBase.mappings,
      unresolved: speakerBase.unresolved,
      changedLines: 0,
      labelLines: speakerShape.labelLines,
      structureWarnings: speakerShape.structureWarnings || [],
      recoveredByScout: [],
    },
    subtitle: `*${topic}访谈${date ? ` · 采访时间 ${date}` : ''}*`,
    outPath: path.join(outputDir, 'Transcripts', `${title}.md`),
    lines, bytes, chars,
    // Turn map (1-based opening line + does-this-turn-end-on-a-question) so refine chunking can snap boundaries to
    // real turn edges and never orphan a question from its answer. Empty for label-less text → splitForRefine falls
    // back to the line-based divider. Cheap: one linear pass already having read the content.
    turns: parseTurns(content),
    // Diagnostic shape for the full-text Scout and the speaker contract. Every file now enters Scout;
    // generic/role-only tracks additionally require a full-text identity decision before Refine.
    speakerLabelLines: speakerShape.labelLines,
    needsSpeakerResolution: speakerShape.needsResolution,
  }
  const headingWarning = hasHeadings && headingPolicy === 'none'
    ? `${path.basename(src)} 疑似已带小标题，而 headingPolicy=none——可用 headingPolicy=keep|regenerate 重跑该份`
    : null
  // speakerShape 一并返回，是为了让调用方（runJob 里默认关闭的说话人链路记录）不必把文档再解析一遍。
  // 它带着全文行数组——只有 speaker-trace.js 从中取结构信息，正文本身永远不会被写出去。
  return { entry, hasHeadings, headingWarning, speakerShape }
}

export function buildFilePolicy({ outputDir, skillDir = DEFAULT_SKILL_DIR, files = [], topic = '', scope = [] }) {
  const outDir = path.resolve(outputDir || process.cwd())
  const writePaths = []
  const writePartBases = []
  for (const f of files || []) {
    if (!f || !f.outPath) continue
    writePaths.push(f.outPath)
    writePartBases.push(f.outPath)
    if (scope.includes('logic')) writePaths.push(path.join(outDir, '逻辑顺序', `${safeName(f.title)}.md`))
  }
  if (scope.includes('summary')) writePaths.push(path.join(outDir, summaryDeliverableName(topic)))
  if (scope.includes('timeline')) writePaths.push(path.join(outDir, timelineDeliverableName(topic)))
  return {
    readRoots: [outDir, path.resolve(skillDir)],
    writeRoots: [outDir],
    readPaths: files.map((f) => f && f.path).filter(Boolean),
    writePaths,
    writePartBases,
  }
}

export function repairCandidatePath(outputDir, file = {}, round = 1) {
  const title = safeName(file.title || file.label || path.basename(file.outPath || 'transcript.md', path.extname(file.outPath || '')))
  return path.join(path.resolve(outputDir), '.repair-candidates', `${title}.round-${Math.max(1, Number(round) || 1)}.md`)
}

// Build the DeepSeek engine — the only API provider the Universal edition supports. apiKey (if given)
// overrides the env lookup: the web UI passes the key the user typed; the CLI passes nothing and falls
// back to DEEPSEEK_API_KEY. Endpoint and the flash/pro model split are fixed inside makeDeepSeekEngine.
export function selectEngine({ concurrency, apiKey, serperKey, jinaKey, filePolicy, env = process.env, onPhase, onLog, onToolEvent, onAgentEvent, searchFn, fetchImpl, localFetchFn, dnsLookup } = {}) {
  const key = apiKey || env.DEEPSEEK_API_KEY
  if (!key) throw new Error('未设 DEEPSEEK_API_KEY（DeepSeek 的 API key）')
  return {
    provider: 'deepseek',
    engine: makeDeepSeekEngine({
      apiKey: key,
      searchApiKey: serperKey || env.SERPER_API_KEY,
      readerApiKey: jinaKey || env.JINA_API_KEY,
      concurrency, filePolicy, onPhase, onLog, onToolEvent, onAgentEvent, searchFn, fetchImpl, localFetchFn, dnsLookup,
    }),
    info: { label: 'DeepSeek', baseURL: DEEPSEEK_BASE_URL, keyVar: 'DEEPSEEK_API_KEY' },
  }
}

// Merge exactly the planned parts and delete them only after the final body has been written. Any missing
// or unreadable part throws before deletion, preserving the successful chunks as failure evidence/recovery input.
export function stitchRefineParts(f, chunks) {
  const parts = (chunks || []).map((c) => partPath(f.outPath, c.idx))
  const texts = parts.map((p) => fs.readFileSync(p, 'utf8'))
  const stitched = stitchPartsWithReport(texts)
  const merged = stitched.text
  fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
  fs.writeFileSync(f.outPath, merged, 'utf8')
  for (const p of parts) { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } }
  return {
    path: f.outPath,
    merged: parts.length,
    bytes: Buffer.byteLength(merged, 'utf8'),
    seamRepairs: stitched.seamRepairs,
    seamDuplicates: stitched.seamDuplicates,
  }
}

// M8 batch-level cross-file claim consistency. Runs ONLY here on the universal path (this layer has fs, so it can
// read every refined file back + the persisted 校对表); the CC-sandbox pipeline has no fs and the refined text
// never enters its orchestration layer, so M8 is universal-only (see claude-code-skill/references/return-handling.md).
// Reads each successfully-refined file's on-disk text, extracts glossary canonicals for entity association, and
// returns the conflict list (empty when < 2 refined files or no conflict). Never throws — an unreadable file is
// skipped, and any internal error degrades to no conflicts (M8 must never break a run).
export function computeCrossFileConflicts(refined, glossaryText) {
  try {
    const files = []
    for (const r of refined || []) {
      const p = r && (r.outPath || r.path)
      if (!p) continue
      let text
      try { text = fs.readFileSync(p, 'utf8') } catch { continue }
      files.push({ label: r.label || path.basename(p, path.extname(p)), refinedText: text })
    }
    if (files.length < 2) return []
    const canonicals = (parseGlossaryLite(glossaryText || '').entries || []).map((e) => e.canonical).filter(Boolean)
    return checkCrossFileClaims(files, canonicals).conflicts || []
  } catch { return [] }
}

// P1: derivative-attribution guard for the produced 时间线 / 访谈总结. Each is audited against the interview
// corpus (this run's source transcripts + refined 成稿 — the ground truth of what was actually said). A figure
// tagged 【访谈】 that is a measured quantity absent from that corpus is a FABRICATED interview figure → hard.
// Runs post-pipeline (fs, files on disk) exactly where the M8 cross-file check runs. Never throws — a missing
// deliverable file is skipped. Returns { status, files:[{ file, kind, status, hardFail[], reporterVerify[],
// review[], failed[] }] } or null. The corpus is the union of every source + 成稿 (extractNumberAtoms
// canonicalises writing systems identically; the 成稿 covers unit-restoration the derivative legitimately copied).
export function computeDerivativeAudit(A, result) {
  try {
    const outDir = A.outputDir
    const deliverables = []
    if ((A.scope || []).includes('summary') && result.summary) deliverables.push({ kind: 'summary', path: path.join(outDir, summaryDeliverableName(A.topic)) })
    if ((A.scope || []).includes('timeline') && result.timeline) deliverables.push({ kind: 'timeline', path: path.join(outDir, timelineDeliverableName(A.topic)) })
    if (!deliverables.length) return null
    const corpus = []
    for (const f of A.files || []) { for (const p of [f.path, f.outPath]) { if (p && fs.existsSync(p) && !corpus.includes(p)) corpus.push(p) } }
    const files = []
    for (const d of deliverables) {
      if (!fs.existsSync(d.path)) continue    // the deliverable agent did not write the expected file — skip (surfaced elsewhere)
      files.push(auditDerivativeFile(d.path, corpus, { kind: d.kind, glossaryText: result.glossary || '' }))
    }
    if (!files.length) return null
    return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
  } catch { return null }
}

// Universal parity with Codex-native: audit each produced logic稿 against the refined body it claims to reorder.
// The deterministic checker blocks fake same-order copies and missing source-section provenance; size inflation and
// duplicate paragraphs remain review-tier. Missing logic output is surfaced by the existing partial-delivery path,
// not misreported as a quality failure for a file that does not exist.
export function computeLogicAudit(A, result) {
  try {
    if (!(A.scope || []).includes('logic')) return null
    const files = []
    const entries = (result.logic || []).filter((l) => l && l.path)
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const source = (A.files || []).find((f) => f.label === entry.label) || (A.files || [])[i]
      if (!source || !source.outPath || !fs.existsSync(source.outPath) || !fs.existsSync(entry.path)) continue
      files.push(auditLogicFile(source.outPath, entry.path))
    }
    if (!files.length) return null
    return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
  } catch { return null }
}

// Persist the returned glossary (pure-JS output; no agent writes it). Cumulative across runs.
export function persistGlossary(result, glossaryPath) {
  if (result.glossary && result.glossary !== SINGLE_FILE_GLOSSARY) {
    fs.mkdirSync(path.dirname(glossaryPath), { recursive: true })
    fs.writeFileSync(glossaryPath, result.glossary, 'utf8')
    return true
  }
  return false
}

function repairAction(failed = []) {
  if (failed.includes('compression_risk')) return 'rerun_from_source'
  if (failed.includes('under_refined')) return 'full_cleanup'
  return 'targeted_repair'
}

function summarizeRepairToolEvents(events = []) {
  const succeeded = {}
  const failed = new Map()
  for (const event of events) {
    const tool = typeof event.tool === 'string' && event.tool ? event.tool : 'unknown'
    if (event.ok) {
      succeeded[tool] = (succeeded[tool] || 0) + 1
      continue
    }
    const code = typeof event.code === 'string' && event.code ? event.code : 'TOOL_UNKNOWN'
    const key = `${tool}\u0000${code}`
    const prev = failed.get(key) || { tool, code, count: 0 }
    prev.count += 1
    failed.set(key, prev)
  }
  return {
    succeeded: Object.fromEntries(Object.entries(succeeded).sort(([a], [b]) => a.localeCompare(b))),
    failed: [...failed.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.code.localeCompare(b.code)),
  }
}

export function qualityRepairResult(pipelineResult = {}) {
  const attempts = Array.isArray(pipelineResult.qualityRepairAttempts)
    ? pipelineResult.qualityRepairAttempts
    : (pipelineResult.refined || []).flatMap((entry) => ((entry.audit && entry.audit.repairAttempts) || []))
  const roundsUsed = attempts.reduce((max, attempt) => Math.max(max, Number(attempt.round) || 0), 0)
  let stopReason = 'not_needed'
  if ((pipelineResult.auditUnavailable || []).length || attempts.some((attempt) => attempt.outcome === 'audit_unavailable')) stopReason = 'audit_unavailable'
  else if ((pipelineResult.auditFailed || []).length) stopReason = attempts.length ? 'max_rounds' : 'repair_unavailable'
  else if (attempts.length) stopReason = 'passed'
  return { schemaVersion: 1, maxRounds: QUALITY_REPAIR_MAX_ROUNDS, roundsUsed, stopReason, attempts }
}

function auditPromptSummary(auditFile = {}) {
  const hard = (auditFile.findings || [])
    .filter((f) => f.severity === 'hard' && f.count)
    .map((f) => ({
      name: f.name,
      count: f.count,
      samples: (f.samples || []).slice(0, 8),
    }))
  return JSON.stringify({
    failed: auditFile.failed || [],
    metrics: auditFile.metrics || {},
    gaps: (auditFile.gaps || []).filter((g) => g.severity === 'hard').slice(0, 12),
    hard,
    long_paragraphs: (auditFile.long_paragraphs || []).slice(0, 8),
  }, null, 2)
}

function repairSpeakerContract(file = {}) {
  const resolution = file.speakerResolution || {}
  const mappings = Array.isArray(resolution.mappings) ? resolution.mappings : []
  const labels = [...new Set(mappings.map((mapping) => mapping && mapping.outputLabel).filter(Boolean))]
  const speakerMode = resolution.speakerMode || file.speakerMode
  if (speakerMode === 'untracked') {
    return '本文件是无说话人轨道独白；候选稿不得新增任何说话人标签或对话标签。'
  }
  if (speakerMode === 'ambiguous') {
    return '本文件疑似有未确认的说话人结构；候选稿必须保留原有标签/时间码，不得新增、猜测、合并或改名任何说话人。'
  }
  if (!labels.length) {
    return '本轮没有可用的 canonical 说话人映射；不得猜测或新增姓名，只能保留当前稿已有标签。'
  }
  const mappingText = mappings
    .filter((mapping) => mapping && mapping.sourceLabel && mapping.outputLabel)
    .map((mapping) => `${mapping.sourceLabel}→${mapping.outputLabel}`)
    .join('；')
  return `允许的输出标签只有：${labels.join('、')}。${mappingText ? `源标签映射：${mappingText}。` : ''}禁止新增、猜测或从主题/文件名推断任何姓名。`
}

function repairIssueCounts(auditFile = {}, hard = []) {
  const counts = {}
  for (const finding of auditFile.findings || []) {
    if (!finding || finding.severity !== 'hard') continue
    const count = Number(finding.count)
    if (finding.name && Number.isFinite(count) && count > 0) counts[finding.name] = count
  }
  const hardGaps = (auditFile.gaps || []).filter((gap) => gap && gap.severity === 'hard').length
  if (hardGaps) counts.content_gap = Math.max(counts.content_gap || 0, hardGaps)
  const longParagraphs = Array.isArray(auditFile.long_paragraphs) ? auditFile.long_paragraphs.length : 0
  if (longParagraphs) counts.long_paragraphs = Math.max(counts.long_paragraphs || 0, longParagraphs)
  for (const name of hard) if (!counts[name]) counts[name] = 1
  return counts
}

function qualityRepairPrompt(A, f, auditFile, attemptNo) {
  const action = repairAction(auditFile.failed || [])
  const actionGuide = action === 'rerun_from_source'
    ? '本次属于全文压缩风险：不要试图从当前成稿补回丢失内容。重新从源文件完整精校，当前成稿最多只作标题/结构参考。'
    : action === 'full_cleanup'
      ? '本次属于欠精校风险：读取源文件与当前成稿，对整份成稿做一轮完整清噪和顺句，保持覆盖与对话体。'
      : (auditFile.failed || []).includes('content_gap')
        ? '本次属于定向内容缺口：按 gaps 的源行区间逐段 Read 原稿，在前后锚点之间补回全部实质内容；不要重写已经通过审计的段落。'
        : (auditFile.failed || []).includes('attribution_mismatch')
          ? '本次属于发言人串位：按 finding 样本与源行核对，只调整对应轮次的标签和段落归属，不改写发言内容。'
          : '本次属于局部质量问题：优先修复 audit 标出的残留口癖、重复、乱码粘连或超长段；如需判断是否改义，再对照源文件。'
  return `你是访谈精校质量修复代理。目标不是总结，而是让既有精校稿通过质量审计，同时保留全部事实细节与对话体。

【第 ${attemptNo} 次修复】
【主题】${A.topic || 'untitled'}
【策略】${actionGuide}
【源文件】${f.path}（约 ${f.lines || '?'} 行）
【当前成稿】${f.outPath}
【输出】修复后仍写回 ${f.outPath}

【不可变说话人契约】
${repairSpeakerContract(f)}

【审计失败摘要】
${auditPromptSummary(auditFile)}

【必须遵守】
- 若 failed 包含 compression_risk：Read 源文件全文，重新完整精校；不要从压缩稿中“脑补恢复”。
- 若 failed 只是残留噪音 / phrase_repeats / broken_fragment_starts / asr_glue / long_paragraphs：可主要 Read 当前成稿，必要时 Read 源文件核对。
- 不要删掉事实、数字、时间、产品名、观点、举例和有信息量的表达。
- 保持发言人标签为纯文本，如“记者：”“王某：”。
- 单个对话段超过约 900 字必须重切；长独白拆成 200-600 字左右的连贯段落。
- 修复“因为因为 / 本身本身 / 涂鸦涂鸦 / 2021 年，2021 年 / 20182018 / SaaSAPP”等明显 ASR 残留。

${RULES}

完成后只返回一行：已写回 <path>；修复策略=<rerun_from_source|full_cleanup|targeted_repair>；备注=<一句话>。`
}

async function prepareInputFile(f, { topic, date, headingPolicy, outputDir, uploadDir, convertedDir }) {
  if (f && typeof f.path === 'string' && f.path.trim()) {
    const src = path.resolve(f.path)
    if (!fs.existsSync(src)) throw new JobConfigError(`找不到文件 ${src}`)
    try {
      return await prepareFile(src, { topic, date, headingPolicy, outputDir, workDir: convertedDir })
    } catch (e) {
      throw new JobConfigError(e.message)
    }
  }
  if (f && typeof f.name === 'string' && f.name.trim()) {
    fs.mkdirSync(uploadDir, { recursive: true })
    const src = path.join(uploadDir, path.basename(f.name))
    fs.writeFileSync(src, Buffer.from(f.base64 || '', 'base64'))
    try {
      return await prepareFile(src, { topic, date, headingPolicy, outputDir, workDir: uploadDir })
    } catch (e) {
      throw new JobConfigError(e.message)
    }
  }
  return null
}

// One-call run used by the web server and CLI. `files` may be filesystem entries
// [{ path }] or uploads [{ name, base64 }]. onPhase/onLog stream progress.
export async function runJob(params, { onPhase, onLog, onNotice } = {}) {
  const startedMs = Date.now()
  const startedAt = new Date(startedMs).toISOString()
  const notice = (msg) => { if (onNotice) onNotice(msg) }
  const {
    apiKey, serperKey, jinaKey, models,
    files = [], topic = 'untitled', date = '', background = '',
    scope = ['refine'], verifyDepth = 'key', headingPolicy = 'none',
    outputDir, fresh = false, concurrency,
    skillDir, refineMode, effort,
  } = params
  const modelOverrides = normalizeModelOverrides(models)
  const stageModels = { ...DEFAULT_STAGE_MODELS, ...modelOverrides }
  const effectiveModels = resolveDeepSeekRouting(stageModels)
  if (!files.length) throw new JobConfigError('未提供任何文件')
  const outDir = path.resolve(outputDir && String(outputDir).trim() ? outputDir : `${process.env.HOME}/Downloads/${topic}`)
  const trace = makeRunTrace(outDir)
  // 开发模式的说话人链路记录：默认关闭（params.devTrace 未开时是全空操作，一次文件系统调用都不做）。
  const speakerTrace = makeSpeakerTrace(outDir, { enabled: Boolean(params.devTrace) })
  const heartbeat = setInterval(() => trace.heartbeat(), 15000)
  heartbeat.unref?.()
  let traceClosed = false
  try {
  const uploadDir = path.join(outDir, '.uploads')
  const convertedDir = path.join(outDir, '.converted')
  const resolvedSkillDir = skillDir ? path.resolve(skillDir) : resolveSkillDir()

  if (!fs.existsSync(path.join(resolvedSkillDir, 'references', 'deliverables.md'))) {
    notice(`警告：${resolvedSkillDir}/references/deliverables.md 不存在——总结/时间线/逻辑稿的结构模板将读不到。用 --skill-dir 指向含 references/ 的目录。`)
  }

  // 1. materialize uploads to disk, then prepare each
  const fileEntries = []
  const warnings = []
  for (const f of files) {
    const prepared = await prepareInputFile(f, { topic, date, headingPolicy, outputDir: outDir, uploadDir, convertedDir })
    if (!prepared) continue
    const { entry, headingWarning, speakerShape } = prepared
    speakerTrace.parse(entry.label, speakerShape)
    if (headingWarning) warnings.push(headingWarning)
    if (headingWarning) notice(`提示：${headingWarning}`)
    fileEntries.push(entry)
  }

  const declaredSummaries = fileEntries.filter((entry) => entry.sourceDocumentKind === 'declared_ai_summary')
  if (declaredSummaries.length) {
    const names = declaredSummaries.map((entry) => entry.label).join('、')
    throw new JobConfigError(`检测到 ${names} 是文档自身明确声明的 AI 智能纪要，不是原始转录稿；请提交妙记转录全文后重新精校。`)
  }

  // 2. prior glossary (persistent per-company校对表). Source priority: an explicit --prior-glossary path >
  //    the default <outDir>/校对表.md. Accumulation always writes back to <outDir>/校对表.md (glossaryPath),
  //    so a one-off external seed still lands in the canonical location for the next run.
  const glossaryPath = path.join(outDir, '校对表.md')
  const explicitPrior = params.priorGlossaryPath ? path.resolve(params.priorGlossaryPath) : null
  const priorSource = !fresh ? (explicitPrior && fs.existsSync(explicitPrior) ? explicitPrior : (fs.existsSync(glossaryPath) ? glossaryPath : null)) : null
  let priorGlossaryText
  if (priorSource) {
    priorGlossaryText = fs.readFileSync(priorSource, 'utf8')
    notice(`沿用既有校对表：${priorSource}`)
  }

  // 3. engine: an injected engine (tests) or DeepSeek + a job-scoped Serper/Jina runtime. Keys are passed
  //    explicitly; never mutate process.env, so concurrent jobs cannot leak credentials into one another.
  const filePolicy = buildFilePolicy({ outputDir: outDir, skillDir: resolvedSkillDir, files: fileEntries, topic, scope })
  const repairToolEvents = []
  let sel
  if (params.__engine) sel = { provider: 'injected', engine: params.__engine, info: { label: 'injected' } }
  else {
    try {
      sel = selectEngine({
        concurrency, apiKey, serperKey, jinaKey, filePolicy,
        onPhase: (title) => { trace.stage(title); if (onPhase) onPhase(title) },
        onLog,
        onToolEvent: (event) => {
          trace.tool(event)
          if (event && typeof event.label === 'string' && event.label.startsWith('repair:')) {
            repairToolEvents.push({
              label: event.label,
              tool: typeof event.tool === 'string' ? event.tool : null,
              ok: !!event.ok,
              code: typeof event.code === 'string' ? event.code : null,
            })
          }
        },
        onAgentEvent: (event) => trace.agent(event),
        searchFn: params.searchFn, fetchImpl: params.fetchImpl, localFetchFn: params.localFetchFn, dnsLookup: params.dnsLookup,
      })
    } catch (e) {
      throw new JobConfigError(e.message)
    }
  }
  if (sel.provider === 'deepseek') {
    notice(`provider=${sel.provider}（${sel.info.label}）· baseURL=${sel.info.baseURL} · key=${sel.info.keyVar}`)
    notice(`⚠ ${SOURCE_PROTECTION_NOTE}`)
    if (!(serperKey || process.env.SERPER_API_KEY) && (scope.includes('timeline') || verifyDepth !== 'none')) {
      notice('提示：未设 SERPER_API_KEY——联网核实/时间线将降级为不联网（refine 不受影响）。')
    }
  }
  notice(`
开始：${fileEntries.length} 份文件 · scope=${scope.join(',')} · verify=${verifyDepth} · 输出 ${outDir}
`)

  // §2 capability injection: with fs available, the audit / anchor / gap-marker work runs INSIDE the pipeline's
  // per-file gate (not as a post-run wrapper — that avoided a double pass). The closures also RECORD their
  // results into the accumulators below, so the top-level result.audit / annotations / anchors keep the exact
  // shape writeRunArtifacts (+ cli/server) already consume. runAudit returns an auditPair file-result so the
  // gate can read failed/gaps; annotate writes the visible 缺口 marker (only when the gate hits a still-hard
  // gap); annotateAnchors writes the invisible source anchors. Universal injects at most two candidate repair rounds:
  // the prompt carries exact source ranges/findings, the agent can write only a disposable candidate, and the
  // host promotes it after speaker-contract + quality validation. Tool failures remain in an append-only metadata
  // ledger; the post-repair audit, not the mere presence of a tool error, decides body quality.
  const auditFilesAcc = []   // auditPair file-results, in first-seen order (→ result.audit.files)
  const annotations = []     // [{ path, inserted, skipped }]  (→ result.annotations)
  const anchors = []         // [{ path, updated, skipped }]   (→ result.anchors)
  const speakerOutputEnforcements = [] // every deterministic pass, including the passes after targeted repairs
  const recordAuditFile = (file) => {
    const i = auditFilesAcc.findIndex((x) => x && file && path.resolve(x.file) === path.resolve(file.file))
    if (i >= 0) auditFilesAcc[i] = file
    else auditFilesAcc.push(file)
  }
  const glossaryTextFor = () => (fs.existsSync(glossaryPath) ? fs.readFileSync(glossaryPath, 'utf8') : null)
  const enforceSpeakerOutput = (f, phase = 'post_refine') => {
    const refinedText = fs.readFileSync(f.outPath, 'utf8')
    const resolution = f.speakerResolution || {}
    const enforced = enforceCanonicalSpeakerLabels(refinedText, resolution.mappings || [], {
      speakerMode: resolution.speakerMode || f.speakerMode,
    })
    if (enforced.text !== refinedText) fs.writeFileSync(f.outPath, enforced.text, 'utf8')
    speakerOutputEnforcements.push({
      sequence: speakerOutputEnforcements.length + 1,
      phase,
      label: f.label,
      path: f.outPath,
      changedLines: enforced.changedLines || 0,
      labelLines: enforced.labelLines || 0,
      replacements: enforced.replacements || [],
      unknownLabels: enforced.unknownLabels || [],
      valid: enforced.valid !== false,
      violations: enforced.violations || [],
    })
    speakerTrace.enforce(f.label, phase, enforced)
    return enforced
  }
  const capabilities = {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    // M11a single-shot refine writes the model's response text straight to the 成稿 (no Write-tool agent). Only
    // the single-shot path uses this; the agentic path still writes via the model's Write tool. mkdir -p first
    // so a first-run Transcripts/ dir exists, then the downstream audit reads it back from disk unchanged.
    writeFile: (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
    // Scout owns speaker identity. Materialize its one mapping as a disposable Refine input so every chunk sees
    // the same names from its first Read. The original f.path is never edited and remains the audit source.
    prepareSpeakerInput: (f, finding = {}) => {
      const sourceText = fs.readFileSync(f.path, 'utf8')
      const resolved = rewriteSpeakerLabels(sourceText, finding.speakers || [])
      speakerTrace.mapping(f.label, resolved)
      speakerTrace.rewrite(f.label, resolved)
      if (!resolved.labelLines || resolved.text === sourceText) return { path: f.path, ...resolved }
      const resolvedPath = path.join(convertedDir, `${safeName(f.title || f.label)}.speaker-resolved.md`)
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      fs.writeFileSync(resolvedPath, resolved.text, 'utf8')
      return { path: resolvedPath, ...resolved }
    },
    // Refine normally preserves the already-canonical input labels. If it nevertheless reintroduces a source
    // number or a role synonym, collapse that alias through the SAME mapping before audit. Unknown names are
    // never guessed or rewritten; they remain visible in unknownLabels for audit/review.
    enforceSpeakerOutput,
    // Risk (a): the pipeline hands us THIS round's in-memory 校对表 (opts.glossaryText) — use it for the
    // ghost_name / missing_yin checks, because on a first run the file isn't persisted until after the pipeline
    // returns, so reading it from disk would miss it. Fall back to the on-disk copy only when nothing was passed.
    runAudit: (f, opts = {}) => {
      // A targeted repair is another model write. Re-apply the same canonical map before every audit round so a
      // repair cannot reintroduce source numbers or role synonyms after the first post-Refine enforcement.
      enforceSpeakerOutput(f, opts.phase || (opts.round ? `post_repair_round_${opts.round}` : 'pre_audit'))
      // Normalize a model-created duplicate topic boundary before any quality or derivative audit consumes it.
      // This preserves all distinct prose and only removes a repeated H2 plus an optional exact replayed turn.
      const before = fs.readFileSync(f.outPath, 'utf8')
      const normalized = collapseAdjacentDuplicateHeadings(before)
      if (normalized.text !== before) fs.writeFileSync(f.outPath, normalized.text, 'utf8')
      const glossaryText = opts.glossaryText != null ? opts.glossaryText : glossaryTextFor()
      const resolution = f.speakerResolution || {}
      const res = auditPairs([{
        sourcePath: f.path,
        refinedPath: f.outPath,
        mode: 'refine',
        glossaryText,
        speakerMode: resolution.speakerMode || f.speakerMode,
        speakerMappings: resolution.mappings || [],
      }])
      const file = res.files[0]
      recordAuditFile(file)
      const metrics = (file && file.metrics) || {}
      speakerTrace.audit(f.label, {
        phase: opts.phase || (opts.round ? `post_repair_round_${opts.round}` : 'pre_audit'),
        ...(metrics.attribution || {}),
        sourceTurns: metrics.sourceTurns,
        refinedTurns: metrics.refinedTurns,
        speakerTurnRatio: metrics.speakerTurnRatio,
        attributionMismatchFailed: (file && (file.failed || []).includes('attribution_mismatch')) || false,
      })
      return file
    },
    repair: async (f, opts = {}) => {
      const auditFile = opts.audit || { file: f.outPath, status: 'fail', failed: opts.hard || [], gaps: opts.gaps || [], findings: [] }
      const action = repairAction(auditFile.failed || [])
      const model = stageModels.repair || stageModels.refine || 'opus'
      const before = fs.readFileSync(f.outPath, 'utf8')
      const round = Number(opts.round) || 1
      const maxRounds = Number(opts.maxRounds) || QUALITY_REPAIR_MAX_ROUNDS
      const label = `repair:${f.label || path.basename(f.outPath)}#${round}/${maxRounds}`
      const candidatePath = repairCandidatePath(outDir, f, round)
      const candidateFile = { ...f, outPath: candidatePath }
      fs.mkdirSync(path.dirname(candidatePath), { recursive: true })
      fs.writeFileSync(candidatePath, before, 'utf8')
      let response = null
      let errorCode = null
      let candidatePromoted = false
      let candidateSpeakerValid = null
      let candidateRejectedReason = null
      let candidateHardFindings = []
      const agentAttempted = (auditFile.failed || []).some((name) => name !== 'quote_style')
      if (agentAttempted) {
        try {
          response = await sel.engine.agent(qualityRepairPrompt({ topic, models: stageModels }, candidateFile, auditFile, round), {
            label, phase: 'Audit', model, outputPath: candidatePath,
            filePolicy: {
              readRoots: [resolvedSkillDir],
              writeRoots: [outDir],
              readPaths: [f.path, candidatePath],
              writePaths: [candidatePath],
              writePartBases: [],
            },
          })
        } catch (error) {
          errorCode = (error && error.code) || 'REPAIR_AGENT_FAILED'
        }
      }
      let deterministicQuoteFix = false
      if ((!agentAttempted || response != null) && !errorCode && fs.existsSync(candidatePath)) {
        try {
          let candidateText = fs.readFileSync(candidatePath, 'utf8')
          if ((auditFile.failed || []).includes('quote_style')) {
            const normalized = normalizeQuoteStyleText(candidateText)
            deterministicQuoteFix = normalized !== candidateText
            if (deterministicQuoteFix) {
              fs.writeFileSync(candidatePath, normalized, 'utf8')
              candidateText = normalized
            }
          }
          const speakerReport = enforceSpeakerOutput(candidateFile, `repair_candidate_round_${round}`)
          candidateSpeakerValid = speakerReport.valid !== false
            && !(speakerReport.unknownLabels || []).length
            && !(speakerReport.violations || []).length
          if (!candidateSpeakerValid) {
            candidateRejectedReason = 'speaker_invalid'
            errorCode = 'REPAIR_CANDIDATE_SPEAKER_INVALID'
          } else {
            const resolution = f.speakerResolution || {}
            const candidateAudit = auditPairs([{
              sourcePath: f.path,
              refinedPath: candidatePath,
              mode: 'refine',
              glossaryText: opts.glossaryText != null ? opts.glossaryText : glossaryTextFor(),
              speakerMode: resolution.speakerMode || f.speakerMode,
              speakerMappings: resolution.mappings || [],
            }]).files[0]
            const beforeHard = (auditFile.failed || []).filter((name) => PUBLICATION_BLOCK_GATES.includes(name))
            candidateHardFindings = (candidateAudit.failed || []).filter((name) => PUBLICATION_BLOCK_GATES.includes(name))
            const beforeCounts = repairIssueCounts(auditFile, beforeHard)
            const candidateCounts = repairIssueCounts(candidateAudit, candidateHardFindings)
            const introducedHard = candidateHardFindings.some((name) => !beforeHard.includes(name))
            const targetImproved = beforeHard.some((name) => (candidateCounts[name] || 0) < (beforeCounts[name] || 1))
            if (introducedHard) {
              candidateRejectedReason = 'introduced_hard_finding'
              errorCode = 'REPAIR_CANDIDATE_NEW_HARD_FINDING'
            } else if (!targetImproved) {
              candidateRejectedReason = 'no_quality_improvement'
              errorCode = 'REPAIR_CANDIDATE_NO_IMPROVEMENT'
            } else {
              fs.renameSync(candidatePath, f.outPath)
              candidatePromoted = true
            }
          }
        } catch {
          if (!candidateRejectedReason) {
            candidateRejectedReason = 'audit_failed'
            errorCode = 'REPAIR_CANDIDATE_AUDIT_FAILED'
          }
        }
      } else if (agentAttempted && !errorCode) {
        errorCode = 'REPAIR_AGENT_NO_RESPONSE'
        candidateRejectedReason = 'agent_no_response'
      }
      if (!candidatePromoted && fs.existsSync(candidatePath)) {
        try { fs.unlinkSync(candidatePath) } catch { /* preserve the formal transcript even if scratch cleanup fails */ }
      }
      const after = fs.readFileSync(f.outPath, 'utf8')
      const events = repairToolEvents.filter((event) => event.label === label)
      return {
        action,
        model: agentAttempted ? effectiveModels.repair : 'deterministic',
        bytesBefore: Buffer.byteLength(before, 'utf8'),
        bytesAfter: Buffer.byteLength(after, 'utf8'),
        changed: after !== before,
        agentCompleted: agentAttempted ? response != null : null,
        deterministicQuoteFix,
        candidatePromoted,
        candidateSpeakerValid,
        candidateRejectedReason,
        candidateHardFindings,
        toolSummary: summarizeRepairToolEvents(events),
        errorCode: errorCode || (response == null ? 'REPAIR_AGENT_NO_RESPONSE' : null),
      }
    },
    annotate: (f, gaps) => {
      if (params.annotate === false) return { inserted: [], skipped: [] }
      const a = annotateFile(f.outPath, gaps)
      if (a.inserted.length) annotations.push(a)
      return a
    },
    annotateAnchors: (f) => {
      if (params.anchors === false) return { updated: [], skipped: [] }
      const resolution = f.speakerResolution || {}
      const a = annotateAnchorsFile(f.path, f.outPath, {
        knownSpeakerLabels: (resolution.mappings || []).map((mapping) => mapping && mapping.sourceLabel).filter(Boolean),
      })
      if (a.updated.length) anchors.push(a)
      return a
    },
    // Deletion #2 (provider side): with fs, the chunk part-files are merged deterministically by the pure
    // stitchParts() (one blank line between parts, exact-dup seam heading collapsed) — no stitch subagent, so
    // no per-response output cap and no paraphrase risk on a long transcript. The Workflow sandbox (no fs) has
    // no such capability and falls back to the concatenation agent. Reads <outPath>.part{idx} in chunk order,
    // writes f.outPath, and drops the consumed parts only after the final write succeeds.
    // Returns a truthy summary; the pipeline consumer only distinguishes truthy (merged) from null (failed).
    stitch: stitchRefineParts,
  }

  const A = {
    topic, date, background, outputDir: outDir,
    skillDir: resolvedSkillDir,
    scope, verifyDepth, headingPolicy, chunkMode: params.chunkMode, chunkSize: params.chunkSize,
    refineMode: refineMode === 'single-shot' ? 'single-shot' : undefined,   // M11a: default agentic (byte-equivalent)
    effort,   // M12: { refine?, logic?, summary?, timeline? } reasoning-effort per smart-tier category
    priorGlossaryText, priorGlossaryPath: (!fresh && fs.existsSync(glossaryPath)) ? glossaryPath : undefined,
    canonicalOverrides: params.canonicalOverrides,
    models: stageModels,
    modelOverrides,
    effectiveModels,
    capabilities,
    searchProvider: 'serper', fetchProvider: 'jina-reader+local-fallback',
    fresh, annotate: params.annotate, files: fileEntries,
    plannedChunks: [],
    onChunkPlan: (plan) => trace.plan(plan),
    // 开发模式的说话人事件出口（关闭时下面这一行是空操作）。目前只有 Scout 会发。
    onSpeakerEvent: (event) => { if (event && event.type === 'scout_chunks') speakerTrace.scout(event.fileLabel, event) },
  }

  {
    const r = await runPipeline(A, sel.engine)
    // A bot job contains one transcript. Finalize its catalog identity only after the main transcript has
    // completed Refine, deterministic speaker enforcement and source-aware audit. The source remains the
    // factual authority; the final transcript and the exact speaker mapping are supporting context. Failed
    // or multi-file runs deliberately emit no top-level identity instead of polluting the shared catalog.
    let transcriptMetadata = null
    const refinedPath = fileEntries.length === 1 && r.refined && r.refined.length === 1
      ? (r.refined[0].outPath || r.refined[0].path)
      : null
    if (!r.error && refinedPath && fs.existsSync(refinedPath)) {
      const refinedText = fs.readFileSync(refinedPath, 'utf8')
      const refinedFile = {
        path: refinedPath,
        label: `${fileEntries[0].label}精校稿`,
        lines: refinedText.split('\n').length,
        bytes: Buffer.byteLength(refinedText, 'utf8'),
      }
      const speakerResolution = (r.speakerResolutions || []).find(
        (item) => item && item.label === fileEntries[0].label,
      ) || (r.speakerResolutions || [])[0] || null
      transcriptMetadata = await extractTranscriptMetadata(sel.engine, fileEntries[0], {
        topic,
        background,
        catalog: params.metadataCatalog,
        model: stageModels.scout,
        refinedFile,
        speakerResolution,
      })
    }
    const wroteGlossary = !r.error && persistGlossary(r, glossaryPath)
    // E13: soft structural lint of the rendered 校对表 (条目数/身份线索/变体比例). Runs on the in-memory glossary
    // (skipped for the single-file sentinel, which builds no independent table); any fired warning flows into
    // review.md via reviewSections. All soft — never affects the exit code.
    const glossaryLint = (wroteGlossary && r.glossary) ? auditGlossary(r.glossary) : null
    // Assemble the top-level audit/annotations/anchors from what the in-pipeline gate recorded (no re-run).
    const audit = auditFilesAcc.length ? { status: auditFilesAcc.some((f) => f.status === 'fail') ? 'fail' : 'ok', files: auditFilesAcc } : null
    if (anchors.length) notice(`源锚点：${anchors.length} 份成稿的小节已标注源行号${anchors.some((a) => a.updated.some((u) => u.ts)) ? '与录音时间' : ''}（渲染不可见，引文可循此回查源文件）`)

    // M8: cross-file numeric consistency over the whole batch (≥2 refined files). Uses this round's rendered
    // 校对表 (in-memory) for entity association, else the on-disk copy. A conflict is attached to the result +
    // manifest and rendered in review.md「跨文件互证」; a ONE-line summary folds into openQuestions so the Step-5
    // batch-ask surfaces it. Never fatal — computeCrossFileConflicts swallows its own errors.
    const crossFileGlossary = (r.glossary && r.glossary !== SINGLE_FILE_GLOSSARY) ? r.glossary : (fs.existsSync(glossaryPath) ? fs.readFileSync(glossaryPath, 'utf8') : '')
    const crossFileConflicts = !r.error ? computeCrossFileConflicts(r.refined, crossFileGlossary) : []
    if (crossFileConflicts.length) {
      notice(`跨文件互证：${crossFileConflicts.length} 处同实体数值在不同文件里冲突——见 review.md「跨文件互证」`)
      // Fold ONE summary line into openQuestions (the per-conflict detail lives in review.md / run.json).
      r.openQuestions = [...(r.openQuestions || []), `跨文件互证：${crossFileConflicts.length} 处同实体数值在不同文件里冲突（每份内部都合规）——请对照录音确认哪个是对的，详见 review.md「跨文件互证」`]
    }

    const logicAudit = !r.error ? computeLogicAudit(A, r) : null
    const logicFailed = logicAudit
      ? logicAudit.files.filter((f) => f.status === 'fail').map((f) => ({ path: f.file, findings: f.failed || [] }))
      : []
    if (logicFailed.length) notice(`⚠ 逻辑顺序稿审计未过 ${logicFailed.length} 份——见 review.md「逻辑顺序稿审计」`)

    // P1: audit the produced 时间线/总结 for fabricated 访谈-attributed figures. A hard fabrication joins
    // auditFailed (→ non-zero exit + review.md), exactly like any other hard finding; 待核/复核 items are soft.
    const derivativeAudit = !r.error ? computeDerivativeAudit(A, r) : null
    if (derivativeAudit) {
      for (const df of derivativeAudit.files) {
        if ((df.hardFail || []).length) {
          r.auditFailed = [...(r.auditFailed || []), { path: df.file, findings: ['derivative_attribution'] }]
          notice(`⚠ 派生件溯源未过：${path.basename(df.file)} 有 ${df.hardFail.length} 个标【访谈】数字源文无对应（疑炮制）——见 review.md「派生件溯源」`)
        }
        const rv = (df.reporterVerify || []).length
        if (rv) notice(`时间线/总结：${rv} 个公开来源数字待记者核实（见 review.md「派生件溯源」）`)
      }
    }
    const finishedMs = Date.now()
    const finishedAt = new Date(finishedMs).toISOString()
    const durationMs = finishedMs - startedMs
    const usage = sel.engine.usage()
    const engineFailures = typeof sel.engine.failures === 'function' ? sel.engine.failures() : []
    const webTelemetry = typeof sel.engine.webTelemetry === 'function' ? sel.engine.webTelemetry() : null
    const executionFailed = !!r.error || (r.failed || []).length > 0
    const primaryFailure = executionFailed
      ? (engineFailures.at(-1) || {
          code: r.error ? 'PIPELINE_ERROR' : 'PIPELINE_INCOMPLETE',
          retryable: false,
          message: r.error || `未完成正文：${(r.failed || []).join('、')}`,
        })
      : null
    const execution = {
      schemaVersion: 1,
      status: executionFailed ? 'failed' : 'completed',
      stage: 'finished',
      failure: primaryFailure,
      failures: engineFailures,
      progress: {
        filesTotal: fileEntries.length,
        filesRefined: (r.refined || []).length,
        filesFailed: (r.failed || []).length,
        partsPlanned: (r.plannedChunks || []).reduce((sum, plan) => sum + (plan.parts || []).length, 0),
      },
      eventsPath: trace.eventsPath,
      statePath: trace.statePath,
      // 只有开了 --dev-trace 才有这一项；默认运行的 run.json 与之前逐字节一致。
      ...(speakerTrace.enabled ? { devTrace: { eventsPath: speakerTrace.eventsPath, summaryPath: speakerTrace.summaryPath } } : {}),
    }
    const result = { ...r, speakerOutputNormalizations: speakerOutputEnforcements, transcriptMetadata, audit, logicAudit, logicFailed, derivativeAudit, qualityRepair: qualityRepairResult(r), execution, escalation: null, glossaryLint, crossFileConflicts, annotations, anchors, outputDir: outDir, glossaryPath: wroteGlossary ? glossaryPath : null, priorGlossaryPath: priorGlossaryText ? glossaryPath : null, provider: sel.provider, providerInfo: sel.info, modelRouting: effectiveModels, webTelemetry, warnings, usage, startedAt, finishedAt, durationMs }
    const artifacts = writeRunArtifacts(result, {
      A,
      outputDir: outDir,
      startedAt,
      finishedAt,
      durationMs,
      provider: sel.provider,
      providerInfo: sel.info,
      warnings,
      usage: result.usage,
      escalation: result.escalation,
    })
    speakerTrace.finish()
    trace.finish(execution)
    traceClosed = true
    clearInterval(heartbeat)

    // Per-run log (time/tokens/estimated cost) — additive, never fatal, opt-out via params.runLog===false
    // (CLI: --no-run-log). `models` is DeepSeek's tier→model-id map (needed for the flash/pro cost split);
    // an injected test engine prices as "unknown" (estimateCost → null for any provider it doesn't recognise).
    let runLog = null
    if (params.runLog !== false) {
      const runLogModels = sel.provider === 'deepseek' ? effectiveModels : null
      const entry = buildRunLogEntry({ params, result, provider: sel.provider, models: runLogModels, webTelemetry })
      const logRes = appendRunLog(entry, { logPath: params.runLogPath })
      if (logRes.ok) runLog = { path: logRes.path, lineCount: logRes.lineCount }
      else notice(`警告：运行日志写入失败：${logRes.error}`)
    }

    return { ...result, ...artifacts, runLog }
  }
  } catch (error) {
    clearInterval(heartbeat)
    if (!traceClosed) {
      speakerTrace.finish()
      const failure = {
        code: error && error.code === 'CONFIG_ERROR' ? 'CONFIG_ERROR' : 'INTERNAL_ERROR',
        retryable: false,
        message: (error && error.message) || String(error),
      }
      trace.finish({ status: 'failed', failure })
    }
    throw error
  }
}
