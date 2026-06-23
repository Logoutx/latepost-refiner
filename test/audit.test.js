import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditText, auditPair } from '../scripts/audit_refined.mjs'

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')

// ---------- output-only audit (cleanliness) ----------

test('hard-fails on leftover filler, confirmation/stutter repeats, and run-on paragraphs', () => {
  const bad = '李明：对对对，嗯，我我觉得是这样。\n\n王某：' + '这是一段很长的独白内容反复说。'.repeat(200)
  const r = auditText(bad, 'bad.md')
  assert.equal(r.status, 'fail')
  const hard = r.findings.filter((f) => f.severity === 'hard' && f.count).map((f) => f.name)
  assert.ok(hard.includes('confirmation_repeats'), '对对对')
  assert.ok(hard.includes('filler_particles'), '嗯')
  assert.ok(hard.includes('stutter_repeats'), '我我')
  assert.equal(r.long_paragraphs.length, 1) // the >900-char monologue
})

test('sentence-final modal particles 啊/哦/欸 and 这个/那个 are soft — they do NOT fail the audit', () => {
  const ok = '李明：太贵了啊。\n\n王某：这个方案我们做过，那个先放放。\n\n李明：哦，明白了。'
  const r = auditText(ok, 'ok.md')
  assert.equal(r.status, 'ok')
  assert.equal(r.hard_issues, 0)
  const soft = r.findings.filter((f) => f.severity === 'soft' && f.count).map((f) => f.name)
  assert.ok(soft.includes('modal_particles'), '啊/哦 surfaced as soft')
  assert.ok(soft.includes('empty_phrase_candidates'), '这个/那个 surfaced as soft')
})

test('headings are skipped and a clean transcript passes', () => {
  const clean = '## 创业初期\n\n李明：我们 2018 年成立。\n\n王某：主要做供应链。'
  const r = auditText(clean, 'clean.md')
  assert.equal(r.status, 'ok')
  assert.equal(r.hard_issues, 0)
})

test('hard-fails phrase repeats, broken starts, and ASR glue left in refined output', () => {
  const bad = [
    '王某：因为因为当时我们刚开始做这个产品，本身本身是个尝试。',
    '王某：呢，那个全国的业务是从南京开始。',
    '王某：你说那个是',
    '王某：那是 2021 年，2021 年的计划。',
    '王某：涂鸦涂鸦智能做了公版模组，后来又看了 20182018 年的数据。',
    '王某：我们先把 APP APP 权限打通，避免 SaaSAPP 黏在一起。',
  ].join('\n\n')
  const r = auditText(bad, 'phase2-bad.md')
  assert.equal(r.status, 'fail')
  const hard = r.findings.filter((f) => f.severity === 'hard' && f.count).map((f) => f.name)
  assert.ok(hard.includes('phrase_repeats'), 'phrase/entity repeats')
  assert.ok(hard.includes('repeated_years'), 'repeated years')
  assert.ok(hard.includes('broken_fragment_starts'), 'broken speaker starts')
  assert.ok(hard.includes('asr_glue'), 'ASR glued tokens')
})

// ---------- source-aware audit (compression / under-refinement) ----------

test('refine mode hard-fails a compressed (summarized) output, primarily on charRatio', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('compressed.md'), mode: 'refine' })
  assert.equal(r.status, 'fail')
  assert.ok(r.failed.includes('compression_risk'), 'compression_risk fires')
  assert.ok(r.metrics.charRatio < 0.55, `charRatio ${r.metrics.charRatio} below floor`)
})

test('refine mode fails an under-refined output (coverage kept, filler not removed) via emptyReduction', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('under-refined.md'), mode: 'refine' })
  assert.equal(r.status, 'fail')
  assert.ok(r.failed.includes('under_refined'), 'under_refined fires')
  assert.ok(!r.failed.includes('compression_risk'), 'charRatio is high — not compression')
  assert.ok(r.metrics.charRatio >= 0.55, `charRatio ${r.metrics.charRatio} stays high`)
})

test('refine mode passes a faithful, properly-cleaned refine', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('clean.md'), mode: 'refine' })
  assert.equal(r.status, 'ok')
  assert.equal(r.failed.length, 0)
})

test('summary mode does NOT apply the compression gate (a summary is meant to be short)', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('compressed.md'), mode: 'summary' })
  assert.ok(!r.failed.includes('compression_risk'), 'no compression gate in summary mode')
  assert.equal(r.status, 'ok')
})

test('speakerTurnRatio is reported but never an independent gate (confirming-only)', () => {
  // A faithful refine that merges same-speaker fragments keeps a healthy ratio;
  // even a low ratio must not fail on its own when charRatio is fine.
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('clean.md'), mode: 'refine' })
  assert.equal(typeof r.metrics.speakerTurnRatio, 'number')
  assert.equal(r.status, 'ok')
})
