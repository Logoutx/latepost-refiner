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
import { SINGLE_FILE_GLOSSARY, partPath, MAX_REFINE_CHUNKS, contentLength } from '../core/spec.js'
import { auditPairs, annotateFile } from '../scripts/audit_refined.mjs'
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

// Persist the returned glossary (pure-JS output; no agent writes it). Cumulative across runs.
export function persistGlossary(result, glossaryPath) {
  if (result.glossary && result.glossary !== SINGLE_FILE_GLOSSARY) {
    fs.mkdirSync(path.dirname(glossaryPath), { recursive: true })
    fs.writeFileSync(glossaryPath, result.glossary, 'utf8')
    return true
  }
  return false
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
    scope, verifyDepth, headingPolicy, models, chunkMode: params.chunkMode, priorGlossaryText, fresh, files: fileEntries,
  }

  try {
    const r = await runPipeline(A, sel.engine)
    cleanupRefineParts(fileEntries) // tidy <outPath>.partN intermediates from chunked refine
    const wroteGlossary = !r.error && persistGlossary(r, glossaryPath)
    // source-aware quality audit: compare each refined transcript against its source (refine scope)
    const auditList = r.error ? [] : fileEntries.filter((f) => f.outPath && fs.existsSync(f.outPath)).map((f) => ({ sourcePath: f.path, refinedPath: f.outPath, mode: 'refine' }))
    const audit = auditList.length ? auditPairs(auditList) : null
    // Content-gap annotation: insert visible 内容缺口 markers into the 成稿 for HARD gaps (a substantial
    // source stretch the audit found missing with no fold trace — the silent-omission/censorship failure),
    // so readers of the document can SEE that something was dropped and where to find it in the source.
    // Default on; params.annotate === false disables. Idempotent (overlap-checked), so re-runs are safe.
    // Runs necessarily after deliverables (the pipeline sandbox has no fs) — review.md notes they predate markers.
    const annotations = []
    if (audit && params.annotate !== false) {
      audit.files.forEach((f, i) => {
        if ((f.gaps || []).some((g) => g.severity === 'hard')) {
          const a = annotateFile(auditList[i].refinedPath, f.gaps)
          if (a.inserted.length) annotations.push(a)
        }
      })
    }
    const finishedMs = Date.now()
    const result = { ...r, audit, annotations, outputDir: outDir, glossaryPath: wroteGlossary ? glossaryPath : null, provider: sel.provider, providerInfo: sel.info, warnings, usage: sel.engine.usage() }
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
