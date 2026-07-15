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
  mergeVerified,
  mergeDedup,
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

test('render → parse → render is idempotent (joined notes, special chars, 40+ rows) AND a 待复核 marker survives N cycles', () => {
  const terms = [
    { canonical: '虚构冲突术语', variants: ['甲', '乙'], hint: '第一说明；第二说明' },
    { canonical: '虚构 A|B [beta] "quote"', variants: ['虚构 A|B [草稿]'], hint: '含特殊字符' },
    // Finding 4: a 待复核 (recheck) flag must survive render→parse→render, not silently vanish when there is no
    // fresh verification hit — otherwise the next batch stops force-re-verifying the entry.
    { canonical: '虚构复核术语', variants: ['虚构旧写'], hint: '需人工确认', confidence: 'recheck' },
    ...Array.from({ length: 42 }, (_, i) => ({ canonical: `虚构批量${String(i + 1).padStart(2, '0')}`, variants: [], hint: `说明 ${i + 1}` })),
  ]
  const render = (m, v, d) => renderGlossary(m, v, d, GA)
  let prev = render(mergedOf(terms), { resolved: [], unresolved: [] }, { suspects: [] })
  assert.match(prev, /虚构复核术语.*〔待复核〕/, 'the recheck marker is emitted on the first render')
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const p = parseGlossary(prev)
    const e = p.terms.find((t) => t.canonical === '虚构复核术语')
    assert.ok(e && e.confidence === 'recheck', `cycle ${cycle}: the marker parses back to confidence 'recheck'`)
    const next = render(
      { people: p.people, brands: p.brands, terms: p.terms, speakersByFile: p.speakersByFile, errors: p.errors, notes: p.notes },
      p.verified, { suspects: p.dedupSuspects },
    )
    assert.equal(next, prev, `cycle ${cycle}: re-render is byte-identical to the previous render`)
    assert.match(next, /〔待复核〕/, `cycle ${cycle}: the 待复核 marker survives the round-trip`)
    prev = next
  }
})

// ---------- P2c follow-up: NON-ENTITY sections must round-trip without loss ----------
// Live evidence (2026-07-15, CC edition with priorGlossaryText): the merged glossary silently dropped the prior
// file's entire 写法统一 section (blockquote + every row) and one normal brand row. Two mechanisms, both covered
// here with fictional fixtures:
//   a. non-entity sections were parsed with `get()` (first matching block only) and any line failing its
//      section grammar was discarded — a row without the exact `（why）` tail lost the WHOLE section on re-render;
//   b. an entity row with minor formatting variance (e.g. no spaces around ←) failed parseEntityLine and fell
//      into g.extra, which nothing ever rendered — the row vanished from the persistent glossary.
// Contract under test: parse → mergeIntoPrior(with fresh findings) → render loses ZERO prior bullets; anything
// unrecognized is preserved verbatim (append-new, never drop-old) and is STABLE across repeated round-trips.

// A full prior 校对表 exercising every special section plus 40 entity rows. Each bullet carries a distinctive
// fictional key string we assert survives the round-trip.
function fullPriorFixture() {
  const keys = []
  const bullet = (line, key) => { keys.push(key); return line }
  const people = Array.from({ length: 12 }, (_, i) => bullet(row(`虚构人${String(i + 1).padStart(2, '0')}`, `旧写人${i + 1}`, `身份说明 ${i + 1}`), `虚构人${String(i + 1).padStart(2, '0')}`))
  const brands = Array.from({ length: 14 }, (_, i) => bullet(row(`虚构坊${String(i + 1).padStart(2, '0')}`, '—', `品牌说明 ${i + 1}`), `虚构坊${String(i + 1).padStart(2, '0')}`))
  // The 季风书院-class repro: a normal-LOOKING brand row whose ← has no surrounding spaces (formatting variance).
  brands.push(bullet('- **虚构书局**←听写误记 ｜ 出版机构（虚构）', '虚构书局'))
  const terms = Array.from({ length: 13 }, (_, i) => bullet(row(`虚构术${String(i + 1).padStart(2, '0')}`, `别写术${i + 1}`, `术语说明 ${i + 1}`), `虚构术${String(i + 1).padStart(2, '0')}`))
  const md = [
    '# 示例公司 统一校对表（采访时间 2026-01）', '',
    '## 采访背景', '虚构离线测试背景。', '',
    '## 发言人统一标注',
    '**虚构访谈甲**',
    bullet('- 说话人1 → 记者（虚构记者甲）', '虚构记者甲'),
    '',
    '## 人名（写法 → 统一）', ...people, '',
    '## 品牌 / 公司 / 产品（写法 → 统一）', ...brands, '',
    '## 术语 / 专名（写法 → 统一）', ...terms, '',
    '## 需特别处理的转写错误',
    bullet('- [虚构访谈甲] 同音误写：虚构错例一；虚构错例二', '虚构错例一'),
    '',
    '## 各份特别提醒',
    bullet('- 虚构提醒：第 3 段有大段静音', '第 3 段有大段静音'),
    '',
    '## 联网核实结论（已采纳的已应用到上表正文；标 ⚠ 的与正文强名冲突、未采纳，待人工确认）',
    bullet('- 旧写人1 → **虚构人01**（虚构身份） ｜ 依据：example.com/虚构来源', 'example.com/虚构来源'),
    bullet('- 虚构存疑名：未能核实，保留（音） ｜ 虚构备注', '虚构存疑名'),
    '',
    '## 写法统一（精校请初次落笔即套用，勿事后逐字回改）',
    '> dedup 已判定为同一术语/品牌的不同写法，下列以右侧为准——精校时直接写对，不要先写错再回头改。',
    bullet('- 91型车 → 统一写 **九号样车**（同一虚构车型的口语与正式写法）', '九号样车'),
    // A row that used to kill itself (and, being the sole survivor filter, could empty the section):
    // no （why） tail — the old regex required it.
    bullet('- 甲写法 → 统一写 **乙正写**', '乙正写'),
    '',
    '## 疑似同指（待人工确认，未自动合并）',
    '> 写法不同但疑似指同一对象——脚本不会自动并（尤其人名），请人工/精校据原文定夺；不是同指就忽略。',
    bullet('- 虚构人甲 ／ 虚构人乙（person）：同音且同一场合出现', '虚构人甲 ／ 虚构人乙'),
    '',
    '## 确认不同指（勿合并）',
    '> 人工确认：以下各组写法相近但确为不同对象，dedup 勿再标记为疑似同指。',
    bullet('- 虚构丙 ／ 虚构丁', '虚构丙 ／ 虚构丁'),
    '',
    '## 编辑手记（自定义段落）',
    bullet('- 这一段是人工添加的自由笔记，任何语法都不认识它', '人工添加的自由笔记'),
  ].join('\n')
  return { md, keys }
}

// Mimic the pipeline's plumbing (core/pipeline.js §P1): mergeIntoPrior for the body, mergeVerified /
// mergeDedup for the carried conclusions, prior.doNotMerge onto the render args.
function pipelineRoundTrip(priorMd, fresh) {
  const prior = parseGlossary(priorMd)
  const merged = mergeIntoPrior(prior, fresh)
  const verified = mergeVerified(prior.verified, { resolved: [], unresolved: [] })
  const dedup = { suspects: mergeDedup(prior.dedupSuspects, []) }
  return renderGlossary(merged, verified, dedup, { ...GA, doNotMerge: prior.doNotMerge })
}

test('P2c follow-up: a prior glossary with ALL special sections + 40 entity rows loses zero bullets through parse→merge→render', () => {
  const { md, keys } = fullPriorFixture()
  assert.ok(keys.length >= 45, `fixture sanity: ${keys.length} keyed bullets (40+ entity rows + one per special section)`)
  const fresh = parseGlossary(chunk([row('本批新术语', '新旧写', '本批新增')]))
  const out = pipelineRoundTrip(md, fresh)
  const lost = keys.filter((k) => !out.includes(k))
  assert.deepEqual(lost, [], `every prior bullet's key string survives the round-trip; lost: ${lost.join('、')}`)
  assert.ok(out.includes('本批新术语'), 'fresh findings are appended (append-new)')
})

test('P2c follow-up: repeated 写法统一 / 各份特别提醒 blocks are ALL parsed, not just the first', () => {
  const md = [
    '## 写法统一（精校请初次落笔即套用，勿事后逐字回改）',
    '- 头块左写 → 统一写 **头块正写**（第一块）',
    '## 各份特别提醒',
    '- 第一块提醒',
    '## 写法统一（精校请初次落笔即套用，勿事后逐字回改）',
    '- 尾块左写 → 统一写 **尾块正写**（第二块）',
    '## 各份特别提醒',
    '- 第二块提醒',
  ].join('\n')
  const g = parseGlossary(md)
  const preferred = g.dedupSuspects.map((s) => s.preferred)
  assert.ok(preferred.includes('头块正写') && preferred.includes('尾块正写'), 'both 写法统一 blocks parsed')
  assert.ok(g.notes.includes('第一块提醒') && g.notes.includes('第二块提醒'), 'both 提醒 blocks parsed')
})

test('P2c follow-up: an entity row with unspaced ← is still adopted as a real row (季风书院-class variance)', () => {
  const g = parseGlossary(chunk(['- **虚构无空格坊**←误写形 ｜ 说明'], { title: '品牌 / 公司 / 产品（写法 → 统一）' }))
  const e = g.brands.find((x) => x.canonical === '虚构无空格坊')
  assert.ok(e, 'row parses as a brand entity, not dropped')
  assert.deepEqual(e.variants, ['误写形'], 'variants survive')
})

test('P2c follow-up: a bullet no grammar recognizes is preserved verbatim in the render, under its section title', () => {
  const md = [
    '## 品牌 / 公司 / 产品（写法 → 统一）',
    '- **虚构正常坊** ← — ｜ 正常行',
    '- 虚构畸形行，没有粗体没有箭头，但绝不能丢',
    '## 编辑手记（自定义段落）',
    '自由文本行也要活下来。',
  ].join('\n')
  const out = pipelineRoundTrip(md, parseGlossary(''))
  assert.ok(out.includes('虚构正常坊'), 'the well-formed row renders normally')
  assert.ok(out.includes('- 虚构畸形行，没有粗体没有箭头，但绝不能丢'), 'the malformed bullet is preserved verbatim')
  assert.ok(out.includes('## 编辑手记（自定义段落）') && out.includes('自由文本行也要活下来。'), 'unknown sections survive with their title')
})

test('P2c follow-up: preserved lines are STABLE across repeated round-trips (no loss, no duplication growth)', () => {
  const { md, keys } = fullPriorFixture()
  let cur = pipelineRoundTrip(md, parseGlossary(''))
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const next = pipelineRoundTrip(cur, parseGlossary(''))
    for (const k of keys) {
      const count = (s) => s.split(k).length - 1
      assert.ok(count(next) >= 1, `cycle ${cycle}: key ${k} survives`)
      assert.equal(count(next), count(cur), `cycle ${cycle}: key ${k} does not multiply`)
    }
    cur = next
  }
})
