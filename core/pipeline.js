import { entitySchema, SCOUT_SCHEMA, SPEAKER_CANDIDATE_SCHEMA, VERIFY_SCHEMA, REFINE_REPORT_SCHEMA, DEDUP_SCHEMA, LOGIC_REPORT_SCHEMA, SINGLE_FILE_GLOSSARY, BODY_FIDELITY_GATES, OUTPUT_QUALITY_GATES, PUBLICATION_BLOCK_GATES, canonicalHeadingKey, effortFor, isWeakKey, stripDesc, longestHanziRun, scoutLooksGarbled, clusterEntities, mergeFindings, VERIFY_CHUNK, MAX_CHUNKS, entityWorth, verifyChunks, dedupListText, splitForRefine, splitForScout, mergeScoutChunks, refineSize, ONE_PASS_CHARS, SINGLE_SHOT_MAX_CHARS, singleShotMaxTokens, contentLength, findHeadingConflicts, renderGlossary, renderRefineGlossary, cleanSuspects, splitSuspects, pickNetworkUnverified, suspectUnverified, contestedQuestions, dedupQuestions, parseGlossary, mergeIntoPrior, mergeVerified, mergeDedup, excludeVerified, buildSpeakerRegistry, glossaryConflicts, weakDupFlags, applyOverridesToMerged, dropLocked, safeName, partPath, contradictionReopen, rotateReverify, ROTATE_REVERIFY } from './spec.js'
import { READ_PAGE, READ_BYTES_PER_PAGE, readPlan, headingNote, scoutPrompt, verifyPrompt, refinePrompt, stitchPrompt, dedupPrompt, speakerCandidatePrompt, singlePassPrompt, singleShotPrompt, summaryPrompt, summaryDeliverableName, timelinePrompt, timelineDeliverableName, logicWritePrompt } from './prompts.js'

export const DEFAULT_STAGE_MODELS = Object.freeze({
  scout: 'haiku', verify: 'sonnet', dedup: 'sonnet', refine: 'opus', repair: 'opus',
  stitch: 'haiku', logic: 'opus', summary: 'opus', timeline: 'opus',
})

export const QUALITY_REPAIR_MAX_ROUNDS = 2

// One shared publication contract: body-fidelity and output-quality groups stay separate for diagnostics, while
// their union drives repair, derivative withholding, exit status, and scorecards. Unknown findings stay review-tier.
export { BODY_FIDELITY_GATES, OUTPUT_QUALITY_GATES, PUBLICATION_BLOCK_GATES } from './spec.js'

function recordTurnContractFailure(A, f, error, phase) {
  if (!Array.isArray(A.turnContractFailures)) A.turnContractFailures = []
  const failure = {
    code: (error && error.code) || 'TURN_CONTRACT_INVALID',
    retryable: false,
    message: (error && error.message) || 'turn contract 校验失败',
    phase,
    label: (f && f.label) || null,
    path: (f && f.outPath) || null,
  }
  A.turnContractFailures.push(failure)
  return failure
}

function retryableAgentFailure(engine, label) {
  if (!engine || typeof engine.failures !== 'function') return false
  const failures = engine.failures()
  if (!Array.isArray(failures)) return false
  const failure = failures.findLast
    ? failures.findLast((entry) => entry && entry.label === label)
    : failures.slice().reverse().find((entry) => entry && entry.label === label)
  return !!(failure && failure.retryable === true)
}

// Refine one file. Cost mode (default), or a small file → one agent. Speed mode + a large file (> REFINE_CHUNK_CHARS
// 字) → parallel chunk agents writing <outPath>.part{idx}, merged deterministically. Speed mode has its own
// small cap; provider-budget and explicit-size chunking are intentionally uncapped.
// when the host injects fs capability, or by a cheap stitch agent in the Workflow sandbox. Returns a
// REFINE_REPORT-shaped object (path = f.outPath) or null if it
// could not produce an output. A failed chunk is surfaced via open_questions (and caught downstream by the
// source-aware audit) rather than silently dropped.
// M11a single-shot refine for ONE file: read the source text, size-gate it, send ONE non-tool request whose
// response IS the refined document, write it via a capability. Requires fs-side capabilities (readFile +
// writeFile) AND an engine.complete (the non-tool primitive) — the CC sandbox has neither, so this returns
// { degrade:true } and refineFile falls back to the agentic path (logged once). A file over SINGLE_SHOT_MAX_CHARS
// is REFUSED with a clear error routed into open_questions (never silently truncated). The full source-aware
// audit runs downstream unchanged — the safety net for single-shot's silent-compression failure mode.
async function refineFileSingleShot(engine, f, glossary, finding, A, M) {
  const cap = (A && A.capabilities) || {}
  const capturing = typeof A.captureSingleShot === 'function'
  // readFile is needed either way (to inline the source). The SEND path additionally needs engine.complete +
  // writeFile; the CAPTURE path (batch submit) needs neither — it hands the built payload to captureSingleShot.
  // Missing what THIS path needs → degrade to agentic (CC sandbox has no fs/complete). Ordered so a submit-time
  // mock engine without complete() still captures.
  if (typeof cap.readFile !== 'function') return { degrade: true }
  if (!capturing && (typeof engine.complete !== 'function' || typeof cap.writeFile !== 'function')) return { degrade: true }
  let sourceText
  try { sourceText = await cap.readFile(f.refinePath || f.path) } catch (e) {
    engine.log(`单请求精校：${f.label} 读源失败（${(e && e.message) || e}）——回退代理式`)
    return { degrade: true }
  }
  const chars = contentLength(sourceText)
  if (chars > SINGLE_SHOT_MAX_CHARS) {
    engine.log(`单请求精校：${f.label} 约 ${chars} 字，超过单请求上限 ${SINGLE_SHOT_MAX_CHARS} 字——拒绝；现已无 --refine-mode 参数，agentic 是默认且唯一的路径，DeepSeek 引擎会在其中按发言轮自动分段处理超长文件`)
    return {
      path: f.outPath, headings: [], key_fixes: [],
      open_questions: [`「${f.label}」约 ${chars} 字，超过 single-shot 上限 ${SINGLE_SHOT_MAX_CHARS} 字（响应封顶会截断长文）——本份未精校；现已无 --refine-mode 参数，agentic 是默认且唯一的路径，重新精校该份即可（DeepSeek 引擎会自动分段处理超长文件）`],
      refused: true,
    }
  }
  const glossaryBlock = (glossary && glossary !== SINGLE_FILE_GLOSSARY) ? glossary : ''
  const overrideNote = (A.singleShotOverrideNote && A.singleShotOverrideNote[f.label]) || ''
  const maxTokens = singleShotMaxTokens(chars)
  const prompt = singleShotPrompt(f, A, sourceText, glossaryBlock, overrideNote, finding)
  const model = M.refine, effort = effortFor(A, 'refine')   // M12-defaults: user override wins, else cap at 'high'
  // M11b batch-submit seam: when A.captureSingleShot is set, hand the built payload to it INSTEAD of sending —
  // the batch script reuses the whole scout→verify→glossary→single-shot-prompt pipeline to assemble batch
  // requests, then submits them itself. The rep is marked captured:true so the audit gate skips it (no 成稿 on
  // disk yet — the refined files are written on `resume`).
  if (typeof A.captureSingleShot === 'function') {
    A.captureSingleShot(f, { prompt, maxTokens, model, effort })
    return { path: f.outPath, headings: [], key_fixes: [], open_questions: [], singleShot: true, captured: true }
  }
  const text = await engine.complete(prompt, { label: `refine:${f.label}`, model, effort, maxTokens })
  if (text == null || !String(text).trim()) { engine.log(`单请求精校：${f.label} 返回空——记为失败`); return null }
  try { await cap.writeFile(f.outPath, String(text)) } catch (e) {
    engine.log(`单请求精校：${f.label} 写成稿失败（${(e && e.message) || e}）`)
    return null
  }
  return { path: f.outPath, headings: [], key_fixes: [], open_questions: [], singleShot: true }
}

async function refineFile(engine, f, glossary, refineGlossary, finding, A, M) {
  // M11a: single-shot mode builds ONE request per file (source inlined, response = 成稿). Falls back to agentic
  // when the runtime can't support it (no fs / no complete primitive — e.g. the CC sandbox).
  // A structured turn contract needs a host-side parse + deterministic render after the model write, so the
  // legacy response-as-final-Markdown single-shot path is intentionally bypassed for contracted files.
  if (A.refineMode === 'single-shot' && !f.refineContract) {
    const r = await refineFileSingleShot(engine, f, glossary, finding, A, M)
    if (!r || !r.degrade) return r
    engine.log(`单请求精校不可用（运行时无 fs / complete 能力）：${f.label} 回退代理式精校`)
  } else if (A.refineMode === 'single-shot' && f.refineContract) {
    engine.log(`单请求精校不承载 turn contract：${f.label} 改走结构化代理式精校`)
  }
  // M12: per-category reasoning effort (smart tier). effortFor = user override ?? per-phase default cap. Passed
  // straight to agent opts; the API engine emits output_config.effort only for allowed models, the CC Workflow
  // agent forwards opts.effort.
  const refineEffort = effortFor(A, 'refine')
  // Provider-aware auto-chunk: if the engine that will run refine declares a faithful-length budget for the model
  // actually assigned to refine (respects --models AND the category-router's smart engine), split any file over
  // it — a weaker-but-cheaper model silently compresses long transcripts. Anthropic / the CC sandbox expose no
  // refineBudget → rb null → budget undefined → splitForRefine behaves byte-identically to before. See
  // engines/providers.js for the per-model budgets and the retention evidence behind them.
  const rb = (typeof engine.refineBudget === 'function') ? engine.refineBudget(M.refine) : null
  const budget = rb ? rb.budget : undefined
  // A.chunkSize (--chunk-size) is the explicit experiment knob; when set it OVERRIDES both the provider budget and
  // speed-mode's count (splitForRefine handles the precedence). `off` still suppresses all chunking upstream.
  let chunks = splitForRefine(f, A.chunkMode, budget, A.chunkSize)
  const cap = (A && A.capabilities) || {}
  const contractValidator = (chunk, outputPath) => (
    f.refineContract && typeof cap.validateRefineContractOutput === 'function'
      ? () => cap.validateRefineContractOutput(f, chunk, outputPath)
      : undefined
  )
  if (f.refineContract && typeof cap.prepareRefineChunks === 'function') {
    try {
      chunks = await cap.prepareRefineChunks(f, chunks)
    } catch (e) {
      recordTurnContractFailure(A, f, e, 'prepare_chunks')
      engine.log(`精校 turn contract 分块准备失败：${f.label}（${(e && e.message) || e}）`)
      return null
    }
  }
  // autoChunk trace: record when a non-opt-in driver forced the split — the model budget (faithfulness) OR the
  // explicit --chunk-size knob. Speed mode alone is an opt-in batch lever and is NOT traced. `off` suppresses
  // chunking upstream, so it can never reach here. When --chunk-size drove it, the record gains requestedChunkSize
  // (and still carries model/budget when a budgeted provider is in play). Rides on the returned report → run.json +
  // review.md via artifacts.js.
  const drivenByChunkSize = chunks.length > 1 && typeof A.chunkSize === 'number' && A.chunkSize > 0 && refineSize(f) > A.chunkSize
  const drivenByBudget = chunks.length > 1 && rb && refineSize(f) > rb.budget
  const autoChunk = (drivenByChunkSize || drivenByBudget)
    ? {
      label: f.label,
      ...(rb ? { model: rb.model, budget: rb.budget } : {}),
      contentLength: refineSize(f),
      parts: chunks.length,
      ...(drivenByChunkSize ? { requestedChunkSize: A.chunkSize } : {}),
    }
    : null
  const plan = {
    label: f.label,
    outPath: f.outPath,
    model: (rb && rb.model) || M.refine,
    contentLength: refineSize(f),
    driver: chunks.length <= 1 ? 'single' : (drivenByChunkSize ? 'chunk_size' : (drivenByBudget ? 'provider_budget' : 'speed')),
    parts: chunks.map((c) => ({ idx: c.idx, startLine: c.startLine, endLine: c.endLine, path: chunks.length > 1 ? partPath(f.outPath, c.idx) : f.outPath })),
    ...(rb ? { budget: rb.budget } : {}),
    ...(drivenByChunkSize ? { requestedChunkSize: A.chunkSize } : {}),
    ...(autoChunk ? { autoChunk } : {}),
  }
  if (!Array.isArray(A.plannedChunks)) A.plannedChunks = []
  const previousPlan = A.plannedChunks.findIndex((x) => x && x.label === plan.label)
  if (previousPlan >= 0) A.plannedChunks[previousPlan] = plan
  else A.plannedChunks.push(plan)
  if (typeof A.onChunkPlan === 'function') A.onChunkPlan(plan)
  if (chunks.length <= 1) {
    // Single agent → full glossary (no token multiplication on one agent).
    const prompt = refinePrompt(f, glossary, finding, A, chunks[0])
    const opts = {
      label: `refine:${f.label}`, phase: 'Refine', model: M.refine, effort: refineEffort,
      schema: REFINE_REPORT_SCHEMA, outputPath: f.outPath,
      validateOutput: contractValidator(chunks[0], f.outPath),
    }
    let rep = await engine.agent(prompt, opts)
    if (!rep && retryableAgentFailure(engine, opts.label)) {
      engine.log(`精校单元：${f.label} 遇到可重试 provider 故障——只重跑该单元一次`)
      rep = await engine.agent(prompt, { ...opts, label: `refine-retry:${f.label}` })
    }
    if (!rep || !f.refineContract) return rep
    if (typeof cap.finalizeRefineContract !== 'function') {
      recordTurnContractFailure(A, f, { code: 'TURN_CONTRACT_CAPABILITY_MISSING', message: '宿主缺少 turn contract 收口能力' }, 'finalize')
      engine.log(`精校 turn contract 缺少宿主收口能力：${f.label}`)
      return null
    }
    try {
      const finalized = await cap.finalizeRefineContract(f, chunks)
      engine.log(`精校 turn contract：${f.label} 已校验 ${finalized.turnCount} 个 source turn，并从 ${finalized.outputBlockCount} 个 output block 确定性渲染`)
      return {
        ...rep,
        path: f.outPath,
        headings: finalized.headings || [],
        turnContract: finalized.contract,
      }
    } catch (e) {
      recordTurnContractFailure(A, f, e, 'finalize')
      engine.log(`精校 turn contract 校验失败：${f.label}（${(e && e.code) || 'TURN_CONTRACT_INVALID'}：${(e && e.message) || e}）`)
      return null
    }
  }
  const chunkReason = drivenByChunkSize ? `（显式分块大小 ${A.chunkSize} 字/块）`
    : (drivenByBudget ? `（自动：约 ${refineSize(f)} 字 超过 ${rb.model} 忠实处理长度 ${rb.budget} 字）` : '')
  engine.log(`精校分块：${f.label}（${f.lines} 行）拆 ${chunks.length} 块并行精校，再拼接${chunkReason}`)
  // Chunk agents get the CONDENSED glossary — it's sent to all K of them, so trimming it is the main
  // lever on chunked-refine token cost; 写法 stay identical (verified canonicals applied the same way).
  const partReps = await engine.parallel(chunks.map((c) => async () => {
    const prompt = refinePrompt(f, refineGlossary, finding, A, c)
    const opts = {
      label: `refine:${f.label}#${c.idx}/${chunks.length}`, phase: 'Refine', model: M.refine, effort: refineEffort,
      schema: REFINE_REPORT_SCHEMA, outputPath: partPath(f.outPath, c.idx),
      validateOutput: contractValidator(c, partPath(f.outPath, c.idx)),
    }
    let rep = await engine.agent(prompt, opts)
    if (!rep && retryableAgentFailure(engine, opts.label)) {
      engine.log(`精校单元：${f.label}#${c.idx}/${chunks.length} 遇到可重试 provider 故障——只重跑该单元一次`)
      rep = await engine.agent(prompt, { ...opts, label: `refine-retry:${f.label}#${c.idx}/${chunks.length}` })
    }
    return rep
  }))
  const stillMissing = chunks.filter((c, i) => !partReps[i])
  if (stillMissing.length) {
    engine.log(`精校分块：${f.label} 处理后仍缺 ${stillMissing.map((c) => `${c.idx}（源第 ${c.startLine}-${c.endLine} 行）`).join('、')}——拒绝拼接残缺正文`)
    return null
  }
  const good = partReps.filter(Boolean)
  let stitchReport = null
  if (f.refineContract && typeof cap.finalizeRefineContract === 'function') {
    try {
      stitchReport = await cap.finalizeRefineContract(f, chunks)
      engine.log(`精校 turn contract：${f.label} 已按 ${stitchReport.turnCount} 个 source turn / ${stitchReport.outputBlockCount} 个 output block 校验并合并 ${chunks.length} 块`)
    } catch (e) {
      recordTurnContractFailure(A, f, e, 'merge')
      engine.log(`精校 turn contract 合并失败：${f.label}（${(e && e.code) || 'TURN_CONTRACT_INVALID'}：${(e && e.message) || e}）`)
      return null
    }
  } else if (typeof cap.stitch === 'function') {
    try {
      const stitched = await cap.stitch(f, chunks)
      if (stitched == null) { engine.log(`精校分块：${f.label} 确定性拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
      stitchReport = stitched
      engine.log(`精校分块：${f.label} 已确定性拼接 ${chunks.length} 块`)
    } catch (e) {
      engine.log(`精校分块：${f.label} 确定性拼接失败：${(e && e.message) || e}`)
      return null
    }
  } else {
    const stitched = await engine.agent(stitchPrompt(f, chunks), { label: `stitch:${f.label}`, phase: 'Refine', model: M.stitch, outputPath: f.outPath })
    if (stitched == null) { engine.log(`精校分块：${f.label} 拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
  }
  return {
    path: f.outPath,
    headings: (stitchReport && stitchReport.headings) || good.flatMap((r) => r.headings || []),
    key_fixes: good.flatMap((r) => r.key_fixes || []),
    open_questions: good.flatMap((r) => r.open_questions || []),
    chunked: chunks.length,
    ...((stitchReport && stitchReport.contract) ? { turnContract: stitchReport.contract } : {}),
    ...((stitchReport && stitchReport.seamRepairs && stitchReport.seamRepairs.length) ? { seamRepairs: stitchReport.seamRepairs } : {}),
    ...((stitchReport && stitchReport.seamDuplicates && stitchReport.seamDuplicates.length) ? { seamDuplicates: stitchReport.seamDuplicates } : {}),
    ...(autoChunk ? { autoChunk } : {}),   // present only when the model budget forced the split (traceability)
  }
}

// Scout one file. A normal interview → one agent (unchanged). An oversized merged file (> SCOUT_CHUNK_CHARS
// 字) → splitForScout parallel chunk agents, merged by mergeScoutChunks — a RESILIENCE measure so a single
// scout can't stall on a huge file (the failure mode that motivated this). Returns one SCOUT_SCHEMA-shaped
// finding, or null if every chunk failed (handled downstream exactly like any other null scout → scoutFailed,
// refine still runs from source). A partial chunk set still yields a usable per-file finding.
async function scoutFile(engine, f, A, M, labelPrefix = 'scout') {
  const chunks = splitForScout(f)
  if (chunks.length === 1) {
    const finding = await engine.agent(scoutPrompt(f, A), { label: `${labelPrefix}:${f.label}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })
    emitSpeakerScout(A, f, 1, [finding], finding)
    return finding
  }
  engine.log(`侦察分块：大文件 ${f.label}（约 ${refineSize(f)} 字）拆 ${chunks.length} 段并行侦察，防单代理卡死`)
  const parts = await engine.parallel(chunks.map((c) => () =>
    engine.agent(scoutPrompt(f, A, c), { label: `${labelPrefix}:${f.label}#${c.idx}/${c.count}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })))
  const merged = mergeScoutChunks(parts, f)
  emitSpeakerScout(A, f, chunks.length, parts, merged)
  return merged
}

// Host-side observability hook for the OFF-BY-DEFAULT speaker dev trace (universal/speaker-trace.js). Only
// speaker labels/roles travel — never transcript text. A missing or throwing callback can never break Scout.
function emitSpeakerScout(A, f, chunkCount, parts, merged) {
  if (!A || typeof A.onSpeakerEvent !== 'function') return
  const pick = (fd) => ((fd && fd.speakers) || []).map((s) => ({ label: s && s.label, output_label: s && s.output_label, output_label_confidence: s && s.output_label_confidence, role: s && s.role }))
  try {
    A.onSpeakerEvent({
      type: 'scout_chunks', fileLabel: (f && f.label) || null, chunkCount,
      chunks: (parts || []).map((fd, i) => ({ idx: i + 1, ok: !!fd, speakers: pick(fd) })),
      merged: { speakers: pick(merged), special_notes: (merged && merged.special_notes) || [] },
    })
  } catch { /* 开发记录不可影响流水线 */ }
}

// Resolve the prior-glossary TEXT (P1 persistent 校对表) from the args. Priority: inline priorGlossaryText >
// priorGlossaryPath. A path is read via capabilities.readFile (hosts with fs — Universal) or, in the CC sandbox
// (no fs in the workflow script), by dispatching a cheap haiku agent to Read the file and return its full text
// verbatim. Returns '' when nothing is available or the read fails (behaviour then identical to a first run).
async function readPriorGlossaryText(A, engine, capabilities) {
  if (A.priorGlossaryText) return A.priorGlossaryText
  const p = A.priorGlossaryPath
  if (!p) return ''
  if (capabilities && typeof capabilities.readFile === 'function') {
    try { return (await capabilities.readFile(p)) || '' } catch { return '' }
  }
  // CC sandbox: no fs here — a subagent has Read. Ask it for the raw file, nothing else.
  const txt = await engine.agent(
    `用 Read 读取文件 ${p} 的全部内容，把原文一字不改地原样返回（不要解释、不要加任何前后缀、不要总结）。若文件不存在或读不到，只回复空字符串。`,
    { label: 'prior-glossary:read', phase: 'Scout', model: 'haiku' })
  return (typeof txt === 'string' ? txt : '') || ''
}

// Parse the audit JSON a fallback agent returned. The agent is told to echo audit_refined.mjs's stdout
// verbatim, but a model may wrap it in prose / a ```json fence — peel the outermost {...} and JSON.parse.
// Returns the parsed object or null (caller retries once, then degrades to auditUnavailable).
function parseAuditJson(raw) {
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  const s = String(raw)
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

// SF-5 — shape guard shared by BOTH audit paths (capability.runAudit and the agent-fallback JSON): the capability
// returns a per-file result ({ status, failed[], gaps[], … }), but the fallback path can return either that OR the
// full auditPairs bundle ({ status, files:[…] }). Normalise to ONE per-file result. When given a bundle, pick the
// file matching f.outPath (by its `file` field) — falling back to files[0] — so a multi-file bundle can't hand back
// the wrong file. Returns null for null/empty. `f` may be omitted (then files[0] is used).
export function normalizeAuditResult(raw, f) {
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw.files)) {
    const want = f && f.outPath
    const match = want ? raw.files.find((x) => x && (x.file === want || x.refinedFile === want)) : null
    return match || raw.files[0] || null
  }
  return raw
}

const SPEAKER_VERDICTS = new Set(['invented_speaker', 'not_speaker', 'source_supported_alias', 'uncertain'])
const SPEAKER_CONFIDENCE = new Set(['high', 'medium', 'low'])
const SPEAKER_REASONS = new Set(['dialogue_turn_without_source', 'document_metadata', 'heading_or_caption', 'list_quote_or_table', 'source_label_or_alias', 'insufficient_context'])

export function outputSpeakerCandidates(report) {
  const out = []
  const seen = new Set()
  for (const item of [...((report && report.unknownLabels) || []), ...((report && report.violations) || [])]) {
    const line = Number(item && item.line)
    const label = typeof (item && item.label) === 'string' ? item.label.trim().slice(0, 80) : ''
    if (!Number.isInteger(line) || line <= 0 || !label) continue
    const key = `${line}\u0000${label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ line, label })
  }
  return out
}

export function normalizeSpeakerCandidateDecisions(raw, candidates) {
  const rows = Array.isArray(raw && raw.decisions) ? raw.decisions : []
  return candidates.map((candidate) => {
    const row = rows.find((item) => (
      Number(item && item.line) === candidate.line
      && String((item && item.label) || '').trim() === candidate.label
    ))
    const verdict = SPEAKER_VERDICTS.has(row && row.verdict) ? row.verdict : 'uncertain'
    const confidence = SPEAKER_CONFIDENCE.has(row && row.confidence) ? row.confidence : 'low'
    const reason = SPEAKER_REASONS.has(row && row.reason) ? row.reason : 'insufficient_context'
    const outcome = verdict === 'invented_speaker' && confidence === 'high'
      ? 'block'
      : verdict === 'not_speaker' && confidence === 'high'
        ? 'dismiss'
        : 'review'
    return { ...candidate, verdict, confidence, reason, outcome }
  })
}

export async function adjudicateOutputSpeakerCandidates(engine, f, report, M = DEFAULT_STAGE_MODELS) {
  const candidates = outputSpeakerCandidates(report)
  if (!candidates.length) return null
  let raw = null
  try {
    raw = await engine.agent(speakerCandidatePrompt(f, candidates), {
      label: `speaker-adjudicate:${f.label}`,
      phase: 'Audit',
      // Reuse the existing high-quality repair route instead of adding a new independently configurable stage.
      // This is a rare publication decision, not a bulk extraction pass.
      model: M.repair,
      schema: SPEAKER_CANDIDATE_SCHEMA,
      // A classifier must never inherit the normal job-wide write allowlist. It may inspect only this source/output
      // pair and submit structured data; model/tool failure is review-tier, not permission to mutate the draft.
      filePolicy: {
        readRoots: [],
        writeRoots: [],
        readPaths: [f.path, f.outPath].filter(Boolean),
        writePaths: [],
        writePartBases: [],
      },
    })
  } catch {
    // Fail open only to the explicit review tier. The final contract below still blocks deterministic
    // unavailability and a high-confidence invented speaker; classifier failure never masquerades as clearance.
  }
  const decisions = normalizeSpeakerCandidateDecisions(raw, candidates)
  const status = decisions.some((item) => item.outcome === 'block')
    ? 'blocked'
    : decisions.some((item) => item.outcome === 'review')
      ? (raw ? 'review_needed' : 'unavailable')
      : 'cleared'
  return { label: f.label, path: f.outPath, status, model: M.repair, decisions }
}

function reuseSpeakerCandidateAdjudication(previous, f, report) {
  const candidates = outputSpeakerCandidates(report)
  const prior = Array.isArray(previous && previous.decisions) ? previous.decisions : []
  if (!candidates.length || !prior.length) return null
  const decisions = []
  for (const candidate of candidates) {
    const match = prior.find((item) => item.label === candidate.label)
    if (!match) return null
    decisions.push({ ...match, ...candidate })
  }
  const status = decisions.some((item) => item.outcome === 'block')
    ? 'blocked'
    : decisions.some((item) => item.outcome === 'review')
      ? (previous.status === 'unavailable' ? 'unavailable' : 'review_needed')
      : 'cleared'
  return { ...previous, label: f.label, path: f.outPath, status, decisions }
}

function unavailableSpeakerCandidateAdjudication(f, report, M = DEFAULT_STAGE_MODELS) {
  const candidates = outputSpeakerCandidates(report)
  if (!candidates.length) return null
  return {
    label: f.label,
    path: f.outPath,
    status: 'unavailable',
    model: M.repair,
    decisions: normalizeSpeakerCandidateDecisions(null, candidates),
  }
}

function speakerAuditLabels(adjudication) {
  const decisions = Array.isArray(adjudication && adjudication.decisions) ? adjudication.decisions : []
  return {
    speakerDismissedLabels: [...new Set(decisions.filter((item) => item.outcome === 'dismiss').map((item) => item.label).filter(Boolean))],
    speakerReviewLabels: [...new Set(decisions.filter((item) => item.outcome === 'review').map((item) => item.label).filter(Boolean))],
  }
}

// Per-file quality gate (Wave 2): the source-aware audit is now IN the pipeline, not a report jobs.js runs
// afterwards. With fs (Universal) the host injects capabilities.runAudit (direct auditPairs call); in the CC
// sandbox there is no fs, so a stitch/haiku subagent runs `node <skillDir>/audit_refined.mjs` and echoes the
// JSON. Any PUBLICATION_BLOCK_GATES finding → optionally auto-repair at most twice through a host-provided
// transactional repair capability, re-audit after each round, and if still hard mark the file auditFailed + drop a visible
// 缺口 marker (--annotate). Then run source anchors (capability or the same agent with --anchors). Never throws:
// an unavailable audit degrades to { status:'unavailable', auditUnavailable:true }.
async function runAuditStep(A, engine, f, capabilities, glossaryText, options = {}) {
  const src = f.path, out = f.outPath
  const skillDir = A.skillDir || '.'
  const cap = capabilities || {}
  const directAudit = typeof cap.runAudit === 'function'

  // Risk (a): the audit's ghost_name / missing_yin checks need THIS round's rendered 校对表. On a first run it is
  // only in memory (persistGlossary writes it to disk AFTER the pipeline returns), so reading <out>/校对表.md would
  // miss it. Prefer the in-memory glossaryText everywhere; only fall back to the on-disk path when we have none.
  const memGlossary = glossaryText && glossaryText !== SINGLE_FILE_GLOSSARY ? glossaryText : null
  const glossaryPath = A.outputDir ? `${A.outputDir}/校对表.md` : null

  // 1) obtain an audit file-result ({ status, failed[], gaps[], findings[], modelMarkers[] })
  async function audit(auditContext = {}) {
    const speakerContext = speakerAuditLabels(f.speakerCandidateAdjudication)
    if (typeof cap.runAudit === 'function') {
      // Pass the in-memory glossary so the capability doesn't have to read a not-yet-persisted file (risk a).
      // Fail-loud (P7): a thrown direct audit is retried ONCE (parity with the CC agent path's one retry); still
      // throwing → null, which the caller turns into a LOUD run failure instead of a quiet "audit unavailable".
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return normalizeAuditResult(await cap.runAudit(f, { glossaryText: memGlossary, ...speakerContext, ...auditContext }), f) }
        catch { if (attempt >= 1) return null }
      }
      return null
    }
    // CC sandbox: no fs here, so hand the in-memory glossary to the agent to stage in a scratch file, then pass it
    // to the CLI via --glossary. Without a memory glossary, fall back to the on-disk path (harmless if it exists).
    const scratch = A.scratchDir ? `${A.scratchDir}/audit-glossary-${f.label}.md` : `${(A.outputDir || '.')}/.audit-glossary-${f.label}.md`
    let glossaryArg = glossaryPath ? ` --glossary ${JSON.stringify(glossaryPath)}` : ''
    let stagePreamble = ''
    if (memGlossary) {
      glossaryArg = ` --glossary ${JSON.stringify(scratch)}`
      stagePreamble = `先用 Write 把下面这段“校对表全文”一字不改写到临时文件 ${JSON.stringify(scratch)}，再运行审计命令。\n<校对表全文>\n${memGlossary}\n</校对表全文>\n\n`
    }
    const dismissedArg = speakerContext.speakerDismissedLabels.length
      ? ` --speaker-dismissed-labels ${JSON.stringify(JSON.stringify(speakerContext.speakerDismissedLabels))}`
      : ''
    const reviewArg = speakerContext.speakerReviewLabels.length
      ? ` --speaker-review-labels ${JSON.stringify(JSON.stringify(speakerContext.speakerReviewLabels))}`
      : ''
    const cmd = `node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)}${glossaryArg}${dismissedArg}${reviewArg}`
    const prompt = `${stagePreamble}用 Bash 运行下面这条命令，把它打印到 stdout 的 JSON **原样**返回（不要任何解释、不要加代码围栏、不要改动）：\n${cmd}`
    let raw = await engine.agent(prompt, { label: `audit:${f.label}`, phase: 'Audit', model: 'haiku' })
    let parsed = parseAuditJson(raw)
    if (!parsed) { // one retry
      raw = await engine.agent(prompt, { label: `audit-retry:${f.label}`, phase: 'Audit', model: 'haiku' })
      parsed = parseAuditJson(raw)
    }
    return normalizeAuditResult(parsed, f)
  }

  const first = await audit({ phase: options.phase || 'pre_audit' })
  // Fail-loud (P7): the audit could not run after one retry. Previously this "degraded to record-only, non-blocking"
  // and the run reported success with an "audit unavailable" note — a quality gate that can be skipped silently.
  // Now the per-file result still carries auditUnavailable (the 成稿 is kept, not destroyed), but the orchestration
  // collects it into a top-level auditUnavailable list that marks the whole run FAILED (unaudited ≠ passed).
  if (!first) { engine.log(`⚠ 审计无法运行（重试后仍失败）：${f.label}——该成稿未经审计，本次运行判定为失败（deliverables unaudited/invalid，请人工跑 audit_refined.mjs 核验）`); return { status: 'unavailable', auditUnavailable: true, failedFindings: [], hardFindings: [], softFindings: [], repaired: false, repairAttempts: [], anchorsAdded: 0, directAudit } }

  const hardOf = (r) => (r.failed || []).filter((k) => PUBLICATION_BLOCK_GATES.includes(k))
  const softOf = (r) => (r.failed || []).filter((k) => !PUBLICATION_BLOCK_GATES.includes(k))
  const issueCounts = (r, hard) => {
    const counts = {}
    for (const finding of (r.findings || [])) {
      if (!finding || finding.severity !== 'hard') continue
      const count = Number(finding.count)
      if (finding.name && Number.isFinite(count) && count > 0) counts[finding.name] = count
    }
    const hardGaps = (r.gaps || []).filter((g) => g && g.severity === 'hard').length
    if (hardGaps) counts.content_gap = Math.max(counts.content_gap || 0, hardGaps)
    const longParagraphs = Array.isArray(r.long_paragraphs) ? r.long_paragraphs.length : 0
    if (longParagraphs) counts.long_paragraphs = Math.max(counts.long_paragraphs || 0, longParagraphs)
    for (const name of hard) if (!counts[name]) counts[name] = 1
    return counts
  }
  let cur = first
  let hard = hardOf(cur)
  let repaired = false
  const repairAttempts = []
  // A runtime without fs cannot stage, audit and atomically promote a candidate. Do not let a fallback model
  // overwrite the current transcript in place; keep the hard finding for explicit/manual repair instead.
  const repairAvailable = options.allowRepair !== false && typeof cap.repair === 'function'

  if (hard.length && repairAvailable) engine.log(`审计 hard：${f.label} → ${hard.join('、')}——最多候选修复 ${QUALITY_REPAIR_MAX_ROUNDS} 轮，每轮后复检`)
  for (let round = 1; hard.length && repairAvailable && round <= QUALITY_REPAIR_MAX_ROUNDS; round += 1) {
    const failedBefore = hard.slice()
    const hardIssueCountsBefore = issueCounts(cur, failedBefore)
    const gaps = (cur.gaps || []).filter((g) => g.severity === 'hard')
    let repairMeta = {}
    let repairError = null
    try { repairMeta = (await cap.repair(f, { gaps, hard: failedBefore, audit: cur, round, maxRounds: QUALITY_REPAIR_MAX_ROUNDS, glossaryText: memGlossary })) || {} }
    catch (error) { repairError = (error && error.code) || 'REPAIR_AGENT_FAILED' }

    const again = await audit({ phase: `post_repair_round_${round}`, round })
    if (!again) {
      repairAttempts.push({
        file: out, round, action: repairMeta.action || null, model: repairMeta.model || null,
        failedBefore, hardIssueCountsBefore, toolSummary: repairMeta.toolSummary || { succeeded: {}, failed: [] },
        bytesBefore: repairMeta.bytesBefore ?? null, bytesAfter: repairMeta.bytesAfter ?? null,
        changed: repairMeta.changed === true, agentCompleted: repairMeta.agentCompleted ?? null,
        candidatePromoted: repairMeta.candidatePromoted ?? null,
        candidateSpeakerValid: repairMeta.candidateSpeakerValid ?? null,
        candidateRejectedReason: repairMeta.candidateRejectedReason || null,
        candidateHardFindings: repairMeta.candidateHardFindings || [],
        failedAfter: failedBefore, hardIssueCountsAfter: hardIssueCountsBefore,
        outcome: 'audit_unavailable', errorCode: repairError,
      })
      engine.log(`审计复检：${f.label} 第 ${round}/${QUALITY_REPAIR_MAX_ROUNDS} 轮后无法运行——停止自动修复，保留原 hard 结论`)
      break
    }

    cur = again
    hard = hardOf(cur)
    const hardIssueCountsAfter = issueCounts(cur, hard)
    const toolFailures = ((repairMeta.toolSummary || {}).failed || []).reduce((sum, x) => sum + (Number(x.count) || 0), 0)
    const changed = repairMeta.changed === true
    const improved = hard.length < failedBefore.length || hard.some((name) => !failedBefore.includes(name)) || failedBefore.some((name) => !hard.includes(name))
    if (changed || improved || (!hard.length && repairMeta.changed == null)) repaired = true
    let outcome
    if (repairError || repairMeta.agentCompleted === false) outcome = 'agent_failed'
    else if (repairMeta.candidatePromoted === false && repairMeta.candidateRejectedReason) outcome = 'candidate_rejected'
    else if (!changed && repairMeta.changed != null) outcome = 'no_change'
    else if (!hard.length) outcome = toolFailures ? 'passed_with_tool_errors' : 'passed'
    else outcome = toolFailures ? 'audit_failed_with_tool_errors' : 'audit_failed'
    repairAttempts.push({
      file: out, round, action: repairMeta.action || null, model: repairMeta.model || null,
      failedBefore, hardIssueCountsBefore, toolSummary: repairMeta.toolSummary || { succeeded: {}, failed: [] },
      bytesBefore: repairMeta.bytesBefore ?? null, bytesAfter: repairMeta.bytesAfter ?? null,
      changed, agentCompleted: repairMeta.agentCompleted ?? null,
      candidatePromoted: repairMeta.candidatePromoted ?? null,
      candidateSpeakerValid: repairMeta.candidateSpeakerValid ?? null,
      candidateRejectedReason: repairMeta.candidateRejectedReason || null,
      candidateHardFindings: repairMeta.candidateHardFindings || [],
      failedAfter: hard.slice(), hardIssueCountsAfter, outcome,
      errorCode: repairError || repairMeta.errorCode || null,
    })
    engine.log(`审计复检：${f.label} 第 ${round}/${QUALITY_REPAIR_MAX_ROUNDS} 轮 → ${hard.length ? `hard 仍在：${hard.join('、')}` : '已通过'}${toolFailures ? `；本轮工具失败 ${toolFailures} 次（已保留记录）` : ''}`)
  }

  const auditFailed = hard.length ? hard.slice() : []
// Still hard after at most two repairs → annotate any concrete source gaps so the document shows the defect.
  // Risk (b): fall back to the agent whenever the annotate CAPABILITY specifically is missing — not only in the
  // all-agent CC path. A host that injects runAudit but not annotate still gets the marker via the agent.
  if (auditFailed.length && (cur.gaps || []).some((g) => g.severity === 'hard')) {
    if (typeof cap.annotate === 'function') { try { await cap.annotate(f, (cur.gaps || []).filter((g) => g.severity === 'hard')) } catch { /* best effort */ } }
    else {
      await engine.agent(
        `用 Bash 运行：node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)} --annotate\n只回复一句话确认即可。`,
        { label: `annotate:${f.label}`, phase: 'Audit', model: 'haiku' })
    }
  }

  // 2) source anchors (provenance) — after any gap annotation, so anchors coexist with just-inserted markers.
  // Risk (b): same per-capability fallback — a missing annotateAnchors capability falls back to the agent even when
  // runAudit IS a capability (previously this whole step was skipped in that mixed configuration).
  let anchorsAdded = 0
  if (typeof cap.annotateAnchors === 'function') {
    try { const a = await cap.annotateAnchors(f); anchorsAdded = (a && a.updated && a.updated.length) || 0 } catch { anchorsAdded = 0 }
  } else {
    await engine.agent(
      `用 Bash 运行：node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)} --anchors\n只回复一句话确认即可。`,
      { label: `anchors:${f.label}`, phase: 'Audit', model: 'haiku' })
  }

  return { status: auditFailed.length ? 'fail' : 'ok', auditFailed, failedFindings: (cur.failed || []).filter(Boolean), hardFindings: hard, softFindings: softOf(cur), repaired, repairAttempts, anchorsAdded, directAudit }
}

const DEDUP_SKIP_UNKNOWN_RATIO = 0.10
const entityCount = (merged) => ((merged && merged.people) || []).length + ((merged && merged.brands) || []).length + ((merged && merged.terms) || []).length
function dedupCoverage(prior, merged) {
  const target = dropLocked(merged)
  const total = entityCount(target)
  if (!prior || !total) return { total, unknown: total, covered: 0, unknownRatio: total ? 1 : 0, skip: false }
  const unknown = entityCount(excludeVerified(target, prior))
  const unknownRatio = unknown / total
  return { total, unknown, covered: total - unknown, unknownRatio, skip: unknownRatio <= DEDUP_SKIP_UNKNOWN_RATIO }
}

export async function runPipeline(A, engine) {
const M = Object.assign(
  {}, DEFAULT_STAGE_MODELS,
  A.models || {}
)
const scope = A.scope || ['refine']
const capabilities = A.capabilities || null
const EMPTY_RETURN = (error) => ({ error, glossary: '', refined: [], failed: [], incomplete: [], unchecked: [], headingConflicts: [], scoutSuspect: [], scoutFailed: [], suspectedDuplicates: [], networkUnverified: [], logic: [], openQuestions: [], summary: null, timeline: null, transcriptMetadata: null, speakerIdentityFinalizations: [], auditFailed: [], auditUnavailable: [], qualityRepairAttempts: [] })
if (!Array.isArray(A.files) || A.files.length === 0) {
  return EMPTY_RETURN('args.files 为空——需在 Step 0 预检后组装 files 再派发')
}
// summary / timeline / logical-order rewrite all take this session's refined output as input; a scope with a
  // deliverable but no refine would silently produce nothing — so fail early and diagnosably.
if ((scope.includes('summary') || scope.includes('timeline') || scope.includes('logic')) && !scope.includes('refine')) {
  return EMPTY_RETURN('summary/时间线/逻辑顺序稿依赖本会话 refine 产物，scope 须同时含 refine（本工作流不支持只对历史成稿单独出交付物）')
}

// Persistent per-company glossary (P1): if Step 0 found an existing 校对表.md and passed its text (or a
// priorGlossaryPath the host/agent reads), parse it into prior memory to seed scout + accumulate into. A.fresh
// forces a from-scratch rebuild. Attached to A so scoutPrompt can read it. Absent/empty → null → behaviour
// identical to a first run. priorGlossaryText wins over priorGlossaryPath (§4 resolution order).
const priorText = A.fresh ? '' : await readPriorGlossaryText(A, engine, capabilities)
const prior = priorText ? parseGlossary(priorText) : null
A.prior = prior
A.doNotMerge = (prior && prior.doNotMerge) || []   // P4: human-confirmed distinct referents, carried forward to dedup + render
let conflicts = []                                  // P4: this batch's verify conclusions that disagree with the prior glossary
let weakDups = []                                   // P4b: cross-batch weak-honorific (张总/李总) ambiguities to disambiguate
let reopenNotes = []                                // M9a: prior 〔核实〕 entries this batch re-queued for verify on new contradicting evidence
if (prior) engine.log(`沿用往次校对表：已知 ${prior.people.length} 人名 / ${prior.brands.length} 品牌 / ${prior.terms.length} 术语、${(prior.verified.resolved || []).length} 条核实结论——本轮在其上累积`)

let glossary = ''
let netUnverified = []
let asrSuspects = []   // scout-flagged ASR suspects verify couldn't resolve → folded into openQuestions
let contestedAsks = []   // 〔同指两解〕 contested identities (spoken form kept in text) → one 收尾待问 line each
let refined = []
let failed = []
let headingConflicts = []
let scoutSuspect = []
let scoutFailed = []   // files whose scout returned nothing (stalled) — refined anyway (glossary degraded), surfaced for re-scout
let dedup = null
let auditFailed = []    // per-file publication-gate findings still failing after at most two targeted repair rounds
let incomplete = []     // Legacy return-contract field; source-aware hard failures live in auditFailed.
let unchecked = []      // Refined files lacking a direct audit capability, or whose audit errored.
let auditUnavailable = []  // P7 fail-loud: files whose audit could NOT run after one retry — the run is marked failed (unaudited, not passed).
let derivativesSkipped = [] // requested derivatives withheld because their source body was not final/audited
let overrideQuestions = []   // SF-2 + risk(c): decree conflicts (one cluster claimed by ≥2 decrees) and cross-category mis-declared-category warnings → openQuestions
let refinedPairs = []   // [{ f, rep }]: successfully refined files and their reports (including headings); used by the logic-reorder phase to read f.title/outPath and verify section-heading coverage
let speakerResolutions = []  // one deterministic Scout mapping per file; Refine reads its materialized input copy
let speakerOutputNormalizations = [] // same mapping re-applied to model output aliases; no identity inference
let speakerStructuralFailures = [] // output violated the source's tracked/untracked speaker contract; never deliver that draft
let speakerStructureWarnings = [] // parser/Scout disagreement or unresolved label shape; visible review, never silent untracked
let speakerCandidateAdjudications = [] // LLM verdicts for residual output candidates; only high-confidence invention blocks
let speakerIdentityFinalizations = [] // post-refine track registry decisions + deterministic render ledger
let transcriptMetadata = null // single-file catalog metadata produced by the same final identity pass
let qualityRepairAttempts = [] // append-only across all files, including drafts later removed by the final contract

// Disabled: every transcript must pass through the full-text Scout before Refine, including a single short file.
// Keep the former branch in place temporarily for an easy diff/review, but make it unreachable.
const useShortFileFastPath = false
// Former condition:
// A.files.length === 1 && refineSize(A.files[0]) < ONE_PASS_CHARS && !A.captureSingleShot && !A.files[0].needsSpeakerResolution
if (useShortFileFastPath) {
  // Legacy single-short-file path: one-pass refine, skipping Scout/Verify.
  // (M11b: a batch-submit capture pass forces the else-branch so even a tiny lone file is captured as a
  // single-shot batch request via refineFileSingleShot, not sent through the one-pass Write-tool agent.)
  // Length judged by 正文字数, not lines. NOTE (M11a): refineMode:'single-shot' does NOT change this branch —
  // one-pass is already the cheapest possible refine (one agent, no scout/verify), so a tiny single file always
  // takes it. Single-shot's one-request-per-file contract governs the standard refineFile path (multi-file /
  // larger single files); see refineFileSingleShot.
  const f = A.files[0]
  engine.phase('Refine')
  engine.log(`▶ 精校 Refine：单份短文件（约 ${refineSize(f)} 字）一遍过，不建独立校对表`)
  // §1 on the one-pass path too: this branch skips scout/merge entirely, so canonicalOverrides has no cluster
  // list to veto — without this, a user decree was silently dropped (never reached singlePassPrompt, never
  // reached audit). Route every override through applyOverridesToMerged against an EMPTY bundle: every decree
  // then hits the documented "matched nothing → still emit a locked cluster" path, so it's guaranteed to
  // surface here exactly as it would on the multi-file path. Category routing (person/brand/term) is preserved.
  const lockedClusters = (A.canonicalOverrides && A.canonicalOverrides.length)
    ? applyOverridesToMerged({ people: [], brands: [], terms: [] }, A.canonicalOverrides)
    : null
  const lockedAll = lockedClusters ? [...lockedClusters.people, ...lockedClusters.brands, ...lockedClusters.terms] : []
  let overrideNote = ''
  let onePassGlossaryText = null
  if (lockedAll.length) {
    engine.log(`用户钦定正名（一遍过分支）：${lockedAll.length} 条已注入 prompt + 最小校对表`)
    // Prompt injection: same voice as the rest of singlePassPrompt (中文、弯引号、盘古空格).
    const decreeLines = lockedAll.map((e) => {
      const variants = (e.variants || []).join(' / ') || '（无变体）'
      return `- ${variants} 一律写作 **${e.canonical}**`
    })
    overrideNote = `【用户钦定正名（必须执行）】以下写法无论源文件里出现哪种口语/变体，精校时一律统一写作钦定正字：\n${decreeLines.join('\n')}`
    // Minimal glossaryText for the audit gate: hand-rolled `- **正字** ← 变体1 / 变体2` rows in the exact
    // grammar audit_refined.mjs's parseGlossaryLite recognises (canonical entity line under a 人名/品牌 header),
    // so ghost_name / missing_yin can catch a decreed variant surviving into the 成稿 on this path too.
    onePassGlossaryText = ['## 人名 / 品牌（用户钦定）', ...lockedAll.map((e) =>
      `- **${e.canonical}** ← ${(e.variants || []).join(' / ') || '—'} ｜ 用户钦定`)].join('\n')
  }
  const onePassPlan = {
    label: f.label, outPath: f.outPath, model: M.refine, contentLength: refineSize(f), driver: 'single',
    parts: [{ idx: 1, startLine: 1, endLine: f.lines, path: f.outPath }],
  }
  if (!Array.isArray(A.plannedChunks)) A.plannedChunks = []
  A.plannedChunks.push(onePassPlan)
  if (typeof A.onChunkPlan === 'function') A.onChunkPlan(onePassPlan)
  const rep = await engine.agent(singlePassPrompt(f, A, overrideNote), { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, effort: effortFor(A, 'refine'), schema: REFINE_REPORT_SCHEMA, outputPath: f.outPath })
  if (rep) {
    refined = [Object.assign({}, rep, { outPath: f.outPath, complete: null, checkNote: '审计待跑' })]
    refinedPairs = [{ f, rep, anchor: null, onePassGlossaryText }]
  } else {
    failed = [f.label]
  }
  glossary = SINGLE_FILE_GLOSSARY
} else {
  engine.phase('Scout')
  engine.log(`▶ 1/${scope.includes('logic') ? 5 : 4} 侦察 Scout：${A.files.length} 份并行抽取实体（人名 / 品牌 / 术语 / 发言人）`)
  let findings = await engine.parallel(A.files.map((f) => () => scoutFile(engine, f, A, M)))
  // Garbled-scout self-healing: if a scout result looks garbled, retry it once (a haiku call is cheap); if still garbled, flag it in scoutSuspect and warn at delivery that the glossary entry for that file is unreliable.
  // The refined transcript is unaffected — refine reads the source file directly and does not blindly trust the scout output — but the archived glossary entry for that file will be dirty.
  const retryIdx = A.files.map((f, i) => (findings[i] && scoutLooksGarbled(findings[i])) ? i : -1).filter((i) => i >= 0)
  if (retryIdx.length) {
    engine.log(`侦察疑似损坏（疑网络中途毁坏生成流）：${retryIdx.map((i) => A.files[i].label).join('、')}——各重试一次`)
    const retries = await engine.parallel(retryIdx.map((i) => () => scoutFile(engine, A.files[i], A, M, 'scout-retry')))
    retryIdx.forEach((i, k) => { if (retries[k] && !scoutLooksGarbled(retries[k])) findings[i] = retries[k] })
  }
  scoutSuspect = A.files.filter((f, i) => findings[i] && scoutLooksGarbled(findings[i])).map((f) => f.label)
  engine.log(`侦察完成 ${findings.filter(Boolean).length}/${A.files.length} 份${scoutSuspect.length ? `（${scoutSuspect.join('、')} 重试后仍疑损坏，校对表该份不可靠）` : ''}`)
  // Still-garbled scout results are dropped entirely from the merge: this prevents polluting the glossary body and avoids wasting verify/dedup web-lookup calls on garbage input.
  // Refine for that file still runs normally (it reads the source file directly, not the scout output); scoutSuspect still prompts the user to re-run scout for that file.
  // If every scout is garbled, cleanFindings is all-null → merged lists are all empty → doVerify is naturally false and dedupList is empty, so the whole verify/dedup block short-circuits safely.
  const cleanFindings = findings.map((fd) => (fd && scoutLooksGarbled(fd)) ? null : fd)
  // §1 user-decreed canonical overrides get their structural veto here — BEFORE verify/render — so a decree
  // (“口语 X/Y 一律写作 Z”) forces the canonical, collapses homophone clusters the weak-key guard won't merge,
  // and is GUARANTEED to appear even if the scout never surfaced it. Locked clusters skip verify (dropLocked
  // below), skip the name-guard (applyVerifiedEntry short-circuits), and render as 〔用户钦定〕 (no ⚠).
  const mergedThisBatch = applyOverridesToMerged(mergeFindings(cleanFindings, A.files), A.canonicalOverrides)
  const lockedCount = [...(mergedThisBatch.people || []), ...(mergedThisBatch.brands || []), ...(mergedThisBatch.terms || [])].filter((e) => e && e.locked).length
  if (lockedCount) engine.log(`用户钦定正名：${lockedCount} 条已锁定（强制 canonical、跳联网核实、渲染带〔用户钦定〕）`)
  // SF-2: a single cluster claimed by ≥2 competing decrees was merged into one locked cluster (canonical = first
  // decree) — surface the disagreement. Risk(c): a decree that hit nothing in its declared category but whose
  // writing appears in another category's cluster — likely a mis-declared category. Both go into openQuestions.
  for (const c of mergedThisBatch.overrideConflicts || []) overrideQuestions.push(`钦定正名冲突：同一对象被多条 decree 命名为「${c.canonicals.join('」「')}」——已按首条统一为「${c.resolvedTo}」，请确认是否正确。`)
  for (const w of mergedThisBatch.categoryWarnings || []) overrideQuestions.push(`钦定正名类别疑误标：「${w.canonical}」声明为${w.declared}，但其写法在${w.foundIn}里出现——已按声明的${w.declared}锁定，请确认类别。`)
  if (overrideQuestions.length) engine.log(`用户钦定正名：${overrideQuestions.length} 条冲突/类别疑问——并入 openQuestions 待确认`)
  headingConflicts = findHeadingConflicts(cleanFindings, A.files, A.headingPolicy)
  if (headingConflicts.length) engine.log(`注意：${headingConflicts.join('、')} 源文件已带小标题但 headingPolicy=none——收尾时需问用户保留还是重做`)

  engine.phase('Verify')
  engine.log(`▶ 2/${scope.includes('logic') ? 5 : 4} 核实 Verify：精校前核实关键实体 + 语义同指排查`)
  // verify (web-lookup fact-checking, chunked and parallelised) and dedup (semantic co-reference check across all entities) are independent of each other — run both concurrently in the same parallel
  let verified = null
  // terms count too (verifyChunks already submits terms for checking; the deep level requires all terms to be verified, and omitting terms from the threshold would cause a terms-only interview to silently skip verification)
  // M9 firebreak (anti-fossilization): BEFORE the verify-cache exclusion, decide which prior 〔核实〕 entries to
  // pull back into the verify queue this batch — (M9a) any prior-verified entry whose scout cluster this batch
  // grew a NEW contradicting strong writing, and (M9b) the N oldest verified entries on a rotation by age. Both
  // are skipped when verify is off (nothing would be re-checked anyway). The reopened writings are removed from
  // excludeVerified's skip set so a re-opened entity that ALSO recurs this batch drops back into verifyTarget;
  // M9a's notes surface into the glossary render (A.reopenNotes → 本轮重新入队复核 section) and openQuestions.
  let forceReopen = []
  if (A.verifyDepth !== 'none' && prior) {
    const reopen = contradictionReopen(prior, mergedThisBatch)   // M9a: scout-evidence contradiction (no model call)
    const rot = rotateReverify(prior, ROTATE_REVERIFY)           // M9b: oldest-N age rotation
    reopenNotes = reopen.notes
    forceReopen = Array.from(new Set([...reopen.writings, ...rot.writings]))
    if (reopen.notes.length) engine.log(`往批核实复核（M9a）：${reopen.notes.length} 项旧核实结论遇新写法证据，已重新入队核实`)
    if (rot.count) engine.log(`轮换复核：${rot.count} 项旧核实结论重新入队（最早 ${rot.oldest || '无日期（视为最旧）'}）`)
  }
  A.reopenNotes = reopenNotes
  // P2: don't re-verify entities the prior glossary already confirmed — verify only this batch's new ones.
  // §1: also drop locked (用户钦定) clusters — a decree is final, nothing to look up.
  // M9: forceReopen pulls the firebreak-selected prior-verified writings back out of the skip set.
  const verifyTarget = excludeVerified(dropLocked(mergedThisBatch), prior, forceReopen)
  if (prior) { const sk = (mergedThisBatch.people.length + mergedThisBatch.brands.length + mergedThisBatch.terms.length) - (verifyTarget.people.length + verifyTarget.brands.length + verifyTarget.terms.length); if (sk > 0) engine.log(`核实缓存：跳过 ${sk} 项往次已核实实体，本轮只核新实体`) }
  const doVerify = A.verifyDepth !== 'none' && (verifyTarget.people.length || verifyTarget.brands.length || verifyTarget.terms.length)
  const vc = doVerify ? verifyChunks(verifyTarget, A.verifyDepth) : { chunks: [], eligible: 0, excluded: 0, overflow: 0 }
  if (doVerify) {
    engine.log(`核实：${vc.eligible} 项分 ${vc.chunks.length} 块并行送检${vc.excluded > 0 ? `，${vc.excluded} 项低优先级未送检（由精校按原文归一）` : ''}`)
    if (vc.overflow > 0) engine.log(`核实：实体过多，${vc.overflow} 项超出 ${VERIFY_CHUNK * MAX_CHUNKS} 上限未送检`)
  }
  const dedupList = dedupListText(mergedThisBatch)
  const dedupStats = dedupCoverage(prior, mergedThisBatch)
  const skipDedup = !!(dedupList && dedupStats.skip)
  if (skipDedup) engine.log(`疑似同指缓存：跳过语义同指排查，往次校对表覆盖 ${dedupStats.covered}/${dedupStats.total} 个非钦定实体，新/未知 ${dedupStats.unknown} 个（${Math.round(dedupStats.unknownRatio * 100)}%，阈值 ≤10%）`)
  const [vparts, dedupRes] = await engine.parallel([
    () => vc.chunks.length
      ? engine.parallel(vc.chunks.map((ct, i) => () => engine.agent(verifyPrompt(ct, A), { label: `verify:${i + 1}/${vc.chunks.length}`, phase: 'Verify', model: M.verify, effort: effortFor(A, 'verify'), schema: VERIFY_SCHEMA })))
      : Promise.resolve([]),
    () => dedupList && !skipDedup
      ? engine.agent(dedupPrompt(dedupList, A), { label: 'dedup:semantic', phase: 'Verify', model: M.dedup, effort: effortFor(A, 'dedup'), schema: DEDUP_SCHEMA })
      : Promise.resolve(null),
  ])
  const goodParts = (vparts || []).filter(Boolean)
  if (vc.chunks.length) {
    // Row-level sanitisation: the schema no longer enforces fields, so degraded output may be missing query/canonical — rows missing critical fields are dropped outright
    verified = {
      resolved: goodParts.flatMap((p) => p.resolved || []).filter((r) => r && r.query && r.canonical),
      unresolved: goodParts.flatMap((p) => p.unresolved || []).filter((r) => r && r.query),
      // Contested verdicts (two-key rule blocked a referent substitution) → 〔同指两解〕 rows + 收尾待问 lines.
      contested: goodParts.flatMap((p) => p.contested || []).filter((r) => r && r.query),
    }
    engine.log(`核实完成：${verified.resolved.length} 项确认，${verified.unresolved.length} 项存疑（${goodParts.length}/${vc.chunks.length} 块返回）`)
    if (goodParts.length < vc.chunks.length) engine.log(`核实：${vc.chunks.length - goodParts.length}/${vc.chunks.length} 块未返回（疑网络劣化），该批实体本轮未核实——网络稳定后可重跑`)
    netUnverified = pickNetworkUnverified(verified)
    if (netUnverified.length) engine.log(`其中 ${netUnverified.length} 项因网络故障未核实——收尾时可向用户提供补核选项（networkUnverified）`)
  }
  conflicts = prior ? glossaryConflicts(prior, verified) : []
  if (conflicts.length) engine.log(`核实冲突：${conflicts.length} 项本轮核实与往次校对表不一致——并入 openQuestions 待人工确认（未自动改写）`)
  dedup = dedupRes ? { suspects: cleanSuspects(dedupRes.suspects) } : null
  if (dedup && dedup.suspects.length) engine.log(`疑似同指：标记 ${dedup.suspects.length} 组待人工确认`)
  // Accumulate this batch into the prior glossary (P1): verify/dedup ran on this batch's findings;
  // prior conclusions are carried forward (not re-verified). Render the cumulative glossary — refine
  // below reads it, so 写法 stay consistent across the company's whole interview set.
  const merged = prior ? mergeIntoPrior(prior, mergedThisBatch) : mergedThisBatch
  const allVerified = prior ? mergeVerified(prior.verified, verified) : verified
  const allDedup = prior ? { suspects: mergeDedup(prior.dedupSuspects, (dedup && dedup.suspects) || []) } : dedup
  weakDups = prior ? weakDupFlags(prior, mergedThisBatch) : []
  asrSuspects = suspectUnverified(mergedThisBatch, allVerified)   // suspects still unresolved after verify → ask the user
  if (asrSuspects.length) engine.log(`疑似转录误写未核实：${asrSuspects.length} 项——并入 openQuestions 待人工确认正确写法`)
  contestedAsks = contestedQuestions(merged, allVerified)   // 〔同指两解〕: spoken form kept, both hypotheses surfaced
  if (contestedAsks.length) engine.log(`同指两解：${contestedAsks.length} 项口播形存疑（正文已保留原形并标注）——并入 openQuestions 待定夺`)
  if (weakDups.length) engine.log(`称呼歧义：${weakDups.length} 个弱称呼跨批次重复（未合并）——并入 openQuestions 待人工辨认`)
  if (prior) engine.log(`累积合并：校对表现含 ${merged.people.length} 人名 / ${merged.brands.length} 品牌 / ${merged.terms.length} 术语`)
  glossary = renderGlossary(merged, allVerified, allDedup, A)
  // Condensed glossary for chunk-refine agents (full 校对表 still persisted + used by single-agent refine).
  const refineGlossary = renderRefineGlossary(merged, allVerified, allDedup, A)

  let positional = []
  if (scope.includes('refine')) {
    // Speaker identity is a whole-file decision owned by Scout, not by independent Refine chunks. Universal
    // materializes that mapping into a disposable, line-for-line input copy here. The original path stays on f
    // for source-aware audit; only Refine switches to refinePath. Runtimes without fs capability keep the prior
    // prompt-only behaviour.
    if (capabilities && typeof capabilities.prepareSpeakerInput === 'function') {
      const prepared = await engine.parallel(A.files.map((f, i) => async () => {
        const finding = cleanFindings[i] || {}
        try { return await capabilities.prepareSpeakerInput(f, finding) } catch (e) {
          if (capabilities.requireTurnContract) return { turnContractFailure: e }
          engine.log(`发言人统一输入生成失败：${f.label}（${(e && e.message) || e}）——保留原稿进入 Refine`)
          return null
        }
      }))
      prepared.forEach((resolution, i) => {
        if (!resolution) return
        const f = A.files[i]
        if (resolution.turnContractFailure) {
          f.refinePreparationFailed = true
          const failure = recordTurnContractFailure(A, f, resolution.turnContractFailure, 'prepare')
          engine.log(`精校 turn contract 输入生成失败：${f.label}（${failure.code}：${failure.message}）`)
          return
        }
        f.refinePath = resolution.refinePath || resolution.path || f.path
        f.refineSourcePath = resolution.path || f.path
        f.refineContract = resolution.refineContract || null
        if (Array.isArray(resolution.turns) && resolution.turns.length) f.turns = resolution.turns
        f.speakerResolution = {
          speakerMode: resolution.speakerMode || f.speakerMode || (resolution.labelLines ? 'tracked' : 'untracked'),
          mappings: resolution.mappings || [],
          unresolved: resolution.unresolved || [],
          changedLines: resolution.changedLines || 0,
          labelLines: resolution.labelLines || 0,
          structureWarnings: resolution.structureWarnings || [],
          recoveredByScout: resolution.recoveredByScout || [],
        }
        f.speakerMode = f.speakerResolution.speakerMode
        if (f.speakerResolution.structureWarnings.length) {
          speakerStructureWarnings.push({
            label: f.label,
            path: f.outPath,
            speakerMode: f.speakerResolution.speakerMode,
            warnings: f.speakerResolution.structureWarnings,
          })
          engine.log(`发言人结构待复核：${f.label} 有 ${f.speakerResolution.structureWarnings.length} 类解析/侦察不一致——本次质量状态将标记待复核`)
        }
        const renamed = f.speakerResolution.mappings.filter((m) => m.sourceLabel !== m.outputLabel)
        if (renamed.length) engine.log(`发言人统一：${f.label} 已在 Refine 输入中一次性应用 ${renamed.map((m) => `${m.sourceLabel}→${m.outputLabel}`).join('、')}`)
        if (f.speakerResolution.unresolved.length) engine.log(`发言人仍未识别：${f.label} 的 ${f.speakerResolution.unresolved.join('、')}（未猜名，保留源标签）`)
      })
    }
    engine.phase('Refine')
    engine.log(`▶ 3/${scope.includes('logic') ? 5 : 4} 精校 Refine：${A.files.length} 份逐份精校${A.chunkMode === 'speed' ? '（大文件分块并行）' : ''}`)
    // Refine runs even when scout failed for a file (findings[i] null): refine reads the source directly and
    // the glossary is only an aid, so a stalled cheap scout degrades the glossary but
    // never blocks the expensive pass. No barrier between files (pipeline).
    positional = await engine.pipeline(A.files,
      (f, _f, i) => f.refinePreparationFailed
        ? Promise.resolve(null)
        : refineFile(engine, f, glossary, refineGlossary, cleanFindings[i] || {}, A, M))
  }
  scoutFailed = A.files.filter((f, i) => scope.includes('refine') && positional[i] && !findings[i]).map((f) => f.label)
  if (scoutFailed.length) engine.log(`侦察未返回、已照常精校（校对表缺这几份实体，网络稳定后可重扫）：${scoutFailed.join('、')}`)
  failed = A.files.filter((f, i) => scope.includes('refine') && !positional[i]).map((f) => f.label)
  refined = positional.map((rep, i) => rep && Object.assign({}, rep, {
    outPath: A.files[i].outPath,
    complete: null,
    checkNote: '审计待跑',
    ...(A.files[i].speakerResolution ? { speakerResolution: A.files[i].speakerResolution } : {}),
  })).filter(Boolean)
  refinedPairs = A.files.map((f, i) => ({ f, rep: positional[i], anchor: cleanFindings[i] && cleanFindings[i].ending_anchor })).filter((p) => p.rep)
  if (failed.length) engine.log(`未完成：${failed.join('、')}（主代理需按 SKILL.md Step 1–2 手动补做）`)
}

// One output contract for BOTH the one-pass and standard branches. Tracked sources may use only the canonical
// mapping; untracked sources must remain untracked. Known aliases are rewritten deterministically. Unknown labels
// are left visible for the final fail-closed check below — never guessed or stripped.
if (scope.includes('refine') && refinedPairs.length && capabilities && typeof capabilities.enforceSpeakerOutput === 'function') {
  const normalized = await engine.parallel(refinedPairs.map(({ f, rep }) => async () => {
    if (!rep || rep.captured) return null
    try { return await capabilities.enforceSpeakerOutput(f, 'post_refine') } catch (e) {
      engine.log(`发言人输出收口失败：${f.label}（${(e && e.message) || e}）——最终结构契约将拒绝该草稿`)
      return { contractUnavailable: true, unknownLabels: [], violations: [] }
    }
  }))
  normalized.forEach((report, i) => {
    if (!report) return
    const { f, rep } = refinedPairs[i]
    f.speakerOutputReport = report
    const entry = {
      label: f.label,
      path: f.outPath,
      changedLines: report.changedLines || 0,
      replacements: report.replacements || [],
      unknownLabels: report.unknownLabels || [],
      valid: report.valid !== false && !report.contractUnavailable,
      violations: report.violations || [],
    }
    speakerOutputNormalizations.push(entry)
    if (entry.changedLines) engine.log(`发言人输出收口：${entry.label} 按全文统一映射修正 ${entry.changedLines} 个标签别名`)
    if (entry.unknownLabels.length) {
      const labels = [...new Set(entry.unknownLabels.map((x) => x.label))]
      engine.log(`发言人输出出现映射外候选：${entry.label} 的 ${labels.join('、')}——未自动猜改，将在最终结构契约中按需调用模型裁决`)
    }
  })
}
speakerResolutions = A.files.filter((f) => f.speakerResolution).map((f) => ({
  label: f.label,
  path: f.refineSourcePath || f.path,
  ...f.speakerResolution,
}))

// §2 Audit gate (in-pipeline): each refined file goes through the source-aware audit AFTER refine/stitch and
// BEFORE logic/summary/timeline. Any publication gate triggers at most two targeted auto-repair rounds,
// each followed by a re-audit; still-hard files are recorded in auditFailed (and get a visible 缺口 marker via --annotate).
// Anchors run on the (possibly repaired) 成稿. With fs the host injects capabilities.runAudit/annotateAnchors/
// repair; without (CC sandbox) a subagent runs audit_refined.mjs. Skipped for a scope with no refine output.
// M11b: on a batch-submit capture pass (A.captureSingleShot), no 成稿 is on disk yet (files are written on
// resume), so every captured rep is excluded from the audit gate here — resume runs the full audit after fetch.
const pairsToAudit = refinedPairs.filter((p) => !(p.rep && p.rep.captured))
if (scope.includes('refine') && pairsToAudit.length) {
  // Adjudicate residual shape candidates before the source-aware audit. Attribution uses the same parser, so
  // waiting until the final contract would let an uncertain label become a hard attribution mismatch first.
  const initialAdjudications = await engine.parallel(pairsToAudit.map(({ f }) => () => (
    adjudicateOutputSpeakerCandidates(engine, f, f.speakerOutputReport, M)
  )))
  pairsToAudit.forEach(({ f }, index) => {
    f.speakerCandidateAdjudication = initialAdjudications[index]
      || unavailableSpeakerCandidateAdjudication(f, f.speakerOutputReport, M)
  })

  engine.phase('Audit')
  engine.log(`▶ 审计门禁 Audit：${pairsToAudit.length} 份逐份源比对（正文忠实性 + 交付质量；有事务能力时最多候选修复 ${QUALITY_REPAIR_MAX_ROUNDS} 轮并逐轮复检；仍未过记入 auditFailed）`)
  // §1 one-pass branch: onePassGlossaryText (the minimal 用户钦定 rows) stands in for the outer `glossary`
  // (which is just the SINGLE_FILE_GLOSSARY placeholder there, and must NOT be handed to the audit — see
  // risk (a) test). Every multi-file pair lacks this key, so `glossary` (the real rendered 校对表) still flows
  // through unchanged.
  const results = await engine.parallel(pairsToAudit.map(({ f, onePassGlossaryText }) => () => runAuditStep(A, engine, f, capabilities, onePassGlossaryText || glossary)))
  const hasDirectAudit = !!(capabilities && typeof capabilities.runAudit === 'function')
  pairsToAudit.forEach(({ f }, k) => {
    const a = results[k] || { status: 'unavailable', auditUnavailable: true, failedFindings: [], hardFindings: [], softFindings: [], repaired: false, anchorsAdded: 0, directAudit: hasDirectAudit }
    qualityRepairAttempts.push(...(a.repairAttempts || []))
    const r = refined.find((x) => (x.outPath || x.path) === f.outPath)
    if (r) {
      r.audit = { status: a.status, hardFindings: a.hardFindings || [], softFindings: a.softFindings || [], repaired: !!a.repaired, repairAttempts: a.repairAttempts || [], anchorsAdded: a.anchorsAdded || 0, auditUnavailable: !!a.auditUnavailable }
      if (a.directAudit && !a.auditUnavailable) {
        r.complete = null
        r.checkNote = ''
      } else {
        r.complete = null
        r.checkNote = a.auditUnavailable ? 'audit unavailable' : 'no direct audit capability'
      }
    }
    if (!a.directAudit || a.auditUnavailable) unchecked.push(f.outPath)
    // P7: an audit that could NOT run (after one retry) fails the run loudly — distinct from the normal
    // "no direct audit capability" CC case (where the agent audit DID run). Only auditUnavailable qualifies.
    if (a.auditUnavailable) auditUnavailable.push({ path: f.outPath, label: f.label })
    if ((a.auditFailed || []).length) auditFailed.push({ path: f.outPath, findings: a.auditFailed })
    const seamDuplicates = (r && r.seamDuplicates) || []
    if (seamDuplicates.length) {
      if (r && r.audit) {
        r.audit.status = 'fail'
        r.audit.hardFindings = [...new Set([...(r.audit.hardFindings || []), 'seam_duplicate'])]
      }
      const existing = auditFailed.find((x) => x.path === f.outPath)
      if (existing) existing.findings = [...new Set([...(existing.findings || []), 'seam_duplicate'])]
      else auditFailed.push({ path: f.outPath, findings: ['seam_duplicate'] })
    }
  })
  if (auditFailed.length) engine.log(`审计未过（候选修复后仍 hard，或当前运行时无安全自动修复能力）：${auditFailed.map((x) => `${x.path}（${x.findings.join('/')}）`).join('；')}`)
  if (auditUnavailable.length) engine.log(`⚠ 审计无法运行 ${auditUnavailable.length} 份——本次运行判定为失败，产物未经审计：${auditUnavailable.map((x) => x.label).join('、')}`)
}

// Repairs are model writes too. Run the structural contract once more after the final audit/repair round and
// fail closed. The draft remains on disk for server-side diagnosis, but it is removed from `refined`, so the
// artifact manifest cannot advertise it as a deliverable main transcript.
if (scope.includes('refine') && pairsToAudit.length && capabilities && typeof capabilities.enforceSpeakerOutput === 'function') {
  const finalContracts = await engine.parallel(pairsToAudit.map(({ f }) => async () => {
    try { return await capabilities.enforceSpeakerOutput(f, 'final_contract') } catch (e) {
      engine.log(`发言人最终结构契约无法运行：${f.label}（${(e && e.message) || e}）`)
      return { contractUnavailable: true, valid: false, unknownLabels: [], violations: [] }
    }
  }))
  const adjudications = await engine.parallel(finalContracts.map((report, index) => async () => {
    if (!report || report.contractUnavailable || !outputSpeakerCandidates(report).length) return Promise.resolve(null)
    const f = pairsToAudit[index].f
    return reuseSpeakerCandidateAdjudication(f.speakerCandidateAdjudication, f, report)
      || adjudicateOutputSpeakerCandidates(engine, f, report, M)
  }))
  const rejectedPaths = new Set()
  finalContracts.forEach((report, index) => {
    const { f } = pairsToAudit[index]
    const adjudication = adjudications[index] || unavailableSpeakerCandidateAdjudication(f, report, M)
    f.speakerCandidateAdjudication = adjudication || null
    if (adjudication) speakerCandidateAdjudications.push(adjudication)
    const decisions = (adjudication && adjudication.decisions) || []
    const blockedCandidates = decisions.filter((item) => item.outcome === 'block')
    const reviewCandidates = decisions.filter((item) => item.outcome === 'review')
    const rawCandidates = outputSpeakerCandidates(report)
    const invalid = !report
      || report.contractUnavailable
      || blockedCandidates.length > 0
      || (report.valid === false && rawCandidates.length === 0)
    if (reviewCandidates.length) {
      const labels = [...new Set(reviewCandidates.map((item) => item.label))]
      const lines = [...new Set(reviewCandidates.map((item) => item.line))]
      speakerStructureWarnings.push({
        label: f.label,
        path: f.outPath,
        speakerMode: (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode || null,
        warnings: [{
          kind: adjudication && adjudication.status === 'unavailable'
            ? 'speaker_candidate_adjudication_unavailable'
            : 'output_speaker_candidate_unresolved',
          count: reviewCandidates.length,
          lines,
          labels,
        }],
      })
      const question = `成稿有 ${reviewCandidates.length} 处疑似映射外说话人候选，模型未能高置信确认是否为新增说话人：${reviewCandidates.map((item) => `第 ${item.line} 行“${item.label}”`).join('、')}。请人工复核。`
      const pair = refinedPairs.find((item) => item.f.outPath === f.outPath)
      if (pair && pair.rep) pair.rep.open_questions = [...(pair.rep.open_questions || []), question]
      const refinedEntry = refined.find((item) => (item.outPath || item.path) === f.outPath)
      if (refinedEntry) refinedEntry.open_questions = [...(refinedEntry.open_questions || []), question]
      engine.log(`发言人候选待复核：${f.label} 的 ${labels.join('、')}——模型裁决不确定或不可用，不阻断成稿`)
    }
    if (!invalid) return
    rejectedPaths.add(f.outPath)
    const labels = [...new Set(blockedCandidates.map((item) => item.label).filter(Boolean))]
    const reason = report && report.contractUnavailable
      ? 'speaker_contract_unavailable'
      : 'speaker_structure'
    speakerStructuralFailures.push({
      path: f.outPath,
      label: f.label,
      finding: reason,
      speakerMode: (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode || null,
      labels,
      violations: blockedCandidates,
    })
    const existing = auditFailed.find((item) => item.path === f.outPath)
    if (existing) existing.findings = [...new Set([...(existing.findings || []), reason])]
    else auditFailed.push({ path: f.outPath, findings: [reason] })
    const refinedEntry = refined.find((item) => (item.outPath || item.path) === f.outPath)
    if (refinedEntry && refinedEntry.audit) {
      refinedEntry.audit.status = 'fail'
      refinedEntry.audit.hardFindings = [...new Set([...(refinedEntry.audit.hardFindings || []), reason])]
    }
    failed.push(f.label)
    engine.log(`发言人结构契约未通过：${f.label}${labels.length ? `（模型高置信确认新增说话人：${labels.join('、')}）` : ''}——草稿仅留服务端诊断，不声明为可交付主稿`)
  })
  if (rejectedPaths.size) {
    failed = [...new Set(failed)]
    refined = refined.filter((item) => !rejectedPaths.has(item.outPath || item.path))
    refinedPairs = refinedPairs.filter(({ f }) => !rejectedPaths.has(f.outPath))
  }
}

// Final identity is a registry update, never a Markdown edit. Only bodies that already passed the normal
// source-aware gate are eligible. The host asks for stable track-ID assignments, updates the one speakerTracks
// registry, deterministically renders the complete transcript from output blocks, then this pipeline audits that
// exact rendered body again (without opening a new repair budget) before any derivative may read it.
if (scope.includes('refine') && refinedPairs.length && capabilities && typeof capabilities.finalizeSpeakerIdentity === 'function') {
  const identityPairs = refinedPairs.filter(({ f }) => {
    const entry = refined.find((item) => (item.outPath || item.path) === f.outPath)
    return f.refineContractFinalized && f.refineContract
      && entry && entry.audit && entry.audit.status === 'ok'
      && !auditFailed.some((item) => item.path === f.outPath)
      && !auditUnavailable.some((item) => item.path === f.outPath)
  })
  if (identityPairs.length) {
    engine.phase('Audit')
    engine.log(`▶ 最终身份：${identityPairs.length} 份按 speaker track 注册表定稿，确定性重渲染后重新审计`)
    const finalizations = await engine.parallel(identityPairs.map(({ f }) => async () => {
      try { return await capabilities.finalizeSpeakerIdentity(f) } catch (error) {
        engine.log(`最终身份定稿失败：${f.label}（${(error && error.message) || error}）`)
        return null
      }
    }))
    finalizations.forEach((finalization, index) => {
      const { f } = identityPairs[index]
      if (finalization) {
        speakerIdentityFinalizations.push(finalization)
        const entry = refined.find((item) => (item.outPath || item.path) === f.outPath)
        if (entry) entry.speakerResolution = f.speakerResolution || null
      } else {
        const finding = 'speaker_identity_finalization_unavailable'
        const existing = auditFailed.find((item) => item.path === f.outPath)
        if (existing) existing.findings = [...new Set([...(existing.findings || []), finding])]
        else auditFailed.push({ path: f.outPath, findings: [finding] })
      }
    })

    const finalizedPairs = identityPairs.filter((_pair, index) => finalizations[index])
    const finalAudits = await engine.parallel(finalizedPairs.map(({ f, onePassGlossaryText }) => () => (
      runAuditStep(
        A,
        engine,
        f,
        capabilities,
        onePassGlossaryText || glossary,
        { allowRepair: false, phase: 'post_identity_finalization' },
      )
    )))
    finalizedPairs.forEach(({ f }, index) => {
      const result = finalAudits[index] || {
        status: 'unavailable', auditUnavailable: true, hardFindings: [], softFindings: [],
        repaired: false, repairAttempts: [], anchorsAdded: 0, directAudit: false,
      }
      auditFailed = auditFailed.filter((item) => item.path !== f.outPath)
      auditUnavailable = auditUnavailable.filter((item) => item.path !== f.outPath)
      const entry = refined.find((item) => (item.outPath || item.path) === f.outPath)
      if (entry) {
        entry.audit = {
          status: result.status,
          hardFindings: result.hardFindings || [],
          softFindings: result.softFindings || [],
          repaired: !!result.repaired,
          repairAttempts: result.repairAttempts || [],
          anchorsAdded: result.anchorsAdded || 0,
          auditUnavailable: !!result.auditUnavailable,
        }
      }
      if (result.auditUnavailable) auditUnavailable.push({ path: f.outPath, label: f.label })
      if ((result.auditFailed || []).length) auditFailed.push({ path: f.outPath, findings: result.auditFailed })
    })
    if (A.files.length === 1 && refined.length === 1 && speakerIdentityFinalizations.length === 1) {
      transcriptMetadata = speakerIdentityFinalizations[0].metadata || null
    }
  }
}

// Re-read the public mapping view from the registry after final identity. This view is derived metadata for
// manifests and downstream naming; renderer and audit never consume it as an authority.
speakerResolutions = A.files.filter((f) => f.speakerResolution).map((f) => ({
  label: f.label,
  path: f.refineSourcePath || f.path,
  ...f.speakerResolution,
}))

// Derivatives may only read FINAL bodies. The main transcript is still delivered when blocked (with review /
// visible markers), but logic/summary/timeline are withheld rather than fossilising a known gap or speaker swap.
const derivativesRequested = ['logic', 'summary', 'timeline'].filter((x) => scope.includes(x))
const finalBodiesReady = refined.length > 0
  && failed.length === 0
  && auditFailed.length === 0
  && auditUnavailable.length === 0
  && pairsToAudit.length === refinedPairs.length
  && refined.every((r) => r.audit && r.audit.status === 'ok')
if (derivativesRequested.length && !finalBodiesReady) {
  derivativesSkipped = derivativesRequested.map((kind) => ({ kind, reason: '正文未完成或忠实性审计未通过' }))
  engine.log(`派生产物暂停：${derivativesRequested.join('、')}——正文未完成或忠实性审计未通过；主成稿与 review 仍照常交付`)
}
const derivativePairs = finalBodiesReady ? refinedPairs : []

// Logic-order resequencing (optional): reads each refined transcript and reorders it into narrative order, run concurrently. Completeness is verified by a zero-cost JS check —
// diff the headings in the refine report against threads[].source_sections in the logic report; any headings not covered go into missingSections.
let logic = []
if (scope.includes('logic') && derivativePairs.length) {
  engine.phase('Logic')
  engine.log(`▶ 4/5 逻辑顺序 Logic：${derivativePairs.length} 份按主线重排为叙事顺序`)
  // Build one logic entry from a (report, refine-report) pair. safeName(f.title) so a title with a slash / colon
  // can't fabricate a nested directory under 逻辑顺序/ (§3). missingSections = refine小标题 not covered by threads.
  const toEntry = (lrep, f, rep) => {
    if (!lrep) return { label: f.label, path: null, mainline: '', threads: [], missingSections: [], open_questions: [] }
    const covered = new Set((lrep.threads || []).flatMap((t) => ((t && t.source_sections) || []).map(canonicalHeadingKey).filter(Boolean)))
    const srcHeadings = ((rep && rep.headings) || []).map((h) => (h || '').trim()).filter(Boolean)
    const missing = srcHeadings.filter((h) => !covered.has(canonicalHeadingKey(h)))
    return { label: f.label, path: `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md`, mainline: lrep.mainline || '', threads: (lrep.threads || []).map((t) => t && t.title).filter(Boolean), missingSections: missing, open_questions: lrep.open_questions || [] }
  }
  const lreps = await engine.parallel(derivativePairs.map(({ f }) => () =>
    engine.agent(logicWritePrompt(f, A), { label: `logic:${f.label}`, phase: 'Logic', model: M.logic, effort: effortFor(A, 'logic'), schema: LOGIC_REPORT_SCHEMA, outputPath: `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md` })))
  logic = lreps.map((lrep, k) => toEntry(lrep, derivativePairs[k].f, derivativePairs[k].rep))
  // §5 missingSections auto-rerun (cap 1): any file whose first pass dropped ≥1 refine小标题 is re-run ONCE with
  // the omitted headings named as a must-include list. If the rerun still omits some, keep the (better of the
  // two) entry — the residual missing stays in the return for a Step-5 spot-check (current behaviour preserved).
  const rerunIdx = logic.map((l, k) => (l.path && l.missingSections.length) ? k : -1).filter((k) => k >= 0)
  if (rerunIdx.length) {
    engine.log(`逻辑顺序补漏：${rerunIdx.map((k) => `${logic[k].label}(${logic[k].missingSections.join('/')})`).join('；')}——各自动重跑一次，点名遗漏小标题`)
    const reReps = await engine.parallel(rerunIdx.map((k) => () => {
      const { f } = derivativePairs[k]
      return engine.agent(logicWritePrompt(f, A, logic[k].missingSections), { label: `logic-rerun:${f.label}`, phase: 'Logic', model: M.logic, effort: effortFor(A, 'logic'), schema: LOGIC_REPORT_SCHEMA, outputPath: `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md` })
    }))
    rerunIdx.forEach((k, j) => {
      const re = reReps[j]
      if (!re) return // rerun failed → keep the first-pass entry
      const entry = toEntry(re, derivativePairs[k].f, derivativePairs[k].rep)
      // Adopt the rerun only if it covers at least as many headings (fewer missing); otherwise keep the first pass.
      if (entry.path && entry.missingSections.length <= logic[k].missingSections.length) logic[k] = entry
    })
  }
  const failedLogic = logic.filter((l) => !l.path).map((l) => l.label)
  const missLogic = logic.filter((l) => l.missingSections && l.missingSections.length)
  engine.log(`逻辑顺序稿完成 ${logic.filter((l) => l.path).length}/${derivativePairs.length} 份${failedLogic.length ? `（${failedLogic.join('、')} 失败）` : ''}`)
  if (missLogic.length) engine.log(`逻辑顺序稿疑漏小标题（重跑后仍疑漏，按精校稿小标题覆盖核对，需抽查）：${missLogic.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
}

engine.phase('Deliver')
if (finalBodiesReady && (scope.includes('summary') || scope.includes('timeline'))) {
  engine.log(`▶ 交付 Deliver：${[scope.includes('summary') && '访谈总结', scope.includes('timeline') && '时间线'].filter(Boolean).join(' + ')}`)
}
const [summary, timeline] = await engine.parallel([
  () => (scope.includes('summary') && finalBodiesReady
    ? engine.agent(summaryPrompt(A, refined), { label: 'summary', phase: 'Deliver', model: M.summary, effort: effortFor(A, 'summary'), outputPath: `${A.outputDir}/${summaryDeliverableName(A.topic)}` })
    : Promise.resolve(null)),
  () => (scope.includes('timeline') && finalBodiesReady
    ? engine.agent(timelinePrompt(A, glossary, refined), { label: 'timeline', phase: 'Deliver', model: M.timeline, effort: effortFor(A, 'timeline'), outputPath: `${A.outputDir}/${timelineDeliverableName(A.topic)}` })
    : Promise.resolve(null)),
])


return {
  glossary,
  refineMode: A.refineMode === 'single-shot' ? 'single-shot' : 'agentic',  // M11a: run-level refine mode (per-file singleShot/refused markers ride on each refined[i])
  refined,
  failed,
  incomplete,
  unchecked,
  headingConflicts,
  scoutSuspect,
  scoutFailed,
  suspectedDuplicates: (dedup && dedup.suspects) || [],
  networkUnverified: netUnverified,
  auditFailed,   // §2: [{ path, findings:['content_gap',…] }] — hard audit findings still failing after at most two repair rounds
  auditUnavailable,   // P7: [{ path, label }] — files whose audit could NOT run after one retry → run marked failed (unaudited)
  plannedChunks: A.plannedChunks || [],   // recorded before any refine agent starts, so failed files remain diagnosable
  speakerResolutions,
  speakerOutputNormalizations,
  speakerStructuralFailures,
  speakerStructureWarnings,
  speakerCandidateAdjudications,
  speakerIdentityFinalizations,
  transcriptMetadata,
  qualityRepairAttempts,
  turnContractFailures: A.turnContractFailures || [],
  autoChunk: (A.plannedChunks || []).map((p) => p.autoChunk).filter(Boolean),   // includes failed provider-budget splits
  logic,
  derivativesSkipped,
  openQuestions: refined.flatMap((r) => r.open_questions || []).concat(dedupQuestions(dedup)).concat(logic.flatMap((l) => l.open_questions || [])).concat(conflicts).concat(weakDups).concat(asrSuspects).concat(contestedAsks).concat(overrideQuestions).concat(reopenNotes).concat(derivativesSkipped.map((x) => `${x.kind} 未生成：${x.reason}`)),
  summary,
  timeline,
}
}
