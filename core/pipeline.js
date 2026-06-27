import { entitySchema, SCOUT_SCHEMA, VERIFY_SCHEMA, REFINE_REPORT_SCHEMA, CHECK_SCHEMA, DEDUP_SCHEMA, LOGIC_REPORT_SCHEMA, RULES, TYPESET, SINGLE_FILE_GLOSSARY, isWeakKey, stripDesc, longestHanziRun, scoutLooksGarbled, clusterEntities, mergeFindings, VERIFY_CHUNK, MAX_CHUNKS, entityWorth, verifyChunks, dedupListText, withCheck, splitForRefine, refineSize, ONE_PASS_CHARS, findHeadingConflicts, renderGlossary, renderRefineGlossary, cleanSuspects, splitSuspects, pickNetworkUnverified, dedupQuestions, parseGlossary, mergeIntoPrior, mergeVerified, mergeDedup, excludeVerified, buildSpeakerRegistry, glossaryConflicts, weakDupFlags } from './spec.js'
import { READ_PAGE, READ_BYTES_PER_PAGE, readPlan, headingNote, scoutPrompt, verifyPrompt, refinePrompt, stitchPrompt, checkPrompt, dedupPrompt, singlePassPrompt, summaryPrompt, timelinePrompt, logicWritePrompt } from './prompts.js'

// Refine one file. Cost mode (default), or a small file → one agent. Speed mode + a large file (> REFINE_CHUNK_CHARS
// 字) → up to MAX_REFINE_CHUNKS parallel chunk agents writing <outPath>.part{idx}, merged by a cheap stitch
// agent. Returns a REFINE_REPORT-shaped object (path = f.outPath) or null if it
// could not produce an output. A failed chunk is surfaced via open_questions (and caught downstream by the
// completeness check + source-aware audit) rather than silently dropped.
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
  if (warn.length) engine.log(`精校分块：${f.label} ${warn.length}/${chunks.length} 块失败——已并入 openQuestions，结尾核对/审计会进一步标记`)
  const stitched = await engine.agent(stitchPrompt(f, chunks), { label: `stitch:${f.label}`, phase: 'Refine', model: M.stitch })
  if (stitched == null) { engine.log(`精校分块：${f.label} 拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
  return {
    path: f.outPath,
    headings: good.flatMap((r) => r.headings || []),
    key_fixes: good.flatMap((r) => r.key_fixes || []),
    open_questions: good.flatMap((r) => r.open_questions || []).concat(warn),
    chunked: chunks.length,
  }
}

export async function runPipeline(A, engine) {
const M = Object.assign(
  { scout: 'haiku', verify: 'sonnet', dedup: 'sonnet', refine: 'opus', stitch: 'haiku', logic: 'opus', summary: 'opus', timeline: 'opus' },
  A.models || {}
)
const scope = A.scope || ['refine']
const EMPTY_RETURN = (error) => ({ error, glossary: '', refined: [], failed: [], incomplete: [], unchecked: [], headingConflicts: [], scoutSuspect: [], scoutFailed: [], suspectedDuplicates: [], networkUnverified: [], logic: [], openQuestions: [], summary: null, timeline: null })
if (!Array.isArray(A.files) || A.files.length === 0) {
  return EMPTY_RETURN('args.files 为空——需在 Step 0 预检后组装 files 再派发')
}
// summary / timeline / logical-order rewrite all take this session's refined output as input; a scope with a
  // deliverable but no refine would silently produce nothing — so fail early and diagnosably.
if ((scope.includes('summary') || scope.includes('timeline') || scope.includes('logic')) && !scope.includes('refine')) {
  return EMPTY_RETURN('summary/时间线/逻辑顺序稿依赖本会话 refine 产物，scope 须同时含 refine（本工作流不支持只对历史成稿单独出交付物）')
}

// Persistent per-company glossary (P1): if Step 0 found an existing 校对表.md and passed its text,
// parse it into prior memory to seed scout + accumulate into. A.fresh forces a from-scratch rebuild.
// Attached to A so scoutPrompt can read it. Absent/empty → null → behaviour identical to a first run.
const prior = (A.priorGlossaryText && !A.fresh) ? parseGlossary(A.priorGlossaryText) : null
A.prior = prior
A.doNotMerge = (prior && prior.doNotMerge) || []   // P4: human-confirmed distinct referents, carried forward to dedup + render
let conflicts = []                                  // P4: this batch's verify conclusions that disagree with the prior glossary
let weakDups = []                                   // P4b: cross-batch weak-honorific (张总/李总) ambiguities to disambiguate
if (prior) engine.log(`沿用往次校对表：已知 ${prior.people.length} 人名 / ${prior.brands.length} 品牌 / ${prior.terms.length} 术语、${(prior.verified.resolved || []).length} 条核实结论——本轮在其上累积`)

let glossary = ''
let netUnverified = []
let refined = []
let failed = []
let headingConflicts = []
let scoutSuspect = []
let scoutFailed = []   // files whose scout returned nothing (stalled) — refined anyway (glossary degraded), surfaced for re-scout
let dedup = null
let refinedPairs = []   // [{ f, rep }]: successfully refined files and their reports (including headings); used by the logic-reorder phase to read f.title/outPath and verify section-heading coverage

if (A.files.length === 1 && refineSize(A.files[0]) < ONE_PASS_CHARS) {
  // Single short file: one-pass refine (mirrors the fast path in SKILL.md), skip Scout/Verify.
  // Length judged by 正文字数, not lines.
  const f = A.files[0]
  engine.phase('Refine')
  engine.log(`▶ 精校 Refine：单份短文件（约 ${refineSize(f)} 字）一遍过，不建独立校对表`)
  const rep = await engine.agent(singlePassPrompt(f, A), { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA })
  if (rep) {
    refined = [Object.assign({}, rep, { outPath: f.outPath, complete: null, checkNote: '结尾核对待跑' })]
    refinedPairs = [{ f, rep, anchor: null }]   // completeness check runs in the shared phase below
  } else {
    failed = [f.label]
  }
  glossary = SINGLE_FILE_GLOSSARY
} else {
  engine.phase('Scout')
  engine.log(`▶ 1/${scope.includes('logic') ? 5 : 4} 侦察 Scout：${A.files.length} 份并行抽取实体（人名 / 品牌 / 术语 / 发言人）`)
  let findings = await engine.parallel(A.files.map((f) => () =>
    engine.agent(scoutPrompt(f, A), { label: `scout:${f.label}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })))
  // Garbled-scout self-healing: if a scout result looks garbled, retry it once (a haiku call is cheap); if still garbled, flag it in scoutSuspect and warn at delivery that the glossary entry for that file is unreliable.
  // The refined transcript is unaffected — refine reads the source file directly and does not blindly trust the scout output — but the archived glossary entry for that file will be dirty.
  const retryIdx = A.files.map((f, i) => (findings[i] && scoutLooksGarbled(findings[i])) ? i : -1).filter((i) => i >= 0)
  if (retryIdx.length) {
    engine.log(`侦察疑似损坏（疑网络中途毁坏生成流）：${retryIdx.map((i) => A.files[i].label).join('、')}——各重试一次`)
    const retries = await engine.parallel(retryIdx.map((i) => () =>
      engine.agent(scoutPrompt(A.files[i], A), { label: `scout-retry:${A.files[i].label}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })))
    retryIdx.forEach((i, k) => { if (retries[k] && !scoutLooksGarbled(retries[k])) findings[i] = retries[k] })
  }
  scoutSuspect = A.files.filter((f, i) => findings[i] && scoutLooksGarbled(findings[i])).map((f) => f.label)
  engine.log(`侦察完成 ${findings.filter(Boolean).length}/${A.files.length} 份${scoutSuspect.length ? `（${scoutSuspect.join('、')} 重试后仍疑损坏，校对表该份不可靠）` : ''}`)
  // Still-garbled scout results are dropped entirely from the merge: this prevents polluting the glossary body and avoids wasting verify/dedup web-lookup calls on garbage input.
  // Refine for that file still runs normally (it reads the source file directly, not the scout output); scoutSuspect still prompts the user to re-run scout for that file.
  // If every scout is garbled, cleanFindings is all-null → merged lists are all empty → doVerify is naturally false and dedupList is empty, so the whole verify/dedup block short-circuits safely.
  const cleanFindings = findings.map((fd) => (fd && scoutLooksGarbled(fd)) ? null : fd)
  const mergedThisBatch = mergeFindings(cleanFindings, A.files)
  headingConflicts = findHeadingConflicts(cleanFindings, A.files, A.headingPolicy)
  if (headingConflicts.length) engine.log(`注意：${headingConflicts.join('、')} 源文件已带小标题但 headingPolicy=none——收尾时需问用户保留还是重做`)

  engine.phase('Verify')
  engine.log(`▶ 2/${scope.includes('logic') ? 5 : 4} 核实 Verify：关键实体联网核实 + 语义同指排查`)
  // verify (web-lookup fact-checking, chunked and parallelised) and dedup (semantic co-reference check across all entities) are independent of each other — run both concurrently in the same parallel
  let verified = null
  // terms count too (verifyChunks already submits terms for checking; the deep level requires all terms to be verified, and omitting terms from the threshold would cause a terms-only interview to silently skip verification)
  // P2: don't re-verify entities the prior glossary already confirmed — verify only this batch's new ones.
  const verifyTarget = excludeVerified(mergedThisBatch, prior)
  if (prior) { const sk = (mergedThisBatch.people.length + mergedThisBatch.brands.length + mergedThisBatch.terms.length) - (verifyTarget.people.length + verifyTarget.brands.length + verifyTarget.terms.length); if (sk > 0) engine.log(`核实缓存：跳过 ${sk} 项往次已核实实体，本轮只核新实体`) }
  const doVerify = A.verifyDepth !== 'none' && (verifyTarget.people.length || verifyTarget.brands.length || verifyTarget.terms.length)
  const vc = doVerify ? verifyChunks(verifyTarget, A.verifyDepth) : { chunks: [], eligible: 0, excluded: 0, overflow: 0 }
  if (doVerify) {
    engine.log(`核实：${vc.eligible} 项分 ${vc.chunks.length} 块并行送检${vc.excluded > 0 ? `，${vc.excluded} 项低优先级未送检（由精校按原文归一）` : ''}`)
    if (vc.overflow > 0) engine.log(`核实：实体过多，${vc.overflow} 项超出 ${VERIFY_CHUNK * MAX_CHUNKS} 上限未送检`)
  }
  const dedupList = dedupListText(mergedThisBatch)
  const [vparts, dedupRes] = await engine.parallel([
    () => vc.chunks.length
      ? engine.parallel(vc.chunks.map((ct, i) => () => engine.agent(verifyPrompt(ct, A), { label: `verify:${i + 1}/${vc.chunks.length}`, phase: 'Verify', model: M.verify, schema: VERIFY_SCHEMA })))
      : Promise.resolve([]),
    () => dedupList
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
  if (weakDups.length) engine.log(`称呼歧义：${weakDups.length} 个弱称呼跨批次重复（未合并）——并入 openQuestions 待人工辨认`)
  if (prior) engine.log(`累积合并：校对表现含 ${merged.people.length} 人名 / ${merged.brands.length} 品牌 / ${merged.terms.length} 术语`)
  glossary = renderGlossary(merged, allVerified, allDedup, A)
  // Condensed glossary for chunk-refine agents (full 校对表 still persisted + used by single-agent refine).
  const refineGlossary = renderRefineGlossary(merged, allVerified, allDedup, A)

  let positional = []
  if (scope.includes('refine')) {
    engine.phase('Refine')
    engine.log(`▶ 3/${scope.includes('logic') ? 5 : 4} 精校 Refine：${A.files.length} 份逐份精校${A.chunkMode === 'speed' ? '（大文件分块并行）' : ''}`)
    // Refine ONLY — the ending-completeness check is NOT in the critical path here; it runs last (after the
    // deliverables are written to disk) so a slow / stalled cheap check can't cost the expensive refine or the
    // deliverables. And refine runs even when scout failed for a file (findings[i] null): refine reads the
    // source directly and the glossary is only an aid, so a stalled cheap scout degrades the glossary but
    // never blocks the expensive pass. No barrier between files (pipeline).
    positional = await engine.pipeline(A.files,
      (f, _f, i) => refineFile(engine, f, glossary, refineGlossary, findings[i] || {}, A, M))
  }
  scoutFailed = A.files.filter((f, i) => scope.includes('refine') && positional[i] && !findings[i]).map((f) => f.label)
  if (scoutFailed.length) engine.log(`侦察未返回、已照常精校（校对表缺这几份实体，网络稳定后可重扫）：${scoutFailed.join('、')}`)
  failed = A.files.filter((f, i) => scope.includes('refine') && !positional[i]).map((f) => f.label)
  refined = positional.map((rep, i) => rep && Object.assign({}, rep, { outPath: A.files[i].outPath, complete: null, checkNote: '结尾核对待跑' })).filter(Boolean)
  refinedPairs = A.files.map((f, i) => ({ f, rep: positional[i], anchor: findings[i] && findings[i].ending_anchor })).filter((p) => p.rep)
  if (failed.length) engine.log(`未完成：${failed.join('、')}（主代理需按 SKILL.md Step 1–2 手动补做）`)
}

// Logic-order resequencing (optional): reads each refined transcript and reorders it into narrative order, run concurrently. Completeness is verified by a zero-cost JS check —
// diff the headings in the refine report against threads[].source_sections in the logic report; any headings not covered go into missingSections.
let logic = []
if (scope.includes('logic') && refinedPairs.length) {
  engine.phase('Logic')
  engine.log(`▶ 4/5 逻辑顺序 Logic：${refinedPairs.length} 份按主线重排为叙事顺序`)
  const lreps = await engine.parallel(refinedPairs.map(({ f }) => () =>
    engine.agent(logicWritePrompt(f, A), { label: `logic:${f.label}`, phase: 'Logic', model: M.logic, schema: LOGIC_REPORT_SCHEMA })))
  lreps.forEach((lrep, k) => {
    const { f, rep } = refinedPairs[k]
    if (!lrep) { logic.push({ label: f.label, path: null, mainline: '', threads: [], missingSections: [], open_questions: [] }); return }
    const covered = new Set((lrep.threads || []).flatMap((t) => ((t && t.source_sections) || []).map((s) => (s || '').trim()).filter(Boolean)))
    const srcHeadings = ((rep && rep.headings) || []).map((h) => (h || '').trim()).filter(Boolean)
    const missing = srcHeadings.filter((h) => !covered.has(h))
    logic.push({ label: f.label, path: `${A.outputDir}/逻辑顺序/${f.title}.md`, mainline: lrep.mainline || '', threads: (lrep.threads || []).map((t) => t && t.title).filter(Boolean), missingSections: missing, open_questions: lrep.open_questions || [] })
  })
  const failedLogic = logic.filter((l) => !l.path).map((l) => l.label)
  const missLogic = logic.filter((l) => l.missingSections && l.missingSections.length)
  engine.log(`逻辑顺序稿完成 ${logic.filter((l) => l.path).length}/${refinedPairs.length} 份${failedLogic.length ? `（${failedLogic.join('、')} 失败）` : ''}`)
  if (missLogic.length) engine.log(`逻辑顺序稿疑漏小标题（按精校稿小标题覆盖核对，需抽查）：${missLogic.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
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

// Completeness check — runs LAST, off the critical path. The expensive refine and the deliverables are
// already written to disk, so a slow / failed / stalled haiku check can no longer cost them (the failure mode
// that bit the 5.25-万字 run, where a stuck 结尾核对 agent held the whole run hostage). The deterministic
// source-aware audit (run post-pipeline on the files) is the authoritative completeness signal; this agent is
// a best-effort refinement folded back into `refined`.
if (refinedPairs.length) {
  engine.phase('Check')
  engine.log(`▶ 结尾核对 Check：${refinedPairs.length} 份（不阻塞已落盘的成稿与交付物）`)
  const chks = await engine.parallel(refinedPairs.map(({ f, anchor }) => () =>
    engine.agent(checkPrompt(f, anchor), { label: `check:${f.label}`, phase: 'Check', model: 'haiku', schema: CHECK_SCHEMA })))
  refinedPairs.forEach(({ f, rep }, k) => {
    const w = withCheck(rep, chks[k], f)
    const r = refined.find((x) => (x.outPath || x.path) === f.outPath)
    if (r) { r.complete = w.complete; r.checkNote = w.checkNote }
  })
}

return {
  glossary,
  refined,
  failed,
  incomplete: refined.filter((r) => r.complete === false).map((r) => ({ path: r.outPath || r.path, note: r.checkNote })),
  unchecked: refined.filter((r) => r.complete === null).map((r) => r.outPath || r.path),
  headingConflicts,
  scoutSuspect,
  scoutFailed,
  suspectedDuplicates: (dedup && dedup.suspects) || [],
  networkUnverified: netUnverified,
  logic,
  openQuestions: refined.flatMap((r) => r.open_questions || []).concat(dedupQuestions(dedup)).concat(logic.flatMap((l) => l.open_questions || [])).concat(conflicts).concat(weakDups),
  summary,
  timeline,
}
}
