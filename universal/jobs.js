// ===== Shared runtime layer =====
// Engine selection + file prep + a one-call runJob(), used by BOTH the CLI (cli.js) and
// the local web server (server.js) so provider quirks and docx-conversion live in one place.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import mammoth from 'mammoth'
import { resolveSkillDir } from './assets.js'
import { runPipeline } from '../core/pipeline.js'
import { SINGLE_FILE_GLOSSARY, partPath, MAX_REFINE_CHUNKS, contentLength, stitchParts } from '../core/spec.js'
import { auditPairs, annotateFile, annotateAnchorsFile, auditGlossary, checkCrossFileClaims, parseGlossaryLite } from '../scripts/audit_refined.mjs'
import { PROVIDERS, PROVIDER_NAMES, resolveKey, jurisdictionNote } from '../engines/providers.js'
import { makeApiEngine } from '../engines/api.js'
import { makeOpenAIEngine } from '../engines/openai.js'
import { makeRouterEngine, CATEGORY_KEYS } from '../engines/router.js'
import { writeRunArtifacts } from './artifacts.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SKILL_DIR = path.join(REPO_ROOT, 'claude-code-skill')

export class JobConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JobConfigError'
    this.code = 'CONFIG_ERROR'
  }
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
  const lines = content.split('\n').length
  const bytes = Buffer.byteLength(content, 'utf8')
  const chars = contentLength(content)   // 正文字数 (汉字 + 英文词/数字)；文档长度以此衡量，行数仅供 Read 分页
  const hasHeadings = HEADING_RE.test(content)
  const title = deriveTitle(src)
  const entry = {
    path: mdPath, label: title, title,
    subtitle: `*${topic}访谈${date ? ` · 采访时间 ${date}` : ''}*`,
    outPath: path.join(outputDir, 'Transcripts', `${title}.md`),
    lines, bytes, chars,
  }
  const headingWarning = hasHeadings && headingPolicy === 'none'
    ? `${path.basename(src)} 疑似已带小标题，而 headingPolicy=none——可用 headingPolicy=keep|regenerate 重跑该份`
    : null
  return { entry, hasHeadings, headingWarning }
}

const allTiers = (id) => ({ haiku: id, sonnet: id, opus: id, fable: id })

export function buildFilePolicy({ outputDir, skillDir = DEFAULT_SKILL_DIR, files = [] }) {
  const outDir = path.resolve(outputDir || process.cwd())
  return {
    readRoots: [outDir, path.resolve(skillDir)],
    writeRoots: [outDir],
    readPaths: files.map((f) => f && f.path).filter(Boolean),
    writePaths: files.map((f) => f && f.outPath).filter(Boolean),
  }
}

// Select the engine for a provider. apiKey (if given) overrides the env lookup — the web
// UI passes the key the user typed; the CLI passes nothing and falls back to env vars.
// modelOverride (if given) pins every tier to one model id (used by per-category routing).
export function selectEngine({ provider = 'anthropic', baseURL, concurrency, apiKey, modelOverride, filePolicy, env = process.env, onPhase, onLog }) {
  provider = String(provider).toLowerCase()
  if (provider === 'anthropic') {
    const key = apiKey || env.ANTHROPIC_API_KEY
    if (!key) throw new Error('未设 ANTHROPIC_API_KEY')
    return { provider, engine: makeApiEngine({ apiKey: key, concurrency, models: modelOverride ? allTiers(modelOverride) : undefined, filePolicy, onPhase, onLog }), info: { label: 'Anthropic', baseURL: 'default', keyVar: 'ANTHROPIC_API_KEY' } }
  }
  const cfg = PROVIDERS[provider]
  if (!cfg) throw new Error(`未知 provider「${provider}」。可选：anthropic, ${PROVIDER_NAMES.join(', ')}`)
  const found = resolveKey(provider, env)
  const key = apiKey || found.key
  if (!key) throw new Error(`未设 ${cfg.keyEnv.join(' / ')}（${cfg.label} 的 API key）`)
  const url = baseURL || cfg.baseURL
  return {
    provider,
    engine: makeOpenAIEngine({ apiKey: key, baseURL: url, models: modelOverride ? allTiers(modelOverride) : cfg.models, maxTokensParam: cfg.maxTokensParam, forceStructured: cfg.forceStructured, nativeSearch: cfg.nativeSearch, concurrency, filePolicy, onPhase, onLog }),
    info: { label: cfg.label, baseURL: url, keyVar: apiKey ? cfg.keyEnv[0] : found.varName, note: cfg.note },
  }
}

// Build a router engine from a per-category config (web UI's "按类别混合"). Sub-engines with
// identical (provider, key, baseURL, model) are shared so they also share one concurrency limit.
// categories: { mechanical:{provider,apiKey,baseURL,modelOverride}, web:{...,tavilyKey}, correction:{...}, smart:{...} }
export function buildRouterEngine({ categories, concurrency, filePolicy, env = process.env, onPhase, onLog }) {
  const cache = new Map()
  const sig = (c) => [c.provider, c.apiKey || '', c.baseURL || '', c.modelOverride || ''].join('')
  const engines = {}
  for (const key of CATEGORY_KEYS) {
    const c = categories && categories[key]
    if (!c || !c.provider) throw new Error(`类别「${key}」未配置 provider/key`)
    const s = sig(c)
    if (!cache.has(s)) cache.set(s, selectEngine({ provider: c.provider, apiKey: c.apiKey, baseURL: c.baseURL, modelOverride: c.modelOverride, concurrency, filePolicy, env, onLog }).engine)
    engines[key] = cache.get(s)
  }
  return makeRouterEngine({ engines, onPhase, onLog })
}

// Remove the <outPath>.partN intermediate files left by chunked refine (the stitch agent merged them
// into outPath). Deterministic by index — no globbing. Safe to call when no chunking happened.
export function cleanupRefineParts(fileEntries) {
  for (const f of fileEntries || []) {
    if (!f || !f.outPath) continue
    for (let i = 1; i <= MAX_REFINE_CHUNKS; i += 1) {
      try { fs.rmSync(partPath(f.outPath, i), { force: true }) } catch { /* ignore */ }
    }
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

// Persist the returned glossary (pure-JS output; no agent writes it). Cumulative across runs.
export function persistGlossary(result, glossaryPath) {
  if (result.glossary && result.glossary !== SINGLE_FILE_GLOSSARY) {
    fs.mkdirSync(path.dirname(glossaryPath), { recursive: true })
    fs.writeFileSync(glossaryPath, result.glossary, 'utf8')
    return true
  }
  return false
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
    provider = 'anthropic', apiKey, baseURL, tavilyKey,
    files = [], topic = 'untitled', date = '', background = '',
    scope = ['refine'], verifyDepth = 'key', headingPolicy = 'none',
    models, outputDir, fresh = false, concurrency,
    skillDir, refineMode, effort,
  } = params
  if (!files.length) throw new JobConfigError('未提供任何文件')
  const outDir = path.resolve(outputDir && String(outputDir).trim() ? outputDir : `${process.env.HOME}/Downloads/${topic}`)
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
    const { entry, headingWarning } = prepared
    if (headingWarning) warnings.push(headingWarning)
    if (headingWarning) notice(`提示：${headingWarning}`)
    fileEntries.push(entry)
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

  // 3. engine. Three modes: an injected engine (tests), per-category routing (web UI's
  //    "按类别混合"), or a single provider. The web-search backend (Tavily) is set for the
  //    run from the web category's key (or the top-level tavilyKey).
  const categories = params.categories
  const filePolicy = buildFilePolicy({ outputDir: outDir, skillDir: resolvedSkillDir, files: fileEntries })
  const webTavily = (categories && categories.web && categories.web.tavilyKey) || tavilyKey
  const prevTavily = process.env.TAVILY_API_KEY
  if (webTavily) process.env.TAVILY_API_KEY = webTavily
  let sel
  if (params.__engine) sel = { provider: 'injected', engine: params.__engine, info: { label: 'injected' } }
  else if (categories) {
    try {
      sel = { provider: 'router', engine: buildRouterEngine({ categories, concurrency, filePolicy, onPhase, onLog }), info: { label: '按类别混合', categories: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, { provider: categories[k] && categories[k].provider, model: (categories[k] && categories[k].modelOverride) || '默认' }])) } }
    } catch (e) {
      throw new JobConfigError(e.message)
    }
  } else {
    try {
      sel = selectEngine({ provider, baseURL, concurrency, apiKey, filePolicy, onPhase, onLog })
    } catch (e) {
      throw new JobConfigError(e.message)
    }
  }
  if (sel.provider !== 'anthropic' && sel.provider !== 'injected' && sel.provider !== 'router') {
    notice(`provider=${sel.provider}（${sel.info.label}）· baseURL=${sel.info.baseURL} · key=${sel.info.keyVar}`)
    if (sel.info.note) notice(`注意：${sel.info.note}`)
    const jn = jurisdictionNote(sel.provider)
    if (jn) notice(`⚠ ${jn}`)
    if (!process.env.TAVILY_API_KEY && (scope.includes('timeline') || verifyDepth !== 'none')) {
      notice('提示：未设 TAVILY_API_KEY——非 anthropic provider 的联网核实/时间线将降级（refine 不受影响）。')
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
  // gap); annotateAnchors writes the invisible source anchors. We deliberately do NOT inject `repair` — the
  // headless API path keeps today's behaviour (mark the gap, let the user decide), never auto-rewriting a 成稿.
  const auditFilesAcc = []   // auditPair file-results, in first-seen order (→ result.audit.files)
  const annotations = []     // [{ path, inserted, skipped }]  (→ result.annotations)
  const anchors = []         // [{ path, updated, skipped }]   (→ result.anchors)
  const glossaryTextFor = () => (fs.existsSync(glossaryPath) ? fs.readFileSync(glossaryPath, 'utf8') : null)
  const capabilities = {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    // M11a single-shot refine writes the model's response text straight to the 成稿 (no Write-tool agent). Only
    // the single-shot path uses this; the agentic path still writes via the model's Write tool. mkdir -p first
    // so a first-run Transcripts/ dir exists, then the downstream audit reads it back from disk unchanged.
    writeFile: (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') },
    // Risk (a): the pipeline hands us THIS round's in-memory 校对表 (opts.glossaryText) — use it for the
    // ghost_name / missing_yin checks, because on a first run the file isn't persisted until after the pipeline
    // returns, so reading it from disk would miss it. Fall back to the on-disk copy only when nothing was passed.
    runAudit: (f, opts = {}) => {
      const glossaryText = opts.glossaryText != null ? opts.glossaryText : glossaryTextFor()
      const res = auditPairs([{ sourcePath: f.path, refinedPath: f.outPath, mode: 'refine', glossaryText }])
      const file = res.files[0]
      auditFilesAcc.push(file)
      return file
    },
    annotate: (f, gaps) => {
      if (params.annotate === false) return { inserted: [], skipped: [] }
      const a = annotateFile(f.outPath, gaps)
      if (a.inserted.length) annotations.push(a)
      return a
    },
    annotateAnchors: (f) => {
      if (params.anchors === false) return { updated: [], skipped: [] }
      const a = annotateAnchorsFile(f.path, f.outPath)
      if (a.updated.length) anchors.push(a)
      return a
    },
    // Deletion #2 (provider side): with fs, the chunk part-files are merged deterministically by the pure
    // stitchParts() (one blank line between parts, exact-dup seam heading collapsed) — no stitch subagent, so
    // no per-response output cap and no paraphrase risk on a long transcript. The Workflow sandbox (no fs) has
    // no such capability and falls back to the concatenation agent. Reads <outPath>.part{idx} in chunk order,
    // writes f.outPath, and drops the consumed parts (cleanupRefineParts also sweeps them post-run — idempotent).
    // Returns a truthy summary; the pipeline consumer only distinguishes truthy (merged) from null (failed).
    stitch: (f, chunks) => {
      const parts = (chunks || []).map((c) => partPath(f.outPath, c.idx))
      const texts = parts.map((p) => fs.readFileSync(p, 'utf8'))
      const merged = stitchParts(texts)
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, merged, 'utf8')
      for (const p of parts) { try { fs.rmSync(p, { force: true }) } catch { /* ignore */ } }
      return { path: f.outPath, merged: parts.length, bytes: Buffer.byteLength(merged, 'utf8') }
    },
  }

  const A = {
    topic, date, background, outputDir: outDir,
    skillDir: resolvedSkillDir,
    scope, verifyDepth, headingPolicy, models, chunkMode: params.chunkMode,
    refineMode: refineMode === 'single-shot' ? 'single-shot' : undefined,   // M11a: default agentic (byte-equivalent)
    effort,   // M12: { refine?, logic?, summary?, timeline? } reasoning-effort per smart-tier category
    captureSingleShot: params.captureSingleShot,   // M11b: batch-submit hook — capture single-shot payloads instead of sending (see scripts/batch_refine.mjs)
    priorGlossaryText, priorGlossaryPath: (!fresh && fs.existsSync(glossaryPath)) ? glossaryPath : undefined,
    canonicalOverrides: params.canonicalOverrides,
    capabilities,
    fresh, annotate: params.annotate, files: fileEntries,
  }

  try {
    const r = await runPipeline(A, sel.engine)
    cleanupRefineParts(fileEntries) // tidy <outPath>.partN intermediates from chunked refine
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
    const finishedMs = Date.now()
    const finishedAt = new Date(finishedMs).toISOString()
    const durationMs = finishedMs - startedMs
    const result = { ...r, audit, glossaryLint, crossFileConflicts, annotations, anchors, outputDir: outDir, glossaryPath: wroteGlossary ? glossaryPath : null, priorGlossaryPath: priorGlossaryText ? glossaryPath : null, provider: sel.provider, providerInfo: sel.info, warnings, usage: sel.engine.usage(), startedAt, finishedAt, durationMs }
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
    })
    return { ...result, ...artifacts }
  } finally {
    if (webTavily) { if (prevTavily === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = prevTavily }
  }
}

export { PROVIDERS, PROVIDER_NAMES }
