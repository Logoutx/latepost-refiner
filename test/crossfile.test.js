import assert from 'node:assert/strict'
import test from 'node:test'
import { checkCrossFileClaims, XFILE } from '../scripts/audit_refined.mjs'
import { buildReviewMarkdown, buildRunManifest, reviewSections, crossFileConflictItems, formatCrossFileConflict } from '../universal/artifacts.js'
import { computeCrossFileConflicts } from '../universal/jobs.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ============================================================================
// M8 — cross-file claim consistency (batch-level, deterministic, ZERO model calls).
// Fictional data ONLY (云洲仪器 / 沈其安 / 苍碧科技 / 占比 are 仓库既有虚构占位；GX-系列产品码同为虚构),
// per the repo red line: never a real interview subject, company, or brand in a committed fixture.
// The failure this closes: two files in one batch state the SAME fact with DIFFERENT numbers, and every
// per-file gate passes because each file is internally faithful to its own source.
// ============================================================================

const GLOSS = ['云洲仪器', '沈其安', '苍碧科技', '占比', '毛利率', '账期']

// A speaker-labelled line so xfileStripLabel blanks the label (a label name that is itself a glossary
// canonical must not self-associate). `名字：内容` with a 全角冒号, per RULES 1.
const F = (label, refinedText) => ({ label, refinedText })

// ---------- the core precision matrix (item 7) ----------

test('planted conflict: 云洲仪器 founded-year 2019 vs 2020 → one conflict carrying both lines + labels', () => {
  const a = F('甲', '## 公司\n\n沈其安：云洲仪器是 2019 年成立的。')
  const b = F('乙', '## 背景\n\n记者：云洲仪器 2020 年成立，对吧？')
  const { conflicts } = checkCrossFileClaims([a, b], GLOSS)
  assert.equal(conflicts.length, 1, 'exactly one entity+unit conflict')
  const c = conflicts[0]
  assert.equal(c.entity, '云洲仪器')
  assert.equal(c.unit, '年')
  const byLabel = Object.fromEntries(c.values.map((v) => [v.label, v]))
  assert.equal(byLabel['甲'].value, '2019')
  assert.equal(byLabel['乙'].value, '2020')
  assert.equal(byLabel['甲'].line, 3, 'the 甲 line number is carried (1-based)')
  assert.equal(byLabel['乙'].line, 3, 'the 乙 line number is carried')
  assert.ok(byLabel['甲'].snippet.includes('2019'), 'a human-readable snippet is attached')
})

test('same value across files → NO flag (30 vs 30 → both canonicalize equal, spans overlap)', () => {
  const a = F('甲', '沈其安：云洲仪器 2019 年成立。')
  const b = F('乙', '记者：云洲仪器是 2019 年的公司。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [])
})

test('30 vs 30.0 → NO flag (extractNumberAtoms canonicalizes both to "30")', () => {
  const a = F('甲', '沈其安：占比 30%。')
  const b = F('乙', '记者：占比 30.0%。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [])
})

test('range vs endpoint → NO flag (60-70 vs 65: 65 ∈ [60,70], spans overlap)', () => {
  const a = F('甲', '沈其安：毛利率大概 60-70%。')
  const b = F('乙', '记者：毛利率 65% 左右。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [])
})

test('range vs its own endpoint → NO flag (60-70 vs 60)', () => {
  const a = F('甲', '沈其安：毛利率 60-70%。')
  const b = F('乙', '记者：毛利率 60%。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [])
})

test('disjoint ranges DO flag (60-70% vs 80-90%: no overlap)', () => {
  const a = F('甲', '沈其安：毛利率 60-70%。')
  const b = F('乙', '记者：毛利率 80-90%。')
  const { conflicts } = checkCrossFileClaims([a, b], GLOSS)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].unit, '%')
})

test('ambiguous entity association → NO flag (two glossary entities within the atom window)', () => {
  const a = F('甲', '沈其安：云洲仪器和苍碧科技 2019 年一起成立。')
  const b = F('乙', '记者：云洲仪器和苍碧科技 2020 年成立。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [],
    'two candidate entities in the window make association ambiguous — the atom is dropped, not flagged')
})

test('unitless numbers are NOT cross-compared (人 is not a measured unit → skipped)', () => {
  // 团队 120 人 vs 130 人 — 人 is a soft classifier, not in ATOM_UNITS, so the atom is unitless → skipped.
  const a = F('甲', '沈其安：云洲仪器团队 120 人。')
  const b = F('乙', '记者：云洲仪器团队 130 人。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [])
})

test('a fact stated in only ONE file → NO flag (needs ≥2 files observing the same entity+unit)', () => {
  const a = F('甲', '沈其安：云洲仪器 2019 年成立。')
  const b = F('乙', '记者：今天聊聊别的话题，没有数字。')
  assert.deepEqual(checkCrossFileClaims([a, b], GLOSS).conflicts, [])
})

test('< 2 files → always empty (nothing to cross-check)', () => {
  assert.deepEqual(checkCrossFileClaims([F('甲', '云洲仪器 2019 年')], GLOSS).conflicts, [])
  assert.deepEqual(checkCrossFileClaims([], GLOSS).conflicts, [])
  assert.deepEqual(checkCrossFileClaims(null, GLOSS).conflicts, [])
})

test('the speaker label itself never self-associates (label name = a glossary canonical)', () => {
  // 沈其安 is the SPEAKER; the entity discussed is 云洲仪器. Without label-blanking, 沈其安 would sit in the
  // atom window and make association ambiguous — the conflict would be silently missed. It must still flag.
  const a = F('甲', '沈其安：云洲仪器 2019 年成立。')
  const b = F('乙', '沈其安：云洲仪器 2020 年成立。')
  const { conflicts } = checkCrossFileClaims([a, b], GLOSS)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].entity, '云洲仪器')
})

test('a multi-char CJK unit (个月) conflict flags, and only ONE entity near the atom stays unambiguous', () => {
  // Single glossary entity (账期) near the atom; the 沈其安 label is blanked, so association is unambiguous.
  const a = F('甲', '沈其安：账期一般压 3 个月。')
  const b = F('乙', '沈其安：账期一般压 6 个月。')
  const { conflicts } = checkCrossFileClaims([a, b], ['账期', '沈其安'])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].entity, '账期')
  assert.equal(conflicts[0].unit, '个月')
})

test('a prose head containing punctuation before a 全角冒号 is NOT blanked as a speaker label', () => {
  // xfileStripLabel blanks ONLY a short, punctuation-free head before the first 全角：(the RULES-1 label form).
  // A prose head carrying internal punctuation (，) is not a bare label, so its entity stays available.
  const a = F('甲', '关于云洲仪器，我认为：它 2019 年成立。')
  const b = F('乙', '关于云洲仪器，我认为：它 2020 年成立。')
  const { conflicts } = checkCrossFileClaims([a, b], ['云洲仪器'])
  assert.equal(conflicts.length, 1, 'the 云洲仪器 before the punctuated prose head is not blanked away')
  assert.equal(conflicts[0].entity, '云洲仪器')
})

test('capitalized/Latin token works as an entity when the glossary is thin', () => {
  // A fictional product code GX200; glossary empty. Latin runs ≥ MIN_LATIN_LEN act as entity signals.
  assert.ok(XFILE.MIN_LATIN_LEN >= 2)
  const a = F('甲', '产品 GX200 售价 50 万。')
  const b = F('乙', '产品 GX200 售价 80 万。')
  const { conflicts } = checkCrossFileClaims([a, b], [])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].entity, 'GX200')
  assert.equal(conflicts[0].unit, '万')
})

test('three files, one dissenter → still flags (any disjoint pair triggers)', () => {
  const a = F('甲', '沈其安：云洲仪器 2019 年成立。')
  const b = F('乙', '记者：云洲仪器 2019 年成立。')
  const c = F('丙', '同事：云洲仪器其实是 2021 年成立的。')
  const { conflicts } = checkCrossFileClaims([a, b, c], GLOSS)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].values.length, 3, 'all three observations are reported for the human to adjudicate')
})

// ---------- computeCrossFileConflicts (jobs.js glue: reads refined files off disk) ----------

test('computeCrossFileConflicts reads on-disk 成稿 and associates via parsed glossary canonicals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfile-'))
  const pa = path.join(dir, 'A.md'), pb = path.join(dir, 'B.md')
  fs.writeFileSync(pa, '沈其安：云洲仪器 2019 年成立。', 'utf8')
  fs.writeFileSync(pb, '记者：云洲仪器 2020 年成立。', 'utf8')
  const glossaryText = ['## 品牌 / 公司 / 产品（写法 → 统一）', '- **云洲仪器** ← 云州仪器 ｜ 核心产品线'].join('\n')
  const conflicts = computeCrossFileConflicts([{ outPath: pa }, { outPath: pb }], glossaryText)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].entity, '云洲仪器')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('computeCrossFileConflicts never throws: an unreadable file is skipped, <2 readable → empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfile-'))
  const pa = path.join(dir, 'A.md')
  fs.writeFileSync(pa, '沈其安：云洲仪器 2019 年成立。', 'utf8')
  // One real file + one missing path → only one readable → empty (no throw).
  assert.deepEqual(computeCrossFileConflicts([{ outPath: pa }, { outPath: path.join(dir, 'missing.md') }], ''), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- artifacts render (item 7: 跨文件互证 section in review.md; manifest carries it) ----------

const RESULT_WITH_CONFLICT = {
  outputDir: '/tmp/out',
  refined: [{ outPath: '/tmp/out/Transcripts/A.md' }, { outPath: '/tmp/out/Transcripts/B.md' }],
  crossFileConflicts: [
    { entity: '云洲仪器', unit: '年', values: [
      { label: '甲', value: '2019', line: 3 },
      { label: '乙', value: '2020', line: 3 },
    ] },
    { entity: '毛利率', unit: '%', values: [
      { label: '甲', value: '30', line: 8 },
      { label: '乙', value: '45', line: 5 },
    ] },
  ],
  openQuestions: [],
}

test('formatCrossFileConflict renders Chinese typesetting: 全角引号, Arabic numerals, 盘古 space, the ask', () => {
  const line = formatCrossFileConflict(RESULT_WITH_CONFLICT.crossFileConflicts[0])
  assert.ok(line.includes('实体“云洲仪器”'), 'entity in full-width curly quotes')
  assert.ok(line.includes('文件 甲 第 3 行作“2019 年”'), '盘古 space between the number and the CJK 年 unit')
  assert.ok(line.includes('文件 乙 第 3 行作“2020 年”'), 'the other file value + line')
  assert.ok(line.includes('请对照录音确认哪个是对的'), 'the fixed ask is present')
  // % unit hugs the number (no 盘古 space before a symbol unit).
  const pct = formatCrossFileConflict(RESULT_WITH_CONFLICT.crossFileConflicts[1])
  assert.ok(pct.includes('“30%”') && pct.includes('“45%”'), 'symbol unit hugs the number (30%, not 30 %)')
})

test('crossFileConflictItems yields one line per conflict', () => {
  assert.equal(crossFileConflictItems(RESULT_WITH_CONFLICT).length, 2)
  assert.deepEqual(crossFileConflictItems({}), [], 'no conflicts → empty')
})

test('review.md renders a 跨文件互证 section with one bullet per conflict', () => {
  const md = buildReviewMarkdown(RESULT_WITH_CONFLICT, { topic: 'T', finishedAt: '2026-07-07T00:00:00.000Z' })
  assert.ok(/##\s*跨文件互证/.test(md), 'the 跨文件互证 section header appears in review.md')
  assert.ok(md.includes('实体“云洲仪器”'), 'the entity conflict bullet is rendered')
  assert.ok(md.includes('实体“毛利率”'), 'the second conflict bullet is rendered')
})

test('review.md has NO 跨文件互证 section when there are no conflicts', () => {
  const md = buildReviewMarkdown({ ...RESULT_WITH_CONFLICT, crossFileConflicts: [] }, { topic: 'T' })
  assert.ok(!/跨文件互证/.test(md), 'the section is omitted entirely when clean')
})

test('reviewSections marks the 跨文件互证 section high priority', () => {
  const secs = reviewSections(RESULT_WITH_CONFLICT, [])
  const xf = secs.find((s) => /跨文件互证/.test(s.title))
  assert.ok(xf, 'the section is present')
  assert.equal(xf.priority, 'high', 'a cross-file numeric discrepancy is a high-priority factual issue')
  assert.equal(xf.items.length, 2)
})

test('run.json manifest carries the structured crossFileConflicts (entity/unit/values with file+line)', () => {
  const manifest = buildRunManifest(RESULT_WITH_CONFLICT, { outputDir: '/tmp/out', topic: 'T' })
  assert.ok(Array.isArray(manifest.result.crossFileConflicts), 'the manifest result block carries the array')
  assert.equal(manifest.result.crossFileConflicts.length, 2)
  const first = manifest.result.crossFileConflicts[0]
  assert.equal(first.entity, '云洲仪器')
  assert.equal(first.unit, '年')
  assert.deepEqual(first.values, [
    { label: '甲', value: '2019', line: 3 },
    { label: '乙', value: '2020', line: 3 },
  ], 'each value keeps its file label, value, and line number')
  // The issues count is auto-derived from the review section title.
  const issueKey = Object.keys(manifest.issues).find((k) => /跨文件互证/.test(k))
  assert.ok(issueKey && manifest.issues[issueKey] === 2, 'the issues map counts the 2 conflicts')
})

test('empty/absent crossFileConflicts → manifest array is [] (back-compat, no undefined)', () => {
  const manifest = buildRunManifest({ outputDir: '/tmp/out' }, { outputDir: '/tmp/out', topic: 'T' })
  assert.deepEqual(manifest.result.crossFileConflicts, [])
})
