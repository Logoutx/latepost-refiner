import { entitySchema, SCOUT_SCHEMA, VERIFY_SCHEMA, REFINE_REPORT_SCHEMA, CHECK_SCHEMA, DEDUP_SCHEMA, LOGIC_REPORT_SCHEMA, RULES, TYPESET, SINGLE_FILE_GLOSSARY, isWeakKey, stripDesc, longestHanziRun, scoutLooksGarbled, clusterEntities, mergeFindings, VERIFY_CHUNK, MAX_CHUNKS, entityWorth, verifyChunks, dedupListText, withCheck, findHeadingConflicts, renderGlossary, cleanSuspects, splitSuspects, pickNetworkUnverified, dedupQuestions } from './spec.js'
import { READ_PAGE, READ_BYTES_PER_PAGE, readPlan, headingNote, scoutPrompt, verifyPrompt, refinePrompt, checkPrompt, dedupPrompt, singlePassPrompt, summaryPrompt, timelinePrompt, logicWritePrompt } from './prompts.js'

export async function runPipeline(A, engine) {
const M = Object.assign(
  { scout: 'haiku', verify: 'sonnet', dedup: 'sonnet', refine: 'opus', logic: 'opus', summary: 'opus', timeline: 'opus' },
  A.models || {}
)
const scope = A.scope || ['refine']
const EMPTY_RETURN = (error) => ({ error, glossary: '', refined: [], failed: [], incomplete: [], unchecked: [], headingConflicts: [], scoutSuspect: [], suspectedDuplicates: [], networkUnverified: [], logic: [], openQuestions: [], summary: null, timeline: null })
if (!Array.isArray(A.files) || A.files.length === 0) {
  return EMPTY_RETURN('args.files 为空——需在 Step 0 预检后组装 files 再派发')
}
// summary/时间线/逻辑顺序稿 都以本会话精校成稿为输入；scope 含交付物却不含 refine 会静默零产出——早失败、可诊断
if ((scope.includes('summary') || scope.includes('timeline') || scope.includes('logic')) && !scope.includes('refine')) {
  return EMPTY_RETURN('summary/时间线/逻辑顺序稿依赖本会话 refine 产物，scope 须同时含 refine（本工作流不支持只对历史成稿单独出交付物）')
}

let glossary = ''
let netUnverified = []
let refined = []
let failed = []
let headingConflicts = []
let scoutSuspect = []
let dedup = null
let refinedPairs = []   // [{ f, rep }]：成功精校的文件与其报告（含 headings），供逻辑顺序阶段读 f.title/outPath 与按小标题核完整性

if (A.files.length === 1 && (A.files[0].lines || 9999) < 400) {
  // 单份短文件：一遍过（镜像 SKILL.md 的快捷路径），跳过 Scout/Verify
  const f = A.files[0]
  engine.phase('Refine')
  engine.log(`单份短文件（${f.lines} 行）：一遍过精校，不建独立校对表`)
  const rep = await engine.agent(singlePassPrompt(f, A), { label: `refine:${f.label}`, model: M.refine, schema: REFINE_REPORT_SCHEMA })
  if (rep) {
    const chk = await engine.agent(checkPrompt(f, null), { label: `check:${f.label}`, model: 'haiku', schema: CHECK_SCHEMA })
    refined = [withCheck(rep, chk, f)]
    refinedPairs = [{ f, rep: refined[0] }]
  } else {
    failed = [f.label]
  }
  glossary = SINGLE_FILE_GLOSSARY
} else {
  engine.phase('Scout')
  let findings = await engine.parallel(A.files.map((f) => () =>
    engine.agent(scoutPrompt(f, A), { label: `scout:${f.label}`, model: M.scout, schema: SCOUT_SCHEMA })))
  // 垃圾侦察自愈：检测到乱码侦察就各重试一次（一次 haiku 很便宜）；仍乱码则标 scoutSuspect，交付时告知该份校对表不可靠。
  // 成稿不受影响——精校读源文件、不盲信校对表——但研究存档的校对表那一份会脏。
  const retryIdx = A.files.map((f, i) => (findings[i] && scoutLooksGarbled(findings[i])) ? i : -1).filter((i) => i >= 0)
  if (retryIdx.length) {
    engine.log(`侦察疑似损坏（疑网络中途毁坏生成流）：${retryIdx.map((i) => A.files[i].label).join('、')}——各重试一次`)
    const retries = await engine.parallel(retryIdx.map((i) => () =>
      engine.agent(scoutPrompt(A.files[i], A), { label: `scout-retry:${A.files[i].label}`, model: M.scout, schema: SCOUT_SCHEMA })))
    retryIdx.forEach((i, k) => { if (retries[k] && !scoutLooksGarbled(retries[k])) findings[i] = retries[k] })
  }
  scoutSuspect = A.files.filter((f, i) => findings[i] && scoutLooksGarbled(findings[i])).map((f) => f.label)
  engine.log(`侦察完成 ${findings.filter(Boolean).length}/${A.files.length} 份${scoutSuspect.length ? `（${scoutSuspect.join('、')} 重试后仍疑损坏，校对表该份不可靠）` : ''}`)
  // 仍乱码的侦察整份剔除出合并：不污染校对表正文，也不让 verify/dedup 拿乱码去联网空转。
  // 该份 refine 仍照跑（精校读源文件、不靠校对表），scoutSuspect 照常提示用户重跑该份侦察。
  // 若全部 scout 都乱码，cleanFindings 全空 → merged 各类皆空 → doVerify 自然为假、dedupList 为空，整段安全短路。
  const cleanFindings = findings.map((fd) => (fd && scoutLooksGarbled(fd)) ? null : fd)
  const merged = mergeFindings(cleanFindings, A.files)
  headingConflicts = findHeadingConflicts(cleanFindings, A.files, A.headingPolicy)
  if (headingConflicts.length) engine.log(`注意：${headingConflicts.join('、')} 源文件已带小标题但 headingPolicy=none——收尾时需问用户保留还是重做`)

  engine.phase('Verify')
  // verify（联网核实，分块并行）与 dedup（语义同指核查，读全量实体）互不依赖，同一 parallel 里并发
  let verified = null
  // terms 也算（verifyChunks 本就送检术语；deep 档要求全量核实术语，门槛漏 terms 会让纯术语访谈静默跳过核实）
  const doVerify = A.verifyDepth !== 'none' && (merged.people.length || merged.brands.length || merged.terms.length)
  const vc = doVerify ? verifyChunks(merged, A.verifyDepth) : { chunks: [], eligible: 0, excluded: 0, overflow: 0 }
  if (doVerify) {
    engine.log(`核实：${vc.eligible} 项分 ${vc.chunks.length} 块并行送检${vc.excluded > 0 ? `，${vc.excluded} 项低优先级未送检（由精校按原文归一）` : ''}`)
    if (vc.overflow > 0) engine.log(`核实：实体过多，${vc.overflow} 项超出 ${VERIFY_CHUNK * MAX_CHUNKS} 上限未送检`)
  }
  const dedupList = dedupListText(merged)
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
    // 行级清洗：schema 不再强制字段，劣化输出可能缺 query/canonical——缺关键字段的行直接弃掉
    verified = {
      resolved: goodParts.flatMap((p) => p.resolved || []).filter((r) => r && r.query && r.canonical),
      unresolved: goodParts.flatMap((p) => p.unresolved || []).filter((r) => r && r.query),
    }
    engine.log(`核实完成：${verified.resolved.length} 项确认，${verified.unresolved.length} 项存疑（${goodParts.length}/${vc.chunks.length} 块返回）`)
    if (goodParts.length < vc.chunks.length) engine.log(`核实：${vc.chunks.length - goodParts.length}/${vc.chunks.length} 块未返回（疑网络劣化），该批实体本轮未核实——网络稳定后可重跑`)
    netUnverified = pickNetworkUnverified(verified)
    if (netUnverified.length) engine.log(`其中 ${netUnverified.length} 项因网络故障未核实——收尾时可向用户提供补核选项（networkUnverified）`)
  }
  dedup = dedupRes ? { suspects: cleanSuspects(dedupRes.suspects) } : null
  if (dedup && dedup.suspects.length) engine.log(`疑似同指：标记 ${dedup.suspects.length} 组待人工确认`)
  glossary = renderGlossary(merged, verified, dedup, A)

  let positional = []
  if (scope.includes('refine')) {
    engine.phase('Refine')
    positional = await engine.pipeline(A.files,
      (f, _f, i) => findings[i] && engine.agent(refinePrompt(f, glossary, findings[i], A),
        { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA }),
      (rep, f, i) => rep && engine.agent(checkPrompt(f, findings[i].ending_anchor),
        { label: `check:${f.label}`, phase: 'Refine', model: 'haiku', schema: CHECK_SCHEMA })
        .then((chk) => withCheck(rep, chk, f)))
  }
  failed = A.files.filter((f, i) => !findings[i] || (scope.includes('refine') && !positional[i])).map((f) => f.label)
  refined = positional.filter(Boolean)
  refinedPairs = A.files.map((f, i) => ({ f, rep: positional[i] })).filter((p) => p.rep)
  if (failed.length) engine.log(`未完成：${failed.join('、')}（主代理需按 SKILL.md Step 1–2 手动补做）`)
}

// 逻辑顺序重排（可选）：逐份读精校稿、重排成叙事顺序，并发跑。完整性靠免费 JS 核对——
// 精校 report 的 headings vs 逻辑稿 report 的 threads[].source_sections 求差，漏的小标题进 missingSections。
let logic = []
if (scope.includes('logic') && refinedPairs.length) {
  engine.phase('Logic')
  const lreps = await engine.parallel(refinedPairs.map(({ f }) => () =>
    engine.agent(logicWritePrompt(f, A), { label: `logic:${f.label}`, model: M.logic, schema: LOGIC_REPORT_SCHEMA })))
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
const [summary, timeline] = await engine.parallel([
  () => (scope.includes('summary') && refined.length
    ? engine.agent(summaryPrompt(A, refined), { label: 'summary', model: M.summary })
    : Promise.resolve(null)),
  () => (scope.includes('timeline') && refined.length
    ? engine.agent(timelinePrompt(A, glossary, refined), { label: 'timeline', model: M.timeline })
    : Promise.resolve(null)),
])

return {
  glossary,
  refined,
  failed,
  incomplete: refined.filter((r) => r.complete === false).map((r) => ({ path: r.outPath || r.path, note: r.checkNote })),
  unchecked: refined.filter((r) => r.complete === null).map((r) => r.outPath || r.path),
  headingConflicts,
  scoutSuspect,
  suspectedDuplicates: (dedup && dedup.suspects) || [],
  networkUnverified: netUnverified,
  logic,
  openQuestions: refined.flatMap((r) => r.open_questions || []).concat(dedupQuestions(dedup)).concat(logic.flatMap((l) => l.open_questions || [])),
  summary,
  timeline,
}
}
