import assert from 'node:assert/strict'
import test from 'node:test'
import { auditText } from '../scripts/audit_refined.mjs'

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
