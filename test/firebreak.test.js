import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contradictionReopen, rotateReverify, excludeVerified, ROTATE_REVERIFY,
  clusterEntities, parseGlossary,
} from '../core/spec.js'
import { runPipeline } from '../core/pipeline.js'

// ============================================================================
// M9 — glossary firebreak 下半 (anti-fossilization). Fictional data ONLY (沈其安/沈启安/沈总/甲/乙/丙/丁 are
// 虚构占位；no real interview subject/company/brand). Two firebreaks that let a once-verified 〔核实〕 entry back
// into the verify queue: M9a contradiction re-open (new strong-writing evidence) and M9b age-rotation.
// ============================================================================

// ---------- M9a — contradictionReopen (unit) ----------

const priorVerified = (over = {}) => ({
  people: [{ canonical: '沈其安', variants: ['沈总'], confidence: 'verified', confidenceDate: '2025-01', ...over }],
  brands: [], terms: [], verified: { resolved: [], unresolved: [] },
})

test('M9a: a fresh cluster with a NEW strong variant (real-name-like) reopens a prior-verified entry', () => {
  const prior = priorVerified()
  const fresh = { people: clusterEntities([{ canonical: '沈其安', variants: ['沈启安'] }]), brands: [], terms: [] }
  const { writings, notes } = contradictionReopen(prior, fresh)
  assert.ok(writings.includes('沈其安'), 'the prior entry writings are returned for force-reopen')
  assert.equal(notes.length, 1)
  assert.ok(notes[0].includes('沈其安') && notes[0].includes('沈启安'), 'the note names both the prior canonical and the new writing')
  assert.ok(notes[0].includes('已重新入队核实'), 'the note carries the fixed phrasing')
})

test('M9a: a weak-honorific-only new variant does NOT reopen (沈总 / 沈老师 are not real-name evidence)', () => {
  const prior = priorVerified()
  const fresh = { people: clusterEntities([{ canonical: '沈其安', variants: ['沈总', '沈老师'] }]), brands: [], terms: [] }
  assert.deepEqual(contradictionReopen(prior, fresh), { writings: [], notes: [] })
})

test('M9a: a new writing the prior entry ALREADY lists is not a contradiction', () => {
  const prior = { people: [{ canonical: '沈其安', variants: ['沈启安'], confidence: 'verified', confidenceDate: '2025-01' }], brands: [], terms: [], verified: { resolved: [], unresolved: [] } }
  const fresh = { people: clusterEntities([{ canonical: '沈其安', variants: ['沈启安'] }]), brands: [], terms: [] }
  assert.deepEqual(contradictionReopen(prior, fresh), { writings: [], notes: [] }, 'the strong writing is already known → no fresh evidence')
})

test('M9a: only confidence:verified entries are eligible — a 用户钦定 entry is never auto-reopened', () => {
  const prior = { people: [{ canonical: '沈其安', variants: ['沈总'], confidence: 'user' }], brands: [], terms: [], verified: { resolved: [], unresolved: [] } }
  const fresh = { people: clusterEntities([{ canonical: '沈其安', variants: ['沈启安'] }]), brands: [], terms: [] }
  assert.deepEqual(contradictionReopen(prior, fresh), { writings: [], notes: [] }, 'a human decree outranks a new ASR variant')
})

test('M9a: an unrelated fresh cluster (no shared strong name) does not reopen', () => {
  const prior = priorVerified()
  const fresh = { people: clusterEntities([{ canonical: '周砚', variants: ['周研'] }]), brands: [], terms: [] }
  assert.deepEqual(contradictionReopen(prior, fresh), { writings: [], notes: [] })
})

// ---------- M9b — rotateReverify (unit) ----------

const threeVerified = () => ({
  people: [
    { canonical: '甲', variants: [], confidence: 'verified', confidenceDate: '2025-03' }, // newest
    { canonical: '乙', variants: [], confidence: 'verified', confidenceDate: '2024-01' }, // 2nd oldest
    { canonical: '丙', variants: [], confidence: 'verified', confidenceDate: '' },         // undated → oldest
  ],
  brands: [], terms: [], verified: { resolved: [], unresolved: [] },
})

test('M9b: the N=2 OLDEST verified entries are picked; the newest is left out', () => {
  const rot = rotateReverify(threeVerified(), ROTATE_REVERIFY)
  assert.equal(ROTATE_REVERIFY, 2)
  assert.equal(rot.count, 2)
  assert.deepEqual(rot.writings.sort(), ['丙', '乙'].sort(), 'the undated + the 2024 entry rotate; 甲 (2025) does not')
  assert.ok(!rot.writings.includes('甲'), 'the newest verified entry is NOT rotated')
})

test('M9b: an undated legacy 〔核实〕 marker counts as OLDEST (sorts first)', () => {
  const rot = rotateReverify(threeVerified(), 1)
  assert.deepEqual(rot.writings, ['丙'], 'the sole undated entry is the single oldest')
  assert.equal(rot.oldest, '', 'oldest date is the empty string (undated)')
})

test('M9b: no verified entries → empty; n<=0 → empty', () => {
  assert.deepEqual(rotateReverify({ people: [], brands: [], terms: [], verified: { resolved: [], unresolved: [] } }), { writings: [], count: 0, oldest: null })
  assert.deepEqual(rotateReverify(threeVerified(), 0), { writings: [], count: 0, oldest: null })
  assert.deepEqual(rotateReverify(null), { writings: [], count: 0, oldest: null })
})

test('M9b: rotated writings, fed to excludeVerified as forceReopen, re-enter the verify set (recurring this batch)', () => {
  const prior = threeVerified()
  const rot = rotateReverify(prior, 2)
  const fresh = { people: clusterEntities([{ canonical: '甲', variants: [] }, { canonical: '乙', variants: [] }, { canonical: '丙', variants: [] }, { canonical: '新', variants: [] }]), brands: [], terms: [] }
  const out = excludeVerified(fresh, prior, rot.writings)
  const names = out.people.map((p) => p.canonical)
  assert.ok(names.includes('乙') && names.includes('丙'), 'the 2 rotated oldest re-enter the verify set')
  assert.ok(!names.includes('甲'), 'the newest verified entry stays excluded (permanent trust intact this round)')
  assert.ok(names.includes('新'), 'a brand-new entity is unaffected')
})

test('excludeVerified without forceReopen is byte-for-byte the pre-M9 behaviour (all verified excluded)', () => {
  const prior = threeVerified()
  const fresh = { people: clusterEntities([{ canonical: '甲', variants: [] }, { canonical: '乙', variants: [] }, { canonical: '丙', variants: [] }, { canonical: '新', variants: [] }]), brands: [], terms: [] }
  const out = excludeVerified(fresh, prior)   // 2-arg call, back-compat
  assert.deepEqual(out.people.map((p) => p.canonical), ['新'], 'all three verified stay excluded; only the new one survives')
})

// ---------- pipeline wiring (M9a + M9b end-to-end with a mock engine) ----------

const F = (over = {}) => ({ path: '/s/A.txt', label: 'A', lines: 100, chars: 5000, title: 'A', subtitle: '*s*', outPath: '/o/Transcripts/A.md', ...over })
const A = (over = {}) => ({ topic: 'X', date: '2025-07', background: 'bg', outputDir: '/o', scope: ['refine'], verifyDepth: 'key', headingPolicy: 'none', files: [F()], ...over })

// A mock engine capturing every agent prompt (zero tokens). Scout returns whatever `scoutPeople` we inject.
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

const scoutWith = (people) => ({ speakers: [{ label: '记者', role: '记者' }], people, brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 100, text: '完' }, special_notes: [] })

test('M9a wiring: a contradicting fresh strong variant puts the prior-verified entity back in the verify prompt + renders the note', async () => {
  const labels = [], prompts = []
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **沈其安** ← 沈总 ｜ 创始人 〔核实·2025-01〕',
  ].join('\n')
  const eng = engine(labels, {
    '^scout': scoutWith([{ canonical: '沈其安', variants: ['沈启安'] }]),  // NEW strong writing 沈启安
    '^verify': { resolved: [], unresolved: [] },
  }, prompts)
  const r = await runPipeline(A({ verifyDepth: 'deep', priorGlossaryText: priorMd }), eng)
  const verifyPrompts = prompts.filter((x) => /^verify/.test(x.label)).map((x) => x.prompt).join('\n')
  assert.ok(/沈其安|沈启安/.test(verifyPrompts), 'the reopened entity is sent back to verify this batch')
  assert.ok(r.glossary.includes('本轮重新入队复核'), 'the glossary carries the re-open note section')
  assert.ok(r.glossary.includes('沈启安'), 'the note names the new contradicting writing')
  assert.ok(r.openQuestions.some((q) => /重新入队核实/.test(q)), 'the note also folds into openQuestions')
})

test('M9a wiring: a weak-honorific-only new variant does NOT trigger the contradiction re-open (no note)', async () => {
  // Isolate M9a: assert on its OBSERVABLE — the re-open NOTE. (The entity may still re-enter verify via the
  // separate M9b age-rotation, since it is the only/oldest verified entry here; that is tested independently.)
  const labels = [], prompts = []
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **沈其安** ← 沈启安 ｜ 创始人 〔核实·2025-01〕',   // prior already lists the strong writing
  ].join('\n')
  const eng = engine(labels, {
    '^scout': scoutWith([{ canonical: '沈其安', variants: ['沈总'] }]),   // only a weak honorific this batch
    '^verify': { resolved: [], unresolved: [] },
  }, prompts)
  const r = await runPipeline(A({ verifyDepth: 'deep', priorGlossaryText: priorMd }), eng)
  assert.ok(!r.glossary.includes('本轮重新入队复核'), 'no M9a re-open note section is rendered (weak evidence)')
  assert.ok(!r.openQuestions.some((q) => /重新入队核实/.test(q)), 'no M9a re-open note in openQuestions')
})

test('M9b wiring: the 2 oldest verified entries (recurring this batch) are pulled back into the verify prompt', async () => {
  const labels = [], prompts = []
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **甲** ← 甲变 ｜ 早期 〔核实·2025-03〕',   // newest
    '- **乙** ← 乙变 ｜ 早期 〔核实·2024-01〕',   // 2nd oldest → rotated
    '- **丙** ← 丙变 ｜ 早期 〔核实〕',             // undated → oldest → rotated
  ].join('\n')
  const eng = engine(labels, {
    '^scout': scoutWith([{ canonical: '甲', variants: [] }, { canonical: '乙', variants: [] }, { canonical: '丙', variants: [] }]),
    '^verify': { resolved: [], unresolved: [] },
  }, prompts)
  await runPipeline(A({ verifyDepth: 'deep', priorGlossaryText: priorMd }), eng)
  const verifyPrompts = prompts.filter((x) => /^verify/.test(x.label)).map((x) => x.prompt).join('\n')
  assert.ok(/乙/.test(verifyPrompts) && /丙/.test(verifyPrompts), 'the 2 oldest (乙 dated-old, 丙 undated) are re-queued')
  assert.ok(!/甲/.test(verifyPrompts), 'the newest verified entry (甲) stays excluded')
})

test('M9b wiring: verifyDepth "none" → NO rotation (verify is off, nothing to re-check)', async () => {
  const labels = [], prompts = []
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **乙** ← 乙变 ｜ 早期 〔核实·2024-01〕',
    '- **丙** ← 丙变 ｜ 早期 〔核实〕',
  ].join('\n')
  const eng = engine(labels, {
    '^scout': scoutWith([{ canonical: '乙', variants: [] }, { canonical: '丙', variants: [] }]),
  }, prompts)
  await runPipeline(A({ verifyDepth: 'none', priorGlossaryText: priorMd }), eng)
  const verifyLabels = labels.filter((l) => /^verify/.test(l))
  assert.equal(verifyLabels.length, 0, 'no verify agent runs at all when verify is off')
})

test('M9b date refresh: a re-confirmed rotated entry gets a fresh 〔核实·<thisDate>〕 with a concrete source', async () => {
  const labels = [], prompts = []
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **乙** ← 乙变 ｜ 早期 〔核实·2024-01〕',
  ].join('\n')
  const eng = engine(labels, {
    '^scout': scoutWith([{ canonical: '乙', variants: ['乙变'] }]),
    // verify re-confirms 乙 with a CONCRETE source → confidenceMark tier 2 re-stamps this round's date.
    '^verify': { resolved: [{ query: '乙变', canonical: '乙', identity: '', source: 'example.com 团队页' }], unresolved: [] },
  }, prompts)
  const r = await runPipeline(A({ verifyDepth: 'deep', date: '2025-07', priorGlossaryText: priorMd }), eng)
  assert.ok(/乙.*〔核实·2025-07〕/.test(r.glossary), 'the rotated entry is re-stamped with 2025-07 after re-confirmation')
  assert.ok(!r.glossary.includes('〔核实·2024-01〕'), 'the stale 2024-01 date is gone')
})

test('M9b × M3 guard: a rotated entry re-confirmed with a NON-concrete source falls to 待复核, not a fresh 核实', () => {
  // The composition that matters: rotation puts an old 〔核实〕 back in the queue; if the re-verify names no
  // concrete evidence (网络搜索), the M3 provenance guard withholds a fresh 核实 date and renders 待复核 — so the
  // entry is re-checked AGAIN next batch instead of fossilizing a fresh-but-unsupported date. (Pure render check.)
  const labels = [], prompts = []
  const priorMd = [
    '# X 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）',
    '- **乙** ← 乙变 ｜ 早期 〔核实·2024-01〕',
  ].join('\n')
  const eng = engine(labels, {
    '^scout': scoutWith([{ canonical: '乙', variants: ['乙变'] }]),
    '^verify': { resolved: [{ query: '乙变', canonical: '乙', identity: '', source: '网络搜索' }], unresolved: [] }, // NO concrete source
  }, prompts)
  return runPipeline(A({ verifyDepth: 'deep', date: '2025-07', priorGlossaryText: priorMd }), eng).then((r) => {
    const line = r.glossary.split('\n').find((l) => l.includes('**乙**'))
    assert.ok(/待复核/.test(line), 'no concrete evidence → 待复核 (re-verifiable next batch)')
    assert.ok(!/核实·2025-07/.test(line), 'NO fresh permanent-trust date is minted on an unsupported re-confirm')
    assert.ok(!/核实·2024-01/.test(line), 'the stale date is also gone (re-render supersedes it)')
  })
})
