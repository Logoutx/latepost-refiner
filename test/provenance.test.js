import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isConcreteSource,
  confidenceMark,
  renderGlossary,
  parseGlossary,
  excludeVerified,
  clusterEntities,
} from '../core/spec.js'

// M3 provenance guard: a verify resolution may only earn the PERMANENT-TRUST 〔核实〕 marker when its `source`
// names concrete evidence. Otherwise it renders 〔待复核〕 instead — still applied to the entry body this run
// (applyVerifiedEntry is untouched), but re-verifiable next batch (excludeVerified force-rechecks 'recheck').
// All fixtures are fictional: 云洲仪器/沈其安/示例公司 是仓库既有虚构占位；本文件新增的 example.com 等域名同样虚构，
// 不对应任何真实受访者或公司。

const GA = { topic: '示例公司', date: '2025-07', background: '虚构采访背景。', doNotMerge: [] }
function findEntry(g, canonical) {
  return [...g.people, ...g.brands, ...g.terms].find((e) => e.canonical === canonical)
}

// ---------- isConcreteSource ----------

test('isConcreteSource: every blocklist term fails, as a full string and embedded as a substring', () => {
  const blocked = ['网络搜索', '联网搜索', '公开资料', '公开信息', '常识', '据记忆', '模型知识', '未提供', '无来源', '搜索结果', 'web search', 'common knowledge']
  for (const term of blocked) {
    assert.equal(isConcreteSource(term), false, `bare "${term}" must fail`)
    assert.equal(isConcreteSource(`经${term}确认`), false, `"${term}" embedded as a substring must fail`)
  }
})

test('isConcreteSource: bare hedges from the verify prompt\'s own vocabulary fail', () => {
  assert.equal(isConcreteSource('搜索确认'), false, 'the search ACTION alone, no citation of what was found')
  assert.equal(isConcreteSource('公开资料显示'), false, 'vague wave at "public info" names nothing specific')
})

test('isConcreteSource: a URL or bare domain passes regardless of scheme/www', () => {
  assert.equal(isConcreteSource('https://example.com/about'), true, 'full URL with scheme')
  assert.equal(isConcreteSource('www.example.org 公司简介页'), true, 'www. prefix')
  assert.equal(isConcreteSource('example.com 官网团队页'), true, 'bare domain, no scheme/www — task-spec example')
  assert.equal(isConcreteSource('据 example.cn 2025-03 报道'), true, '.cn domain embedded in a sentence')
})

test('isConcreteSource: a specific publication/page/document string passes via the length heuristic', () => {
  assert.equal(isConcreteSource('公司官网 about 页'), true, 'task-spec example: names a specific page')
  assert.equal(isConcreteSource('36kr.com 2025-03 报道'), true, 'task-spec example: domain + dated report')
  assert.equal(isConcreteSource('据《云洲晚报》2025 年 3 月报道'), true, 'names a specific (fictional) publication + date')
  assert.equal(isConcreteSource('公司年报 2024 第 12 页'), true, 'names a specific document + page')
})

test('isConcreteSource: empty, whitespace-only, undefined, null, and non-string all fail', () => {
  assert.equal(isConcreteSource(''), false)
  assert.equal(isConcreteSource('   '), false)
  assert.equal(isConcreteSource(undefined), false)
  assert.equal(isConcreteSource(null), false)
  assert.equal(isConcreteSource(42), false, 'non-string input fails closed rather than throwing')
})

test('isConcreteSource: full-width ASCII variants of blocklist terms and URLs are normalised before matching', () => {
  // Full-width Ｗ/Ｅ/Ｂ (U+FF37/FF25/FF22) — a CJK input method can easily produce these instead of ASCII.
  assert.equal(isConcreteSource('Ｗｅｂ ｓｅａｒｃｈ'), false, 'full-width "web search" still hits the blocklist')
  assert.equal(isConcreteSource('ｅｘａｍｐｌｅ．ｃｏｍ 团队页'), true, 'full-width domain still matches the URL fragment')
})

test('isConcreteSource: a short generic phrase that dodges the blocklist by wording still fails the length floor', () => {
  assert.equal(isConcreteSource('查到了'), false, '3 chars, no URL, no blocklist hit, but too short to be a real citation')
  assert.equal(isConcreteSource('确认过'), false)
})

// ---------- confidenceMark: gated by isConcreteSource ----------

test('confidenceMark: a resolution with a concrete source earns 〔核实〕 as before', () => {
  const resolved = new Map([['臻选', { query: '臻选', canonical: '真选', source: 'example.com 官网团队页' }]])
  assert.equal(confidenceMark({ canonical: '真选', variants: ['臻选'] }, resolved, '2025-07'), ' 〔核实·2025-07〕')
})

test('confidenceMark: a resolution with NO concrete source falls back to 〔待复核〕, not 〔核实〕', () => {
  const resolved = new Map([['臻选', { query: '臻选', canonical: '真选', source: '网络搜索' }]])
  assert.equal(confidenceMark({ canonical: '真选', variants: ['臻选'] }, resolved, '2025-07'), ' 〔待复核〕')
})

test('confidenceMark: a resolution with an empty/missing source also falls back to 〔待复核〕', () => {
  const resolved = new Map([['臻选', { query: '臻选', canonical: '真选' }]])   // no `source` field at all
  assert.equal(confidenceMark({ canonical: '真选', variants: ['臻选'] }, resolved, '2025-07'), ' 〔待复核〕')
})

test('confidenceMark: 用户钦定 still short-circuits before the provenance guard even runs', () => {
  const resolved = new Map([['甄选', { query: '甄选', canonical: '别的名字', source: '网络搜索' }]])
  assert.equal(confidenceMark({ canonical: '甄选', locked: true }, resolved, '2025-07'), ' 〔用户钦定〕',
    'a locked cluster is settled regardless of any colliding verify hit\'s source quality')
})

test('confidenceMark: a prior-round verified marker with no fresh hit this round is unaffected by the guard', () => {
  // Old behaviour path (priority tier 3) — nothing to gate, since there is no THIS-ROUND source to judge.
  const resolved = new Map()
  assert.equal(confidenceMark({ canonical: '真选', confidence: 'verified', confidenceDate: '2025-06' }, resolved, '2025-07'),
    ' 〔核实·2025-06〕', 'a previously-earned 核实 is preserved verbatim, unaffected by this round\'s guard')
})

// ---------- end-to-end: render → parse → exclude ----------

test('a verify resolution with source "网络搜索" renders 待复核, still applies the canonical, and stays re-verifiable', () => {
  const merged = {
    speakersByFile: [],
    people: [], brands: [],
    terms: [{ canonical: '云洲仪表', variants: ['云洲仪器'], hint: '核心产品线', files: ['A'], crossFile: false }],
    errors: [], notes: [],
  }
  // The verify agent hallucinated a canonical spelling backed only by a vague search-action hedge.
  const verified = { resolved: [{ query: '云洲仪器', canonical: '云洲仪表机', identity: '', source: '网络搜索' }], unresolved: [] }
  const md = renderGlossary(merged, verified, null, GA)
  assert.ok(md.includes('云洲仪表机'), 'the resolution IS applied: canonical rewritten to the verify result')
  assert.ok(md.includes('〔待复核〕'), 'the entry carries 待复核, not 核实 — no concrete source, no permanent trust')
  assert.ok(!/云洲仪表机.*〔核实/.test(md), '核实 marker must NOT appear on this line')

  const g = parseGlossary(md)
  const e = findEntry(g, '云洲仪表机')
  assert.ok(e, 'the applied canonical parses back')
  assert.equal(e.confidence, 'recheck', 'parsed confidence is recheck, matching a hand-written 待复核')

  // Simulate the NEXT batch: excludeVerified must NOT skip this entry — it must be re-verified.
  const priorWithStaleVerifyRow = Object.assign({}, g, {
    verified: { resolved: [{ query: '云洲仪表机', canonical: '云洲仪表机' }], unresolved: [] },
  })
  const nextBatchMerged = { people: [], brands: [], terms: clusterEntities([{ canonical: '云洲仪表机', variants: ['云洲仪器'] }, { canonical: '新术语', variants: [] }]) }
  const stillToVerify = excludeVerified(nextBatchMerged, priorWithStaleVerifyRow)
  const names = stillToVerify.terms.map((t) => t.canonical)
  assert.ok(names.includes('云洲仪表机'), 'BLOCKER: a 待复核 entry is NOT excluded — it is sent back to verify next batch')
  assert.ok(names.includes('新术语'), 'a brand-new entry is unaffected, still included')
})

test('a resolution with source "example.com 官网团队页" renders 〔核实〕, exactly as before the guard', () => {
  const merged = {
    speakersByFile: [],
    people: [{ canonical: '沈其安', variants: ['沈其岸'], hint: '受访者', files: ['A'], crossFile: false }],
    brands: [], terms: [],
    errors: [], notes: [],
  }
  const verified = { resolved: [{ query: '沈其岸', canonical: '沈其安', identity: '创始人', source: 'example.com 官网团队页' }], unresolved: [] }
  const md = renderGlossary(merged, verified, null, GA)
  assert.ok(/沈其安.*〔核实·2025-07〕/.test(md), 'a concrete source still earns the permanent 核实 marker')

  const g = parseGlossary(md)
  const e = findEntry(g, '沈其安')
  assert.equal(e.confidence, 'verified', 'parses back as verified (settled)')

  // Confirm this ONE stays excluded (settled) in the next batch — contrast with the 待复核 case above.
  const priorWithVerifyRow = Object.assign({}, g, { verified: { resolved: [{ query: '沈其安', canonical: '沈其安' }], unresolved: [] } })
  const nextBatchMerged = { people: clusterEntities([{ canonical: '沈其安', variants: [] }]), brands: [], terms: [] }
  const stillToVerify = excludeVerified(nextBatchMerged, priorWithVerifyRow)
  assert.ok(!stillToVerify.people.some((p) => p.canonical === '沈其安'), 'a genuinely verified entry stays excluded (permanent trust earned)')
})
