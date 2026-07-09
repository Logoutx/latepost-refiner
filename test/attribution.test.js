import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditText, auditPair, checkAttribution, checkQuoteFabrication, checkEntitySubstitution,
  parseGlossaryLite, detectHeadingRegex, buildSections, anchorTurns, ATTR,
} from '../scripts/audit_refined.mjs'

// ============================================================================
// M6 attribution + M7 quote/entity guards + two micro-fixes. Fictional entities
// ONLY (云洲仪器 / 磐石科技 / 沈其安 / 周砚 placeholders), per the repo red line:
// never a real interview subject, company, or brand in a committed fixture.
// ============================================================================

// ---- fictional interview builder ------------------------------------------------------------------
// 12 substantive, distinctive Q&A pairs. 沈其安 (发言人1, interviewer) asks; 周砚 (发言人2, guest) answers. Each
// answer is long + lexically distinctive so it anchors with contiguous shingles → the majority map can be learned
// (needs ≥ ATTR.MIN_MAP_SAMPLE anchored turns per speaker). Distinct topics prevent cross-turn shingle collisions.
const QA = [
  ['上个季度我们聊到云洲仪器在东南亚市场的布局，这个季度有什么新的进展可以分享一下吗？',
   '东南亚这块我觉得进展比预期要快，我们在越南胡志明市新签了三家分销商，光是传感器标定这个业务线的订单额就翻了一倍多。'],
  ['你提到传感器标定，能不能具体讲讲这块业务的技术壁垒到底在哪里？',
   '传感器标定的核心难点在于温漂补偿的算法，我们花了整整两年时间去打磨这套补偿模型，把零点漂移压到了行业平均水平的三分之一以下。'],
  ['那在人才招募方面，云洲仪器这个季度有没有引进一些关键的技术骨干？',
   '人才这块我们运气不错，从磐石科技挖来了一位做嵌入式固件的资深工程师，他带过一整个惯性导航的团队，落地能力非常强。'],
  ['听说你们在跟高校合作做产学研，这个合作的模式是怎么设计的？',
   '产学研我们跟南方一所理工院校共建了一个联合实验室，学校出理论和论文，我们出工程化和真实场景的数据，双方一起推进标定算法的迭代。'],
  ['从财务角度看，这个季度云洲仪器的毛利率相比去年同期是上升还是下降了？',
   '毛利率其实是有所改善的，因为规模效应上来了，采购成本被摊薄，加上高端型号的占比提高，整体毛利率比去年同期上升了差不多六个百分点。'],
  ['你怎么看待现在国内做工业传感器的这些厂商之间的竞争格局？',
   '竞争格局我觉得还是比较分散的，头部几家各有各的护城河，有的强在渠道，有的强在算法，短期内很难看到一家独大的那种局面出现。'],
  ['云洲仪器接下来在海外扩张上，最大的挑战你觉得会是什么？',
   '海外扩张最大的挑战其实是本地化的售后和认证，每个国家的合规要求都不一样，我们需要在当地建立一支能快速响应的工程师队伍来支撑。'],
  ['如果让你给正在创业做硬件的年轻团队一个建议，你会说什么？',
   '我会建议他们一定要先把一个细分场景做深做透，不要一上来就想着做平台化，硬件的坑非常多，先在一个窄的赛道里跑通商业闭环最重要。'],
  ['最近资本市场对硬科技的关注度在回升，你们有没有新的融资计划？',
   '融资这块我们保持开放的态度，但不着急，账上的现金还比较充裕，我们更希望等到下一代产品验证之后，在一个更好的时点去启动新一轮的融资。'],
  ['云洲仪器有没有考虑过把标定算法单独拆出来做成一个对外的服务？',
   '这个我们内部讨论过，把标定能力做成云端的一个接口对外开放确实有想象空间，但短期内我们还是想先把自己的硬件产品打磨到极致再说。'],
  ['你个人平时是怎么保持对前沿技术的敏感度的？',
   '我保持敏感度的方式主要是多去一线跟客户聊，客户的真实痛点往往比任何行业报告都更能告诉你技术的下一步应该往哪个方向去演进。'],
  ['最后一个问题，你希望三年之后的云洲仪器变成一家什么样的公司？',
   '三年之后我希望云洲仪器能成为工业感知领域一个绕不开的名字，不追求规模上的庞大，但一定要在精度和可靠性上做到让客户完全放心。'],
]
// Build source (发言人 N 时间戳 label lines) and a FAITHFUL refined (名字：内容, unified labels, sub-headings).
function buildSource() {
  const lines = []
  QA.forEach(([q, a], i) => {
    const mm = String(i * 5).padStart(2, '0')
    lines.push(`发言人1   00:${mm}`, q, '', `发言人2   00:${String(i * 5 + 2).padStart(2, '0')}`, a, '')
  })
  return lines.join('\n')
}
function buildRefined({ swapTurnIndex = -1, swapTo = null } = {}) {
  // sub-heading every 4 pairs so anchoring + sections have structure
  const out = ['# 云洲仪器专访', '', '*采访者：沈其安｜受访者：周砚*', '']
  QA.forEach(([q, a], i) => {
    if (i % 4 === 0) out.push(`## 第 ${i / 4 + 1} 部分`, '')
    out.push(`沈其安：${q}`, '')
    // the guest turn — optionally MISATTRIBUTED to the interviewer's label (a planted swap)
    const label = (i === swapTurnIndex) ? (swapTo || '沈其安') : '周砚'
    out.push(`${label}：${a}`, '')
  })
  return out.join('\n')
}

// ---------- M6: majority map ----------

test('M6 majority map: learns 发言人1→沈其安 and 发言人2→周砚 from high-confidence anchors', () => {
  const r = checkAttribution(buildSource(), buildRefined())
  assert.equal(r.assessed, true)
  assert.equal(r.mappedSpeakers, 2, 'both speakers cleared the sample + majority bar')
  assert.equal(r.map['发言人1'], '沈其安')
  assert.equal(r.map['发言人2'], '周砚')
  assert.ok(r.speakers['发言人2'].sampled >= ATTR.MIN_MAP_SAMPLE, 'guest sampled ≥ MIN_MAP_SAMPLE turns')
  assert.ok(r.speakers['发言人2'].frac >= ATTR.MAJORITY_MIN, 'guest majority ≥ MAJORITY_MIN')
})

test('M6 legit label unification does NOT flag: every 发言人2 turn faithfully under 周砚 → 0 mismatches', () => {
  const r = checkAttribution(buildSource(), buildRefined())
  assert.equal(r.mismatches, 0, 'a clean, consistently-labeled refine raises no attribution flag')
})

test('M6 swapped attribution IS flagged: one guest answer placed under the interviewer label', () => {
  // move the 5th guest answer (index 4, a long distinctive turn) under 沈其安
  const refined = buildRefined({ swapTurnIndex: 4, swapTo: '沈其安' })
  const r = checkAttribution(buildSource(), refined)
  assert.equal(r.mismatches, 1, 'exactly the swapped turn is caught')
  const s = r.samples[0]
  assert.match(s.text, /发言人2/, 'cites the source speaker')
  assert.match(s.text, /沈其安/, 'cites the wrong label the content landed under')
  assert.match(s.text, /应为.*周砚/, 'cites the expected label')
})

test('M6 swap flag localizes to a section via buildSections flags', () => {
  const source = buildSource()
  const refined = buildRefined({ swapTurnIndex: 4, swapTo: '沈其安' })
  const attribution = checkAttribution(source, refined)
  const sections = buildSections(source, refined, { attribution })
  const flagged = sections.filter((sec) => sec.flags.some((f) => f.kind === 'attribution_mismatch'))
  assert.equal(flagged.length, 1, 'the misattribution surfaces in exactly one section checklist')
  assert.match(flagged[0].flags.find((f) => f.kind === 'attribution_mismatch').sample, /发言人2→沈其安/)
})

test('M6 unassessable path: too few anchored turns → speaker not mapped, no false flags', () => {
  // a tiny 2-pair interview: neither speaker reaches MIN_MAP_SAMPLE → map is empty → assessed false
  const src = ['发言人1   00:00', '云洲仪器最近怎么样，有没有什么值得说的新进展可以聊一聊的？', '',
    '发言人2   00:02', '最近我们把东南亚的传感器标定业务线又往前推进了一大步，签了好几个新的分销商。', '',
    '发言人1   00:05', '那毛利率这块呢，有没有比去年同期有一个比较明显的改善？', '',
    '发言人2   00:07', '毛利率确实改善了不少，主要是规模效应上来以后采购成本被摊薄了很多。'].join('\n')
  const ref = ['## 概况', '', '沈其安：云洲仪器最近怎么样，有没有什么值得说的新进展可以聊一聊的？', '',
    '周砚：最近我们把东南亚的传感器标定业务线又往前推进了一大步，签了好几个新的分销商。', '',
    '沈其安：那毛利率这块呢，有没有比去年同期有一个比较明显的改善？', '',
    '周砚：毛利率确实改善了不少，主要是规模效应上来以后采购成本被摊薄了很多。'].join('\n')
  const r = checkAttribution(src, ref)
  assert.equal(r.mappedSpeakers, 0, 'no speaker reaches the sample floor')
  assert.equal(r.assessed, false, 'unassessable → assessed:false (lenient, never a false flag)')
  assert.equal(r.mismatches, 0)
})

test('M6 struck source label is excluded from map + flags (transcriber on-the-fly speaker correction)', () => {
  // Build a normal doc, then append a 发言人1 turn whose SOURCE text carries a struck ~~发言人2~~ label — the
  // content is really the guest\'s and the refine correctly puts it under 周砚. This must NOT be a mismatch.
  const baseSrc = buildSource().split('\n')
  baseSrc.push('发言人1   01:30', '~~发言人2 01:31~~ 补充一句，我们那套温漂补偿的算法其实还申请了两项发明专利，护城河比外界想的要深。', '')
  const baseRef = buildRefined().split('\n')
  baseRef.push('周砚：补充一句，我们那套温漂补偿的算法其实还申请了两项发明专利，护城河比外界想的要深。', '')
  const r = checkAttribution(baseSrc.join('\n'), baseRef.join('\n'))
  assert.equal(r.mismatches, 0, 'a struck-label turn is source-ambiguous → never accused')
})

// ---------- M7a: quote_fabrication_risk ----------

const QUOTE_SRC = ['周砚   00:00',
  '我经常跟团队说，硬件创业最忌讳的就是贪大求全，一定要先在一个足够窄的场景里把商业闭环彻底跑通，这比什么都重要。'].join('\n')

test('M7a faithfully-quoted source text is NOT flagged', () => {
  const ref = ['## 观点', '',
    '周砚：他反复强调，“硬件创业最忌讳的就是贪大求全，一定要先在一个足够窄的场景里把商业闭环彻底跑通”，这是他的核心信条。'].join('\n')
  const r = checkQuoteFabrication(QUOTE_SRC, ref)
  assert.equal(r.assessed, true)
  assert.equal(r.flagged, 0, 'a quote whose words are present in the source is grounded')
})

test('M7a invented polished quote IS flagged', () => {
  const ref = ['## 金句', '',
    '周砚：他最后总结道，“唯有坚守长期主义方能穿越周期，这是我们这家公司十年来始终不渝的信念根基”。'].join('\n')
  const r = checkQuoteFabrication(QUOTE_SRC, ref)
  assert.equal(r.flagged, 1, 'a quote with no source support is a manufactured-quote candidate')
  assert.match(r.samples[0].text, /炮制引语/)
})

test('M7a short spans (≤ 11 hanzi term marks) are exempt', () => {
  const ref = ['## 术语', '', '周砚：所谓的“护城河效应”其实被高估了，“贪大求全”才是真问题。'].join('\n')
  const r = checkQuoteFabrication(QUOTE_SRC, ref)
  assert.equal(r.spansChecked, 0, 'sub-12-hanzi spans are not even checked')
  assert.equal(r.flagged, 0)
})

// ---------- M7b: entity_substitution_risk ----------

const ENT_GLOSSARY = ['## 品牌 / 公司（写法 → 统一）',
  '- **云洲仪器** ← 云舟仪器 / 运洲', '- **磐石科技** ← 盘石 / 磐实'].join('\n')

test('M7b planted entity swap IS flagged (磐石科技 region → 云洲仪器 in refined)', () => {
  const glossary = parseGlossaryLite(ENT_GLOSSARY)
  const source = ['沈其安 00:12',
    '我们最近在跟磐石科技谈一个很大的合作，他们那边的负责人特别专业，聊了整整一个下午关于传感器标定的方案细节。', '',
    '沈其安 02:30',
    '另外云洲仪器的老客户也在催我们赶紧把新版本发出去，这个季度的交付压力确实不小，团队都在加班加点赶进度。'].join('\n')
  // the 磐石科技 mention got SWAPPED to 云洲仪器; 云洲仪器 also legitimately appears once → 2 occurrences ≤ MAX
  const refined = ['## 合作', '',
    '沈其安：我们最近在跟云洲仪器谈一个很大的合作，他们那边的负责人特别专业，聊了整整一个下午关于传感器标定的方案细节。', '',
    '## 客户', '',
    '沈其安：另外云洲仪器的老客户也在催我们赶紧把新版本发出去，这个季度的交付压力确实不小，团队都在加班加点赶进度。'].join('\n')
  const r = checkEntitySubstitution(source, refined, glossary)
  assert.equal(r.flagged, 1, 'the swapped occurrence (unsupported source region) is caught')
  assert.match(r.samples[0].text, /云洲仪器/)
  assert.match(r.samples[0].text, /实体被替换/)
})

test('M7b glossary-driven pervasive canonical is NOT flagged (> MAX_REFINED_OCCURRENCES)', () => {
  const glossary = parseGlossaryLite(ENT_GLOSSARY)
  const source = ['沈其安 00:12',
    '云洲仪器是我们的主体公司，云洲仪器主打工业传感器，云洲仪器口碑不错，云洲仪器出品向来精良，这段话足够长以便稳定锚定该轮次。'].join('\n')
  const refined = ['## 概况', '',
    '沈其安：云洲仪器是我们的主体公司，云洲仪器主打工业传感器，云洲仪器口碑不错，云洲仪器出品向来精良，这段话足够长以便稳定锚定该轮次。'].join('\n')
  const r = checkEntitySubstitution(source, refined, glossary)
  assert.equal(r.flagged, 0, 'a pervasive canonical is glossary-driven by design, not a local swap')
})

test('M7b is dormant (assessed:false) when the glossary yields no parseable canonicals', () => {
  const glossary = parseGlossaryLite('## 品牌\n| 写法 | 统一为 |\n|---|---|\n| 云舟 | 云洲仪器 |')  // table shape parseGlossaryLite ignores
  const r = checkEntitySubstitution('沈其安 00:00\n云洲仪器很好，这段内容足够长可以锚定。', '沈其安：云洲仪器很好，这段内容足够长可以锚定。', glossary)
  assert.equal(r.assessed, false, 'no canonicals → dormant, never a false flag')
})

// ---------- micro-fix #7: 能能 stutter guard ----------

test('micro-fix 能能: 可能能够 / 智能能力 / 性能能耗 / 功能能 PASS (word ending in 能 + word starting with 能)', () => {
  for (const s of ['我觉得可能能够解决这个问题', '这套系统的智能能力很强', '它的性能能耗比做得不错', '这个功能能覆盖大部分场景']) {
    const r = auditText(s)
    const stut = r.findings.find((f) => f.name === 'stutter_repeats')
    assert.equal(stut.count, 0, `${s} → 能能 is legitimate, not a stutter`)
    assert.equal(r.status, 'ok')
  }
})

test('micro-fix 能能: a standalone 能能 stutter at phrase start STILL fails', () => {
  const r = auditText('周砚：能能，这个我得想想。')  // 能能 at phrase start (after ：) → real stutter
  assert.equal(r.findings.find((f) => f.name === 'stutter_repeats').count, 1)
  assert.equal(r.status, 'fail')
})

test('micro-fix 能能: 我我 / 就就 stutters and 对对对 / 是是是 confirmations are unchanged', () => {
  assert.equal(auditText('我我觉得').findings.find((f) => f.name === 'stutter_repeats').count, 1, '我我 still flags')
  assert.equal(auditText('就就是说').findings.find((f) => f.name === 'stutter_repeats').count, 1, '就就 still flags')
  assert.equal(auditText('对对对好的').findings.find((f) => f.name === 'confirmation_repeats').count, 1, '对对对 unchanged')
  assert.equal(auditText('是是是没错').findings.find((f) => f.name === 'confirmation_repeats').count, 1, '是是是 unchanged')
})

// ---------- micro-fix #8: heading-level fallback ----------

test('micro-fix headings: a normal ## -sectioned doc keeps ## (## out-numbers any deeper level)', () => {
  const doc = '# 标题\n## 甲\n正文\n## 乙\n正文\n## 丙\n正文\n### 子\n正文'
  assert.equal(detectHeadingRegex(doc).source, /^##\s+/.source)
})

test('micro-fix headings: a nested doc with few ## band headers but many #### leaves sections on ####', () => {
  // 2 band-level ## + 4 leaf #### → the reader-meaningful granularity is the 4 ####, not 2 giant pseudo-sections
  const doc = ['# 标题', '## 前沿', '### 竞争', '#### 模型', 'a', '#### 编码', 'b',
    '## 扩散', '#### 交互', 'c', '#### 语音', 'd'].join('\n')
  assert.equal(detectHeadingRegex(doc).source, /^#{4}\s+/.source, '#### (4) out-numbers ## (2) → use ####')
})

test('micro-fix headings: < 3 ## but ≥ 3 of a deeper level → densest deeper level', () => {
  const doc = ['# 标题', '## 唯一的二级标题', '### 甲', 'a', '### 乙', 'b', '### 丙', 'c', '### 丁', 'd'].join('\n')
  assert.equal(detectHeadingRegex(doc).source, /^#{3}\s+/.source, '1 ## vs 4 ### → ###')
})

// ---------- integration: auditPair surfaces M6 + M7a metrics/findings, all SOFT ----------

test('auditPair: attribution + quotes ride as SOFT findings and metrics; a swap never fails the gate', () => {
  const source = buildSource()
  const refined = buildRefined({ swapTurnIndex: 4, swapTo: '沈其安' })
  const r = auditPair({ sourceText: source, refinedText: refined, mode: 'refine' })
  assert.equal(r.metrics.attribution.mapped, 2)
  assert.equal(r.metrics.attribution.mismatches, 1)
  assert.ok('quotes' in r.metrics, 'quotes metric present in refine mode')
  const am = r.findings.find((f) => f.name === 'attribution_mismatch')
  assert.equal(am.severity, 'soft')
  assert.equal(am.count, 1)
  assert.ok(!r.failed.includes('attribution_mismatch'), 'attribution is SOFT — never a gate this pass')
})

test('auditPair: entity_substitution_risk is absent by default and present only under strict', () => {
  const source = ['沈其安 00:12', '我们最近在跟磐石科技谈合作，聊了整整一个下午关于传感器标定的方案细节安排。', '',
    '沈其安 02:30', '另外云洲仪器的老客户也在催新版本，这个季度的交付压力确实不小需要加班。'].join('\n')
  const refined = ['## 合作', '', '沈其安：我们最近在跟云洲仪器谈合作，聊了整整一个下午关于传感器标定的方案细节安排。', '',
    '## 客户', '', '沈其安：另外云洲仪器的老客户也在催新版本，这个季度的交付压力确实不小需要加班。'].join('\n')
  const off = auditPair({ sourceText: source, refinedText: refined, mode: 'refine', glossaryText: ENT_GLOSSARY })
  assert.ok(!off.findings.some((f) => f.name === 'entity_substitution_risk'), 'dormant without strict')
  const on = auditPair({ sourceText: source, refinedText: refined, mode: 'refine', glossaryText: ENT_GLOSSARY, strict: true })
  const es = on.findings.find((f) => f.name === 'entity_substitution_risk')
  assert.ok(es, 'present under strict')
  assert.equal(es.severity, 'soft')
})
