import { entitySchema, SCOUT_SCHEMA, VERIFY_SCHEMA, REFINE_REPORT_SCHEMA, DEDUP_SCHEMA, LOGIC_REPORT_SCHEMA, RULES, TYPESET, SINGLE_FILE_GLOSSARY, isWeakKey, stripDesc, longestHanziRun, scoutLooksGarbled, clusterEntities, mergeFindings, VERIFY_CHUNK, MAX_CHUNKS, entityWorth, verifyChunks, dedupListText, splitForRefine, splitForScout, mergeScoutChunks, refineSize, ONE_PASS_CHARS, findHeadingConflicts, renderGlossary, renderRefineGlossary, cleanSuspects, splitSuspects, pickNetworkUnverified, suspectUnverified, dedupQuestions, parseGlossary, mergeIntoPrior, mergeVerified, mergeDedup, excludeVerified, buildSpeakerRegistry, glossaryConflicts, weakDupFlags, applyOverridesToMerged, dropLocked, safeName, contradictionReopen, rotateReverify, ROTATE_REVERIFY } from './spec.js'
import { READ_PAGE, READ_BYTES_PER_PAGE, readPlan, headingNote, scoutPrompt, verifyPrompt, refinePrompt, stitchPrompt, dedupPrompt, singlePassPrompt, summaryPrompt, timelinePrompt, logicWritePrompt } from './prompts.js'

// Refine one file. Cost mode (default), or a small file → one agent. Speed mode + a large file (> REFINE_CHUNK_CHARS
// 字) → up to MAX_REFINE_CHUNKS parallel chunk agents writing <outPath>.part{idx}, merged deterministically
// when the host injects fs capability, or by a cheap stitch agent in the Workflow sandbox. Returns a
// REFINE_REPORT-shaped object (path = f.outPath) or null if it
// could not produce an output. A failed chunk is surfaced via open_questions (and caught downstream by the
// source-aware audit) rather than silently dropped.
async function refineFile(engine, f, glossary, refineGlossary, finding, A, M) {
  const chunks = splitForRefine(f, A.chunkMode)
  if (chunks.length <= 1) {
    // Single agent → full glossary (no token multiplication on one agent).
    return engine.agent(refinePrompt(f, glossary, finding, A),
      { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA })
  }
  engine.log(`精校分块：${f.label}（${f.lines} 行）拆 ${chunks.length} 块并行精校，再拼接`)
  // Chunk agents get the CONDENSED glossary — it's sent to all K of them, so trimming it is the main
  // lever on chunked-refine token cost; 写法 stay identical (verified canonicals applied the same way).
  const partReps = await engine.parallel(chunks.map((c) => () =>
    engine.agent(refinePrompt(f, refineGlossary, finding, A, c),
      { label: `refine:${f.label}#${c.idx}/${chunks.length}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA })))
  const good = partReps.filter(Boolean)
  if (!good.length) { engine.log(`精校分块：${f.label} 全部 ${chunks.length} 块失败`); return null }
  const warn = chunks.filter((c, i) => !partReps[i]).map((c) => `分块精校第 ${c.idx}/${chunks.length} 块（源文件约第 ${c.startLine}–${c.endLine} 行）失败，成稿可能缺这一段——建议对该份重跑精校`)
  if (warn.length) engine.log(`精校分块：${f.label} ${warn.length}/${chunks.length} 块失败——已并入 openQuestions，审计会进一步标记`)
  const cap = (A && A.capabilities) || {}
  if (typeof cap.stitch === 'function') {
    try {
      const stitched = await cap.stitch(f, chunks)
      if (stitched == null) { engine.log(`精校分块：${f.label} 确定性拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
      engine.log(`精校分块：${f.label} 已确定性拼接 ${chunks.length} 块`)
    } catch (e) {
      engine.log(`精校分块：${f.label} 确定性拼接失败：${(e && e.message) || e}`)
      return null
    }
  } else {
    const stitched = await engine.agent(stitchPrompt(f, chunks), { label: `stitch:${f.label}`, phase: 'Refine', model: M.stitch })
    if (stitched == null) { engine.log(`精校分块：${f.label} 拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
  }
  return {
    path: f.outPath,
    headings: good.flatMap((r) => r.headings || []),
    key_fixes: good.flatMap((r) => r.key_fixes || []),
    open_questions: good.flatMap((r) => r.open_questions || []).concat(warn),
    chunked: chunks.length,
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
    return engine.agent(scoutPrompt(f, A), { label: `${labelPrefix}:${f.label}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })
  }
  engine.log(`侦察分块：大文件 ${f.label}（约 ${refineSize(f)} 字）拆 ${chunks.length} 段并行侦察，防单代理卡死`)
  const parts = await engine.parallel(chunks.map((c) => () =>
    engine.agent(scoutPrompt(f, A, c), { label: `${labelPrefix}:${f.label}#${c.idx}/${c.count}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })))
  return mergeScoutChunks(parts, f)
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

// Per-file quality gate (Wave 2): the source-aware audit is now IN the pipeline, not a report jobs.js runs
// afterwards. With fs (Universal) the host injects capabilities.runAudit (direct auditPairs call); in the CC
// sandbox there is no fs, so a stitch/haiku subagent runs `node <skillDir>/audit_refined.mjs` and echoes the
// JSON. content_gap(hard) or quote_style(hard) → optionally auto-repair once (capabilities.repair, or a refine
// subagent with Read/Edit in CC), re-audit ONCE, and if still hard mark the file auditFailed + drop a visible
// 缺口 marker (--annotate). Then run source anchors (capability or the same agent with --anchors). Never throws:
// an unavailable audit degrades to { status:'unavailable', auditUnavailable:true }.
async function runAuditStep(A, engine, f, capabilities, glossaryText) {
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
  async function audit() {
    if (typeof cap.runAudit === 'function') {
      // Pass the in-memory glossary so the capability doesn't have to read a not-yet-persisted file (risk a).
      try { return normalizeAuditResult(await cap.runAudit(f, { glossaryText: memGlossary }), f) } catch { return null }
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
    const cmd = `node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)}${glossaryArg}`
    const prompt = `${stagePreamble}用 Bash 运行下面这条命令，把它打印到 stdout 的 JSON **原样**返回（不要任何解释、不要加代码围栏、不要改动）：\n${cmd}`
    let raw = await engine.agent(prompt, { label: `audit:${f.label}`, phase: 'Audit', model: 'haiku' })
    let parsed = parseAuditJson(raw)
    if (!parsed) { // one retry
      raw = await engine.agent(prompt, { label: `audit-retry:${f.label}`, phase: 'Audit', model: 'haiku' })
      parsed = parseAuditJson(raw)
    }
    return normalizeAuditResult(parsed, f)
  }

  const first = await audit()
  if (!first) { engine.log(`审计不可用：${f.label}（子代理未能返回可解析 JSON，降级为仅记录，不阻断）`); return { status: 'unavailable', auditUnavailable: true, failedFindings: [], hardFindings: [], softFindings: [], repaired: false, anchorsAdded: 0, directAudit } }

  const hardOf = (r) => (r.failed || []).filter((k) => k === 'content_gap' || k === 'quote_style')
  const softOf = (r) => (r.failed || []).filter((k) => k !== 'content_gap' && k !== 'quote_style')
  let cur = first
  let hard = hardOf(cur)
  let repaired = false

  if (hard.length) {
    engine.log(`审计 hard：${f.label} → ${hard.join('、')}——尝试自动修复一次`)
    const gaps = (cur.gaps || []).filter((g) => g.severity === 'hard')
    const gapLines = gaps.map((g) => `源第 ${g.startLine}-${g.endLine} 行（约 ${g.chars} 字）`).join('；') || '（见审计 gaps）'
    let didRepair = false
    if (typeof cap.repair === 'function') {
      try { await cap.repair(f, { gaps, hard }); didRepair = true } catch { didRepair = false }
    } else if (typeof cap.runAudit !== 'function') {
      // CC path: a refine-tier subagent with Read/Edit patches ONLY the flagged spots in the on-disk 成稿.
      const parts = []
      if (hard.includes('content_gap')) parts.push(`· 内容缺口：把源文件这些行区间的实质内容按精校规范补进成稿的对应位置：${gapLines}。`)
      if (hard.includes('quote_style')) parts.push('· 直引号：把正文里紧贴中文的 ASCII 直引号（以及任何「」『』）改成全角弯引号 “”（内层 ‘’）。')
      await engine.agent(
        `用 Read 打开成稿 ${out}（必要时也 Read 源文件 ${src} 对照），只修下面点名的位置、用 Edit 直接改 ${out}，**不得改动其它任何内容、不得重写全文**：\n${parts.join('\n')}\n改完用一句话回复即可。`,
        { label: `repair:${f.label}`, phase: 'Audit', model: 'refine' })
      didRepair = true
    }
    if (didRepair) {
      const again = await audit()
      if (again) { cur = again; repaired = true; hard = hardOf(cur); engine.log(`审计复检：${f.label} → ${hard.length ? 'hard 仍在：' + hard.join('、') : '已通过'}`) }
    }
  }

  const auditFailed = hard.length ? hard.slice() : []
  // Still hard after (at most one) repair → drop a visible 内容缺口/引号 marker so the document shows the defect.
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

  return { status: auditFailed.length ? 'fail' : 'ok', auditFailed, failedFindings: (cur.failed || []).filter(Boolean), hardFindings: hard, softFindings: softOf(cur), repaired, anchorsAdded, directAudit }
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
  { scout: 'haiku', verify: 'sonnet', dedup: 'sonnet', refine: 'opus', stitch: 'haiku', logic: 'opus', summary: 'opus', timeline: 'opus' },
  A.models || {}
)
const scope = A.scope || ['refine']
const capabilities = A.capabilities || null
const EMPTY_RETURN = (error) => ({ error, glossary: '', refined: [], failed: [], incomplete: [], unchecked: [], headingConflicts: [], scoutSuspect: [], scoutFailed: [], suspectedDuplicates: [], networkUnverified: [], logic: [], openQuestions: [], summary: null, timeline: null, auditFailed: [] })
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
let refined = []
let failed = []
let headingConflicts = []
let scoutSuspect = []
let scoutFailed = []   // files whose scout returned nothing (stalled) — refined anyway (glossary degraded), surfaced for re-scout
let dedup = null
let auditFailed = []    // §2: per-file hard audit findings (content_gap/quote_style) still failing after one repair
let incomplete = []     // Derived from direct deterministic audit ending_missing failures.
let unchecked = []      // Refined files lacking a direct audit capability, or whose audit errored.
let overrideQuestions = []   // SF-2 + risk(c): decree conflicts (one cluster claimed by ≥2 decrees) and cross-category mis-declared-category warnings → openQuestions
let refinedPairs = []   // [{ f, rep }]: successfully refined files and their reports (including headings); used by the logic-reorder phase to read f.title/outPath and verify section-heading coverage

if (A.files.length === 1 && refineSize(A.files[0]) < ONE_PASS_CHARS) {
  // Single short file: one-pass refine (mirrors the fast path in SKILL.md), skip Scout/Verify.
  // Length judged by 正文字数, not lines.
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
  const rep = await engine.agent(singlePassPrompt(f, A, overrideNote), { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA })
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
  engine.log(`▶ 2/${scope.includes('logic') ? 5 : 4} 核实 Verify：关键实体联网核实 + 语义同指排查`)
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
      ? engine.parallel(vc.chunks.map((ct, i) => () => engine.agent(verifyPrompt(ct, A), { label: `verify:${i + 1}/${vc.chunks.length}`, phase: 'Verify', model: M.verify, schema: VERIFY_SCHEMA })))
      : Promise.resolve([]),
    () => dedupList && !skipDedup
      ? engine.agent(dedupPrompt(dedupList, A), { label: 'dedup:semantic', phase: 'Verify', model: M.dedup, schema: DEDUP_SCHEMA })
      : Promise.resolve(null),
  ])
  const goodParts = (vparts || []).filter(Boolean)
  if (vc.chunks.length) {
    // Row-level sanitisation: the schema no longer enforces fields, so degraded output may be missing query/canonical — rows missing critical fields are dropped outright
    verified = {
      resolved: goodParts.flatMap((p) => p.resolved || []).filter((r) => r && r.query && r.canonical),
      unresolved: goodParts.flatMap((p) => p.unresolved || []).filter((r) => r && r.query),
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
  if (weakDups.length) engine.log(`称呼歧义：${weakDups.length} 个弱称呼跨批次重复（未合并）——并入 openQuestions 待人工辨认`)
  if (prior) engine.log(`累积合并：校对表现含 ${merged.people.length} 人名 / ${merged.brands.length} 品牌 / ${merged.terms.length} 术语`)
  glossary = renderGlossary(merged, allVerified, allDedup, A)
  // Condensed glossary for chunk-refine agents (full 校对表 still persisted + used by single-agent refine).
  const refineGlossary = renderRefineGlossary(merged, allVerified, allDedup, A)

  let positional = []
  if (scope.includes('refine')) {
    engine.phase('Refine')
    engine.log(`▶ 3/${scope.includes('logic') ? 5 : 4} 精校 Refine：${A.files.length} 份逐份精校${A.chunkMode === 'speed' ? '（大文件分块并行）' : ''}`)
    // Refine runs even when scout failed for a file (findings[i] null): refine reads the source directly and
    // the glossary is only an aid, so a stalled cheap scout degrades the glossary but
    // never blocks the expensive pass. No barrier between files (pipeline).
    positional = await engine.pipeline(A.files,
      (f, _f, i) => refineFile(engine, f, glossary, refineGlossary, findings[i] || {}, A, M))
  }
  scoutFailed = A.files.filter((f, i) => scope.includes('refine') && positional[i] && !findings[i]).map((f) => f.label)
  if (scoutFailed.length) engine.log(`侦察未返回、已照常精校（校对表缺这几份实体，网络稳定后可重扫）：${scoutFailed.join('、')}`)
  failed = A.files.filter((f, i) => scope.includes('refine') && !positional[i]).map((f) => f.label)
  refined = positional.map((rep, i) => rep && Object.assign({}, rep, { outPath: A.files[i].outPath, complete: null, checkNote: '审计待跑' })).filter(Boolean)
  refinedPairs = A.files.map((f, i) => ({ f, rep: positional[i], anchor: findings[i] && findings[i].ending_anchor })).filter((p) => p.rep)
  if (failed.length) engine.log(`未完成：${failed.join('、')}（主代理需按 SKILL.md Step 1–2 手动补做）`)
}

// §2 Audit gate (in-pipeline): each refined file goes through the source-aware audit AFTER refine/stitch and
// BEFORE logic/summary/timeline. A hard content_gap or quote_style triggers one auto-repair +
// one re-audit; still-hard files are recorded in auditFailed (and get a visible 缺口 marker via --annotate).
// Anchors run on the (possibly repaired) 成稿. With fs the host injects capabilities.runAudit/annotateAnchors/
// repair; without (CC sandbox) a subagent runs audit_refined.mjs. Skipped for a scope with no refine output.
if (scope.includes('refine') && refinedPairs.length) {
  engine.phase('Audit')
  engine.log(`▶ 审计门禁 Audit：${refinedPairs.length} 份逐份源比对（content_gap / 引号 hard → 自动修复一次 → 复检；仍 hard 记入 auditFailed）`)
  // §1 one-pass branch: onePassGlossaryText (the minimal 用户钦定 rows) stands in for the outer `glossary`
  // (which is just the SINGLE_FILE_GLOSSARY placeholder there, and must NOT be handed to the audit — see
  // risk (a) test). Every multi-file pair lacks this key, so `glossary` (the real rendered 校对表) still flows
  // through unchanged.
  const results = await engine.parallel(refinedPairs.map(({ f, onePassGlossaryText }) => () => runAuditStep(A, engine, f, capabilities, onePassGlossaryText || glossary)))
  const hasDirectAudit = !!(capabilities && typeof capabilities.runAudit === 'function')
  refinedPairs.forEach(({ f }, k) => {
    const a = results[k] || { status: 'unavailable', auditUnavailable: true, failedFindings: [], hardFindings: [], softFindings: [], repaired: false, anchorsAdded: 0, directAudit: hasDirectAudit }
    const endingMissing = (a.failedFindings || []).includes('ending_missing') || (a.softFindings || []).includes('ending_missing')
    const r = refined.find((x) => (x.outPath || x.path) === f.outPath)
    if (r) {
      r.audit = { status: a.status, hardFindings: a.hardFindings || [], softFindings: a.softFindings || [], repaired: !!a.repaired, anchorsAdded: a.anchorsAdded || 0, auditUnavailable: !!a.auditUnavailable }
      if (a.directAudit && !a.auditUnavailable) {
        r.complete = !endingMissing
        r.checkNote = endingMissing ? 'deterministic audit: ending_missing' : ''
      } else {
        r.complete = null
        r.checkNote = a.auditUnavailable ? 'audit unavailable' : 'no direct audit capability'
      }
    }
    if (a.directAudit && !a.auditUnavailable && endingMissing) incomplete.push({ path: f.outPath, note: 'deterministic audit: ending_missing' })
    if (!a.directAudit || a.auditUnavailable) unchecked.push(f.outPath)
    if ((a.auditFailed || []).length) auditFailed.push({ path: f.outPath, findings: a.auditFailed })
  })
  if (auditFailed.length) engine.log(`审计未过（自动修复后仍 hard）：${auditFailed.map((x) => `${x.path}（${x.findings.join('/')}）`).join('；')}`)
}

// Logic-order resequencing (optional): reads each refined transcript and reorders it into narrative order, run concurrently. Completeness is verified by a zero-cost JS check —
// diff the headings in the refine report against threads[].source_sections in the logic report; any headings not covered go into missingSections.
let logic = []
if (scope.includes('logic') && refinedPairs.length) {
  engine.phase('Logic')
  engine.log(`▶ 4/5 逻辑顺序 Logic：${refinedPairs.length} 份按主线重排为叙事顺序`)
  // Build one logic entry from a (report, refine-report) pair. safeName(f.title) so a title with a slash / colon
  // can't fabricate a nested directory under 逻辑顺序/ (§3). missingSections = refine小标题 not covered by threads.
  const toEntry = (lrep, f, rep) => {
    if (!lrep) return { label: f.label, path: null, mainline: '', threads: [], missingSections: [], open_questions: [] }
    const covered = new Set((lrep.threads || []).flatMap((t) => ((t && t.source_sections) || []).map((s) => (s || '').trim()).filter(Boolean)))
    const srcHeadings = ((rep && rep.headings) || []).map((h) => (h || '').trim()).filter(Boolean)
    const missing = srcHeadings.filter((h) => !covered.has(h))
    return { label: f.label, path: `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md`, mainline: lrep.mainline || '', threads: (lrep.threads || []).map((t) => t && t.title).filter(Boolean), missingSections: missing, open_questions: lrep.open_questions || [] }
  }
  const lreps = await engine.parallel(refinedPairs.map(({ f }) => () =>
    engine.agent(logicWritePrompt(f, A), { label: `logic:${f.label}`, phase: 'Logic', model: M.logic, schema: LOGIC_REPORT_SCHEMA })))
  logic = lreps.map((lrep, k) => toEntry(lrep, refinedPairs[k].f, refinedPairs[k].rep))
  // §5 missingSections auto-rerun (cap 1): any file whose first pass dropped ≥1 refine小标题 is re-run ONCE with
  // the omitted headings named as a must-include list. If the rerun still omits some, keep the (better of the
  // two) entry — the residual missing stays in the return for a Step-5 spot-check (current behaviour preserved).
  const rerunIdx = logic.map((l, k) => (l.path && l.missingSections.length) ? k : -1).filter((k) => k >= 0)
  if (rerunIdx.length) {
    engine.log(`逻辑顺序补漏：${rerunIdx.map((k) => `${logic[k].label}(${logic[k].missingSections.join('/')})`).join('；')}——各自动重跑一次，点名遗漏小标题`)
    const reReps = await engine.parallel(rerunIdx.map((k) => () => {
      const { f } = refinedPairs[k]
      return engine.agent(logicWritePrompt(f, A, logic[k].missingSections), { label: `logic-rerun:${f.label}`, phase: 'Logic', model: M.logic, schema: LOGIC_REPORT_SCHEMA })
    }))
    rerunIdx.forEach((k, j) => {
      const re = reReps[j]
      if (!re) return // rerun failed → keep the first-pass entry
      const entry = toEntry(re, refinedPairs[k].f, refinedPairs[k].rep)
      // Adopt the rerun only if it covers at least as many headings (fewer missing); otherwise keep the first pass.
      if (entry.path && entry.missingSections.length <= logic[k].missingSections.length) logic[k] = entry
    })
  }
  const failedLogic = logic.filter((l) => !l.path).map((l) => l.label)
  const missLogic = logic.filter((l) => l.missingSections && l.missingSections.length)
  engine.log(`逻辑顺序稿完成 ${logic.filter((l) => l.path).length}/${refinedPairs.length} 份${failedLogic.length ? `（${failedLogic.join('、')} 失败）` : ''}`)
  if (missLogic.length) engine.log(`逻辑顺序稿疑漏小标题（重跑后仍疑漏，按精校稿小标题覆盖核对，需抽查）：${missLogic.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
}

engine.phase('Deliver')
if (refined.length && (scope.includes('summary') || scope.includes('timeline'))) {
  engine.log(`▶ 交付 Deliver：${[scope.includes('summary') && '访谈总结', scope.includes('timeline') && '时间线'].filter(Boolean).join(' + ')}`)
}
const [summary, timeline] = await engine.parallel([
  () => (scope.includes('summary') && refined.length
    ? engine.agent(summaryPrompt(A, refined), { label: 'summary', phase: 'Deliver', model: M.summary })
    : Promise.resolve(null)),
  () => (scope.includes('timeline') && refined.length
    ? engine.agent(timelinePrompt(A, glossary, refined), { label: 'timeline', phase: 'Deliver', model: M.timeline })
    : Promise.resolve(null)),
])


return {
  glossary,
  refined,
  failed,
  incomplete,
  unchecked,
  headingConflicts,
  scoutSuspect,
  scoutFailed,
  suspectedDuplicates: (dedup && dedup.suspects) || [],
  networkUnverified: netUnverified,
  auditFailed,   // §2: [{ path, findings:['content_gap',…] }] — hard audit findings still failing after one auto-repair
  logic,
  openQuestions: refined.flatMap((r) => r.open_questions || []).concat(dedupQuestions(dedup)).concat(logic.flatMap((l) => l.open_questions || [])).concat(conflicts).concat(weakDups).concat(asrSuspects).concat(overrideQuestions).concat(reopenNotes),
  summary,
  timeline,
}
}
