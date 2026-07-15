#!/usr/bin/env node
// ===== Level 2: end-to-end verify replay =====
// Runs the REAL pipeline's verify slice with a chosen search adapter injected, and writes the resulting
// 校对表 (glossary, with 〔核实·date〕 markers) so runs under different backends can be diffed later.
//
//   node bench/search-api/run-verify-replay.mjs \
//     --source <transcript> --background-file <bg.md> --provider tavily --k 5 --verify-depth key --out <dir>
//
// What it runs (documented, because scout+verify are not exported in isolation): the real
// core/pipeline.js runPipeline with scope=['verify']. That runs Scout (entity extraction) + Verify
// (web-lookup against the injected adapter, via engines/deepseek.js searchFn) + glossary render, and
// SKIPS refine and every deliverable (scope excludes them — see pipeline.js: refine is gated on scope).
// File prep reuses universal/jobs.js prepareFile + buildFilePolicy, identical to the product path.
//
// Limitation: a single source under ONE_PASS_CHARS (4000 正文字数) takes the pipeline's one-pass branch,
// which skips scout+verify. So the replay requires a real transcript; a too-small source errors out
// rather than silently skipping verify. Thin by design (<150 lines of glue); the pipeline does the work.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareFile, buildFilePolicy } from '../../universal/jobs.js' // importing also loads .env (jobs.js side effect)
import { runPipeline } from '../../core/pipeline.js'
import { makeDeepSeekEngine } from '../../engines/deepseek.js'
import { ONE_PASS_CHARS } from '../../core/spec.js'
import { getAdapter, PROVIDERS, KEY_ENV, UNVERIFIED } from './adapters.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USAGE = 'usage: node bench/search-api/run-verify-replay.mjs --source <transcript> [--background-file <md>] --provider <name> [--k 5] [--verify-depth key|deep] --out <dir>'

function parseArgs(argv) {
  const a = { k: 5, verifyDepth: 'key', topic: 'verify-replay', date: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (t === '--source') a.source = argv[++i]
    else if (t === '--background-file') a.backgroundFile = argv[++i]
    else if (t === '--provider') a.provider = argv[++i]
    else if (t === '--k') a.k = Number(argv[++i])
    else if (t === '--verify-depth') a.verifyDepth = argv[++i]
    else if (t === '--topic') a.topic = argv[++i]
    else if (t === '--date') a.date = argv[++i]
    else if (t === '--out') a.out = argv[++i]
    else if (t === '--help' || t === '-h') a.help = true
  }
  return a
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.source || !args.provider || !args.out) { console.log(USAGE); process.exit(args.help ? 0 : 2) }
  if (!PROVIDERS.includes(args.provider)) { console.error(`未知 provider：${args.provider}（可选：${PROVIDERS.join(', ')}）`); process.exit(2) }
  if (!['key', 'deep'].includes(args.verifyDepth)) { console.error(`--verify-depth 需为 key 或 deep（none 无核实可复现）`); process.exit(2) }
  if (!Number.isFinite(args.k) || args.k <= 0) { console.error('--k 需为正整数'); process.exit(2) }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) { console.error('未设 DEEPSEEK_API_KEY（精校流水线只用 DeepSeek）'); process.exit(2) }
  const providerKey = process.env[KEY_ENV[args.provider]]
  if (!providerKey) console.error(`⚠ 未设 ${KEY_ENV[args.provider]}——${args.provider} 搜索会失败，核实将无结果（仍会跑完并产出校对表）。`)
  if (UNVERIFIED.has(args.provider)) console.error(`⚠ ${args.provider} 形状未证实（UNVERIFIED SHAPE）——首次实跑若无结果，先按真实响应校正 adapters.js。`)

  const outDir = path.resolve(args.out)
  const workDir = path.join(outDir, '.work')
  fs.mkdirSync(outDir, { recursive: true })

  // 1. prepare the source exactly as the product does (convert → count → entry)
  const { entry } = await prepareFile(path.resolve(args.source), {
    topic: args.topic, date: args.date, headingPolicy: 'none', outputDir: outDir, workDir,
  })
  if (entry.chars < ONE_PASS_CHARS) {
    console.error(`源文件仅 ${entry.chars} 字 < ${ONE_PASS_CHARS}（一遍过阈值）——单份短文件走一遍过精校、跳过 scout/verify，无法复现核实。请用真实访谈转录（正文 ≥ ${ONE_PASS_CHARS} 字）。`)
    process.exit(2)
  }

  const background = args.backgroundFile ? fs.readFileSync(path.resolve(args.backgroundFile), 'utf8') : ''

  // 2. engine with the chosen adapter injected as the web_search backend (web_fetch stays default)
  const filePolicy = buildFilePolicy({ outputDir: outDir, files: [entry] })
  const searchFn = getAdapter(args.provider)
  const log = (m) => process.stderr.write(`  ${m}\n`)
  const engine = makeDeepSeekEngine({
    apiKey, filePolicy, searchFn, searchK: args.k,
    onPhase: (t) => process.stderr.write(`\n▸ ${t}\n`), onLog: log,
  })

  // 3. real pipeline, verify slice only (scope has no refine/summary/timeline/logic)
  const A = {
    topic: args.topic, date: args.date, background,
    outputDir: outDir, skillDir: path.join(REPO_ROOT, 'claude-code-skill'),
    scope: ['verify'], verifyDepth: args.verifyDepth, headingPolicy: 'none',
    files: [entry], fresh: true,
  }
  process.stderr.write(`\n开始核实复现：source=${path.basename(args.source)}（${entry.chars} 字）· provider=${args.provider} · k=${args.k} · verify=${args.verifyDepth}\n`)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const r = await runPipeline(A, engine)
  const durationMs = Date.now() - t0
  if (r.error) { console.error(`pipeline 报错：${r.error}`); process.exit(1) }

  // 4. write the glossary (the diff artifact) + a metadata sidecar
  const glossaryFile = path.join(outDir, `校对表.${args.provider}.md`)
  fs.writeFileSync(glossaryFile, r.glossary || '', 'utf8')
  const meta = {
    provider: args.provider, unverifiedShape: UNVERIFIED.has(args.provider),
    source: path.resolve(args.source), sourceChars: entry.chars,
    k: args.k, verifyDepth: args.verifyDepth, startedAt, durationMs,
    glossaryFile,
    networkUnverified: r.networkUnverified || [],
    openQuestions: r.openQuestions || [],
    scoutSuspect: r.scoutSuspect || [], scoutFailed: r.scoutFailed || [],
    headingConflicts: r.headingConflicts || [],
    usage: engine.usage(),
  }
  const metaFile = path.join(outDir, `verify-replay.${args.provider}.json`)
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')

  process.stderr.write(`\n✓ 校对表：${glossaryFile}\n✓ 元信息：${metaFile}\n`)
}

main().catch((e) => { console.error(e); process.exit(1) })
