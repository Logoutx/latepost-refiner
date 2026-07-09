import assert from 'node:assert/strict'
import test from 'node:test'
import { auditGlossary, parseGlossaryEntities } from '../scripts/audit_refined.mjs'
import { reviewSections, glossarySourceItems } from '../universal/artifacts.js'

// ============================================================================
// P2b — 校对表 source labels. Fictional entities ONLY (周衡 / 林骁 / 沈其安 /
// 云洲仪器 placeholders), per the repo red line: never a real interview subject,
// company, or brand in a committed fixture. The failure this closes: a glossary
// row asserts a publicly-sourced fact as if the interviewee confirmed it.
// ============================================================================

const H = '## 人名（写法 → 统一）'

test('P2b parseGlossaryEntities exposes label / citesExternal / publicMarker per row', () => {
  const g = [H,
    '- **周衡** ← 周恒 ｜ 据公开报道任某公司 CFO ｜ 【访谈】',
    '- **沈其安** ← 沈其岸 ｜ 受访者本人亲述 ｜ 【访谈】',
    '- **林骁** ← 林晓 ｜ 同事',
  ].join('\n')
  const by = Object.fromEntries(parseGlossaryEntities(g).map((e) => [e.canonical, e]))
  assert.equal(by['周衡'].label, 'interview')
  assert.equal(by['周衡'].citesExternal, true, '据公开报道 is an external-source citation')
  assert.equal(by['周衡'].publicMarker, false)
  assert.equal(by['沈其安'].citesExternal, false, '亲述 is not an external source')
  assert.equal(by['林骁'].hasExplicitLabel, false, 'no 【…】 label')
})

test('P2b mislabel: a row citing external/public sources but标【访谈】 is flagged', () => {
  const g = [H,
    '- **周衡** ← 周恒 ｜ 据公开报道任某公司 CFO ｜ 【访谈】',
    '- **沈其安** ← 沈其岸 ｜ 受访者本人 ｜ 【访谈】',
  ].join('\n')
  const r = auditGlossary(g)
  const mis = r.findings.find((f) => f.name === 'glossary_source_mislabel')
  assert.equal(mis.count, 1, 'only the externally-sourced 访谈 row is flagged')
  assert.equal(mis.severity, 'soft')
  assert.match(mis.samples[0].text, /周衡/)
  assert.match(mis.samples[0].text, /访谈亲述/)
})

test('P2b NOT mislabel: the same external citation carrying 【公开·待记者核实】 or 〔核实〕 passes', () => {
  const g = [H,
    '- **某型号** ← 某型 ｜ 据公开报道规格如下 ｜ 【公开·待记者核实】',
    '- **沈其安** ← 沈其岸 ｜ 据官网团队页任创始人 ｜ 创始人 〔核实·2025-07〕',
  ].join('\n')
  const r = auditGlossary(g)
  assert.equal(r.findings.find((f) => f.name === 'glossary_source_mislabel').count, 0, 'a properly-public-marked row is not a mislabel')
})

test('P2b unlabeled: once the table uses 【…】 labels, rows still missing one are listed', () => {
  const g = [H,
    '- **周衡** ← 周恒 ｜ 受访者 ｜ 【访谈】',
    '- **林骁** ← 林晓 ｜ 同事',
    '- **云洲仪器** ← 云舟仪器 ｜ 主体公司',
  ].join('\n')
  const r = auditGlossary(g)
  const un = r.findings.find((f) => f.name === 'glossary_source_unlabeled')
  assert.equal(un.count, 2, 'the two rows without a source label are listed')
  assert.ok(un.samples.some((s) => s.text.includes('林骁')) && un.samples.some((s) => s.text.includes('云洲仪器')))
})

test('P2b a legacy table using NO 【…】 labels at all is not nagged about unlabeled rows', () => {
  const g = [H,
    '- **周衡** ← 周恒 ｜ 受访者',
    '- **林骁** ← 林晓 ｜ 同事',
  ].join('\n')
  const r = auditGlossary(g)
  assert.equal(r.findings.find((f) => f.name === 'glossary_source_unlabeled').count, 0, 'the convention is not in use → no nag')
  assert.equal(r.findings.find((f) => f.name === 'glossary_source_mislabel').count, 0, 'and no external citation → no mislabel')
})

test('P2b artifacts: source-label issues render their own medium-priority review section', () => {
  const g = [H,
    '- **周衡** ← 周恒 ｜ 据公开报道任 CFO ｜ 【访谈】',
    '- **林骁** ← 林晓 ｜ 同事',
  ].join('\n')
  const result = { glossaryLint: auditGlossary(g) }
  const items = glossarySourceItems(result)
  assert.ok(items.length >= 2, 'one line for the mislabel + one for the unlabeled row')
  assert.ok(items.some((x) => /周衡/.test(x)) && items.some((x) => /林骁/.test(x)))
  assert.ok(!items.some((x) => /["']/.test(x)), 'no ASCII quotes leak into the Chinese review lines')
  const sec = reviewSections(result, []).find((s) => s.title.includes('校对表来源标注'))
  assert.ok(sec && sec.priority === 'medium' && sec.items.length === items.length, 'a dedicated review section carries them')
})
