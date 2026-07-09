import assert from 'node:assert/strict'
import test from 'node:test'
import { checkNumericConsistency, auditPair, NUMERIC_CONSISTENCY } from '../scripts/audit_refined.mjs'
import { reviewSections, buildRunManifest, numericConsistencyItems } from '../universal/artifacts.js'

// ============================================================================
// P6 — within-document numeric consistency (single file, WARNING tier only).
// Fictional entities ONLY (云洲仪器 / 沈其安 placeholders), per the repo red line:
// never a real interview subject, company, or brand in a committed fixture.
// The failure this closes: the 成稿 states the SAME measured quantity twice with
// conflicting numbers, and every other gate passes because each is locally faithful.
// ============================================================================

test('P6 core: the same 毛利率 stated as 30% and 45% in one doc is ONE conflict with both line refs', () => {
  const doc = [
    '# 云洲仪器专访',
    '',
    '沈其安：公司这几年发展不错，毛利率 30%，团队也扩了不少。',
    '',
    '## 复盘',
    '',
    '沈其安：后来复盘时才发现，毛利率 45% 才是那年的真实水平。',
  ].join('\n')
  const { conflicts } = checkNumericConsistency(doc)
  assert.equal(conflicts.length, 1, 'exactly one measured-quantity conflict')
  assert.equal(conflicts[0].keyNoun, '毛利率')
  assert.equal(conflicts[0].unit, '%')
  assert.deepEqual(conflicts[0].values.map((v) => v.value).sort(), ['30', '45'])
  assert.ok(conflicts[0].values.every((v) => v.line > 0 && v.snippet), 'each occurrence carries a line ref + snippet')
})

test('P6 the same value repeated is NOT a conflict (30% and 30% agree)', () => {
  const doc = ['沈其安：毛利率 30% 很稳定。', '', '沈其安：确实，毛利率 30% 我们保持了好几年。'].join('\n')
  assert.equal(checkNumericConsistency(doc).conflicts.length, 0)
})

test('P6 an ESTIMATE never conflicts with a fact (毛利率大概 30% vs 毛利率 45%)', () => {
  const doc = ['沈其安：毛利率大概 30% 吧，记不太清。', '', '沈其安：这块业务，毛利率 45%。'].join('\n')
  assert.equal(checkNumericConsistency(doc).conflicts.length, 0, '大概 marks an estimate → that atom is skipped')
})

test('P6 a BOUND never conflicts (账期不到 3 个月 vs 账期 6 个月)', () => {
  const doc = ['沈其安：账期不到 3 个月。', '', '沈其安：另一条线，账期 6 个月。'].join('\n')
  assert.equal(checkNumericConsistency(doc).conflicts.length, 0, '不到 is a bound qualifier → the atom is not an exact fact')
})

test('P6 different measured nouns do NOT cross-conflict (毛利率 30% vs 净利率 45%)', () => {
  const doc = ['沈其安：这块，毛利率 30%。', '', '沈其安：那块，净利率 45%。'].join('\n')
  assert.equal(checkNumericConsistency(doc).conflicts.length, 0)
})

test('P6 a speaker label is never mistaken for the measured noun', () => {
  // 沈其安 is a label; the noun before each number is 毛利率, so this is one 毛利率 conflict, not a 沈其安 one
  const doc = ['沈其安：毛利率 30%。', '', '沈其安：毛利率 45%。'].join('\n')
  const { conflicts } = checkNumericConsistency(doc)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].keyNoun, '毛利率')
})

test('P6 headings / blockquotes / comments are ignored (not prose)', () => {
  const doc = ['## 毛利率 30% 的那一年', '', '> 编者按：毛利率 45% 存疑', '', '<!-- 毛利率 90% -->', '', '沈其安：毛利率 30% 是准的。'].join('\n')
  // only the one prose line carries a countable value → no conflict
  assert.equal(checkNumericConsistency(doc).conflicts.length, 0)
})

test('P6 is capped at MAX_CONFLICTS to avoid drowning the 复核清单', () => {
  const nouns = ['甲率', '乙率', '丙率', '丁率', '戊率', '己率', '庚率', '辛率', '壬率', '癸率', '子率', '丑率']
  const lines = []
  nouns.forEach((n, i) => {
    lines.push(`沈其安：这项，${n} ${10 + i}%。`, '', `沈其安：那项，${n} ${50 + i}%。`, '')
  })
  const { conflicts } = checkNumericConsistency(lines.join('\n'))
  assert.equal(conflicts.length, NUMERIC_CONSISTENCY.MAX_CONFLICTS, '12 conflicts → capped at 10')
})

// ---------- auditPair integration: SOFT ONLY, never gates ----------

test('P6 auditPair: numeric_inconsistency rides as a SOFT finding and never enters failed[]', () => {
  const src = ['沈其安 00:12', '老业务这边，毛利率三十个点；新业务那边，毛利率四十五个点，差别确实挺大的，这是实情。'].join('\n')
  const ref = ['## 毛利结构', '', '沈其安：老业务这边，毛利率 30%；新业务那边，毛利率 45%，差别确实挺大，这是实情。'].join('\n')
  const r = auditPair({ sourceText: src, refinedText: ref, mode: 'refine' })
  const nf = r.findings.find((f) => f.name === 'numeric_inconsistency')
  assert.ok(nf && nf.severity === 'soft' && nf.count === 1, 'soft finding present with the one conflict')
  assert.match(nf.samples[0].text, /毛利率/)
  assert.match(nf.samples[0].text, /30%/)
  assert.match(nf.samples[0].text, /45%/)
  assert.ok(!r.failed.includes('numeric_inconsistency'), 'a within-doc conflict is warning tier, never a gate')
  assert.equal(r.metrics.numericConsistency.conflicts, 1)
  assert.deepEqual(r.numericConflicts.length, 1, 'the conflict detail is attached to the pair result')
})

test('P6 auditPair: a self-consistent 成稿 produces no numeric_inconsistency finding', () => {
  const src = ['沈其安 00:12', '我们这块业务的毛利率去年就是三十个点，今年也基本维持在三十个点上下，很稳定。'].join('\n')
  const ref = ['## 毛利', '', '沈其安：我们这块业务的毛利率去年是 30%，今年也基本维持在 30% 上下，很稳定。'].join('\n')
  const r = auditPair({ sourceText: src, refinedText: ref, mode: 'refine' })
  assert.ok(!r.findings.some((f) => f.name === 'numeric_inconsistency'), 'no conflict finding when values agree')
  assert.equal(r.metrics.numericConsistency.conflicts, 0)
})

test('P6 auditPair: summary mode does not run the within-doc numeric check', () => {
  const r = auditPair({ sourceText: '沈其安 00:12\n随便一段。', refinedText: '毛利率 30%，毛利率 45%。', mode: 'summary' })
  assert.equal(r.metrics.numericConsistency, undefined)
  assert.ok(!r.findings.some((f) => f.name === 'numeric_inconsistency'))
})

test('P6 artifacts: within-doc conflicts render a medium-priority review section + persist in the manifest', () => {
  const result = {
    audit: { status: 'ok', files: [{ file: '/out/Transcripts/示例访谈.md', status: 'ok', failed: [], sections: [],
      numericConflicts: [{ keyNoun: '毛利率', unit: '%', values: [{ value: '30', line: 3 }, { value: '45', line: 7 }] }] }] },
  }
  const items = numericConsistencyItems(result)
  assert.equal(items.length, 1)
  assert.match(items[0], /示例访谈\.md/)
  assert.match(items[0], /“毛利率”自相矛盾/)
  assert.match(items[0], /第 3 行作“30%”/)
  assert.match(items[0], /第 7 行作“45%”/)
  assert.ok(!/["']/.test(items[0]), 'no ASCII quotes leak into the Chinese review line')
  const sec = reviewSections(result, []).find((s) => s.title.includes('文档内数值自相矛盾'))
  assert.ok(sec && sec.priority === 'medium' && sec.items.length === 1, 'a medium-priority review section is emitted')
  const manifest = buildRunManifest(result, {})
  assert.equal(manifest.result.numericConflicts.length, 1, 'persisted to the manifest (alongside crossFileConflicts)')
  assert.equal(manifest.result.numericConflicts[0].file, '示例访谈.md')
  assert.equal(manifest.result.numericConflicts[0].keyNoun, '毛利率')
})
