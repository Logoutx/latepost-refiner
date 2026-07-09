import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseGlossary,
  renderGlossary,
  mergeIntoPrior,
  clusterEntities,
  mergeHints,
  HINT_TRUNC_MARK,
  HEADERLESS_MARK,
  MAX_HINT_NOTES,
} from '../core/spec.js'

// Regression suite for the cumulative / prior-glossary parse+merge path (校对表.md read back as a company's
// persistent proofing memory). Four diagnosed silent data-loss defects in core/spec.js are covered:
//   1. same-key merge dropped a fresh conflicting note (mergeEntityLists);
//   2. repeated `## 术语…` sections were parsed once (parseGlossary used sections.find);
//   3. entity rows with no / a mangled category header were ignored;
//   4. clusterEntities silently capped notes at the first 2 (.slice(0, 2)).
// All names are fictional placeholders (虚构… / 甲乙丙), consistent with the repo's no-real-subject rule.

const GA = { topic: '示例公司', date: '2026-01', background: '虚构离线测试背景。', doNotMerge: [] }
const row = (canon, variants = '—', hint = '') => `- **${canon}** ← ${variants}${hint ? ` ｜ ${hint}` : ''}`
const chunk = (rows, { title = '术语 / 专名（写法 → 统一）', withHeader = true } = {}) =>
  [withHeader ? `## ${title}` : '', ...rows].filter(Boolean).join('\n')
const termByName = (g, name) => g.terms.find((e) => e.canonical === name)
const mergedOf = (terms) => ({ people: [], brands: [], terms, speakersByFile: [], errors: [], notes: [] })
const roundTrip = (merged) => parseGlossary(renderGlossary(merged, { resolved: [], unresolved: [] }, { suspects: [] }, GA))

// ---------- mergeHints: the shared bound + marker policy ----------

test('mergeHints unions distinct notes, is idempotent, keeps ⚠ flags, and bounds growth with a marker', () => {
  assert.equal(mergeHints('甲说明', '乙说明'), '甲说明；乙说明', 'two distinct notes both survive')
  assert.equal(mergeHints('甲说明；乙说明', '甲说明；乙说明'), '甲说明；乙说明', 'mergeHints(x, x) === x (idempotent)')
  const capped = mergeHints('n1；n2；n3', 'n4')
  assert.ok(['n1', 'n2', 'n3'].every((n) => capped.includes(n)), 'first MAX_HINT_NOTES plain notes are kept')
  assert.ok(capped.includes(HINT_TRUNC_MARK), 'overflow (n4) is flagged with an explicit marker, not dropped silently')
  assert.equal(mergeHints(capped, 'n1；n2；n3'), capped, 'once truncated the marker stays put — stable across re-merge')
  assert.equal(mergeHints('note；⚠警告', ''), 'note；⚠警告', '⚠ warnings are always preserved')
})

// ---------- defect 1: conflicting notes on cumulative merge ----------

test('identical duplicate rows across chunks dedup to a single row (existing behavior preserved)', () => {
  const merged = mergeIntoPrior(
    parseGlossary(chunk([row('虚构同名术语', '虚构旧称', '相同说明')])),
    parseGlossary(chunk([row('虚构同名术语', '虚构旧称', '相同说明')])),
  )
  assert.equal(merged.terms.length, 1, 'shared strong key + identical note → one row')
  assert.equal(merged.terms[0].hint, '相同说明', 'the note is unchanged, not duplicated')
})

test('conflicting notes on the same term BOTH survive the cumulative merge (was silently dropped)', () => {
  const merged = mergeIntoPrior(
    parseGlossary(chunk([row('虚构冲突术语', '虚构旧称甲', '第 1 块说明')])),
    parseGlossary(chunk([row('虚构冲突术语', '虚构旧称乙', '第 2 块冲突说明')])),
  )
  assert.equal(merged.terms.length, 1, 'same strong key → one row')
  const h = merged.terms[0].hint
  assert.ok(h.includes('第 1 块说明'), 'prior note kept')
  assert.ok(h.includes('第 2 块冲突说明'), 'fresh conflicting note kept')
  assert.ok(!h.includes(HINT_TRUNC_MARK), 'two notes are within the cap — no truncation marker')
})

test('four notes accumulated across cumulative batches: first three kept + explicit marker (defect 1 bound)', () => {
  let g = parseGlossary(chunk([row('虚构累积术语', '—', '批次说明一')]))
  for (const n of ['批次说明二', '批次说明三', '批次说明四']) {
    g = mergeIntoPrior(g, parseGlossary(chunk([row('虚构累积术语', '—', n)])))
  }
  assert.equal(g.terms.length, 1, 'all folded into one row by shared strong key')
  const h = g.terms[0].hint
  assert.ok(['批次说明一', '批次说明二', '批次说明三'].every((n) => h.includes(n)), 'first three notes kept')
  assert.ok(h.includes(HINT_TRUNC_MARK), 'the fourth is flagged, never silently lost')
})

// ---------- defect 4: structured-path (clusterEntities) note cap ----------

test('four distinct notes on one clustered entity: bounded with a marker, nothing silently truncated (defect 4)', () => {
  const [c] = clusterEntities([
    { canonical: '虚构多说明术语', variants: [], hint: '说明一' },
    { canonical: '虚构多说明术语', variants: [], hint: '说明二' },
    { canonical: '虚构多说明术语', variants: [], hint: '说明三' },
    { canonical: '虚构多说明术语', variants: [], hint: '说明四' },
  ])
  assert.ok(['说明一', '说明二', '说明三'].every((n) => c.hint.includes(n)), 'first three distinct notes retained')
  assert.ok(c.hint.includes(HINT_TRUNC_MARK), 'overflow flagged explicitly (was a silent .slice(0, 2))')
  const plain = c.hint.split('；').filter((n) => n && n !== HINT_TRUNC_MARK)
  assert.equal(plain.length, MAX_HINT_NOTES, 'exactly MAX_HINT_NOTES plain notes retained')
})

// ---------- defect 2: repeated same-title sections ----------

test('repeated same-title `## 术语…` sections are ALL parsed, not just the first', () => {
  const md = [chunk([row('虚构前段术语', '—', '前段说明')]), chunk([row('虚构后段术语', '—', '后段说明')])].join('\n\n')
  const g = parseGlossary(md)
  assert.equal(g.terms.length, 2, 'both blocks parsed')
  assert.ok(termByName(g, '虚构前段术语'), 'first section survives')
  assert.ok(termByName(g, '虚构后段术语'), 'later duplicate-title section survives (was dropped by sections.find)')
})

// ---------- defect 3: headerless / mangled-header rows ----------

test('a headerless entity row (in the preamble) is rescued into 术语 with a marker, never dropped', () => {
  const md = [
    '# 示例公司 统一校对表（采访时间 2026-01）',
    '- **虚构无标题术语** ← 虚构旧写 ｜ 无标题说明', // stranded before any `##` header
    '',
    chunk([row('虚构有标题术语', '—', '有标题说明')]),
  ].join('\n')
  const g = parseGlossary(md)
  const rescued = termByName(g, '虚构无标题术语')
  assert.ok(rescued, 'the headerless row is preserved (not silently ignored)')
  assert.ok(rescued.hint.includes('无标题说明'), 'its original note survives verbatim')
  assert.ok(rescued.hint.includes(HEADERLESS_MARK), 'and it is flagged for human re-filing')
  assert.ok(termByName(g, '虚构有标题术语'), 'the normal headed row is unaffected')
})

test('entity rows under an unrecognized / mangled header are rescued too', () => {
  const md = ['## 术语专名', row('虚构错标题术语', '—', '错标题说明')].join('\n') // header missing 「（写法」 → unrecognized
  const g = parseGlossary(md)
  const e = termByName(g, '虚构错标题术语')
  assert.ok(e, 'a row under a header matching no known section is rescued into 术语')
  assert.ok(e.hint.includes('错标题说明') && e.hint.includes(HEADERLESS_MARK), 'original note kept + marker added')
})

test('the rescue is a no-op on well-formed renderGlossary output (no phantom rows, no stray marker)', () => {
  const g = roundTrip(mergedOf([{ canonical: '虚构常规术语', variants: ['虚构别名'], hint: '常规说明' }]))
  assert.equal(g.terms.length, 1, 'exactly the one real row, nothing invented')
  assert.ok(!g.terms.some((e) => (e.hint || '').includes(HEADERLESS_MARK)), 'a clean round-trip never adds the headerless marker')
})

// ---------- round-trip fidelity ----------

test('a 45-row glossary round-trips through render → parse with every row intact', () => {
  const terms = Array.from({ length: 45 }, (_, i) => ({
    canonical: `虚构批量术语${String(i + 1).padStart(2, '0')}`, variants: [], hint: `批量说明 ${i + 1}`,
  }))
  const g = roundTrip(mergedOf(terms))
  assert.equal(g.terms.length, 45, 'all 45 rows survive')
  assert.equal(g.terms[0].hint, '批量说明 1')
  assert.equal(g.terms[44].canonical, '虚构批量术语45')
})

test('terms with ASCII pipes, brackets, and quotes round-trip unchanged', () => {
  const terms = [
    { canonical: '虚构 A|B [beta] "quote"', variants: ['虚构 A|B [草稿] "q"'], hint: '含 ASCII 管道、方括号、直引号' },
    { canonical: '虚构竖线术语', variants: ['虚构|别名'], hint: '说明里有 ASCII | 字符' },
  ]
  const g = roundTrip(mergedOf(terms))
  const e = termByName(g, '虚构 A|B [beta] "quote"')
  assert.ok(e, 'a term with |, [], and ASCII quotes survives')
  assert.deepEqual(e.variants, ['虚构 A|B [草稿] "q"'], 'its variant survives too')
  assert.equal(e.hint, '含 ASCII 管道、方括号、直引号', 'note intact')
  assert.equal(termByName(g, '虚构竖线术语').hint, '说明里有 ASCII | 字符', 'ASCII pipe inside a note is not a field separator')
})

test('render → parse → render is idempotent on a table with joined notes, special chars, and 40+ rows', () => {
  const terms = [
    { canonical: '虚构冲突术语', variants: ['甲', '乙'], hint: '第一说明；第二说明' },
    { canonical: '虚构 A|B [beta] "quote"', variants: ['虚构 A|B [草稿]'], hint: '含特殊字符' },
    ...Array.from({ length: 42 }, (_, i) => ({ canonical: `虚构批量${String(i + 1).padStart(2, '0')}`, variants: [], hint: `说明 ${i + 1}` })),
  ]
  const merged = mergedOf(terms)
  const r1 = renderGlossary(merged, { resolved: [], unresolved: [] }, { suspects: [] }, GA)
  const p = parseGlossary(r1)
  const r2 = renderGlossary(
    { people: p.people, brands: p.brands, terms: p.terms, speakersByFile: p.speakersByFile, errors: p.errors, notes: p.notes },
    p.verified, { suspects: p.dedupSuspects }, GA,
  )
  assert.equal(r2, r1, 'a second render of the parsed table is byte-identical to the first')
})
