import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditPair, checkEntityMergeReview, parseGlossaryLite } from '../scripts/audit_refined.mjs'

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')

// Wholesale-substitution tripwire (entity_merge_review / unificationList). All names below are fictional
// (per repo rule): 林川/林传 is a made-up homophone-ish pair, "K Frame"/"K-Frame" a made-up spoken/product
// term, 云桥引擎/云桥科技 an unrelated fictional product name.

test('entity_merge_review: a variant globally replaced into a canonical that ALREADY existed independently in the source fires Tier 2 with correct counts', () => {
  const glossaryText = [
    '## 人名（写法 → 统一）',
    '- **林川** ← 林传 ｜ 示例项目组长',
  ].join('\n')
  const sourceText = [
    '发言人1 00:01',
    '林传今天来介绍情况，林传说得很清楚。',
    '发言人2 00:02',
    '林传补充了一句，林传的意思很明确。',
    '发言人1 00:03',
    '林川也在场，林川点头表示同意，林川补充了几句。',
  ].join('\n')
  // simulate the pipeline's unify-writing mechanism: every 林传 rewritten to 林川
  const refinedText = sourceText.replace(/林传/g, '林川')

  const glossary = parseGlossaryLite(glossaryText)
  const { unificationList, findings } = checkEntityMergeReview(sourceText, refinedText, glossary)

  assert.deepEqual(unificationList, [
    { from: '林传', to: '林川', sourceFrom: 4, sourceTo: 3, refinedFrom: 0, refinedTo: 7 },
  ], 'Tier 1 list carries the exact plain-substring counts')

  assert.equal(findings.name, 'entity_merge_review')
  assert.equal(findings.severity, 'soft')
  assert.equal(findings.count, 1, 'Tier 2 fires because 林川 already stood on its own in the source (3 >= 2)')
  assert.equal(findings.samples.length, 1)
  const text = findings.samples[0].text
  assert.ok(text.includes('林传→林川'), 'sample names the from/to pair')
  assert.ok(text.includes('×4'), 'replacement estimate = sourceFrom(4) - refinedFrom(0)')
  assert.ok(text.includes('本就独立出现 3 次'), 'sample states the pre-existing independent count of the canonical')

  // wired into auditPair: findings array carries it, soft, so it never fails the pair.
  const r = auditPair({ sourceText, refinedText, mode: 'refine', glossaryText })
  const fromPair = r.findings.find((f) => f.name === 'entity_merge_review')
  assert.equal(fromPair.count, 1)
  assert.equal(fromPair.severity, 'soft')
  assert.deepEqual(r.unificationList, unificationList)
})

test('entity_merge_review: pure spelling/spacing normalization ("K-Frame" → "K Frame") never flags, not even in the Tier 1 list', () => {
  const glossaryText = [
    '## 品牌 / 公司 / 产品（写法 → 统一）',
    '- **K Frame** ← K-Frame ｜ 示例硬件产品名',
  ].join('\n')
  const sourceText = [
    '发言人1 00:01',
    'K-Frame K-Frame K-Frame 这几次测试都用了 K-Frame 这套设备。',
  ].join('\n')
  const refinedText = sourceText.replace(/K-Frame/g, 'K Frame')

  const glossary = parseGlossaryLite(glossaryText)
  const { unificationList, findings } = checkEntityMergeReview(sourceText, refinedText, glossary)

  assert.deepEqual(unificationList, [], 'normalize("K-Frame") === normalize("K Frame") → mapping is skipped entirely')
  assert.equal(findings.count, 0)
  assert.deepEqual(findings.samples, [])
})

test('entity_merge_review: variant globally replaced but canonical absent from source → Tier 1 list only, no soft finding', () => {
  const glossaryText = [
    '## 品牌 / 公司 / 产品（写法 → 统一）',
    '- **云桥引擎** ← 云桥科技 ｜ 示例产品线',
  ].join('\n')
  const sourceText = [
    '发言人1 00:01',
    '云桥科技这个项目组，云桥科技当时投入很大，云桥科技后来才改名。',
  ].join('\n')
  const refinedText = sourceText.replace(/云桥科技/g, '云桥引擎')

  const glossary = parseGlossaryLite(glossaryText)
  const { unificationList, findings } = checkEntityMergeReview(sourceText, refinedText, glossary)

  assert.equal(unificationList.length, 1, 'still globally replaced → Tier 1 lists it')
  assert.deepEqual(unificationList[0], { from: '云桥科技', to: '云桥引擎', sourceFrom: 3, sourceTo: 0, refinedFrom: 0, refinedTo: 3 })
  assert.equal(findings.count, 0, 'canonical never existed independently in source (0 < 2) → no Tier 2 finding')
  assert.deepEqual(findings.samples, [])
})

test('entity_merge_review: omitting --glossary leaves auditPair output unchanged (no new counts, no crash)', () => {
  const sourceText = fixture('source-excerpt.md')
  const refinedText = fixture('clean.md')

  const bare = auditPair({ sourceText, refinedText, mode: 'refine' })
  const withNullGlossary = auditPair({ sourceText, refinedText, mode: 'refine', glossaryText: null })
  const withEmptyGlossary = auditPair({ sourceText, refinedText, mode: 'refine', glossaryText: '' })

  assert.deepEqual(bare.unificationList, [], 'no glossary → empty Tier 1 list')
  const finding = bare.findings.find((f) => f.name === 'entity_merge_review')
  assert.ok(finding, 'entity_merge_review is present (dormant), matching the ghost_name/missing_yin convention')
  assert.equal(finding.count, 0)
  assert.deepEqual(finding.samples, [])

  // omitting the field entirely, passing null, and passing '' are all equivalent — the new param is a
  // pure no-op when there is nothing to parse, and does not perturb any pre-existing field.
  assert.equal(JSON.stringify(bare), JSON.stringify(withNullGlossary), 'omitted vs null glossaryText: byte-identical output')
  assert.equal(JSON.stringify(bare), JSON.stringify(withEmptyGlossary), 'omitted vs empty-string glossaryText: byte-identical output')

  // and the known-good baseline this fixture pair already establishes elsewhere in audit.test.js is untouched
  assert.equal(bare.status, 'ok')
  assert.equal(bare.failed.length, 0)
})
