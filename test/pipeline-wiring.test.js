import assert from 'node:assert/strict'
import test from 'node:test'
import { runPipeline, normalizeAuditResult } from '../core/pipeline.js'
import { auditPair } from '../scripts/audit_refined.mjs'

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

// ---------- every file enters Scout, including one short file ----------

test('short single file always enters Scout and carries canonicalOverrides into the normal Refine prompt', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {}, prompts)
  await runPipeline(A({
    files: [F({ chars: 1000 })],
    canonicalOverrides: [{ canonical: '陈涛', variants: ['陈焘', '陈涛（同音）'] }],
  }), eng)
  assert.ok(labels.includes('scout:A'), 'a short single file still runs full-text Scout')
  const refinePrompt = prompts.find((x) => x.label === 'refine:A').prompt
  assert.ok(/用户钦定/.test(refinePrompt), 'the normal Refine prompt carries the locked glossary entry')
  assert.ok(refinePrompt.includes('陈涛') && refinePrompt.includes('陈焘'), 'both canonical and variant are named')
})

test('short single file without canonicalOverrides still enters Scout', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {}, prompts)
  await runPipeline(A({ files: [F({ chars: 1000 })] }), eng)
  assert.ok(labels.includes('scout:A'), 'there is no short-file Scout bypass')
  const refinePrompt = prompts.find((x) => x.label === 'refine:A').prompt
  assert.ok(!/用户钦定正名/.test(refinePrompt), 'no decree section appears when there is no override')
})

test('short single file hands the normal in-memory glossary to audit', async () => {
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

test('short single file without overrides still hands the Scout-built glossary to audit', async () => {
  const labels = []
  let seenGlossary = 'unset'
  const capabilities = {
    runAudit: (f, opts = {}) => { seenGlossary = opts.glossaryText; return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    annotateAnchors: () => ({ updated: [] }),
  }
  await runPipeline(A({ files: [F({ chars: 1000 })], capabilities }), engine(labels))
  assert.ok(typeof seenGlossary === 'string' && seenGlossary.includes('统一校对表'), 'the normal Scout-built glossary reaches audit')
})

test('generic speakers bypass the short-file fast path and every Refine read uses the Scout-resolved input', async () => {
  const labels = [], prompts = []
  let auditSource = '', outputEnforced = false
  const capabilities = {
    prepareSpeakerInput: (f, finding) => {
      assert.equal(f.path, '/s/A.txt', 'the resolver reads the untouched original')
      assert.equal(finding.speakers[0].output_label, '刘益枫')
      return {
        path: '/o/.converted/A.speaker-resolved.md',
        mappings: [{ sourceLabel: '发言人 1', outputLabel: '刘益枫', basis: 'scout_output_label' }],
        unresolved: [],
        changedLines: 12,
        labelLines: 12,
      }
    },
    enforceSpeakerOutput: (f) => {
      outputEnforced = true
      assert.equal(f.refinePath, '/o/.converted/A.speaker-resolved.md', 'output enforcement reuses the prepared mapping')
      return { changedLines: 1, replacements: [{ line: 10, from: '发言人 1', to: '刘益枫' }], unknownLabels: [] }
    },
    runAudit: (f) => {
      auditSource = f.path
      return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }
    },
    annotateAnchors: () => ({ updated: [] }),
  }
  const eng = engine(labels, {
    '^scout': {
      speakers: [{ label: '发言人 1', role: '受访者', identity: '刘益枫，某公司创始人', output_label: '刘益枫' }],
      people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [],
    },
  }, prompts)
  const result = await runPipeline(A({
    files: [F({ chars: 1000, needsSpeakerResolution: true })],
    capabilities,
  }), eng)

  assert.ok(labels.includes('scout:A'), 'a generic-label short file no longer skips the whole-file Scout')
  const refine = prompts.find((item) => item.label === 'refine:A')
  assert.ok(refine.prompt.includes('/o/.converted/A.speaker-resolved.md'), 'Refine reads the materialized canonical-label copy')
  assert.ok(refine.prompt.includes('发言人 1 → 刘益枫'), 'the one mapping is explicit in the prompt')
  assert.equal(outputEnforced, true, 'the same mapping is enforced once after Refine and before audit')
  assert.equal(auditSource, '/s/A.txt', 'the source-aware audit still compares against the original transcript')
  assert.equal(result.speakerResolutions[0].mappings[0].outputLabel, '刘益枫')
  assert.equal(result.speakerOutputNormalizations[0].changedLines, 1)
})

function unknownSpeakerCapabilities() {
  return {
    enforceSpeakerOutput: () => ({
      changedLines: 0,
      replacements: [],
      unknownLabels: [{ line: 3, label: '王小明' }],
      valid: false,
      violations: [{ line: 3, label: '王小明', kind: 'unknown_speaker_label' }],
    }),
    runAudit: (f) => ({ file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }),
    annotateAnchors: () => ({ updated: [] }),
  }
}

test('a high-confidence LLM verdict is required before an unknown output label blocks delivery', async () => {
  const labels = []
  const r = await runPipeline(A({ capabilities: unknownSpeakerCapabilities() }), engine(labels, {
    '^speaker-adjudicate': {
      decisions: [{
        line: 3,
        label: '王小明',
        verdict: 'invented_speaker',
        confidence: 'high',
        reason: 'dialogue_turn_without_source',
      }],
    },
  }))
  assert.equal(labels.filter((label) => label === 'speaker-adjudicate:A').length, 1)
  assert.deepEqual(r.failed, ['A'])
  assert.equal(r.refined.length, 0)
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['speaker_structure'] }])
  assert.equal(r.speakerCandidateAdjudications[0].status, 'blocked')
  assert.equal(r.speakerStructuralFailures[0].labels[0], '王小明')
})

test('an unavailable or uncertain LLM verdict becomes review-needed instead of a hard failure', async () => {
  const labels = []
  const r = await runPipeline(A({
    scope: ['refine', 'summary'],
    capabilities: unknownSpeakerCapabilities(),
  }), engine(labels))
  assert.equal(labels.filter((label) => label === 'speaker-adjudicate:A').length, 1)
  assert.deepEqual(r.failed, [])
  assert.equal(r.refined.length, 1)
  assert.deepEqual(r.auditFailed, [])
  assert.ok(r.summary, 'review-tier speaker ambiguity does not suppress requested derivatives')
  assert.equal(r.speakerCandidateAdjudications[0].status, 'unavailable')
  assert.ok(r.speakerStructureWarnings[0].warnings.some((item) => item.kind === 'speaker_candidate_adjudication_unavailable'))
  assert.ok(r.openQuestions.some((item) => item.includes('第 3 行“王小明”')))
})

test('a high-confidence non-speaker verdict clears the candidate without a warning', async () => {
  const labels = []
  const r = await runPipeline(A({ capabilities: unknownSpeakerCapabilities() }), engine(labels, {
    '^speaker-adjudicate': {
      decisions: [{
        line: 3,
        label: '王小明',
        verdict: 'not_speaker',
        confidence: 'high',
        reason: 'heading_or_caption',
      }],
    },
  }))
  assert.deepEqual(r.failed, [])
  assert.equal(r.refined.length, 1)
  assert.deepEqual(r.auditFailed, [])
  assert.deepEqual(r.speakerStructureWarnings, [])
  assert.equal(r.speakerCandidateAdjudications[0].status, 'cleared')
})

// ---------- §2 in-pipeline audit gate (capability injection) ----------

test('an exact double remains reviewable without repair or derivative suppression', async () => {
  const labels = []
  let repairs = 0
  const sourceText = '记者：请告诉我我的安排。\n\n受访者：这个选择可以，但是是另一种方案。'
  const capabilities = {
    runAudit: (f) => auditPair({ sourceText, refinedText: sourceText, refinedFile: f.outPath, mode: 'logic' }),
    repair: () => { repairs += 1 },
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ scope: ['refine', 'summary'], capabilities }), engine(labels))
  assert.equal(repairs, 0, 'a review-only double does not spend a repair round')
  assert.deepEqual(r.auditFailed, [])
  assert.ok(r.summary, 'a review-only double does not suppress requested derivatives')
  assert.deepEqual(r.refined[0].audit.hardFindings, [])
})

test('a triple repeat still receives capped repair and suppresses derivatives when it persists', async () => {
  const labels = []
  let repairs = 0
  const sourceText = '受访者：我我我觉得这个方向可以。'
  const capabilities = {
    runAudit: (f) => auditPair({ sourceText, refinedText: sourceText, refinedFile: f.outPath, mode: 'logic' }),
    repair: () => { repairs += 1 },
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ scope: ['refine', 'summary'], capabilities }), engine(labels))
  assert.equal(repairs, 2)
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['residual_noise'] }])
  assert.equal(r.summary, null)
  assert.deepEqual(r.derivativesSkipped.map((x) => x.kind), ['summary'])
})

test('audit gate: content_gap hard → auto-repair → re-audit passes → not auditFailed', async () => {
  const labels = []
  let auditCalls = 0, repaired = false, anchored = false
  const auditContexts = []
  const capabilities = {
    runAudit: (f, opts) => { auditCalls += 1; auditContexts.push(opts); return auditCalls === 1
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
  assert.equal(auditContexts[0].phase, 'pre_audit')
  assert.deepEqual({ phase: auditContexts[1].phase, round: auditContexts[1].round }, { phase: 'post_repair_round_1', round: 1 })
})

test('audit gate: still hard after two repair rounds → auditFailed + visible marker (annotate) + fail status', async () => {
  const labels = []
  let annotateCalled = false, auditCalls = 0, repairCalls = 0
  const capabilities = {
    runAudit: (f) => { auditCalls += 1; return { file: f.outPath, status: 'fail', failed: ['content_gap', 'quote_style'], gaps: [{ startLine: 10, endLine: 30, chars: 400, severity: 'hard' }], findings: [] } },
    repair: () => { repairCalls += 1 }, // both repairs run but both re-audits still fail
    annotate: () => { annotateCalled = true },
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.equal(auditCalls, 3, 'initial audit plus one re-audit after each of two capped repairs')
  assert.equal(repairCalls, 2, 'repair is capped at two rounds')
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['content_gap', 'quote_style'] }])
  assert.ok(annotateCalled, 'a still-hard gap drops a visible 缺口 marker')
  assert.equal(r.refined[0].audit.status, 'fail')
  assert.equal(r.refined[0].audit.repairAttempts.length, 2)
})

test('known-bad body is delivered but logic/summary/timeline are withheld', async () => {
  const labels = []
  const capabilities = {
    runAudit: (f) => ({ file: f.outPath, status: 'fail', failed: ['content_gap'], gaps: [{ startLine: 10, endLine: 30, chars: 400, severity: 'hard' }], findings: [] }),
    repair: () => {}, annotate: () => {}, annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ scope: ['refine', 'logic', 'summary', 'timeline'], capabilities }), engine(labels))
  assert.equal(r.refined.length, 1, 'the blocked main transcript is still returned')
  assert.deepEqual(r.logic, [])
  assert.equal(r.summary, null)
  assert.equal(r.timeline, null)
  assert.deepEqual(r.derivativesSkipped.map((x) => x.kind), ['logic', 'summary', 'timeline'])
  assert.ok(!labels.some((l) => /^(logic|summary|timeline)/.test(l)), 'no derivative agent reads the known-bad body')
})

test('audit gate (P7): a throwing runAudit capability is retried once, then FAILS LOUDLY (universal fs path)', async () => {
  const labels = []
  let auditCalls = 0
  const capabilities = {
    runAudit: () => { auditCalls += 1; throw new Error('simulated sandbox/fs error') },
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.equal(auditCalls, 2, 'the direct audit is retried exactly once before giving up')
  assert.deepEqual(r.auditUnavailable, [{ path: '/o/Transcripts/A.md', label: 'A' }], 'a persistently-throwing audit fails the run loudly, not silently')
  assert.equal(r.refined[0].audit.auditUnavailable, true)
})

test('audit gate: publication-quality failures receive two repairs and still block when they persist', async () => {
  const labels = []
  let audits = 0, repairs = 0
  const capabilities = {
    runAudit: (f) => { audits += 1; return { file: f.outPath, status: 'fail', failed: ['under_refined'], gaps: [], findings: [] } },
    repair: () => { repairs += 1 },
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine(labels))
  assert.equal(audits, 3, 'publication-quality failure is re-audited after each repair round')
  assert.equal(repairs, 2, 'publication-quality failure gets both allowed repair rounds before blocking')
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['under_refined'] }])
  assert.deepEqual(r.refined[0].audit.hardFindings, ['under_refined'])
})

test('audit gate keeps failed repair tools visible even when a later Edit and the final audit succeed', async () => {
  let auditCalls = 0
  const capabilities = {
    runAudit: (f) => {
      auditCalls += 1
      return auditCalls === 1
        ? {
            file: f.outPath, status: 'fail', failed: ['residual_noise', 'attribution_mismatch'], gaps: [],
            findings: [
              { name: 'confirmation_repeats', severity: 'hard', count: 5, samples: [] },
              { name: 'attribution_mismatch', severity: 'hard', count: 6, samples: [] },
            ],
          }
        : { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }
    },
    repair: () => ({
      action: 'targeted_repair', model: 'deepseek-v4-pro', changed: true, agentCompleted: true,
      bytesBefore: 1000, bytesAfter: 1010,
      toolSummary: {
        succeeded: { Read: 30, Edit: 30 },
        failed: [
          { tool: 'Edit', code: 'TOOL_EDIT_TARGET_MISMATCH', count: 6 },
          { tool: 'Grep', code: 'TOOL_UNKNOWN', count: 5 },
        ],
      },
    }),
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine([]))
  const attempt = r.refined[0].audit.repairAttempts[0]
  assert.equal(r.refined[0].audit.status, 'ok', 'the successful final audit remains authoritative')
  assert.equal(attempt.outcome, 'passed_with_tool_errors')
  assert.deepEqual(attempt.hardIssueCountsBefore, { confirmation_repeats: 5, attribution_mismatch: 6, residual_noise: 1 })
  assert.deepEqual(attempt.toolSummary.failed, [
    { tool: 'Edit', code: 'TOOL_EDIT_TARGET_MISMATCH', count: 6 },
    { tool: 'Grep', code: 'TOOL_UNKNOWN', count: 5 },
  ])
  assert.deepEqual(attempt.failedAfter, [])
})

test('audit gate stops safely and records audit_unavailable when a post-repair re-audit cannot run', async () => {
  let auditCalls = 0
  const capabilities = {
    runAudit: (f) => {
      auditCalls += 1
      if (auditCalls === 1) return { file: f.outPath, status: 'fail', failed: ['content_gap'], gaps: [], findings: [] }
      throw new Error('audit unavailable after repair')
    },
    repair: () => ({ action: 'targeted_repair', model: 'deepseek-v4-pro', changed: true, agentCompleted: true }),
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({ capabilities }), engine([]))
  assert.equal(auditCalls, 3, 'the post-repair audit receives its normal one retry before stopping')
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['content_gap'] }])
  assert.equal(r.refined[0].audit.repairAttempts[0].outcome, 'audit_unavailable')
  assert.equal(r.refined[0].audit.repairAttempts.length, 1, 'a second repair never runs without a fresh audit')
})

test('chunk seam: a residual duplicate reported after deterministic stitch blocks derivatives', async () => {
  const labels = []
  const capabilities = {
    stitch: () => ({ path: '/o/Transcripts/A.md', seamRepairs: [], seamDuplicates: [{ seam: 1, repeatedBlocks: 2 }] }),
    runAudit: (f) => ({ file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }),
    annotateAnchors: () => ({ updated: [] }),
  }
  const r = await runPipeline(A({
    scope: ['refine', 'summary'],
    chunkMode: 'speed',
    files: [F({ chars: 30000, lines: 600 })],
    capabilities,
  }), engine(labels))
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['seam_duplicate'] }])
  assert.equal(r.refined[0].audit.status, 'fail')
  assert.equal(r.summary, null, 'a derivative cannot read a body with a residual seam duplicate')
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

test('audit gate without a transactional repair capability never lets a fallback agent overwrite the body', async () => {
  const labels = []
  const eng = engine(labels, {
    '^audit:': () => JSON.stringify({ status: 'fail', files: [{ file: '/o/Transcripts/A.md', status: 'fail', failed: ['residual_noise'], gaps: [], findings: [] }] }),
    '^anchors:': '已加锚点',
    '^repair:': '不应运行',
  })
  const r = await runPipeline(A(), eng)
  assert.ok(!labels.some((label) => label.startsWith('repair:')), 'no-fs runtime keeps the hard finding for manual repair')
  assert.deepEqual(r.auditFailed, [{ path: '/o/Transcripts/A.md', findings: ['residual_noise'] }])
  assert.deepEqual(r.qualityRepairAttempts, [])
})

test('audit gate (no capability): unparseable agent output → one retry → FAILS LOUDLY via top-level auditUnavailable, never throws', async () => {
  const labels = []
  const eng = engine(labels, { '^audit': '这不是 JSON，只是一段解释文字。' }) // both the call and the retry fail to parse
  const r = await runPipeline(A(), eng)
  assert.ok(labels.includes('audit:A') && labels.includes('audit-retry:A'), 'audited then retried once')
  // P7 fail-loud: an audit that could not run marks the run failed via top-level auditUnavailable — it is NOT a
  // quiet degrade. The per-file flag still records unavailability; the 成稿 is kept (not destroyed).
  assert.deepEqual(r.auditUnavailable, [{ path: '/o/Transcripts/A.md', label: 'A' }], 'the unaudited file is surfaced as a loud run-level failure')
  assert.equal(r.refined[0].audit.auditUnavailable, true, 'the per-file audit is still marked unavailable')
  assert.deepEqual(r.auditFailed, [], 'auditFailed stays for hard CONTENT findings; unavailability is its own channel')
})

// ---------- §5 logic missingSections auto-rerun ----------

const PASS_AUDIT = { runAudit: (f) => ({ file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] }), annotateAnchors: () => ({ updated: [] }) }

test('logic: a first-pass missing section triggers exactly one rerun that clears it', async () => {
  const labels = []
  const eng = engine(labels, {
    '^refine': { path: 'x', headings: ['某节', '另一节'], key_fixes: [], open_questions: [] },
    '^logic-rerun': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['某节', '另一节'] }], open_questions: [] },
    '^logic:': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['另一节'] }], open_questions: [] }, // omits 某节
  })
  const r = await runPipeline(A({ scope: ['refine', 'logic'], capabilities: PASS_AUDIT }), eng)
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
  const r = await runPipeline(A({ scope: ['refine', 'logic'], capabilities: PASS_AUDIT }), eng)
  assert.equal(labels.filter((l) => /^logic-rerun/.test(l)).length, 1, 'still only one rerun')
  assert.deepEqual(r.logic[0].missingSections, ['某节'], 'the still-missing heading is surfaced for a Step-5 spot-check')
})

test('logic: punctuation and whitespace variants in source_sections do not trigger a false rerun', async () => {
  const labels = []
  const eng = engine(labels, {
    '^refine': { path: 'x', headings: ['“Good Enough”之后，差异化会消失', '2023 年上海车展：一次集体的“Shock”'], key_fixes: [], open_questions: [] },
    '^logic': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['"good enough"之后差异化会消失', '２０２３年上海车展——一次集体的 shock'] }], open_questions: [] },
  })
  const r = await runPipeline(A({ scope: ['refine', 'logic'], capabilities: PASS_AUDIT }), eng)
  assert.deepEqual(r.logic[0].missingSections, [])
  assert.equal(labels.filter((l) => /^logic-rerun/.test(l)).length, 0, 'typesetting-only drift is already covered')
})

test('logic: safeName is applied to the 逻辑顺序 output path (a slash/colon title can\'t fabricate a directory)', async () => {
  const labels = []
  const eng = engine(labels, {
    '^logic': { path: 'y', mainline: '导读', threads: [{ title: '线1', source_sections: ['某节'] }], open_questions: [] },
  })
  const r = await runPipeline(A({ scope: ['refine', 'logic'], capabilities: PASS_AUDIT, files: [F({ title: 'A/B:2025' })] }), eng)
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

// ---------- contested identity (〔同指两解〕) end-to-end wiring ----------
// Coattail-mishear class, fictional placeholders: spoken/literal "K Frame", real product "Keyframe", coattail SEO
// site "kframe.ai". The scout flags "K Frame" suspect_asr → it reaches verify (even at key depth); verify applies
// the two-key rule and returns a contested verdict; the pipeline must land it as a 〔同指两解〕 glossary row (spoken
// form kept) and one 收尾待问 line in openQuestions.

test('wiring: a suspect brand reaches verify with its ⚠ signal + hint, and a contested verdict lands as 〔同指两解〕 + a 收尾待问 line', async () => {
  const labels = [], prompts = []
  const eng = engine(labels, {
    '^scout': { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [{ canonical: 'K Frame', variants: [], suspect_asr: true, hint: '受访者提到的剪辑工具' }], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] },
    '^verify': { resolved: [], unresolved: [], contested: [{ query: 'K Frame', literal: 'K Frame', literal_tier: '目录站/SEO 博客', correction: 'Keyframe', correction_tier: '官方域名', note: '字面命中仅为 Keyframe 的分销站，属搭便车反转' }] },
  }, prompts)
  const r = await runPipeline(A({ verifyDepth: 'key', files: [F(), F({ path: '/s/B.txt', label: 'B', outPath: '/o/Transcripts/B.md' })] }), eng)

  const verifyPrompt = prompts.filter((x) => /^verify/.test(x.label)).map((x) => x.prompt).join('\n')
  assert.ok(/K Frame/.test(verifyPrompt), 'the suspect brand is sent to verify')
  assert.ok(/⚠/.test(verifyPrompt) && /剪辑工具/.test(verifyPrompt), 'its suspicion signal + mention hint reach the prompt')
  assert.ok(/搭便车反转/.test(verifyPrompt) && /两把钥匙规则/.test(verifyPrompt), 'the hypothesis-driven protocol is emitted for the suspect chunk')

  const line = r.glossary.split('\n').find((l) => l.includes('K Frame')) || ''
  assert.ok(line.includes('〔同指两解〕'), 'the contested verdict renders as a 〔同指两解〕 row')
  assert.ok(/\*\*K Frame\*\*/.test(line), 'the spoken/literal form is kept as canonical (no referent substitution)')
  assert.ok(!line.includes('〔核实'), 'a contested row is not marked 已核实')

  const q = r.openQuestions.find((x) => typeof x === 'string' && x.includes('〔同指两解〕') && x.includes('K Frame'))
  assert.ok(q, 'a 收尾待问 line is surfaced for the contested identity')
  assert.ok(q.includes('B=Keyframe（官方域名）') && q.includes('A=K Frame（目录站/SEO 博客）'), 'both hypotheses + tiers are stated')
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

test('risk (a): a short single file now passes the Scout-built glossary to audit', async () => {
  const labels = []
  let called = false, seen = 'unset'
  const capabilities = {
    runAudit: (f, opts = {}) => { called = true; seen = opts.glossaryText; return { file: f.outPath, status: 'ok', failed: [], gaps: [], findings: [] } },
    annotateAnchors: () => ({ updated: [] }),
  }
  await runPipeline(A({ capabilities, files: [F({ chars: 1000 })] }), engine(labels))
  assert.ok(called, 'the audit ran for the short file')
  assert.ok(typeof seen === 'string' && seen.includes('统一校对表'), 'the normal Scout-built glossary reaches audit')
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
