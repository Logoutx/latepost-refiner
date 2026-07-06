#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scoutPrompt,
  verifyPrompt,
  refinePrompt,
  checkPrompt,
  dedupPrompt,
  singlePassPrompt,
  summaryPrompt,
  timelinePrompt,
  logicWritePrompt,
} from '../core/prompts.js'
import {
  DEDUP_SCHEMA,
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
  renderGlossary,
  scoutLooksGarbled,
  verifyChunks,
  weakDupFlags,
} from '../core/spec.js'
import { writeRunArtifacts } from '../universal/artifacts.js'
import { auditGlossary, auditPairs } from './audit_refined.mjs'

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')

function usage() {
  return `Usage:
  node "<this skill dir>/scripts/codex-native.mjs" prepare --args run-args.json
  node "<this skill dir>/scripts/codex-native.mjs" after-scout --args <out>/_codex-native/args.json --findings findings.json
  node "<this skill dir>/scripts/codex-native.mjs" after-verify --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-scout.json --verified verified.json [--dedup dedup.json]
  node "<this skill dir>/scripts/codex-native.mjs" deliver-prompts --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-verify.json
  node "<this skill dir>/scripts/codex-native.mjs" audit --args <out>/_codex-native/args.json --result result.json
  node "<this skill dir>/scripts/codex-native.mjs" artifacts --args <out>/_codex-native/args.json --result result.json

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

  const files = Array.isArray(A.files) ? A.files : []
  if (!files.length) throw new Error('args.files must contain at least one source file')
  A.files = files.map((entry, index) => {
    const f = typeof entry === 'string' ? { path: entry } : { ...entry }
    if (!f.path) throw new Error(`args.files[${index}].path is required`)
    f.path = path.resolve(f.path)
    f.label = f.label || titleFromPath(f.path) || `file-${index + 1}`
    f.lines = Number.isFinite(Number(f.lines)) && Number(f.lines) > 0 ? Number(f.lines) : lineCount(f.path)
    f.bytes = Number.isFinite(Number(f.bytes)) && Number(f.bytes) > 0 ? Number(f.bytes) : byteCount(f.path)
    f.chars = Number.isFinite(Number(f.chars)) && Number(f.chars) > 0 ? Number(f.chars) : contentChars(f.path)
    f.title = f.title || titleFromPath(f.path) || f.label
    f.subtitle = f.subtitle || defaultSubtitle(A)
    f.outPath = f.outPath ? path.resolve(f.outPath) : path.join(A.outputDir, 'Transcripts', `${f.title}.md`)
    return f
  })

  const priorPath = path.join(A.outputDir, '校对表.md')
  if (!A.fresh && !A.priorGlossaryText && fs.existsSync(priorPath)) {
    A.priorGlossaryText = fs.readFileSync(priorPath, 'utf8')
  }
  return A
}

export function prepareNativeRun(args) {
  const A = normalizeArgs(args)
  const dir = stateDir(A)
  fs.mkdirSync(path.join(A.outputDir, 'Transcripts'), { recursive: true })
  if (A.scope.includes('logic')) fs.mkdirSync(path.join(A.outputDir, '逻辑顺序'), { recursive: true })

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
    prompts.push({
      stage: 'single-pass',
      label: f.label,
      schema: REFINE_REPORT_SCHEMA,
      path: writeText(path.join(dir, 'prompts', promptName('single-pass', 0, f.label)), singlePassPrompt(f, A, overrideNote)),
    })
  } else {
    A.files.forEach((f, index) => {
      prompts.push({
        stage: 'scout',
        label: f.label,
        schema: SCOUT_SCHEMA,
        path: writeText(path.join(dir, 'prompts', promptName('scout', index, f.label)), scoutPrompt(f, A)),
      })
    })
  }

  const manifestPath = writeJson(path.join(dir, 'prompt-manifest.json'), { argsPath: normalizedArgsPath, prompts })
  return { argsPath: normalizedArgsPath, promptManifestPath: manifestPath, prompts }
}

function normalizeFindings(raw, files) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw.findings) ? raw.findings : raw
  if (Array.isArray(source)) return files.map((_, index) => source[index] || null)
  if (source && typeof source === 'object') {
    return files.map((f) => source[f.label] || source[f.title] || source[f.path] || null)
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

  const verifyPrompts = vc.chunks.map((chunk, index) => ({
    stage: 'verify',
    label: `verify:${index + 1}/${vc.chunks.length}`,
    schema: VERIFY_SCHEMA,
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
    dedupPrompt: dedupPromptPath ? { stage: 'dedup', label: 'dedup:semantic', schema: DEDUP_SCHEMA, path: dedupPromptPath } : null,
  }
  const statePath = writeJson(path.join(dir, 'state-after-scout.json'), state)
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
  const dir = stateDir(A)
  const glossaryPath = writeText(path.join(A.outputDir, '校对表.md'), glossary)

  const refinePrompts = A.files.map((f, index) => {
    const finding = state.findings[index] || {}
    return {
      stage: 'refine',
      label: f.label,
      schema: REFINE_REPORT_SCHEMA,
      path: writeText(path.join(dir, 'prompts', promptName('refine', index, f.label)), refinePrompt(f, glossary, finding, A)),
    }
  })
  const checkPrompts = A.files.map((f, index) => {
    const finding = state.findings[index] || {}
    return {
      stage: 'check',
      label: f.label,
      path: writeText(path.join(dir, 'prompts', promptName('check', index, f.label)), checkPrompt(f, finding.ending_anchor || null)),
    }
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
    glossaryPath,
    conflicts,
    weakDups,
    networkUnverified,
    refinePrompts,
    checkPrompts,
    resultSeed,
  }
  const statePath = writeJson(path.join(dir, 'state-after-verify.json'), nextState)
  return { statePath, glossaryPath, refinePrompts, checkPrompts }
}

export function deliverPrompts(args, state) {
  const A = normalizeArgs(args)
  const dir = stateDir(A)
  const refined = (state.refined || state.resultSeed?.refined || []).filter(Boolean)
  const prompts = []
  if (A.scope.includes('logic')) {
    A.files.forEach((f, index) => {
      prompts.push({
        stage: 'logic',
        label: f.label,
        path: writeText(path.join(dir, 'prompts', promptName('logic', index, f.label)), logicWritePrompt(f, A)),
      })
    })
  }
  if (A.scope.includes('summary') && refined.length) {
    prompts.push({
      stage: 'summary',
      label: 'summary',
      path: writeText(path.join(dir, 'prompts', 'summary.txt'), summaryPrompt(A, refined)),
    })
  }
  if (A.scope.includes('timeline') && refined.length) {
    prompts.push({
      stage: 'timeline',
      label: 'timeline',
      path: writeText(path.join(dir, 'prompts', 'timeline.txt'), timelinePrompt(A, state.glossary || '', refined)),
    })
  }
  const manifestPath = writeJson(path.join(dir, 'deliver-prompt-manifest.json'), { prompts })
  return { manifestPath, prompts }
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
  const glossaryText = glossaryTextForAudit(A)
  const glossaryLint = glossaryText ? auditGlossary(glossaryText) : null
  const audited = {
    ...result,
    outputDir: A.outputDir,
    audit,
    auditFailed,
    glossaryLint,
  }
  const resultPath = writeJson(path.join(stateDir(A), 'result-audited.json'), audited)
  return { resultPath, audit, auditFailed, glossaryLint }
}

export function writeNativeArtifacts(args, result) {
  const A = normalizeArgs(args)
  const fullResult = { ...result, outputDir: A.outputDir }
  return writeRunArtifacts(fullResult, {
    A,
    outputDir: A.outputDir,
    provider: 'codex-subscription',
    providerInfo: { mode: 'native-subagents', apiKey: null },
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
  } else if (command === 'deliver-prompts') {
    if (!opts.state) throw new Error('--state is required')
    out = deliverPrompts(args, readJson(opts.state))
  } else if (command === 'audit') {
    if (!opts.result) throw new Error('--result is required')
    out = auditNativeResult(args, readJson(opts.result))
  } else if (command === 'artifacts') {
    if (!opts.result) throw new Error('--result is required')
    out = writeNativeArtifacts(args, readJson(opts.result))
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
