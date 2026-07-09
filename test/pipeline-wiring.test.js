import assert from 'node:assert/strict'
import test from 'node:test'
import { runPipeline, normalizeAuditResult } from '../core/pipeline.js'

// All fixtures are fictional (王总/王志远, 苍碧/苍璧科技, 沈其安/沈总, 陈涛/陈焘 — 仓库既有虚构占位).
// These tests drive runPipeline with a mock engine (zero tokens) + mock capabilities, exercising the Wave 2
// wiring: canonicalOverrides into the pipeline (verify剔除 + name-guard short-circuit + 〔用户钦定〕 render),
// the in-pipeline audit gate (capability + agent-fallback branches), safeName join points, priorGlossaryPath
// resolution, and the logic missingSections auto-rerun.

const F = (over = {}) => ({ path: '/s/A.txt', label: 'A', lines: 100, chars: 5000, title: 'A', subtitle: '*s*', outPath: '/o/Transcripts/A.md', ...over })
const A = (over = {}) => ({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/o', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [F()], ...over })

// A configurable mock engine. `on` maps a label-prefix regex → a reply (or (prompt)=>reply). Unhandled
// scout/refine/dedup labels get sensible defaults; everything else returns null.
function engine(labels, on = {}, capturePrompts = null) {
  const def = (l) => {
    if (/^scout/.test(l)) return { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] }
    if (/^refine/.test(l)) return { path: 'x', headings: ['某节'], key_fixes: [], open_questions: [] }
    if (/^dedup/.test(l)) return { suspects: [] }
    if (/^(summary|timeline)/.test(l)) return `/o/${l}.md`
    return null
  }
  return {
    agent: async (p, o) => {
      labels.push(o.label)
      if (capturePrompts) capturePrompts.push({ label: o.label, prompt: p })
      for (const [pre, val] of Object.entries(on)) if (new RegExp(pre).test(o.label)) return typeof val === 'function' ? val(p, o) : val
      return def(o.label)
    },
    parallel: (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all((items || []).map(async (item, i) => {
      let v = item
      for (const s of stages) { try { v = await s(v, item, i) } catch { return null } if (!v) return null }
      return v
    })),
    phase: () => {}, log: () => {},
  }
}

// ---------- §1 canonicalOverrides into the pipeline ----------

test('override: a locked cluster is excluded from verify even at verifyDepth:deep and despite suspect_asr', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {
    '^scout': { speakers: [{ label: '记者', role: '记者' }], people: [{ canonical: '王总', variants: [], suspect_asr: true, hint: '受访者' }], brands: [{ canonical: '苍碧科技', variants: [], suspect_asr: true }], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
    '^verify': { resolved: [], unresolved: [] },
  }, prompts)
  const r = await runPipeline(A({ verifyDepth: 'deep', canonicalOverrides: [{ canonical: '王志远', variants: ['王总'] }, { canonical: '苍璧科技', variants: ['苍碧科技'], category: 'brand' }] }), eng)
  const verifyPrompts = prompts.filter((x) => /^verify/.test(x.label)).map((x) => x.prompt).join('\n')
  assert.ok(!/王总|王志远/.test(verifyPrompts), 'the decreed person is not sent to verify (nothing to look up)')
  assert.ok(!/苍/.test(verifyPrompts), 'the decreed brand is not sent to verify')
  assert.ok(r.glossary.includes('王志远') && r.glossary.includes('用户钦定'), 'the decree is in the glossary as 用户钦定')
})

test('override: a locked person entry renders WITHOUT ⚠ even when its source cluster was scout-flagged suspect_asr', async () => {
  const labels = []
  const eng = engine(labels, {
    '^scout': { speakers: [{ label: '记者', role: '记者' }], people: [{ canonical: '王总', variants: [], suspect_asr: true, hint: '受访者' }], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
  })
  const r = await runPipeline(A({ files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })], canonicalOverrides: [{ canonical: '王志远', variants: ['王总'] }] }), eng)
  const line = r.glossary.split('\n').find((l) => l.includes('王志远')) || ''
  assert.ok(line.includes('用户钦定'), 'renders the 〔用户钦定〕 marker')
  assert.ok(!line.includes('⚠'), 'a locked cluster never carries the suspect-ASR ⚠, even from a consumed cluster')
})

test('override: excludeVerified via prior confidence coexists with a fresh decree (both skip verify)', async () => {
  const labels = [], prompts = []
  // Two OLDER dated verified entries (2024-*) so the M9b age-rotation (ROTATE_REVERIFY=2) picks THOSE as the
  // oldest, leaving 沈其安 (2025-01, the newest verified) still excluded — this keeps the original assertion
  // "a prior verified entry is not re-verified" valid under M9b. The two older entries are not in this batch's
  // scout, so re-opening them is a no-op (no fresh cluster to un-filter); they never reach the verify prompt.
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **旧甲** ← 旧甲变体 ｜ 早期条目 〔核实·2024-01〕',   // oldest verified → rotated (no fresh cluster → no-op)
    '- **旧乙** ← 旧乙变体 ｜ 早期条目 〔核实·2024-02〕',   // 2nd oldest verified → rotated (no-op)
    '- **沈其安** ← 沈总 ｜ 创始人 〔核实·2025-01〕',        // newest verified → stays excluded (not rotated)
  ].join('\n')
  const eng = engine(labels, {
    '^scout': { speakers: [{ label: '记者', role: '记者' }], people: [{ canonical: '沈其安', variants: ['沈总'] }, { canonical: '新人', variants: [] }], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
    '^verify': { resolved: [], unresolved: [] },
  }, prompts)
  await runPipeline(A({ verifyDepth: 'deep', priorGlossaryText: priorMd, files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })], canonicalOverrides: [{ canonical: '陈涛', variants: ['陈焘'] }] }), eng)
  const verifyPrompts = prompts.filter((x) => /^verify/.test(x.label)).map((x) => x.prompt).join('\n')
  assert.ok(!/沈其安|沈总/.test(verifyPrompts), 'the NEWEST prior verified entry is not re-verified (M9b rotates only the 2 oldest)')
  assert.ok(!/旧甲|旧乙/.test(verifyPrompts), 'the rotated old entries have no fresh cluster this batch → re-opening them is a no-op')
  assert.ok(!/陈涛|陈焘/.test(verifyPrompts), 'the fresh decree is not verified')
  assert.ok(/新人/.test(verifyPrompts), 'a genuinely new entity still gets verified')
})

// ---------- one-pass branch: canonicalOverrides must not be silently dropped ----------
// The one-pass branch (single short file, refineSize < ONE_PASS_CHARS) skips scout/merge entirely — before this
// fix, A.canonicalOverrides had no cluster list to attach to and was dropped: singlePassPrompt never mentioned
// the decree, and the audit gate got no glossaryText (so ghost_name/missing_yin couldn't watch for a variant
// leaking into the 成稿). Both effects are now covered.

test('one-pass: canonicalOverrides is injected into singlePassPrompt as a 用户钦定 note', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {}, prompts)
  await runPipeline(A({
    files: [F({ chars: 1000 })],
    canonicalOverrides: [{ canonical: '陈涛', variants: ['陈焘', '陈涛（同音）'] }],
  }), eng)
  const refinePrompt = prompts.find((x) => x.label === 'refine:A').prompt
  assert.ok(/用户钦定正名/.test(refinePrompt), 'the prompt carries a 用户钦定 section on the one-pass path')
  assert.ok(refinePrompt.includes('陈涛') && refinePrompt.includes('陈焘'), 'both canonical and variant are named')
})

test('one-pass: canonicalOverrides absent leaves singlePassPrompt unchanged (no stray section)', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {}, prompts)
  await runPipeline(A({ files: [F({ chars: 1000 })] }), eng)
  const refinePrompt = prompts.find((x) => x.label === 'refine:A').prompt
  assert.ok(!/用户钦定正名/.test(refinePrompt), 'no decree section appears when there is no override')
})

test('one-pass: canonicalOverrides is handed to the audit gate as glossaryText (canonical + variants present)', async () => {
  const labels = []
  let seenGlossary = 'unset'
  const capabilities = {
    runAudit: (f, opts = {}) => { seenGlossary = opts.glossaryText; return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    annotateAnchors: () => ({ updated: [] }),
  }
  await runPipeline(A({
    files: [F({ chars: 1000 })],
    capabilities,
    canonicalOverrides: [{ canonical: '陈涛', variants: ['陈焘'] }],
  }), engine(labels))
  assert.ok(seenGlossary && typeof seenGlossary === 'string', 'the audit capability received a glossaryText string')
  assert.ok(seenGlossary.includes('陈涛'), 'the decreed canonical is present')
  assert.ok(seenGlossary.includes('陈焘'), 'the decreed variant is present (so ghost_name can catch it surviving in prose)')
})

test('one-pass: with no canonicalOverrides the audit gate still gets NO glossary (unchanged prior behaviour)', async () => {
  const labels = []
  let seenGlossary = 'unset'
  const capabilities = {
    runAudit: (f, opts = {}) => { seenGlossary = opts.glossaryText; return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    annotateAnchors: () => ({ updated: [] }),
  }
  await runPipeline(A({ files: [F({ chars: 1000 })], capabilities }), engine(labels))
  assert.equal(seenGlossary, null, 'no fake glossary is handed to the audit when there is no override (SINGLE_FILE_GLOSSARY placeholder is never leaked)')
})

// ---------- §2 in-pipeline audit gate (capability injection) ----------

test('audit gate: content_gap hard → auto-repair → re-audit passes → not auditFailed', async () => {
  const labels = []
  let auditCalls = 0, repaired = false, anchored = false
  const capabilities = {
    runAudit: (f) => { auditCalls += 1; return auditCalls === 1
      ? { file: f.outPath, status: 'fail', failed: ['content_gap'], gaps: [{ startLine: 10, endLine: 30, chars: 400, severity: 'hard' }], findings: [] }
      : { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    repair: () => { repaired = true },
    annotateAnchors: () => { anchored = true; return { updated: [{ title: '某节' }] } },
  }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.equal(auditCalls, 2, 'audited, then re-audited exactly once')
  assert.ok(repaired, 'repair capability invoked on the hard finding')
  assert.ok(anchored, 'anchors run after the (repaired) audit passed')
  assert.deepEqual(r.auditFailed, [], 'a repaired file is not auditFailed')
  assert.equal(r.refined[0].audit.status, 'ok')
  assert.equal(r.refined[0].audit.repaired, true)
  assert.equal(r.refined[0].audit.anchorsAdded, 1)
})

test('audit gate: still hard after one repair → auditFailed + visible marker (annotate) + fail status', async () => {
  const labels = []
  let annotateCalled = false, auditCalls = 0
  const capabilities = {
    runAudit: (f) => { auditCalls += 1; return { file: f.outPath, status: 'fail', failed: ['content_gap', 'quote_style'], gaps: [{ startLine: 10, endLine: 30, chars: 400, severity: 'hard' }], findings: [] } },
    repair: () => {}, // repair runs but the re-audit still fails
    annotate: () => { annotateCalled = true },
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.equal(auditCalls, 2, 'repair-then-reaudit capped at one extra audit (no loop)')
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['content_gap', 'quote_style'] }])
  assert.ok(annotateCalled, 'a still-hard gap drops a visible 缺口 marker')
  assert.equal(r.refined[0].audit.status, 'fail')
})

test('audit gate: soft-only findings never fail the gate', async () => {
  const labels = []
  const capabilities = { runAudit: (f) => ({ file: f.outPath, status: 'fail', failed: ['under_refined'], gaps: [], findings: [] }), annotateAnchors: () => ({ updated: [] }) }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.deepEqual(r.auditFailed, [], 'under_refined (not content_gap/quote_style) is not a hard gate here')
  assert.deepEqual(r.refined[0].audit.softFindings, ['under_refined'])
})

test('audit gate (no capability, CC sandbox): an agent runs audit_refined.mjs; a parseable pass → ok', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {
    '^audit:': () => JSON.stringify({ status: 'ok', files: [{ file: '/o/Transcripts/A.md', status: 'ok', failed: [], gaps: [], findings: [] }] }),
    '^anchors:': '已加锚点',
  }, prompts)
  const r = await runPipeline(A(), eng) // no capabilities → CC fallback path
  assert.ok(labels.includes('audit:A'), 'a fallback audit agent ran')
  const auditPrompt = prompts.find((x) => x.label === 'audit:A').prompt
  assert.ok(/audit_refined\.mjs/.test(auditPrompt) && /--source/.test(auditPrompt), 'the agent is told to run the audit script')
  assert.deepEqual(r.auditFailed, [])
  assert.equal(r.refined[0].audit.status, 'ok')
})

test('audit gate (no capability): unparseable agent output → one retry → degrade to auditUnavailable, never throws', async () => {
  const labels = []
  const eng = engine(labels, { '^audit': '这不是 JSON，只是一段解释文字。' }) // both the call and the retry fail to parse
  const r = await runPipeline(A(), eng)
  assert.ok(labels.includes('audit:A') && labels.includes('audit-retry:A'), 'audited then retried once')
  assert.deepEqual(r.auditFailed, [], 'an unavailable audit does not fail the run')
  assert.equal(r.refined[0].audit.auditUnavailable, true)
})

// ---------- §5 logic missingSections auto-rerun ----------

test('logic: a first-pass missing section triggers exactly one rerun that clears it', async () => {
  const labels = []
  const eng = engine(labels, {
    '^refine': { path: 'x', headings: ['某节', '另一节'], key_fixes: [], open_questions: [] },
    '^logic-rerun': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['某节', '另一节'] }], open_questions: [] },
    '^logic:': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['另一节'] }], open_questions: [] }, // omits 某节
  })
  const r = await runPipeline(A({ scope: ['refine', 'logic'] }), eng)
  assert.ok(labels.includes('logic:A'), 'first logic pass ran')
  assert.ok(labels.includes('logic-rerun:A'), 'the rerun ran (cap 1)')
  assert.deepEqual(r.logic[0].missingSections, [], 'the rerun covered the omitted heading')
  assert.equal(labels.filter((l) => /^logic-rerun/.test(l)).length, 1, 'reran at most once')
})

test('logic: if the rerun still misses, the residual stays in the return (no infinite rerun)', async () => {
  const labels = []
  const eng = engine(labels, {
    '^refine': { path: 'x', headings: ['某节', '另一节'], key_fixes: [], open_questions: [] },
    '^logic': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['另一节'] }], open_questions: [] }, // both pass + rerun omit 某节
  })
  const r = await runPipeline(A({ scope: ['refine', 'logic'] }), eng)
  assert.equal(labels.filter((l) => /^logic-rerun/.test(l)).length, 1, 'still only one rerun')
  assert.deepEqual(r.logic[0].missingSections, ['某节'], 'the still-missing heading is surfaced for a Step-5 spot-check')
})

test('logic: safeName is applied to the 逻辑顺序 output path (a slash/colon title can\'t fabricate a directory)', async () => {
  const labels = []
  const eng = engine(labels, {
    '^logic': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['某节'] }], open_questions: [] },
  })
  const r = await runPipeline(A({ scope: ['refine', 'logic'], files: [F({ title: 'A/B:2025' })] }), eng)
  assert.equal(r.logic[0].path, '/o/逻辑顺序/A B 2025.md', 'slash and colon scrubbed out of the filename')
})

// ---------- §4 priorGlossaryPath resolution ----------

const PRIOR_MD = ['# 示例公司 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）', '- **沈其安** ← 沈总 ｜ 创始人 〔核实·2025-01〕'].join('\n')

test('priorGlossaryPath: read via capabilities.readFile (no agent), glossary is seeded', async () => {
  const labels = []
  let capRead = 0
  const eng = engine(labels)
  const r = await runPipeline(A({ priorGlossaryPath: '/o/校对表.md', capabilities: { readFile: (p) => { capRead += 1; return PRIOR_MD } } }), eng)
  assert.equal(capRead, 1, 'the file was read through the capability')
  assert.ok(!labels.includes('prior-glossary:read'), 'no fallback agent was dispatched')
  assert.ok(r.glossary.includes('沈其安'), 'the prior entity seeded the cumulative glossary')
})

test('priorGlossaryPath: no capability (CC sandbox) → a haiku agent Reads the file', async () => {
  const labels = []
  const eng = engine(labels, { 'prior-glossary': PRIOR_MD })
  const r = await runPipeline(A({ priorGlossaryPath: '/o/校对表.md', files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })] }), eng)
  assert.ok(labels.includes('prior-glossary:read'), 'the fallback Read agent ran')
  assert.ok(r.glossary.includes('沈其安'), 'the agent-read prior seeded the glossary')
})

test('priorGlossaryText wins over priorGlossaryPath (no read of the path at all)', async () => {
  const labels = []
  let capRead = 0
  const eng = engine(labels)
  const r = await runPipeline(A({ priorGlossaryText: PRIOR_MD, priorGlossaryPath: '/o/other.md', capabilities: { readFile: () => { capRead += 1; return 'WRONG' } } }), eng)
  assert.equal(capRead, 0, 'the path is never read when inline text is present')
  assert.ok(!labels.includes('prior-glossary:read'), 'no agent read either')
  assert.ok(r.glossary.includes('沈其安'), 'the inline text was used')
})

test('fresh:true ignores priorGlossaryPath entirely', async () => {
  const labels = []
  let capRead = 0
  const eng = engine(labels)
  await runPipeline(A({ fresh: true, priorGlossaryPath: '/o/校对表.md', capabilities: { readFile: () => { capRead += 1; return PRIOR_MD } } }), eng)
  assert.equal(capRead, 0, 'fresh short-circuits the prior read')
})

// ---------- dedup skip on returning batches (prior-glossary coverage) ----------
// When the prior 校对表 already covers ≥90% of this batch's (non-钦定) entities, the semantic dedup agent is
// skipped — its whole job is catching NEW cross-writing co-references, and a returning batch of already-known
// entities has almost none. The deterministic dedup-adjacent logic (weakDupFlags, suspectUnverified) still runs.

// A configurable engine that also captures engine.log lines (the base `engine` helper swallows them).
function engineWithLogs(labels, logs, on = {}) {
  const base = engine(labels, on)
  return { ...base, log: (m) => { logs.push(String(m)) } }
}

// Prior glossary with N verified people (canonicals 人0…人{N-1}), each 〔核实〕 so excludeVerified counts them covered.
const priorWithVerified = (n) => [
  '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
  ...Array.from({ length: n }, (_, i) => `- **人${i}** ← 变${i} ｜ 受访者 〔核实·2025-01〕`),
].join('\n')

// A scout that reports the given people canonicals (no variants) on file A, so mergeFindings yields exactly them.
const scoutPeople = (canonicals) => ({
  '^scout:A': { speakers: [{ label: '记者', role: '记者' }], people: canonicals.map((c) => ({ canonical: c, variants: [] })), brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
  '^scout:B': { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
})

const TWO_FILES = [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })]

test('dedup skip: prior covers ≥90% of the batch → the dedup agent is skipped and the coverage counts are logged', async () => {
  const labels = [], logs = []
  // 9 prior-verified people + 1 genuinely new one = 10 total, 1 unknown → ratio 0.10 (≤ threshold) → skip.
  const known = Array.from({ length: 9 }, (_, i) => `人${i}`)
  const eng = engineWithLogs(labels, logs, scoutPeople([...known, '新人']))
  const r = await runPipeline(A({ verifyDepth: 'none', priorGlossaryText: priorWithVerified(9), files: TWO_FILES }), eng)
  assert.ok(!labels.includes('dedup:semantic'), 'the semantic dedup agent is NOT dispatched when prior coverage clears the threshold')
  const skipLog = logs.find((l) => l.includes('疑似同指缓存') && l.includes('跳过'))
  assert.ok(skipLog, 'a skip log line is emitted')
  assert.ok(/9\/10/.test(skipLog) && /10%/.test(skipLog), 'the log states the covered/total counts and the unknown ratio')
  assert.deepEqual(r.suspectedDuplicates, [], 'no fresh suspects are produced on a skipped batch')
})

test('dedup skip: below the coverage threshold the dedup agent still runs', async () => {
  const labels = [], logs = []
  // 5 prior-verified + 5 new = 10 total, 5 unknown → ratio 0.50 (> threshold) → NO skip.
  const known = Array.from({ length: 5 }, (_, i) => `人${i}`)
  const fresh = Array.from({ length: 5 }, (_, i) => `新${i}`)
  const eng = engineWithLogs(labels, logs, scoutPeople([...known, ...fresh]))
  await runPipeline(A({ verifyDepth: 'none', priorGlossaryText: priorWithVerified(5), files: TWO_FILES }), eng)
  assert.ok(labels.includes('dedup:semantic'), 'the semantic dedup agent runs when too many entities are new')
  assert.ok(!logs.some((l) => l.includes('疑似同指缓存')), 'no skip line is logged when dedup runs')
})

test('dedup skip: a first run (no prior) never skips dedup', async () => {
  const labels = [], logs = []
  const eng = engineWithLogs(labels, logs, scoutPeople(['甲', '乙', '丙']))
  await runPipeline(A({ verifyDepth: 'none', files: TWO_FILES }), eng) // no priorGlossaryText
  assert.ok(labels.includes('dedup:semantic'), 'with no prior glossary there is nothing to skip against — dedup always runs')
})

// ---------- SF-5 normalizeAuditResult shape guard ----------

test('SF-5: normalizeAuditResult accepts BOTH a per-file object and a {files:[…]} bundle', () => {
  const perFile = { file: '/o/Transcripts/A.md', status: 'ok', failed: [], gaps: [] }
  assert.equal(normalizeAuditResult(perFile), perFile, 'a per-file result passes through unchanged')
  const bundle = { status: 'fail', files: [{ file: '/o/Transcripts/A.md', status: 'ok' }, { file: '/o/Transcripts/B.md', status: 'fail' }] }
  // With a file, it matches by path; without, it takes files[0].
  assert.equal(normalizeAuditResult(bundle, { outPath: '/o/Transcripts/B.md' }).file, '/o/Transcripts/B.md', 'bundle → the matching file by outPath')
  assert.equal(normalizeAuditResult(bundle).file, '/o/Transcripts/A.md', 'bundle without f → files[0]')
  assert.equal(normalizeAuditResult(null), null, 'null → null')
  assert.equal(normalizeAuditResult({ files: [] }), null, 'an empty bundle → null')
})

test('SF-5: the pipeline audit gate normalizes a capability that returns a {files:[…]} bundle', async () => {
  const labels = []
  // This capability returns the FULL bundle shape (not per-file) — the guard must still extract the right file.
  const capabilities = {
    runAudit: (f) => ({ status: 'ok', files: [{ file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }] }),
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.equal(r.refined[0].audit.status, 'ok', 'a bundle-shaped capability return is normalized to a per-file result')
  assert.deepEqual(r.auditFailed, [])
})

// ---------- risk (a): first run — audit glossary comes from THIS round's in-memory 校对表 ----------

test('risk (a): on a first run the audit capability receives the in-memory glossaryText (not a disk read)', async () => {
  const labels = []
  let seenGlossary = null
  const eng = engine(labels, {
    '^scout': { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [{ canonical: '示例品牌', variants: ['示例品拍'] }], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
  })
  const capabilities = {
    runAudit: (f, opts = {}) => { seenGlossary = opts.glossaryText; return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    annotateAnchors: () => ({ updated: [] }),
  }
  // 2 files → the scout/verify/render branch runs and a real 校对表 is rendered in memory this round.
  await runPipeline(A({ verifyDepth: 'none', capabilities, files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })] }), eng)
  assert.ok(seenGlossary && typeof seenGlossary === 'string', 'the capability got a glossaryText string')
  assert.ok(seenGlossary.includes('示例品牌'), 'it is THIS round\'s in-memory glossary (the entity is present) — not an empty disk read')
})

test('risk (a): the single-file one-pass branch passes NO glossary (SINGLE_FILE_GLOSSARY is not a real 校对表)', async () => {
  const labels = []
  let called = false, seen = 'unset'
  const capabilities = {
    runAudit: (f, opts = {}) => { called = true; seen = opts.glossaryText; return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    annotateAnchors: () => ({ updated: [] }),
  }
  // A single short file → one-pass branch → glossary === SINGLE_FILE_GLOSSARY → audit gets null (no ghost/yin).
  await runPipeline(A({ capabilities, files: [F({ chars: 1000 })] }), engine(labels))
  assert.ok(called, 'the audit still ran for the one-pass file')
  assert.equal(seen, null, 'no fake glossary is handed to the audit on the one-pass path')
})

// ---------- risk (b): per-capability agent fallback ----------

test('risk (b): with ONLY runAudit injected, the anchors step still runs via the agent fallback', async () => {
  const labels = []
  // runAudit is a capability, but annotateAnchors is NOT — the anchors step must fall back to the agent
  // (previously the whole step was skipped in this mixed configuration).
  const capabilities = { runAudit: (f) => ({ file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }) }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.ok(labels.includes('anchors:A'), 'the anchors agent fallback ran even though runAudit is a capability')
  assert.equal(r.refined[0].audit.status, 'ok')
})

test('risk (b): with ONLY runAudit injected and a still-hard gap, the annotate marker also falls back to the agent', async () => {
  const labels = []
  // runAudit + (implicitly) the CC repair path via runAudit-absent? No — runAudit IS present, so repair is NOT
  // auto-run (Universal semantics). The gap stays hard → annotate must still fall back to the agent.
  const capabilities = { runAudit: (f) => ({ file: f.outPath, status: 'fail', failed: ['content_gap'], gaps: [{ startLine: 10, endLine: 30, chars: 400, severity: 'hard' }], findings: [] }) }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.ok(labels.includes('annotate:A'), 'the annotate agent fallback ran (annotate capability absent)')
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['content_gap'] }], 'still-hard is recorded')
})

// ---------- risk (c): cross-category override warning ----------

test('risk (c): a person-declared decree whose writing appears in a BRAND cluster is flagged (still locked in person)', async () => {
  const labels = []
  const eng = engine(labels, {
    // the scout surfaces 苍碧科技 as a BRAND; the decree declares it a person (default category).
    '^scout': { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [{ canonical: '苍碧科技', variants: [] }], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
    '^verify': { resolved: [], unresolved: [] },
  })
  const r = await runPipeline(A({ verifyDepth: 'none', canonicalOverrides: [{ canonical: '苍璧科技', variants: ['苍碧科技'] }], files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })] }), eng)
  const warn = r.openQuestions.find((q) => typeof q === 'string' && q.includes('类别疑误标') && q.includes('苍璧科技'))
  assert.ok(warn, 'a cross-category mis-declared-category warning is surfaced into openQuestions')
  assert.ok(warn.includes('人名') && warn.includes('品牌'), 'the warning names both the declared and found-in categories')
  // It is still LOCKED in the declared (person) category — the declaration is honoured, only flagged.
  const personLine = r.glossary.split('\n').find((l) => l.includes('苍璧科技')) || ''
  assert.ok(personLine.includes('用户钦定'), 'the decree is still locked (〔用户钦定〕) in the declared category')
})
