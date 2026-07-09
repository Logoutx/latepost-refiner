#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scoutPrompt,
  verifyPrompt,
  refinePrompt,
  dedupPrompt,
  singlePassPrompt,
  summaryPrompt,
  timelinePrompt,
  logicPlanPrompt,
  logicWritePrompt,
  stitchPrompt,
} from '../core/prompts.js'
import {
  DEDUP_SCHEMA,
  LOGIC_PLAN_SCHEMA,
  LOGIC_REPORT_SCHEMA,
  ONE_PASS_CHARS,
  REFINE_REPORT_SCHEMA,
  SCOUT_SCHEMA,
  VERIFY_SCHEMA,
  applyOverridesToMerged,
  cleanSuspects,
  contentLength,
  dedupListText,
  dedupQuestions,
  dropLocked,
  excludeVerified,
  findHeadingConflicts,
  glossaryConflicts,
  mergeDedup,
  mergeFindings,
  mergeIntoPrior,
  mergeVerified,
  parseGlossary,
  pickNetworkUnverified,
  partPath,
  renderGlossary,
  renderRefineGlossary,
  safeName,
  scoutLooksGarbled,
  splitForRefine,
  splitForScout,
  mergeScoutChunks,
  stitchParts,
  verifyChunks,
  weakDupFlags,
} from '../core/spec.js'
import { writeRunArtifacts } from '../universal/artifacts.js'
import { annotateAnchorsFile, annotateFile, auditGlossary, auditLogicFile, auditPairs, normalizeSrtTranscript, shouldNormalizeSrtSource } from './audit_refined.mjs'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')

export const CODEX_MODEL_PROFILE = {
  scout: { model: 'gpt-5.4-mini', reasoning_effort: 'low' },
  check: { model: 'gpt-5.4-mini', reasoning_effort: 'low' },
  stitch: { model: 'gpt-5.4-mini', reasoning_effort: 'low' },
  verify: { model: 'gpt-5.4', reasoning_effort: 'medium' },
  dedup: { model: 'gpt-5.4', reasoning_effort: 'medium' },
  summary: { model: 'gpt-5.4', reasoning_effort: 'medium' },
  timeline: { model: 'gpt-5.4', reasoning_effort: 'high' },
  refine: { model: 'gpt-5.5', reasoning_effort: 'high' },
  'single-pass': { model: 'gpt-5.5', reasoning_effort: 'high' },
  'logic-plan': { model: 'gpt-5.5', reasoning_effort: 'high' },
  logic: { model: 'gpt-5.5', reasoning_effort: 'high' },
}

function stageProfile(A, stage) {
  const base = CODEX_MODEL_PROFILE[stage] || { model: 'gpt-5.4', reasoning_effort: 'medium' }
  const override = A && A.codexModels && A.codexModels[stage]
  if (typeof override === 'string') return { ...base, model: override }
  if (override && typeof override === 'object') return { ...base, ...override }
  return { ...base }
}

function promptEntry(A, stage, rest) {
  return { stage, ...stageProfile(A, stage), ...rest }
}

function usage() {
  return `Usage:
  node "<this skill dir>/scripts/codex-native.mjs" prepare --args run-args.json
  node "<this skill dir>/scripts/codex-native.mjs" after-scout --args <out>/_codex-native/args.json --findings findings.json
  node "<this skill dir>/scripts/codex-native.mjs" after-verify --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-scout.json --verified verified.json [--dedup dedup.json]
  node "<this skill dir>/scripts/codex-native.mjs" after-refine --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-verify.json --refined refined.json
  node "<this skill dir>/scripts/codex-native.mjs" deliver-prompts --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-verify.json
  node "<this skill dir>/scripts/codex-native.mjs" after-logic-plan --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-refine.json --plans logic-plans.json
  node "<this skill dir>/scripts/codex-native.mjs" after-deliver --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-logic-plan.json [--logic logic.json] [--summary summary.json] [--timeline timeline.json] [--checks checks.json]
  node "<this skill dir>/scripts/codex-native.mjs" audit --args <out>/_codex-native/args.json --result result.json
  node "<this skill dir>/scripts/codex-native.mjs" artifacts --args <out>/_codex-native/args.json --result result.json
  node "<this skill dir>/scripts/codex-native.mjs" mark-stage --args <out>/_codex-native/args.json --stage refine --status start|end

This helper is deterministic glue for the Codex subscription-native workflow. It never calls model APIs and never
requires OPENAI_API_KEY or TAVILY_API_KEY. Codex subagents consume the generated prompt files and return JSON reports.`
}

function parseCli(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const name = key.slice(2)
    const value = rest[i + 1]
    if (!value || value.startsWith('--')) {
      opts[name] = true
    } else {
      opts[name] = value
      i += 1
    }
  }
  return { command, opts }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return filePath
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, text, 'utf8')
  return filePath
}

function slug(value, fallback = 'item') {
  const s = String(value || fallback)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96)
  return s || fallback
}

function titleFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/^\d{4}-\d{2}-\d{2}[_\s-]+/, '').trim()
}

function lineCount(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    if (!text.length) return 0
    return text.split(/\r\n|\r|\n/).length
  } catch {
    return 0
  }
}

function byteCount(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function contentChars(filePath) {
  try {
    return contentLength(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return 0
  }
}

function defaultSubtitle(A) {
  const prefix = [A.date, A.topic].filter(Boolean).join(' · ')
  return `*${prefix ? `${prefix} · ` : ''}访谈精校稿*`
}

function normalizeScope(scope) {
  if (Array.isArray(scope) && scope.length) return scope
  if (typeof scope === 'string' && scope.trim()) return scope.split(',').map((s) => s.trim()).filter(Boolean)
  return ['refine']
}

function stateDir(A) {
  return path.join(path.resolve(A.outputDir), '_codex-native')
}

function normalizeNativeSourcePath(filePath, A, index) {
  const raw = fs.readFileSync(filePath, 'utf8')
  if (!shouldNormalizeSrtSource(raw, filePath)) return { path: filePath, sourceKind: 'text', originalPath: filePath }
  const title = titleFromPath(filePath) || `file-${index + 1}`
  const dest = path.join(stateDir(A), 'sources', `${slug(title, `file-${index + 1}`)}.md`)
  writeText(dest, normalizeSrtTranscript(raw, { sourceFile: filePath }))
  return { path: dest, sourceKind: 'srt', originalPath: filePath }
}

function nowIso() {
  return new Date().toISOString()
}

function timingPath(A) {
  return path.join(stateDir(A), 'timing.json')
}

function readTiming(A) {
  try {
    if (fs.existsSync(timingPath(A))) return readJson(timingPath(A))
  } catch {
    // best effort
  }
  return { startedAt: nowIso(), stages: {} }
}

function writeTiming(A, timing) {
  return writeJson(timingPath(A), timing)
}

function markStage(A, stage, status = 'end', meta = {}) {
  const timing = readTiming(A)
  const key = String(stage || 'unknown')
  const item = timing.stages[key] || {}
  const at = nowIso()
  if (status === 'start') {
    item.startedAt = item.startedAt || at
    item.status = 'running'
  } else {
    item.startedAt = item.startedAt || at
    item.finishedAt = at
    item.status = status === 'fail' ? 'fail' : 'ok'
    const t0 = Date.parse(item.startedAt)
    const t1 = Date.parse(item.finishedAt)
    item.durationMs = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : null
  }
  item.meta = { ...(item.meta || {}), ...meta }
  timing.stages[key] = item
  if (status !== 'start') timing.finishedAt = at
  writeTiming(A, timing)
  return { timingPath: timingPath(A), stage: key, status: item.status, durationMs: item.durationMs ?? null }
}

function promptName(prefix, index, label, ext = '.txt') {
  return `${String(index + 1).padStart(3, '0')}-${prefix}-${slug(label, `file-${index + 1}`)}${ext}`
}

export function normalizeArgs(input) {
  const A = { ...input }
  if (!A.outputDir) throw new Error('args.outputDir is required')
  A.outputDir = path.resolve(A.outputDir)
  A.skillDir = A.skillDir ? path.resolve(A.skillDir) : SKILL_DIR
  A.scope = normalizeScope(A.scope)
  A.verifyDepth = A.verifyDepth || 'key'
  A.headingPolicy = A.headingPolicy || 'none'
  A.background = A.background || ''
  A.topic = A.topic || 'untitled'
  A.date = A.date || ''
  A.codexModels = (A.codexModels && typeof A.codexModels === 'object') ? A.codexModels : {}
  A.chunkMode = A.chunkMode || 'speed'

  const files = Array.isArray(A.files) ? A.files : []
  if (!files.length) throw new Error('args.files must contain at least one source file')
  A.files = files.map((entry, index) => {
    const f = typeof entry === 'string' ? { path: entry } : { ...entry }
    if (!f.path) throw new Error(`args.files[${index}].path is required`)
    f.path = path.resolve(f.path)
    const originalTitle = titleFromPath(f.path)
    const source = normalizeNativeSourcePath(f.path, A, index)
    f.path = source.path
    f.originalPath = f.originalPath || source.originalPath
    f.sourceKind = f.sourceKind || source.sourceKind
    f.label = f.label || originalTitle || titleFromPath(f.path) || `file-${index + 1}`
    f.lines = Number.isFinite(Number(f.lines)) && Number(f.lines) > 0 ? Number(f.lines) : lineCount(f.path)
    f.bytes = Number.isFinite(Number(f.bytes)) && Number(f.bytes) > 0 ? Number(f.bytes) : byteCount(f.path)
    f.chars = Number.isFinite(Number(f.chars)) && Number(f.chars) > 0 ? Number(f.chars) : contentChars(f.path)
    f.title = f.title || originalTitle || titleFromPath(f.path) || f.label
    f.subtitle = f.subtitle || defaultSubtitle(A)
    f.outPath = f.outPath ? path.resolve(f.outPath) : path.join(A.outputDir, 'Transcripts', `${f.title}.md`)
    return f
  })

  const priorPath = path.join(A.outputDir, '校对表.md')
  if (A.priorGlossaryResolved !== true && !A.fresh && !A.priorGlossaryText && fs.existsSync(priorPath)) {
    A.priorGlossaryText = fs.readFileSync(priorPath, 'utf8')
  }
  A.priorGlossaryResolved = true
  return A
}

export function prepareNativeRun(args) {
  const A = normalizeArgs(args)
  const dir = stateDir(A)
  fs.mkdirSync(path.join(A.outputDir, 'Transcripts'), { recursive: true })
  if (A.scope.includes('logic')) fs.mkdirSync(path.join(A.outputDir, '逻辑顺序'), { recursive: true })
  if (A.scope.includes('logic')) fs.mkdirSync(path.join(dir, 'logic-plans'), { recursive: true })

  markStage(A, 'prepare', 'start')
  const normalizedArgsPath = writeJson(path.join(dir, 'args.json'), A)
  const prompts = []
  const shortSinglePass = A.files.length === 1 && (A.files[0].chars || 0) < ONE_PASS_CHARS
  if (shortSinglePass) {
    const f = A.files[0]
    const lockedClusters = (A.canonicalOverrides && A.canonicalOverrides.length)
      ? applyOverridesToMerged({ people: [], brands: [], terms: [] }, A.canonicalOverrides)
      : null
    const lockedAll = lockedClusters ? [...lockedClusters.people, ...lockedClusters.brands, ...lockedClusters.terms] : []
    const overrideNote = lockedAll.length
      ? `【用户钦定正名（必须执行）】以下写法无论源文件里出现哪种口语/变体，精校时一律统一写作钦定正字：\n${lockedAll.map((e) => `- ${(e.variants || []).join(' / ') || '（无变体）'} 一律写作 **${e.canonical}**`).join('\n')}`
      : ''
    const onePassGlossaryText = lockedAll.length
      ? ['## 人名 / 品牌（用户钦定）', ...lockedAll.map((e) => `- **${e.canonical}** ← ${(e.variants || []).join(' / ') || '—'} ｜ 用户钦定`)].join('\n')
      : null
    if (onePassGlossaryText) writeText(path.join(dir, 'one-pass-glossary.md'), onePassGlossaryText)
    prompts.push(promptEntry(A, 'single-pass', {
      label: f.label,
      schema: REFINE_REPORT_SCHEMA,
      path: writeText(path.join(dir, 'prompts', promptName('single-pass', 0, f.label)), singlePassPrompt(f, A, overrideNote)),
    }))
  } else {
    A.files.forEach((f, index) => {
      const chunks = splitForScout(f)
      if (chunks.length <= 1) {
        prompts.push(promptEntry(A, 'scout', {
          label: f.label,
          schema: SCOUT_SCHEMA,
          path: writeText(path.join(dir, 'prompts', promptName('scout', index, f.label)), scoutPrompt(f, A)),
        }))
      } else {
        chunks.forEach((chunk, cIndex) => {
          prompts.push(promptEntry(A, 'scout', {
            label: `${f.label}#${chunk.idx}/${chunk.count}`,
            schema: SCOUT_SCHEMA,
            chunk,
            path: writeText(path.join(dir, 'prompts', promptName('scout', prompts.length, `${f.label}-${chunk.idx}`)), scoutPrompt(f, A, chunk)),
          }))
        })
      }
    })
  }

  const manifestPath = writeJson(path.join(dir, 'prompt-manifest.json'), { argsPath: normalizedArgsPath, prompts })
  markStage(A, 'prepare', 'end', { prompts: prompts.length, chunkMode: A.chunkMode })
  return { argsPath: normalizedArgsPath, promptManifestPath: manifestPath, prompts }
}

function normalizeFindings(raw, files) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw.findings) ? raw.findings : raw
  if (Array.isArray(source)) {
    let cursor = 0
    return files.map((f) => {
      const chunks = splitForScout(f)
      if (chunks.length <= 1) return source[cursor++] || null
      const parts = chunks.map(() => source[cursor++] || null)
      return mergeScoutChunks(parts, f)
    })
  }
  if (source && typeof source === 'object') {
    return files.map((f) => {
      const chunks = splitForScout(f)
      if (chunks.length <= 1) return source[f.label] || source[f.title] || source[f.path] || null
      const parts = chunks.map((c) => source[`${f.label}#${c.idx}/${c.count}`] || source[`${f.title}#${c.idx}/${c.count}`] || null)
      return mergeScoutChunks(parts, f)
    })
  }
  throw new Error('findings must be an array, { findings: [...] }, or an object keyed by file label/title/path')
}

export function afterScout(args, findingsRaw) {
  const A = normalizeArgs(args)
  const prior = (A.priorGlossaryText && !A.fresh) ? parseGlossary(A.priorGlossaryText) : null
  A.prior = prior
  A.doNotMerge = (prior && prior.doNotMerge) || []
  const findings = normalizeFindings(findingsRaw, A.files)
  const scoutSuspect = A.files.filter((f, i) => findings[i] && scoutLooksGarbled(findings[i])).map((f) => f.label)
  const cleanFindings = findings.map((fd) => (fd && scoutLooksGarbled(fd)) ? null : fd)
  const mergedThisBatch = applyOverridesToMerged(mergeFindings(cleanFindings, A.files), A.canonicalOverrides)
  const overrideQuestions = []
  for (const c of mergedThisBatch.overrideConflicts || []) overrideQuestions.push(`钦定正名冲突：同一对象被多条 decree 命名为「${c.canonicals.join('」「')}」——已按首条统一为「${c.resolvedTo}」，请确认是否正确。`)
  for (const w of mergedThisBatch.categoryWarnings || []) overrideQuestions.push(`钦定正名类别疑误标：「${w.canonical}」声明为${w.declared}，但其写法在${w.foundIn}里出现——已按声明的${w.declared}锁定，请确认类别。`)
  const headingConflicts = findHeadingConflicts(cleanFindings, A.files, A.headingPolicy)
  const verifyTarget = excludeVerified(dropLocked(mergedThisBatch), prior)
  const doVerify = A.verifyDepth !== 'none' && (verifyTarget.people.length || verifyTarget.brands.length || verifyTarget.terms.length)
  const vc = doVerify ? verifyChunks(verifyTarget, A.verifyDepth) : { chunks: [], eligible: 0, excluded: 0, overflow: 0 }
  const dedupList = dedupListText(mergedThisBatch)
  const dir = stateDir(A)

  const verifyPrompts = vc.chunks.map((chunk, index) => promptEntry(A, 'verify', {
    label: `verify:${index + 1}/${vc.chunks.length}`,
    schema: VERIFY_SCHEMA,
    timeoutMs: A.verifyTimeoutMs || 90000,
    path: writeText(path.join(dir, 'prompts', promptName('verify', index, `chunk-${index + 1}`)), verifyPrompt(chunk, A)),
  }))
  const dedupPromptPath = dedupList
    ? writeText(path.join(dir, 'prompts', 'dedup-semantic.txt'), dedupPrompt(dedupList, A))
    : null

  const state = {
    findings,
    cleanFindings,
    mergedThisBatch,
    overrideQuestions,
    headingConflicts,
    scoutSuspect,
    verify: { eligible: vc.eligible, excluded: vc.excluded, overflow: vc.overflow, chunks: vc.chunks.length },
    verifyPrompts,
    dedupPrompt: dedupPromptPath ? promptEntry(A, 'dedup', { label: 'dedup:semantic', schema: DEDUP_SCHEMA, path: dedupPromptPath }) : null,
  }
  const statePath = writeJson(path.join(dir, 'state-after-scout.json'), state)
  markStage(A, 'scout', 'end', { files: A.files.length, scoutSuspect: scoutSuspect.length, verifyChunks: vc.chunks.length })
  return { statePath, verifyPrompts, dedupPromptPath }
}

function normalizeVerified(raw) {
  if (!raw) return null
  const parts = Array.isArray(raw) ? raw : Array.isArray(raw.parts) ? raw.parts : null
  if (parts) {
    return {
      resolved: parts.flatMap((p) => p && p.resolved || []).filter((r) => r && r.query && r.canonical),
      unresolved: parts.flatMap((p) => p && p.unresolved || []).filter((r) => r && r.query),
    }
  }
  return {
    resolved: (raw.resolved || []).filter((r) => r && r.query && r.canonical),
    unresolved: (raw.unresolved || []).filter((r) => r && r.query),
  }
}

function normalizeDedup(raw) {
  if (!raw) return null
  return { suspects: cleanSuspects(raw.suspects || []) }
}

function normalizeReportItems(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(Boolean)
  if (Array.isArray(raw.parts)) return raw.parts.filter(Boolean)
  if (Array.isArray(raw.refined)) return raw.refined.filter(Boolean)
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([label, value]) => (value && typeof value === 'object') ? { label, ...value } : null).filter(Boolean)
  }
  return []
}

function reportFor(items, candidates) {
  const cs = new Set(candidates.filter(Boolean).map((x) => path.resolve(String(x))))
  return items.find((r) => {
    if (!r) return false
    if (r.label && candidates.includes(r.label)) return true
    for (const k of ['path', 'outPath', 'partPath', 'refinedPath']) {
      if (r[k] && cs.has(path.resolve(String(r[k])))) return true
    }
    return false
  }) || null
}

function extractSections(filePath) {
  let text = ''
  try { text = fs.readFileSync(filePath, 'utf8') } catch { return [] }
  const lines = text.split(/\r?\n/)
  const heads = []
  lines.forEach((line, i) => {
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (m) heads.push({ title: m[1].trim(), line: i + 1 })
  })
  return heads.map((h, i) => ({
    title: h.title,
    startLine: h.line,
    endLine: i + 1 < heads.length ? heads[i + 1].line - 1 : lines.length,
    tags: h.title.split(/[：:、，,／/·\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
  }))
}

function buildSectionMap(A, refined) {
  const files = (refined || []).map((r) => {
    const file = r.outPath || r.path
    return {
      label: r.label || path.basename(file || ''),
      title: path.basename(file || '', path.extname(file || '')),
      path: file,
      sections: file ? extractSections(file) : [],
    }
  })
  const sectionMap = {
    generatedAt: nowIso(),
    topic: A.topic,
    files,
  }
  const sectionMapPath = writeJson(path.join(stateDir(A), 'section-map.json'), sectionMap)
  return { sectionMap, sectionMapPath }
}

function asRefinedPromptFile(f) {
  return {
    ...f,
    path: f.outPath,
    lines: lineCount(f.outPath),
    bytes: byteCount(f.outPath),
    chars: contentChars(f.outPath),
  }
}

function headingOrderForFile(sectionMap, f) {
  const item = (sectionMap?.files || []).find((x) => x.path === f.outPath || x.label === f.label)
  return (item?.sections || []).map((s, i) => ({ title: s.title, order: i + 1 }))
}

function lcsNum(a, b) {
  const prev = new Array(b.length + 1).fill(0)
  const curr = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    for (let j = 0; j <= b.length; j += 1) { prev[j] = curr[j]; curr[j] = 0 }
  }
  return prev[b.length]
}

function auditLogicPlan(plan, headings) {
  const issues = []
  const source = headings.map((h) => h.title)
  const threads = Array.isArray(plan?.threads) ? plan.threads : []
  if (plan?.no_reorder_needed) return { status: 'skip', issues, metrics: { sourceSections: source.length, threads: 0, sameOrderRatio: 1 } }
  if (threads.length < 3 || threads.length > 7) issues.push(`主线数量应为 3-7 条，当前 ${threads.length} 条。`)
  const covered = []
  const order = []
  for (const t of threads) {
    const ss = Array.isArray(t?.source_sections) ? t.source_sections.filter(Boolean) : []
    if (!ss.length) issues.push(`主线「${t?.title || '未命名'}」没有 source_sections。`)
    covered.push(...ss)
    const explicit = Array.isArray(t?.source_order) ? t.source_order.map(Number).filter((n) => Number.isFinite(n)) : []
    if (explicit.length) order.push(...explicit)
    else for (const s of ss) {
      const found = headings.find((h) => h.title === s)
      if (found) order.push(found.order)
    }
  }
  const coveredSet = new Set(covered)
  const missing = source.filter((h) => !coveredSet.has(h))
  const dupes = Array.from(covered.reduce((m, h) => m.set(h, (m.get(h) || 0) + 1), new Map())).filter(([, n]) => n > 1).map(([h]) => h)
  if (missing.length) issues.push(`漏掉 ${missing.length}/${source.length} 个精校小标题：${missing.slice(0, 8).join('、')}`)
  if (dupes.length) issues.push(`重复覆盖 ${dupes.length} 个精校小标题：${dupes.slice(0, 8).join('、')}`)
  const canonical = headings.map((h) => h.order).filter((n) => order.includes(n))
  const sameOrderRatio = order.length ? Number((lcsNum(canonical, order) / order.length).toFixed(3)) : 1
  const moved = order.filter((n, i) => n !== canonical[i]).length
  if (order.length >= 8 && sameOrderRatio > 0.85) issues.push(`source_order 同序率 ${sameOrderRatio}，实质重排不足。`)
  if (order.length >= 8 && moved < Math.max(3, Math.ceil(order.length * 0.2))) issues.push(`仅 ${moved}/${order.length} 个小标题发生位移，疑只是局部前置或合并标题。`)
  return {
    status: issues.length ? 'fail' : 'ok',
    issues,
    metrics: { sourceSections: source.length, coveredSections: covered.length, missingSections: missing.length, duplicateSections: dupes.length, sameOrderRatio, movedSections: moved, threads: threads.length },
  }
}

export function afterVerify(args, state, verifiedRaw, dedupRaw) {
  const A = normalizeArgs(args)
  const prior = (A.priorGlossaryText && !A.fresh) ? parseGlossary(A.priorGlossaryText) : null
  A.prior = prior
  A.doNotMerge = (prior && prior.doNotMerge) || []
  const verified = normalizeVerified(verifiedRaw)
  const dedup = normalizeDedup(dedupRaw)
  const merged = prior ? mergeIntoPrior(prior, state.mergedThisBatch) : state.mergedThisBatch
  const allVerified = prior ? mergeVerified(prior.verified, verified) : verified
  const allDedup = prior ? { suspects: mergeDedup(prior.dedupSuspects, (dedup && dedup.suspects) || []) } : dedup
  const conflicts = prior ? glossaryConflicts(prior, verified) : []
  const weakDups = prior ? weakDupFlags(prior, state.mergedThisBatch) : []
  const networkUnverified = pickNetworkUnverified(verified)
  const glossary = renderGlossary(merged, allVerified, allDedup, A)
  const refineGlossary = renderRefineGlossary(merged, allVerified, allDedup, A)
  const dir = stateDir(A)
  const glossaryPath = writeText(path.join(A.outputDir, '校对表.md'), glossary)

  const refinePlan = []
  const refinePrompts = []
  A.files.forEach((f, index) => {
    const finding = state.findings[index] || {}
    const chunks = splitForRefine(f, A.chunkMode)
    const plan = {
      label: f.label,
      outPath: f.outPath,
      chunks,
      chunked: chunks.length > 1,
      partPaths: chunks.map((c) => partPath(f.outPath, c.idx)),
    }
    refinePlan.push(plan)
    if (chunks.length <= 1) {
      refinePrompts.push(promptEntry(A, 'refine', {
        label: f.label,
        schema: REFINE_REPORT_SCHEMA,
        path: writeText(path.join(dir, 'prompts', promptName('refine', refinePrompts.length, f.label)), refinePrompt(f, glossary, finding, A)),
      }))
    } else {
      chunks.forEach((chunk) => {
        refinePrompts.push(promptEntry(A, 'refine', {
          label: `${f.label}#${chunk.idx}/${chunk.count}`,
          schema: REFINE_REPORT_SCHEMA,
          chunk,
          partPath: partPath(f.outPath, chunk.idx),
          path: writeText(path.join(dir, 'prompts', promptName('refine', refinePrompts.length, `${f.label}-${chunk.idx}`)), refinePrompt(f, refineGlossary, finding, A, chunk)),
        }))
      })
    }
  })
  const stitchPrompts = refinePlan.filter((p) => p.chunked).map((p, index) => {
    const f = A.files.find((x) => x.label === p.label)
    return promptEntry(A, 'stitch', {
      label: `stitch:${p.label}`,
      path: writeText(path.join(dir, 'prompts', promptName('stitch', index, p.label)), stitchPrompt(f, p.chunks)),
      deterministic: true,
    })
  })

  const resultSeed = {
    outputDir: A.outputDir,
    glossaryPath,
    refined: [],
    failed: [],
    incomplete: [],
    unchecked: [],
    headingConflicts: state.headingConflicts || [],
    scoutSuspect: state.scoutSuspect || [],
    suspectedDuplicates: (dedup && dedup.suspects) || [],
    networkUnverified,
    logic: [],
    openQuestions: dedupQuestions(dedup).concat(conflicts).concat(weakDups).concat(state.overrideQuestions || []),
    summary: null,
    timeline: null,
  }

  const nextState = {
    ...state,
    verified,
    dedup,
    glossary,
    refineGlossary,
    glossaryPath,
    conflicts,
    weakDups,
    networkUnverified,
    refinePlan,
    refinePrompts,
    stitchPrompts,
    resultSeed,
  }
  const statePath = writeJson(path.join(dir, 'state-after-verify.json'), nextState)
  markStage(A, 'verify', 'end', { resolved: (verified?.resolved || []).length, unresolved: (verified?.unresolved || []).length, refinePrompts: refinePrompts.length })
  return { statePath, glossaryPath, refinePrompts, stitchPrompts }
}

export function afterRefine(args, state, refinedRaw) {
  const A = normalizeArgs(args)
  const dir = stateDir(A)
  const items = normalizeReportItems(refinedRaw)
  const refined = []
  const failed = []
  const openQuestions = [...(state.resultSeed?.openQuestions || [])]

  for (const plan of state.refinePlan || []) {
    const f = A.files.find((x) => x.label === plan.label)
    if (!f) continue
    if (plan.chunked) {
      const missing = (plan.partPaths || []).filter((p) => !fs.existsSync(p))
      if (missing.length) {
        failed.push(f.label)
        openQuestions.push(`分块精校未完成：${f.label} 缺少 ${missing.length}/${plan.partPaths.length} 个 part 文件，已停止拼接，避免静默漏段。`)
        continue
      }
      const texts = plan.partPaths.map((p) => fs.readFileSync(p, 'utf8'))
      writeText(f.outPath, stitchParts(texts))
      const reps = plan.partPaths.map((p, i) => reportFor(items, [p, `${f.label}#${i + 1}/${plan.partPaths.length}`])).filter(Boolean)
      refined.push({
        label: f.label,
        path: f.outPath,
        outPath: f.outPath,
        headings: reps.flatMap((r) => r.headings || []),
        key_fixes: reps.flatMap((r) => r.key_fixes || []),
        open_questions: reps.flatMap((r) => r.open_questions || []),
        chunked: plan.partPaths.length,
        complete: null,
        checkNote: '结尾核对待跑',
      })
    } else {
      const rep = reportFor(items, [f.label, f.outPath])
      if (!rep && !fs.existsSync(f.outPath)) {
        failed.push(f.label)
        continue
      }
      refined.push({
        label: f.label,
        ...(rep || {}),
        path: f.outPath,
        outPath: f.outPath,
        complete: null,
        checkNote: '结尾核对待跑',
      })
    }
  }

  const { sectionMapPath, sectionMap } = buildSectionMap(A, refined)
  const resultSeed = {
    ...(state.resultSeed || {}),
    refined,
    failed,
    unchecked: [],
    openQuestions,
  }
  const nextState = {
    ...state,
    refined,
    failed,
    checkPrompts: [],
    sectionMapPath,
    sectionMap,
    resultSeed,
  }
  const statePath = writeJson(path.join(dir, 'state-after-refine.json'), nextState)
  markStage(A, 'refine', 'end', { refined: refined.length, failed: failed.length, checkPrompts: 0 })
  return { statePath, refined, failed, checkPrompts: [], sectionMapPath }
}

export function deliverPrompts(args, state) {
  const A = normalizeArgs(args)
  const dir = stateDir(A)
  const refined = (state.refined || state.resultSeed?.refined || []).filter(Boolean)
  const prompts = []
  if (A.scope.includes('logic')) {
    A.files.forEach((f, index) => {
      const refinedFile = asRefinedPromptFile(f)
      prompts.push(promptEntry(A, 'logic-plan', {
        label: f.label,
        schema: LOGIC_PLAN_SCHEMA,
        path: writeText(path.join(dir, 'prompts', promptName('logic-plan', index, f.label)), logicPlanPrompt(refinedFile, A, state.sectionMapPath)),
      }))
    })
  }
  if (A.scope.includes('summary') && refined.length) {
    prompts.push(promptEntry(A, 'summary', {
      label: 'summary',
      path: writeText(path.join(dir, 'prompts', 'summary.txt'), summaryPrompt(A, refined, state.sectionMapPath)),
    }))
  }
  if (A.scope.includes('timeline') && refined.length) {
    prompts.push(promptEntry(A, 'timeline', {
      label: 'timeline',
      timeoutMs: A.timelineTimeoutMs || 180000,
      path: writeText(path.join(dir, 'prompts', 'timeline.txt'), timelinePrompt(A, state.glossary || '', refined, state.sectionMapPath)),
    }))
  }
  const manifestPath = writeJson(path.join(dir, 'deliver-prompt-manifest.json'), { prompts })
  markStage(A, 'deliver-prompts', 'end', { prompts: prompts.length })
  return { manifestPath, prompts }
}

export function afterLogicPlan(args, state, plansRaw) {
  const A = normalizeArgs(args)
  const dir = stateDir(A)
  const items = normalizeReportItems(plansRaw)
  const logicPlans = []
  const logicPlanAudit = []
  const logicWritePrompts = []
  const logicByLabel = new Map((state.resultSeed?.logic || []).filter((l) => l && l.label).map((l) => [l.label, l]))
  const openQuestions = [...(state.resultSeed?.openQuestions || [])]

  A.files.forEach((f, index) => {
    const plan = reportFor(items, [f.label, path.join(dir, 'logic-plans', `${safeName(f.title)}.json`)]) || {}
    const planPath = path.resolve(plan.path || path.join(dir, 'logic-plans', `${safeName(f.title)}.json`))
    writeJson(planPath, { ...plan, path: planPath })
    const headings = headingOrderForFile(state.sectionMap, f)
    const audit = auditLogicPlan(plan, headings)
    logicPlans.push({ label: f.label, path: planPath, plan })
    logicPlanAudit.push({ label: f.label, path: planPath, ...audit })
    if (audit.status === 'skip') {
      logicByLabel.set(f.label, { label: f.label, path: null, skipped: true, reason: plan.reason || '精校稿已天然按叙事顺序组织，无需另出逻辑顺序稿。', mainline: plan.mainline || '', threads: [], missingSections: [], open_questions: plan.open_questions || [] })
      openQuestions.push(`逻辑顺序稿未生成：${f.label} — ${plan.reason || '精校稿已天然按叙事顺序组织，无需另出逻辑顺序稿。'}`)
    } else if (audit.status === 'fail') {
      logicByLabel.set(f.label, { label: f.label, path: null, failedPlan: true, planPath, planIssues: audit.issues, mainline: plan.mainline || '', threads: [], missingSections: [], open_questions: plan.open_questions || [] })
      openQuestions.push(`逻辑重排方案未过审：${f.label} — ${audit.issues.join('；')}`)
    } else {
      const refinedFile = asRefinedPromptFile(f)
      logicWritePrompts.push(promptEntry(A, 'logic', {
        label: f.label,
        schema: LOGIC_REPORT_SCHEMA,
        planPath,
        path: writeText(path.join(dir, 'prompts', promptName('logic', index, f.label)), logicWritePrompt(refinedFile, A, [], planPath)),
      }))
    }
  })

  const resultSeed = {
    ...(state.resultSeed || {}),
    logic: A.files.map((f) => logicByLabel.get(f.label)).filter(Boolean),
    openQuestions,
  }
  const nextState = { ...state, logicPlans, logicPlanAudit, logicWritePrompts, resultSeed }
  const statePath = writeJson(path.join(dir, 'state-after-logic-plan.json'), nextState)
  const manifestPath = writeJson(path.join(dir, 'logic-write-manifest.json'), { prompts: logicWritePrompts, logicPlanAudit })
  markStage(A, 'logic-plan', 'end', { prompts: logicWritePrompts.length, failed: logicPlanAudit.filter((x) => x.status === 'fail').length, skipped: logicPlanAudit.filter((x) => x.status === 'skip').length })
  return { statePath, manifestPath, logicWritePrompts, logicPlanAudit }
}

function normalizeCheck(raw) {
  const items = normalizeReportItems(raw)
  return items.map((x) => ({ ...x, complete: x.complete === true, note: x.note || x.checkNote || '' }))
}

export function afterDeliver(args, state, { logicRaw = null, summaryRaw = null, timelineRaw = null, checksRaw = null } = {}) {
  const A = normalizeArgs(args)
  const logicItems = normalizeReportItems(logicRaw)
  const checkItems = checksRaw ? normalizeCheck(checksRaw) : []
  const refined = (state.refined || state.resultSeed?.refined || []).map((r) => {
    const f = A.files.find((x) => x.outPath === (r.outPath || r.path) || x.label === r.label)
    const chk = f ? reportFor(checkItems, [f.label, f.outPath]) : null
    if (!chk) return r
    return { ...r, complete: chk.complete, checkNote: chk.note || '' }
  })
  const logicByLabel = new Map((state.resultSeed?.logic || []).filter((l) => l && l.label).map((l) => [l.label, l]))
  A.files.forEach((f) => {
    const rep = reportFor(logicItems, [f.label, path.join(A.outputDir, '逻辑顺序', `${safeName(f.title)}.md`)])
    if (!rep) return
    const outPath = path.resolve(rep.path || path.join(A.outputDir, '逻辑顺序', `${safeName(f.title)}.md`))
    logicByLabel.set(f.label, {
      label: f.label,
      path: outPath,
      mainline: rep.mainline || '',
      threads: (rep.threads || []).map((t) => t && t.title ? t.title : t).filter(Boolean),
      sourceSections: (rep.threads || []).flatMap((t) => (t && t.source_sections) || []),
      missingSections: [],
      open_questions: rep.open_questions || [],
    })
  })
  const logic = A.files.map((f) => logicByLabel.get(f.label)).filter(Boolean)
  const summary = summaryRaw ? (typeof summaryRaw === 'string' ? { path: summaryRaw } : summaryRaw) : (state.resultSeed?.summary || null)
  const timeline = timelineRaw ? (typeof timelineRaw === 'string' ? { path: timelineRaw } : timelineRaw) : (state.resultSeed?.timeline || null)
  const result = {
    ...(state.resultSeed || {}),
    refined,
    failed: state.failed || state.resultSeed?.failed || [],
    incomplete: refined.filter((r) => r.complete === false).map((r) => ({ path: r.outPath || r.path, note: r.checkNote })),
    unchecked: refined.filter((r) => r.complete === null || r.complete === undefined).map((r) => r.outPath || r.path),
    logic,
    summary,
    timeline,
    openQuestions: (state.resultSeed?.openQuestions || []).concat(logic.flatMap((l) => l.open_questions || [])),
  }
  const resultPath = writeJson(path.join(stateDir(A), 'result.json'), result)
  markStage(A, 'deliver', 'end', { logic: logic.filter((l) => l.path).length, summary: !!summary, timeline: !!timeline })
  return { resultPath, result }
}

function refinedPathOf(entry) {
  return entry && (entry.outPath || entry.path || entry.refinedPath)
}

function glossaryTextForAudit(A) {
  const primary = path.join(A.outputDir, '校对表.md')
  const onePass = path.join(stateDir(A), 'one-pass-glossary.md')
  for (const p of [primary, onePass]) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8')
    } catch {
      // best effort
    }
  }
  return null
}

function logicPathOf(A, f, entry) {
  const p = entry && entry.path
  return path.resolve(p || path.join(A.outputDir, '逻辑顺序', `${safeName(f.title)}.md`))
}

function logicEntryFor(A, f, entries) {
  const defaultPath = path.resolve(path.join(A.outputDir, '逻辑顺序', `${safeName(f.title)}.md`))
  return entries.find((e) => e && (e.label === f.label || (e.path && path.resolve(e.path) === defaultPath))) || null
}

function auditLogicOutputs(A, result) {
  const entries = Array.isArray(result && result.logic) ? result.logic : []
  if (!A.scope.includes('logic') && !entries.length) return null
  const files = A.files
    .map((f) => {
      const refinedPath = path.resolve(f.outPath)
      const entry = logicEntryFor(A, f, entries)
      if (!entry || !entry.path) return null
      const logicPath = logicPathOf(A, f, entry)
      if (!fs.existsSync(refinedPath) || !fs.existsSync(logicPath)) return null
      return auditLogicFile(refinedPath, logicPath)
    })
    .filter(Boolean)
  if (!files.length) return null
  return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
}

export function auditNativeResult(args, result) {
  const A = normalizeArgs(args)
  const refined = Array.isArray(result && result.refined) ? result.refined : []
  const refinedByPath = new Map(refined.map((r) => {
    const p = refinedPathOf(r)
    return p ? [path.resolve(p), r] : null
  }).filter(Boolean))
  const pairs = A.files
    .map((f) => {
      const outPath = path.resolve(f.outPath)
      if (!refinedByPath.has(outPath) || !fs.existsSync(outPath)) return null
      return { sourcePath: f.path, refinedPath: outPath, mode: 'refine', glossaryText: glossaryTextForAudit(A) }
    })
    .filter(Boolean)
  const audit = pairs.length ? auditPairs(pairs) : null
  const auditFailed = audit
    ? audit.files.filter((f) => f.status === 'fail').map((f) => ({ path: f.file || f.refinedFile, findings: f.failed || [] }))
    : []
  const annotations = [...(result.annotations || [])]
  const anchors = [...(result.anchors || [])]
  const refinedNext = refined.map((r) => ({ ...r }))
  if (audit) {
    for (const file of audit.files || []) {
      const outPath = path.resolve(file.refinedFile || file.file || '')
      const rr = refinedNext.find((r) => path.resolve(refinedPathOf(r) || '') === outPath)
      if (rr) {
        rr.audit = {
          status: file.status,
          hardFindings: file.failed || [],
          softFindings: (file.findings || []).filter((f) => f.severity !== 'hard' && f.count).map((f) => f.name),
          repaired: false,
          anchorsAdded: 0,
          auditUnavailable: false,
        }
      }
      if (A.annotate !== false && (file.failed || []).includes('content_gap') && (file.gaps || []).length) {
        const a = annotateFile(outPath, file.gaps)
        if (a.inserted && a.inserted.length) annotations.push(a)
      }
    }
    if (A.anchors !== false) {
      for (const f of A.files) {
        if (!fs.existsSync(f.outPath)) continue
        const a = annotateAnchorsFile(f.path, f.outPath)
        if (a.updated && a.updated.length) {
          anchors.push(a)
          const rr = refinedNext.find((r) => path.resolve(refinedPathOf(r) || '') === path.resolve(f.outPath))
          if (rr && rr.audit) rr.audit.anchorsAdded = a.updated.length
        }
      }
    }
  }
  const glossaryText = glossaryTextForAudit(A)
  const glossaryLint = glossaryText ? auditGlossary(glossaryText) : null
  const logicAudit = auditLogicOutputs(A, result)
  const logicFailed = logicAudit
    ? logicAudit.files.filter((f) => f.status === 'fail').map((f) => ({ path: f.file || f.logicFile, findings: f.failed || [] }))
    : []
  const auditIncomplete = audit
    ? audit.files
      .filter((f) => (f.failed || []).includes('ending_missing'))
      .map((f) => ({ path: f.file || f.refinedFile, note: 'deterministic audit: ending_missing' }))
    : []
  const auditedPaths = new Set(audit ? (audit.files || []).map((f) => path.resolve(f.file || f.refinedFile || '')).filter(Boolean) : [])
  const unchecked = audit
    ? (result.unchecked || []).filter((p) => !auditedPaths.has(path.resolve(p.path || p)))
    : (result.unchecked || [])
  const incompleteByPath = new Map([...(result.incomplete || []), ...auditIncomplete].map((x) => [path.resolve(x.path || x), typeof x === 'string' ? { path: x } : x]))
  const audited = {
    ...result,
    refined: refinedNext,
    outputDir: A.outputDir,
    audit,
    auditFailed,
    incomplete: Array.from(incompleteByPath.values()),
    unchecked,
    glossaryLint,
    logicAudit,
    logicFailed,
    annotations,
    anchors,
  }
  const resultPath = writeJson(path.join(stateDir(A), 'result-audited.json'), audited)
  return { resultPath, audit, auditFailed, glossaryLint, logicAudit, logicFailed }
}

export function writeNativeArtifacts(args, result) {
  const A = normalizeArgs(args)
  const timing = readTiming(A)
  const startedAt = timing.startedAt || null
  const finishedAt = timing.finishedAt || nowIso()
  const t0 = startedAt ? Date.parse(startedAt) : NaN
  const t1 = finishedAt ? Date.parse(finishedAt) : NaN
  const durationMs = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : null
  const fullResult = { ...result, outputDir: A.outputDir }
  return writeRunArtifacts(fullResult, {
    A,
    outputDir: A.outputDir,
    provider: 'codex-subscription',
    providerInfo: { mode: 'native-subagents', apiKey: null, stages: timing.stages || {} },
    startedAt,
    finishedAt,
    durationMs,
    usage: null,
  })
}

async function main() {
  const { command, opts } = parseCli(process.argv.slice(2))
  if (!command || command === '--help' || command === '-h' || opts.help || opts.h) {
    console.log(usage())
    return
  }
  if (!opts.args) throw new Error('--args is required')
  const args = readJson(opts.args)
  let out
  if (command === 'prepare') {
    out = prepareNativeRun(args)
  } else if (command === 'after-scout') {
    if (!opts.findings) throw new Error('--findings is required')
    out = afterScout(args, readJson(opts.findings))
  } else if (command === 'after-verify') {
    if (!opts.state) throw new Error('--state is required')
    if (!opts.verified) throw new Error('--verified is required')
    out = afterVerify(args, readJson(opts.state), readJson(opts.verified), opts.dedup ? readJson(opts.dedup) : null)
  } else if (command === 'after-refine') {
    if (!opts.state) throw new Error('--state is required')
    if (!opts.refined) throw new Error('--refined is required')
    out = afterRefine(args, readJson(opts.state), readJson(opts.refined))
  } else if (command === 'deliver-prompts') {
    if (!opts.state) throw new Error('--state is required')
    out = deliverPrompts(args, readJson(opts.state))
  } else if (command === 'after-logic-plan') {
    if (!opts.state) throw new Error('--state is required')
    if (!opts.plans) throw new Error('--plans is required')
    out = afterLogicPlan(args, readJson(opts.state), readJson(opts.plans))
  } else if (command === 'after-deliver') {
    if (!opts.state) throw new Error('--state is required')
    out = afterDeliver(args, readJson(opts.state), {
      logicRaw: opts.logic ? readJson(opts.logic) : null,
      summaryRaw: opts.summary ? readJson(opts.summary) : null,
      timelineRaw: opts.timeline ? readJson(opts.timeline) : null,
      checksRaw: opts.checks ? readJson(opts.checks) : null,
    })
  } else if (command === 'audit') {
    if (!opts.result) throw new Error('--result is required')
    out = auditNativeResult(args, readJson(opts.result))
  } else if (command === 'artifacts') {
    if (!opts.result) throw new Error('--result is required')
    out = writeNativeArtifacts(args, readJson(opts.result))
  } else if (command === 'mark-stage') {
    if (!opts.stage) throw new Error('--stage is required')
    out = markStage(normalizeArgs(args), opts.stage, opts.status || 'end')
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
  console.log(JSON.stringify(out, null, 2))
}

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err && err.stack || err)
    process.exitCode = 1
  })
}
