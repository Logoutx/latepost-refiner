#!/usr/bin/env node
// ===== Anthropic Batch refine (M11b) — submit / resume =====
// Archival bulk refine at the Batch tier (50% price; results typically < 1h). Two-phase because batching is
// out-of-band and resumable:
//
//   node scripts/batch_refine.mjs submit --files a.txt b.txt --topic X --out <dir> [--background ... --effort refine=medium]
//     → runs Scout / Verify / Glossary EXACTLY as a normal run (agentic, interactive, billed now), then instead
//       of sending the refine, builds ONE single-shot request per file (source inlined + the rendered 校对表),
//       POSTs them as a Message Batch, writes <out>/batch-state.json {batchId, files, glossary, params}, prints
//       the batch id, exits 0. Nobody waits — refine happens asynchronously on Anthropic's side.
//
//   node scripts/batch_refine.mjs resume --dir <out> [--max-wait-min 90 --poll-sec 30]
//     → reads batch-state.json, polls the batch until processing_status:'ended' (exponential backoff up to
//       --poll-sec, giving up after --max-wait-min), fetches the .jsonl results, writes each refined file, then
//       runs the FULL deterministic audit gates + source anchors + cross-file consistency + review.md/run.json —
//       exactly as a normal run's tail. A per-request error leaves that file UNREFINED and listed in review.md.
//
// DESIGN CHOICE (standalone script, not --batch-mode woven through runJob): runJob is single-return (build →
// pipeline → artifacts → return); batching is fundamentally two-invocation with a state file surviving process
// death and a wait of up to an hour. Threading --batch-mode through runJob would fork every phase (scout/verify
// run NOW, refine runs LATER) and split artifact-writing across two calls — invasive for v1. The brief grants
// this alternative. Submit REUSES runJob via its captureSingleShot hook (so scout/verify/glossary and the
// single-shot prompt construction are the pipeline's, verbatim); resume reuses the exported audit/artifact
// helpers. No duplicated pipeline logic.
//
// --dry-run submit runs scout/verify/glossary (which DO bill the即时 API — they build the校对表 that goes into
// each request) and then PRINTS the batch request payloads instead of POSTing them: it skips only the final
// batch submit + state write. So --dry-run still needs ANTHROPIC_API_KEY. (Tests make it fully offline by
// injecting a mock engine via the __engine option — that path needs no key.) BatchClient's fetcher is injectable,
// so every batch HTTP call is offline-testable.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runJob, computeCrossFileConflicts, loadDotEnv, JobConfigError,
} from '../universal/jobs.js'
import { auditPairs, annotateFile, annotateAnchorsFile } from './audit_refined.mjs'
import { writeRunArtifacts } from '../universal/artifacts.js'
import { BatchClient, resolveBaseURL } from '../engines/batch.js'
import { contentLength, SINGLE_SHOT_MAX_CHARS } from '../core/spec.js'

const STATE_FILE = 'batch-state.json'

// ---------- argv (same variadic --files convention as universal/cli.js) ----------
export function parseArgs(argv) {
  const out = { files: [] }
  const booleans = { '--dry-run': 'dryRun', '--fresh': 'fresh', '--no-anchors': 'noAnchors', '--no-annotate': 'noAnnotate', '--help': 'help', '-h': 'help' }
  const aliases = {
    '--out': 'outputDir', '--output-dir': 'outputDir', '--dir': 'dir',
    '--background-file': 'backgroundFile', '--base-url': 'baseURL',
    '--max-wait-min': 'maxWaitMin', '--poll-sec': 'pollSec', '--prior-glossary': 'priorGlossaryPath',
  }
  let i = 0
  while (i < argv.length) {
    const tok = argv[i]
    if (booleans[tok]) { out[booleans[tok]] = true; i++; continue }
    if (tok === '--files') { i++; while (i < argv.length && !argv[i].startsWith('--')) { out.files.push(argv[i]); i++ } continue }
    if (tok.startsWith('--')) { const key = aliases[tok] || tok.replace(/^--/, ''); out[key] = argv[i + 1]; i += 2; continue }
    i++
  }
  return out
}

const HELP = `batch_refine — Anthropic Batch 归档精校（50% 价格，结果通常 < 1 小时）

submit（现在跑侦察/核实/校对表，把 refine 投成批处理后退出）:
  node scripts/batch_refine.mjs submit --files <文件...> --topic <主题> --out <目录> [--background ... --date YYYY-MM --effort refine=medium --dry-run]

resume（读状态、轮询到结束、取回结果、写成稿并跑审计门禁）:
  node scripts/batch_refine.mjs resume --dir <目录> [--max-wait-min 90 --poll-sec 30]

说明：submit 生成 <out>/batch-state.json；--dry-run 仍跑侦察/核实（即时计费）、但只打印请求负载、不投批处理。`

// ---------- submit ----------
// Reuse runJob with captureSingleShot: the pipeline runs scout→verify→glossary, then for each file builds the
// single-shot payload and hands it to our collector INSTEAD of calling the API. We harvest those payloads, wrap
// them as batch requests (custom_id = file label), submit, and persist state. runJob still persists the glossary
// (desired — resume needs no glossary rebuild) and writes a submit-phase manifest (harmless).
export async function runSubmit(a, { env = process.env, clientFactory, __engine } = {}) {
  if (!a.files.length) throw new JobConfigError('submit 需要 --files')
  const topic = a.topic || 'untitled'
  const outputDir = path.resolve(a.outputDir && String(a.outputDir).trim() ? a.outputDir : `${env.HOME}/Downloads/${topic}`)
  let background = a.background || ''
  if (a.backgroundFile) background = fs.readFileSync(path.resolve(a.backgroundFile), 'utf8').trim()

  // Collector: label → { prompt, maxTokens, model, effort }. captureSingleShot is invoked once per file by the
  // pipeline's refineFileSingleShot (which also enforces the size gate and refuses oversize files upstream).
  const captured = new Map()
  const params = {
    files: a.files.map((p) => ({ path: path.resolve(p) })),
    topic, date: a.date || '', background, outputDir,
    scope: ['refine'], verifyDepth: a.verify || 'key', headingPolicy: a.headingPolicy || 'none',
    refineMode: 'single-shot',
    effort: parseEffort(a.effort),
    fresh: !!a.fresh,
    priorGlossaryPath: a.priorGlossaryPath ? path.resolve(a.priorGlossaryPath) : undefined,
    baseURL: a.baseURL,
    // The hook. It also captures the file's outPath so resume knows where to write without re-preparing.
    captureSingleShot: (f, payload) => { captured.set(f.label, { ...payload, outPath: f.outPath, path: f.path, title: f.title, subtitle: f.subtitle }) },
    __engine,   // tests inject a mock engine so scout/verify run offline (no API key). Production leaves it undefined.
  }

  const notices = []
  const r = await runJob(params, { onNotice: (m) => notices.push(m) })
  if (r.error) throw new Error(`submit 侦察/核实阶段失败：${r.error}`)

  // Files the pipeline REFUSED (oversize) never reach captureSingleShot — surface them and don't batch them.
  const refused = (r.refined || []).filter((x) => x && x.refused).map((x) => x.outPath)
  const requests = []
  for (const [label, p] of captured) requests.push({ custom_id: label, params: buildRequestParams(p) })
  if (!requests.length) throw new Error('submit 没有可投递的请求（所有文件都被拒绝或侦察失败）')

  if (a.dryRun) {
    process.stdout.write(JSON.stringify({ dryRun: true, outputDir, requestCount: requests.length, refused, requests }, null, 2) + '\n')
    return { dryRun: true, outputDir, requests, refused }
  }

  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) throw new JobConfigError('submit 需要 ANTHROPIC_API_KEY（--dry-run 除外）')
  const client = clientFactory ? clientFactory({ apiKey, baseURL: a.baseURL, env }) : new BatchClient({ apiKey, baseURL: a.baseURL, env })
  const batch = await client.submitBatch(requests)

  const state = {
    version: 1,
    batchId: batch.id,
    createdAt: new Date().toISOString(),
    outputDir,
    baseURL: resolveBaseURL(a.baseURL, env),
    topic, date: a.date || '', background,
    glossaryPath: path.join(outputDir, '校对表.md'),
    files: Array.from(captured, ([label, p]) => ({ label, sourcePath: p.path, outPath: p.outPath, title: p.title, subtitle: p.subtitle })),
    refused,
    params: { verify: a.verify || 'key', headingPolicy: a.headingPolicy || 'none', effort: parseEffort(a.effort) || null, anchors: a.noAnchors ? false : true, annotate: a.noAnnotate ? false : true },
  }
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8')

  process.stdout.write(`批处理已提交：batchId=${batch.id}\n状态文件：${path.join(outputDir, STATE_FILE)}\n投递 ${requests.length} 份${refused.length ? `（另有 ${refused.length} 份因超限未投递，见状态文件 refused）` : ''}\n结果通常 1 小时内就绪；就绪后运行：\n  node scripts/batch_refine.mjs resume --dir ${JSON.stringify(outputDir)}\n`)
  return { batchId: batch.id, outputDir, requestCount: requests.length, refused }
}

// ---------- resume ----------
// Poll → fetch → write each refined file → run the FULL audit gate (deterministic auditPairs), gap annotate,
// source anchors, cross-file consistency, and review.md/run.json. Reuses the exported jobs.js/audit helpers, so
// the resume tail is behaviourally the same quality gate a normal run applies. A per-request error leaves the
// file unrefined and recorded. sleeper/clientFactory are injectable so tests drive the whole flow offline.
export async function runResume(a, { env = process.env, clientFactory, sleeper } = {}) {
  const dir = path.resolve(a.dir || a.outputDir || '.')
  const statePath = path.join(dir, STATE_FILE)
  if (!fs.existsSync(statePath)) throw new JobConfigError(`找不到状态文件 ${statePath}（先跑 submit）`)
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const apiKey = env.ANTHROPIC_API_KEY
  const client = clientFactory ? clientFactory({ apiKey, baseURL: state.baseURL, env }) : new BatchClient({ apiKey, baseURL: state.baseURL, env })

  const maxWaitMs = Math.max(1, Number(a.maxWaitMin || 90)) * 60_000
  const basePollMs = Math.max(1, Number(a.pollSec || 30)) * 1000
  const sleep = sleeper || ((ms) => new Promise((res) => setTimeout(res, ms)))
  const startedMs = Date.now()

  // Poll with capped exponential backoff until ended or max-wait.
  let batch = await client.pollBatch(state.batchId)
  let delay = basePollMs
  while (batch.processing_status !== 'ended') {
    if (Date.now() - startedMs > maxWaitMs) throw new Error(`轮询超时（${a.maxWaitMin || 90} 分钟）——批处理仍为 ${batch.processing_status}；稍后可再次 resume（幂等）`)
    process.stderr.write(`  批处理 ${state.batchId} 状态 ${batch.processing_status}，${Math.round(delay / 1000)}s 后重试…\n`)
    await sleep(delay)
    delay = Math.min(delay * 2, basePollMs * 8)
    batch = await client.pollBatch(state.batchId)
  }
  if (!batch.results_url) throw new Error('批处理已结束但无 results_url')

  const { byCustomId } = await client.fetchResults(batch.results_url)

  // Write each refined file; collect per-file status.
  const written = []           // [{ label, outPath, sourcePath }]
  const errored = []           // [{ label, error }]
  for (const f of state.files || []) {
    const res = byCustomId.get(f.label)
    if (!res) { errored.push({ label: f.label, error: '结果缺失（批处理未返回该 custom_id）' }); continue }
    if (!res.ok) { errored.push({ label: f.label, error: res.error }); continue }
    if (!res.text || !res.text.trim()) { errored.push({ label: f.label, error: '返回空文本' }); continue }
    fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
    fs.writeFileSync(f.outPath, res.text, 'utf8')
    written.push({ label: f.label, outPath: f.outPath, sourcePath: f.sourcePath })
  }

  // Full deterministic audit on each written file (same gate as a normal run). glossaryText from the persisted
  // 校对表 feeds ghost_name / missing_yin checks; anchors + gap markers unless disabled in state.params.
  const glossaryText = state.glossaryPath && fs.existsSync(state.glossaryPath) ? fs.readFileSync(state.glossaryPath, 'utf8') : ''
  const auditFiles = []
  const auditFailed = []
  const incomplete = []
  const anchors = []
  const annotations = []
  for (const w of written) {
    const bundle = auditPairs([{ sourcePath: w.sourcePath, refinedPath: w.outPath, mode: 'refine', glossaryText }])
    const fr = bundle.files[0]
    if (fr) {
      auditFiles.push(fr)
      const hard = (fr.failed || []).filter((k) => k === 'content_gap' || k === 'quote_style')
      const endingMissing = (fr.failed || []).includes('ending_missing')
      if (hard.length) {
        if (state.params && state.params.annotate !== false) {
          const gaps = (fr.gaps || []).filter((g) => g.severity === 'hard')
          if (gaps.length) { const an = annotateFile(w.outPath, gaps); if (an.inserted && an.inserted.length) annotations.push(an) }
        }
        auditFailed.push({ path: w.outPath, findings: hard })
      }
      if (endingMissing) incomplete.push({ path: w.outPath, note: 'deterministic audit: ending_missing' })
    }
    if (!state.params || state.params.anchors !== false) {
      const an = annotateAnchorsFile(w.sourcePath, w.outPath)
      if (an.updated && an.updated.length) anchors.push(an)
    }
  }

  const refined = written.map((w) => ({ label: w.label, path: w.outPath, outPath: w.outPath }))
  const openQuestions = errored.map((e) => `批处理精校失败：「${e.label}」——${e.error}；本份未精校，可对该份改用普通（agentic）精校重跑`)
    .concat((state.refused || []).map((p) => `${path.basename(p)} 超过 single-shot 上限（${SINGLE_SHOT_MAX_CHARS} 字），submit 时已跳过——请对该份改用 agentic 精校`))
  const crossFileConflicts = computeCrossFileConflicts(refined, glossaryText)
  if (crossFileConflicts.length) openQuestions.push(`跨文件互证：${crossFileConflicts.length} 处同实体数值在不同文件里冲突——见 review.md「跨文件互证」`)

  const finishedAt = new Date().toISOString()
  const result = {
    refineMode: 'single-shot',
    batchId: state.batchId,
    glossary: glossaryText, glossaryPath: fs.existsSync(state.glossaryPath) ? state.glossaryPath : null,
    refined, failed: errored.map((e) => e.label),
    audit: auditFiles.length ? { status: auditFiles.some((f) => f.status === 'fail') ? 'fail' : 'ok', files: auditFiles } : null,
    auditFailed, incomplete, unchecked: [], annotations, anchors, crossFileConflicts,
    headingConflicts: [], scoutSuspect: [], scoutFailed: [], suspectedDuplicates: [], networkUnverified: [], logic: [],
    openQuestions, summary: null, timeline: null,
    outputDir: dir, batchErrored: errored, finishedAt,
  }
  const artifacts = writeRunArtifacts(result, { outputDir: dir, finishedAt, provider: 'anthropic-batch' })

  process.stdout.write(`批处理精校完成：${written.length} 份成稿${errored.length ? `，${errored.length} 份失败（见 review.md）` : ''}\n`)
  for (const w of written) process.stdout.write(`  ✓ ${w.outPath}\n`)
  for (const e of errored) process.stderr.write(`  ✗ ${e.label}：${e.error}\n`)
  if (auditFailed.length) process.stderr.write(`⚠ 审计门禁未过（自动修复未启用于批处理路径，请人工核对）：${auditFailed.map((x) => path.basename(x.path)).join('、')}\n`)
  process.stdout.write(`Review queue：${artifacts.reviewPath}\nRun manifest：${artifacts.manifestPath}\n`)
  return { ...result, ...artifacts }
}

// ---------- small helpers (kept local; mirror cli.js semantics) ----------
const EFFORT_CATS = new Set(['refine', 'logic', 'summary', 'timeline'])
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
export function parseEffort(s) {
  if (!s) return undefined
  const m = {}
  for (const pair of String(s).split(',')) { const [k, v] = pair.split('='); const key = k && k.trim(), val = v && v.trim(); if (EFFORT_CATS.has(key) && EFFORT_LEVELS.has(val)) m[key] = val }
  return Object.keys(m).length ? m : undefined
}
const MODEL_IDS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8', fable: 'claude-fable-5' }
export const resolveModelId = (m) => MODEL_IDS[m] || m || MODEL_IDS.opus
// Build one batch request's params from a captured single-shot payload. Mirrors engines/api.js completeOnce's
// request shape EXACTLY so a batch refine is quality-equivalent to an interactive single-shot refine: adaptive
// thinking for opus/sonnet/fable (composes with effort), output_config.effort only when set AND allowed (never
// haiku — it 400-errors), and NO stream/tools (batch requires MessageCreateParamsNonStreaming). Exported for tests.
const ALLOWED_TIER = /opus|sonnet|fable/
export function buildRequestParams(p) {
  const model = resolveModelId(p.model)
  const params = { model, max_tokens: p.maxTokens, messages: [{ role: 'user', content: p.prompt }] }
  if (ALLOWED_TIER.test(model)) params.thinking = { type: 'adaptive' }
  if (p.effort && ALLOWED_TIER.test(model)) params.output_config = { effort: p.effort }
  return params
}

// ---------- entry ----------
async function main() {
  loadDotEnv()
  const argv = process.argv.slice(2)
  const sub = argv[0]
  const a = parseArgs(argv.slice(1))
  if (a.help || !sub || sub === '--help' || sub === '-h') { process.stdout.write(HELP + '\n'); process.exit(sub ? 0 : 1) }
  try {
    if (sub === 'submit') { await runSubmit(a); process.exit(0) }
    else if (sub === 'resume') { await runResume(a); process.exit(0) }
    else { process.stderr.write(`未知子命令「${sub}」。用 submit 或 resume。\n`); process.exit(2) }
  } catch (e) {
    if (e && e.code === 'CONFIG_ERROR') { process.stderr.write('错误：' + e.message + '\n'); process.exit(2) }
    process.stderr.write('\n致命错误：' + (e.stack || e.message) + '\n'); process.exit(1)
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main()
