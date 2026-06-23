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
import { RULES, SINGLE_FILE_GLOSSARY } from '../core/spec.js'
import { auditPairs } from '../scripts/audit_refined.mjs'
import { PROVIDERS, PROVIDER_NAMES, resolveKey } from '../engines/providers.js'
import { makeApiEngine } from '../engines/api.js'
import { makeOpenAIEngine } from '../engines/openai.js'
import { makeRouterEngine, CATEGORY_KEYS } from '../engines/router.js'
import { writeRunArtifacts } from './artifacts.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SKILL_DIR = path.join(REPO_ROOT, 'claude-code-skill')

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
  const hasHeadings = HEADING_RE.test(content)
  const title = deriveTitle(src)
  const entry = {
    path: mdPath, label: title, title,
    subtitle: `*${topic}访谈${date ? ` · 采访时间 ${date}` : ''}*`,
    outPath: path.join(outputDir, 'Transcripts', `${title}.md`),
    lines, bytes,
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

// Persist the returned glossary (pure-JS output; no agent writes it). Cumulative across runs.
export function persistGlossary(result, glossaryPath) {
  if (result.glossary && result.glossary !== SINGLE_FILE_GLOSSARY) {
    fs.mkdirSync(path.dirname(glossaryPath), { recursive: true })
    fs.writeFileSync(glossaryPath, result.glossary, 'utf8')
    return true
  }
  return false
}

export const QUALITY_REPAIR_MAX_RETRIES = 2

function auditListForFiles(files = []) {
  return files
    .filter((f) => f && f.path && f.outPath && fs.existsSync(f.path) && fs.existsSync(f.outPath))
    .map((f) => ({ sourcePath: f.path, refinedPath: f.outPath, mode: 'refine' }))
}

function repairAction(failed = []) {
  if (failed.includes('compression_risk') || failed.includes('ending_missing')) return 'rerun_from_source'
  if (failed.includes('under_refined')) return 'full_cleanup'
  return 'targeted_repair'
}

function repairModel(A = {}, action) {
  const models = A.models || {}
  if (action === 'targeted_repair') return models.repair || models.refine || models.dedup || 'sonnet'
  return models.repair || models.refine || 'opus'
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
    hard,
    long_paragraphs: (auditFile.long_paragraphs || []).slice(0, 8),
  }, null, 2)
}

function qualityRepairPrompt(A, f, auditFile, attemptNo) {
  const action = repairAction(auditFile.failed || [])
  const actionGuide = action === 'rerun_from_source'
    ? '本次属于压缩/结尾缺失风险：不要试图从当前成稿补回丢失内容。重新从源文件完整精校，当前成稿最多只作标题/结构参考。'
    : action === 'full_cleanup'
      ? '本次属于欠精校风险：读取源文件与当前成稿，对整份成稿做一轮完整清噪和顺句，保持覆盖与对话体。'
      : '本次属于局部质量问题：优先修复 audit 标出的残留口癖、重复、乱码粘连或超长段；如需判断是否改义，再对照源文件。'
  return `你是访谈精校质量修复代理。目标不是总结，而是让既有精校稿通过质量审计，同时保留全部事实细节与对话体。

【第 ${attemptNo} 次修复】
【主题】${A.topic || 'untitled'}
【策略】${actionGuide}
【源文件】${f.path}（约 ${f.lines || '?'} 行）
【当前成稿】${f.outPath}
【输出】修复后仍写回 ${f.outPath}

【审计失败摘要】
${auditPromptSummary(auditFile)}

【必须遵守】
- 若 failed 包含 compression_risk 或 ending_missing：Read 源文件全文，重新完整精校；不要从压缩稿中“脑补恢复”。
- 若 failed 只是残留噪音 / phrase_repeats / broken_fragment_starts / asr_glue / long_paragraphs：可主要 Read 当前成稿，必要时 Read 源文件核对。
- 不要删掉事实、数字、时间、产品名、观点、举例和有信息量的表达。
- 保持发言人标签为纯文本，如“记者：”“王某：”。
- 单个对话段超过约 900 字必须重切；长独白拆成 200-600 字左右的连贯段落。
- 修复“因为因为 / 本身本身 / 涂鸦涂鸦 / 2021 年，2021 年 / 20182018 / SaaSAPP”等明显 ASR 残留。

${RULES}

完成后只返回一行：已写回 <path>；修复策略=<rerun_from_source|full_cleanup|targeted_repair>；备注=<一句话>。`
}

export async function auditAndRepairRefined({ A, result, engine, maxRetries = QUALITY_REPAIR_MAX_RETRIES, onLog } = {}) {
  const files = A.files || []
  const attempts = []
  let audit = null
  const log = (msg) => {
    if (onLog) onLog(msg)
    else if (engine && typeof engine.log === 'function') engine.log(msg)
  }

  for (let round = 0; round <= maxRetries; round += 1) {
    const pairs = auditListForFiles(files)
    audit = pairs.length ? auditPairs(pairs) : null
    if (!audit) break
    const failed = (audit.files || []).filter((f) => f.status === 'fail')
    if (!failed.length) break
    if (round >= maxRetries) {
      log(`质量审计仍未通过：${failed.map((f) => `${path.basename(f.file)}(${(f.failed || []).join('/')})`).join('、')}`)
      break
    }

    if (engine && typeof engine.phase === 'function') engine.phase(`Repair ${round + 1}`)
    log(`质量修复第 ${round + 1}/${maxRetries} 轮：${failed.length} 份需修复`)
    const tasks = failed.map((auditFile) => async () => {
      const file = files.find((f) => path.resolve(f.outPath) === path.resolve(auditFile.file))
      if (!file) return null
      const action = repairAction(auditFile.failed || [])
      const model = repairModel(A, action)
      const label = `repair:${file.label || path.basename(file.outPath)}`
      const before = [...(auditFile.failed || [])]
      try {
        const response = await engine.agent(qualityRepairPrompt(A, file, auditFile, round + 1), { label, phase: 'Repair', model })
        const ok = !!response && fs.existsSync(file.outPath)
        return { file: file.outPath, attempt: round + 1, action, model, failedBefore: before, ok, response: typeof response === 'string' ? response.slice(0, 500) : response }
      } catch (e) {
        return { file: file.outPath, attempt: round + 1, action, model, failedBefore: before, ok: false, error: e.message || String(e) }
      }
    })
    const repaired = engine && typeof engine.parallel === 'function'
      ? await engine.parallel(tasks)
      : await Promise.all(tasks.map((t) => t()))
    attempts.push(...repaired.filter(Boolean))
  }

  result.audit = audit
  result.qualityRepair = { maxRetries, attempts }
  return { audit, attempts }
}

// One-call run used by the web server. `files` are uploads: [{ name, base64 }] (raw bytes,
// any type — docx/pdf converted via markitdown). onPhase/onLog stream progress.
export async function runJob(params, { onPhase, onLog } = {}) {
  const startedMs = Date.now()
  const startedAt = new Date(startedMs).toISOString()
  const {
    provider = 'anthropic', apiKey, baseURL, tavilyKey,
    files = [], topic = 'untitled', date = '', background = '',
    scope = ['refine'], verifyDepth = 'key', headingPolicy = 'none',
    models, outputDir, fresh = false, concurrency,
    skillDir,
  } = params
  if (!files.length) throw new Error('未提供任何文件')
  const outDir = path.resolve(outputDir && String(outputDir).trim() ? outputDir : `${process.env.HOME}/Downloads/${topic}`)
  const workDir = path.join(outDir, '.uploads')
  fs.mkdirSync(workDir, { recursive: true })

  // 1. materialize uploads to disk, then prepare each
  const fileEntries = []
  const warnings = []
  for (const f of files) {
    if (!f || !f.name) continue
    const src = path.join(workDir, path.basename(f.name))
    fs.writeFileSync(src, Buffer.from(f.base64 || '', 'base64'))
    const { entry, headingWarning } = await prepareFile(src, { topic, date, headingPolicy, outputDir: outDir, workDir })
    if (headingWarning) warnings.push(headingWarning)
    fileEntries.push(entry)
  }

  // 2. prior glossary (persistent per-company校对表)
  const glossaryPath = path.join(outDir, '校对表.md')
  let priorGlossaryText
  if (!fresh && fs.existsSync(glossaryPath)) priorGlossaryText = fs.readFileSync(glossaryPath, 'utf8')

  // 3. engine. Three modes: an injected engine (tests), per-category routing (web UI's
  //    "按类别混合"), or a single provider. The web-search backend (Tavily) is set for the
  //    run from the web category's key (or the top-level tavilyKey).
  const categories = params.categories
  const resolvedSkillDir = skillDir ? path.resolve(skillDir) : resolveSkillDir()
  const filePolicy = buildFilePolicy({ outputDir: outDir, skillDir: resolvedSkillDir, files: fileEntries })
  const webTavily = (categories && categories.web && categories.web.tavilyKey) || tavilyKey
  const prevTavily = process.env.TAVILY_API_KEY
  if (webTavily) process.env.TAVILY_API_KEY = webTavily
  let sel
  if (params.__engine) sel = { provider: 'injected', engine: params.__engine, info: { label: 'injected' } }
  else if (categories) sel = { provider: 'router', engine: buildRouterEngine({ categories, concurrency, filePolicy, onPhase, onLog }), info: { label: '按类别混合', categories: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, { provider: categories[k] && categories[k].provider, model: (categories[k] && categories[k].modelOverride) || '默认' }])) } }
  else sel = selectEngine({ provider, baseURL, concurrency, apiKey, filePolicy, onPhase, onLog })

  const A = {
    topic, date, background, outputDir: outDir,
    skillDir: resolvedSkillDir,
    scope, verifyDepth, headingPolicy, models, priorGlossaryText, fresh, files: fileEntries,
  }

  try {
    const r = await runPipeline(A, sel.engine)
    const wroteGlossary = !r.error && persistGlossary(r, glossaryPath)
    const result = { ...r, outputDir: outDir, glossaryPath: wroteGlossary ? glossaryPath : null, provider: sel.provider, providerInfo: sel.info, warnings, usage: null }
    if (!r.error) await auditAndRepairRefined({ A, result, engine: sel.engine, onLog })
    const finishedMs = Date.now()
    result.usage = sel.engine.usage()
    const artifacts = writeRunArtifacts(result, {
      A,
      outputDir: outDir,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
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
