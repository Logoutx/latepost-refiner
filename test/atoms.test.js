import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractNumberAtoms, countHedges, atomLabel, checkMeaningAtoms, buildSections, auditPair, checkDerivativeAttribution,
} from '../scripts/audit_refined.mjs'
import { reviewSections, buildReviewMarkdown, sectionReviewItems, sectionReviewSummary, buildRunManifest } from '../universal/artifacts.js'

// ============================================================================
// M4 — meaning-atom fidelity (the MUTATION tier). Fictional entities only
// (云洲仪器 / 沈其安 / 周砚 placeholders), per the repo red line: never a real
// interview subject, company, or brand in a committed fixture.
// ============================================================================

// A compact fictional source turn rich in numeric facts, polarity, and hedges — the raw material every
// mutation test perturbs. `发言人 名字 MM:SS` label so parseSourceTurns treats it as spoken content.
const SRC = [
  '沈其安 00:12',
  '我们云洲仪器是二〇一九年成立的，去年营收差不多八千万，毛利率不到百分之三十。团队一百二十多人。账期一般压三个月，坏账率从百分之六压到百分之一以内。',
  '',
  '沈其安 02:31',
  '海外这块，我觉得可能明年会有起色，东南亚也许能起来，据说竞品已经进去了，估计规模不小。',
].join('\n')

// A FAITHFUL refined output: 数字→阿拉伯 per RULES 10, filler stripped, polarity + hedges preserved, Pangu spacing.
const GOOD = [
  '## 公司概况',
  '',
  '沈其安：我们云洲仪器是 2019 年成立的，去年营收差不多 8000 万，毛利率不到 30%。团队 120 多人。账期一般压 3 个月，坏账率从 6% 压到 1% 以内。',
  '',
  '## 海外扩张',
  '',
  '沈其安：海外这块，我觉得可能明年会有起色，东南亚也许能起来，据说竞品已经进去了，估计规模不小。',
].join('\n')

// ---------- extraction unit tests ----------

test('extractNumberAtoms: 汉字数字→阿拉伯 normalization matches RULES 10 (十六→16, 二〇一九→2019, 八千万→8000万, 百分之三十→30%)', () => {
  const key = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(key('一共十六个部门'), ['16|'], '十六 → 16 (scale)')
  assert.deepEqual(key('二〇一九年成立'), ['2019|年'], '二〇一九 → 2019 年 (year form)')
  assert.deepEqual(key('营收八千万'), ['8000|万'], '八千万 → 8000 万 (scale folded into unit)')
  assert.deepEqual(key('两亿的盘子'), ['2|亿'], '两亿 → 2 亿')
  assert.deepEqual(key('毛利率百分之三十'), ['30|%'], '百分之三十 → 30%')
  assert.deepEqual(key('一百二十多人'), ['120|'], '一百二十 → 120')
})

test('extractNumberAtoms: an arabic number and its 汉字 twin canonicalize IDENTICALLY (the parity that prevents false drift)', () => {
  const k = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(k('八千万'), k('8000 万'), '八千万 == 8000 万')
  assert.deepEqual(k('百分之三十'), k('30%'), '百分之三十 == 30%')
  assert.deepEqual(k('二〇一九年'), k('2019 年'), '二〇一九年 == 2019 年')
  assert.deepEqual(k('两亿'), k('2 亿'), '两亿 == 2 亿')
  assert.deepEqual(k('二十四小时'), k('24 小时'), '二十四小时 == 24 小时')
})

test('extractNumberAtoms: ranges canonicalize to lo-hi in any writing (六七十→60-70, 三四十→30-40, 30到40→30-40)', () => {
  const k = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(k('大概六七十亿'), ['60-70|亿'], '六七十 → 60-70')
  assert.deepEqual(k('三四十个点'), ['30-40|个点'], '三四十 → 30-40')
  assert.deepEqual(k('大概30到40个点'), ['30-40|个点'], '30到40 → 30-40')
  assert.deepEqual(k('三四十个点'), k('30-40 个点'), 'range writings agree')
})

test('extractNumberAtoms: polarity / bound qualifiers ride on the number (不到 30% / 亏损 2 亿 / 超过 5 倍)', () => {
  const one = (t) => extractNumberAtoms(t)[0]
  assert.equal(one('毛利率不到百分之三十').polarity, '不到')
  assert.equal(one('去年亏损两亿').polarity, '亏损')
  assert.equal(one('增长超过五倍').polarity, '超过')
  assert.equal(one('营收八千万').polarity, null, 'no qualifier → null polarity')
})

test('extractNumberAtoms EXCEPTIONS: small oral 汉字 (两三年 / 三五个 / 一两次 / 七八家 / 两个人), 成语, timestamps, labels are NOT extracted', () => {
  const k = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(k('干了两三年'), [], '两三 approximation kept 汉字')
  assert.deepEqual(k('招三五个人'), [], '三五个 kept 汉字')
  assert.deepEqual(k('去过一两次'), [], '一两次 kept 汉字')
  assert.deepEqual(k('砍掉七八家'), [], '七八家 kept 汉字')
  assert.deepEqual(k('就我们两个人'), [], '两个人 vague small count')
  assert.deepEqual(k('他做事一五一十很实在'), [], '成语 一五一十 not a number')
  assert.deepEqual(k('五花八门的产品'), [], '成语 五花八门 not a number')
  assert.deepEqual(k('沈其安 00:12'), [], 'speaker+timestamp label yields no atom')
  assert.deepEqual(k('时间是 08:00:15 开始'), [], 'HH:MM:SS timestamp masked')
  assert.deepEqual(k('回款一直下不来'), [], '一直 is lexical, not the number 1')
  assert.deepEqual(k('这是第三点'), [], '第三 ordinal in prose does not over-fire as a bare number')
})

test('extractNumberAtoms: spoken measure-word 大额 (2 个亿 / 1.5 个亿 / 两个亿 / 三个亿 / 3 个千万) folds 个 and canonicalizes to the SAME atom as the bare form (parity, no drift)', () => {
  const k = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(k('那也就是 2 个亿'), ['2|亿'], '2 个亿 → 2 亿')
  assert.deepEqual(k('那也就是 2 个亿'), k('约 2 亿元'), '2 个亿 == 2 亿 (identical atom, no phantom drift)')
  assert.deepEqual(k('大概 1.5 个亿'), ['1.5|亿'], '1.5 个亿 decimal → 1.5 亿')
  assert.deepEqual(k('两个亿'), ['2|亿'], '两个亿 → 2 亿')
  assert.deepEqual(k('两个亿'), k('2 亿'), '两个亿 == 2 亿')
  assert.deepEqual(k('三个亿'), ['3|亿'], '三个亿 → 3 亿')
  assert.deepEqual(k('3 个千万'), ['3|千万'], '3 个千万 → 3 千万')
})

test('extractNumberAtoms: the 个-fold does NOT touch 个月 (a real duration unit) or 个 + noun (5 个方面 / 三个人)', () => {
  const k = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(k('过了 3 个月'), ['3|个月'], '3 个月 stays the 个月 unit (not folded to 月)')
  assert.deepEqual(k('干了三个月才做完，投了三个亿'), ['3|个月', '3|亿'], '个月 and 个亿 coexist correctly in one turn')
  assert.deepEqual(k('就我们三个人'), [], '三个人 vague small count — no atom (unchanged)')
  assert.deepEqual(k('讲 5 个方面'), ['5|'], '5 个方面 → bare 5, 个 adds no unit atom (unchanged)')
})

test('checkDerivativeAttribution: a 时间线 "约 2 亿元"【访谈】 is COVERED by a source that says "2 个亿" — no fabrication hard-fail', () => {
  const corpus = '董锴：那也就是 2 个亿，投了差不多 1.5 个亿。'
  const timeline = '2021 年完成融资，规模约 2 亿元。【访谈】'
  const r = checkDerivativeAttribution(corpus, timeline)
  assert.equal(r.hardFail.length, 0, 'spoken 个亿 form now matches the canonical 亿 atom → no hard fail')
})

test('extractNumberAtoms: 千万 as the adverb (千万不要 / 千万别 / 千万要) is NOT extracted as 1000 万; a real 一千万 / 千万不止 IS kept', () => {
  const k = (t) => extractNumberAtoms(t).map((a) => a.key)
  assert.deepEqual(k('以后千万不要这样'), [], '千万不要 — adverb, not a number')
  assert.deepEqual(k('千万别忘了'), [], '千万别 — adverb')
  assert.deepEqual(k('千万要记住'), [], '千万要 — adverb')
  assert.deepEqual(k('花了一千万不到'), ['1000|万'], '一千万 has a digit prefix → real number kept')
  assert.deepEqual(k('身价千万不止'), ['1000|万'], '千万不止 is a genuine quantity → kept (excluded from the guard)')
})

test('countHedges: evidentiality / modality markers counted; a flat assertion has none', () => {
  assert.equal(countHedges('我觉得可能明年会好，据说也许能起来，估计不小'), 5, '我觉得 + 可能 + 据说 + 也许 + 估计 = 5 markers')
  assert.equal(countHedges('明年一定会盈利，收入翻倍'), 0, 'flat assertion → 0 hedges')
})

test('atomLabel applies 盘古之白: space before a CJK unit and after a polarity word, none before a symbol unit', () => {
  assert.equal(atomLabel({ value: '2', unit: '亿', polarity: '亏损' }), '亏损 2 亿')
  assert.equal(atomLabel({ value: '30', unit: '%', polarity: '不到' }), '不到 30%')
  assert.equal(atomLabel({ value: '8000', unit: '万', polarity: null }), '8000 万')
  assert.equal(atomLabel({ value: '2019', unit: '年', polarity: null }), '2019 年')
})

// ---------- comparison: mutations caught, legit rewordings NOT flagged ----------

test('a faithful refine (数字→阿拉伯, filler stripped, polarity+hedges kept) shows ZERO drift and ZERO hedge loss', () => {
  const r = checkMeaningAtoms(SRC, GOOD)
  assert.equal(r.assessed, true)
  assert.equal(r.drifted, 0, 'no number drift on a faithful refine')
  assert.equal(r.hedgeTurnsLost, 0, 'no hedge wipe on a faithful refine')
  assert.ok(r.sourceNumbers >= 6, 'the source facts were all extracted')
})

test('MUTATION — a changed number (2019→2021) is flagged as number_drift', () => {
  const bad = GOOD.replace('2019 年', '2021 年')
  const r = checkMeaningAtoms(SRC, bad)
  assert.ok(r.drifted >= 1, 'changed year caught')
  assert.ok(r.driftSamples.some((s) => s.text.includes('2019 年')), 'sample cites the lost source atom')
})

test('MUTATION — a dropped number-with-unit (8000 万 removed) is flagged', () => {
  const bad = GOOD.replace('差不多 8000 万，', '')
  const r = checkMeaningAtoms(SRC, bad)
  assert.ok(r.driftSamples.some((s) => s.text.includes('8000 万')), '8000 万 reported missing')
})

test('MUTATION — polarity dropped (不到 30% → 30%) is flagged as a polarity drift', () => {
  const bad = GOOD.replace('不到 30%', '30%')
  const r = checkMeaningAtoms(SRC, bad)
  assert.ok(r.driftSamples.some((s) => s.text.includes('不到') && s.text.includes('限定词')), 'the missing 不到 bound is reported')
})

test('MUTATION — a sign word vanishing (亏损 2 亿 → 2 亿) is flagged', () => {
  // The turn must be substantive (≥20 normalized 汉字) to enter the coverage/atom machinery, so it carries
  // enough surrounding context to anchor while the sign word rides on the number.
  const src = ['沈其安 00:12', '说实话去年整个公司是亏损两亿的，主要是大客户回款出了问题，今年一季度才勉强回正。'].join('\n')
  const kept = ['## 财务', '沈其安：说实话去年整个公司亏损 2 亿，主要是大客户回款出了问题，今年一季度才勉强回正。'].join('\n')
  const dropped = ['## 财务', '沈其安：说实话去年整个公司做了 2 亿，主要是大客户回款出了问题，今年一季度才勉强回正。'].join('\n')
  assert.equal(checkMeaningAtoms(src, kept).drifted, 0, '亏损 kept → clean')
  const r = checkMeaningAtoms(src, dropped)
  assert.ok(r.driftSamples.some((s) => s.text.includes('亏损')), '亏损 vanishing near 2 亿 is caught')
})

test('MUTATION — hedges stripped (可能/也许/据说/估计 all removed) fires hedge_loss with a density line', () => {
  const bad = GOOD.replace('我觉得可能明年会有起色，东南亚也许能起来，据说竞品已经进去了，估计规模不小',
    '明年会有起色，东南亚能起来，竞品已经进去了，规模不小')
  const r = checkMeaningAtoms(SRC, bad)
  assert.ok(r.hedgeTurnsLost >= 1, 'the hedge-stripped turn is flagged')
  assert.ok(r.hedgeSamples.some((s) => s.text.includes('不确定语气')), 'hedge sample explains the wipe')
})

test('NOT flagged — legit rewordings: 十六→16, 六七十亿→60-70 亿, 百分之三十→30%, range reformat, number moved within the turn', () => {
  const src = ['沈其安 00:12', '一共十六个部门，融资六七十亿，毛利率百分之三十，规模三四十个点。'].join('\n')
  // every number converted per RULES 10 AND reordered within the sentence — content identical, writing differs
  const ref = ['## 概况', '沈其安：毛利率 30%，规模 30-40 个点，一共 16 个部门，融资 60-70 亿。'].join('\n')
  const r = checkMeaningAtoms(src, ref)
  assert.equal(r.drifted, 0, 'pure 数字 conversion + intra-turn reorder is NOT drift')
})

test('NOT flagged — 两三年 kept as 汉字 in BOTH source and refined does not drift', () => {
  const src = ['沈其安 00:12', '这个项目做了两三年，招了三五个人。'].join('\n')
  const ref = ['## 概况', '沈其安：这个项目做了两三年，招了三五个人。'].join('\n')
  assert.equal(checkMeaningAtoms(src, ref).drifted, 0, 'small oral numbers never enter the atom set → never drift')
})

// ---------- Finding 2: unit-aware number_drift (a unit mutation is now visible) ----------

test('MUTATION (Finding 2) — a unit mutation on the same value (3 个月 → 3 年) is flagged as number_drift', () => {
  const src = ['沈其安 00:12', '这个项目我们从最初立项一直到最后正式上线，前前后后满打满算总共也就只用了 3 个月，团队执行力确实很强。'].join('\n')
  const kept = ['## 进度', '沈其安：这个项目我们从最初立项一直到最后正式上线，前前后后满打满算总共也就只用了 3 个月，团队执行力确实很强。'].join('\n')
  const bad = ['## 进度', '沈其安：这个项目我们从最初立项一直到最后正式上线，前前后后满打满算总共也就只用了 3 年，团队执行力确实很强。'].join('\n')
  assert.equal(checkMeaningAtoms(src, kept).drifted, 0, '3 个月 kept → clean')
  const r = checkMeaningAtoms(src, bad)
  assert.ok(r.drifted >= 1, 'the same value 3 under a different unit family (个月 → 年) is caught')
  assert.ok(r.driftSamples.some((s) => s.text.includes('单位')), 'the sample explains it is a unit change')
})

test('NOT flagged (Finding 2) — a unit-synonym swap (3 千米 → 3 公里) is NOT a unit mutation', () => {
  // 千米 / 公里 are not ATOM_UNITS, so both extract as a bare value 3 (no unit) — a synonym swap must never register
  // as a unit drift. (Aside: the scale char 千 inside 千米 tokenizes to a separate value 1000, a pre-existing
  // extraction detail unrelated to Finding 2, so we assert specifically that no UNIT-kind drift is raised.)
  const src = ['沈其安 00:12', '我们物流车队单程配送的平均半径，按去年整年的运营数据统计下来，基本就是 3 千米。'].join('\n')
  const ref = ['## 半径', '沈其安：我们物流车队单程配送的平均半径，按去年整年的运营数据统计下来，基本就是 3 公里。'].join('\n')
  assert.ok(!checkMeaningAtoms(src, ref).driftSamples.some((s) => s.text.includes('单位')), '千米/公里 do not register as a unit mutation')
})

test('NOT flagged (Finding 2) — a real unit-synonym pair among ATOM_UNITS (3 个月 → 3 月, same family)', () => {
  const src = ['沈其安 00:12', '这个项目从最初立项一直到最后正式上线，前前后后满打满算总共用了 3 个月。'].join('\n')
  const ref = ['## 进度', '沈其安：这个项目从最初立项一直到最后正式上线，前前后后满打满算总共用了 3 月。'].join('\n')
  assert.equal(checkMeaningAtoms(src, ref).drifted, 0, '个月/月 map to the same family → not a unit mutation')
})

test('NOT flagged (Finding 2) — a value present only WITHOUT a unit on the refined side is not a unit drift', () => {
  // Spec choice: unit-present-vs-absent is too FP-prone (prose reflow drops units), so it is NOT counted as drift.
  const src = ['沈其安 00:12', '这条产品线去年整年下来的综合毛利率，我印象里其实就是稳定在 30% 这个水平上下。'].join('\n')
  const ref = ['## 毛利', '沈其安：这条产品线去年整年下来的综合毛利率，我印象里其实就是稳定在 30 这个水平上下。'].join('\n')
  assert.equal(checkMeaningAtoms(src, ref).drifted, 0, 'source 30% vs refined bare 30 → the value matched, unit drop not flagged')
})

// ---------- P3: number-drift precision (garbage discipline, stutter dedup, turn-aware confidence) ----------

test('P3 stutter dedup — an ASR-doubled number (百分之三十 百分之三十) is ONE fact: a drop is one drift, not two', () => {
  const base = '说到毛利率这个问题，我们这个行业其实普遍都不算高，我们公司去年的毛利率大概就是'
  const tail = '的样子，比同行确实要稍微好那么一点点，这是实打实跑出来的数据。'
  const srcDouble = ['沈其安 00:12', base + '百分之三十 百分之三十' + tail].join('\n')
  const srcSingle = ['沈其安 00:12', base + '百分之三十' + tail].join('\n')
  // a refine that DROPPED the 30% figure entirely (a real omission, not a garbage clean-up)
  const dropped = ['## 毛利', '沈其安：说到毛利率这个问题，我们这个行业其实普遍都不算高，我们公司去年的毛利率其实并不算突出，比同行确实要稍微好那么一点点，这是实打实跑出来的数据。'].join('\n')
  const rd = checkMeaningAtoms(srcDouble, dropped)
  const rs = checkMeaningAtoms(srcSingle, dropped)
  assert.equal(rd.drifted, 1, 'the doubled 30% collapses to one → one confirmed drift, not two')
  assert.equal(rd.drifted, rs.drifted, 'a stuttered source and a single-mention source give the same drift count')
  assert.ok(rd.driftSamples.some((s) => s.text.includes('30%')))
})

test('P3 garbage discipline — a number inside an ASR-glue span (20182018) the refine cleaned is a NOTE, never a drift', () => {
  const src = ['沈其安 00:12', '我记得那个项目很早就启动了，具体年份我印象里大概是 20182018 年前后吧，反正就是那几年，团队规模也就十来个人。'].join('\n')
  const cleaned = ['## 起步', '沈其安：我记得那个项目很早就启动了，具体年份我印象里大概是 2018 年前后吧，反正就是那几年，团队规模也就十来个人。'].join('\n')
  const r = checkMeaningAtoms(src, cleaned)
  assert.equal(r.drifted, 0, 'the ASR-glue number is NOT counted as a missing drift (the refine correctly cleaned噪音)')
  assert.ok(r.driftNotes >= 1, 'it is surfaced as a downgraded review note instead')
  assert.ok(r.driftNoteSamples.some((s) => s.text.includes('ASR 噪音')), 'the note explains it is ASR noise')
})

test('P3 regression — a genuine changed number (2019→2021) stays a CONFIRMED drift, not a downgraded note', () => {
  const bad = GOOD.replace('2019 年', '2021 年')
  const r = checkMeaningAtoms(SRC, bad)
  assert.ok(r.drifted >= 1, 'the changed year is still a confirmed drift')
  assert.ok(r.driftSamples.some((s) => s.text.includes('2019 年')), 'sample cites the real lost atom')
  assert.equal(r.driftNotes, 0, 'a clean, non-garbage, shingle-anchored turn produces no downgraded notes')
})

test('P3 auditPair — number_drift_note rides as a separate SOFT finding, and is absent on a faithful refine', () => {
  const src = ['沈其安 00:12', '我记得那个项目很早就启动了，具体年份我印象里大概是 20182018 年前后吧，反正就是那几年，团队规模也就十来个人。'].join('\n')
  const cleaned = ['## 起步', '沈其安：我记得那个项目很早就启动了，具体年份我印象里大概是 2018 年前后吧，反正就是那几年，团队规模也就十来个人。'].join('\n')
  const r = auditPair({ sourceText: src, refinedText: cleaned, mode: 'refine' })
  const note = r.findings.find((f) => f.name === 'number_drift_note')
  assert.ok(note && note.severity === 'soft' && note.count >= 1, 'note finding present and soft')
  assert.ok(!r.failed.includes('number_drift_note'), 'a note never gates the pair')
  assert.equal(r.metrics.atoms.driftNotes, note.count, 'metrics carries the note count')
  const clean = auditPair({ sourceText: SRC, refinedText: GOOD, mode: 'refine' })
  assert.ok(!clean.findings.some((f) => f.name === 'number_drift_note'), 'no note finding on a faithful refine')
})

test('leniency — unparseable source (no speaker labels) or zero anchored turns → assessed:false, no findings', () => {
  const r = checkMeaningAtoms('一段没有发言人标签的连续文字，包含数字 2019 和百分之三十。', '# 标题\n\n随便的成稿 2020 年。')
  assert.equal(r.assessed, false)
  assert.equal(r.drifted, 0)
  assert.deepEqual(r.driftSamples, [])
})

// ---------- auditPair integration: SOFT ONLY, never enters failed[] ----------

test('auditPair (mode=refine): atom findings are SOFT — a drift never appears in failed[]; metrics.atoms is populated', () => {
  const bad = GOOD.replace('2019 年', '2021 年').replace('不到 30%', '30%')
  const r = auditPair({ sourceText: SRC, refinedText: bad, mode: 'refine' })
  assert.ok(r.metrics.atoms && r.metrics.atoms.assessed, 'metrics.atoms present')
  assert.ok(r.metrics.atoms.drifted >= 2, 'drift counted in metrics')
  const nd = r.findings.find((f) => f.name === 'number_drift')
  assert.equal(nd.severity, 'soft', 'number_drift is soft')
  assert.ok(nd.count >= 2)
  assert.ok(!r.failed.includes('number_drift'), 'SOFT ONLY — must not gate the pair')
  assert.ok(!r.failed.includes('hedge_loss'), 'hedge_loss never gates')
})

test('auditPair: mode=summary does NOT run the mutation tier (a summary legitimately drops qualifiers)', () => {
  const r = auditPair({ sourceText: SRC, refinedText: GOOD, mode: 'summary' })
  assert.equal(r.metrics.atoms, undefined, 'no atom metrics in summary mode')
  assert.ok(!r.findings.some((f) => f.name === 'number_drift'), 'no number_drift finding in summary mode')
})

// ============================================================================
// M5 — sections[] + 逐节复核清单
// ============================================================================

test('buildSections: one entry per ## section with source range + timestamp; a clean section carries empty flags', () => {
  const secs = buildSections(SRC, GOOD, { atoms: checkMeaningAtoms(SRC, GOOD) })
  assert.equal(secs.length, 2, 'two ## sections')
  const by = Object.fromEntries(secs.map((s) => [s.title, s]))
  assert.ok(by['公司概况'].sourceRange, 'section anchored to a source range')
  assert.deepEqual(by['公司概况'].flags, [], 'a faithful section is trusted (no flags)')
  assert.deepEqual(by['海外扩张'].flags, [], 'the hedge-heavy section is clean when hedges are kept')
})

test('buildSections: a mutated section carries the RIGHT flags (number_drift + hedge_loss localized to it)', () => {
  const bad = GOOD
    .replace('2019 年', '2021 年')                    // number_drift in 公司概况
    .replace('我觉得可能明年会有起色，东南亚也许能起来，据说竞品已经进去了，估计规模不小',
      '明年会有起色，东南亚能起来，竞品已经进去了，规模不小')  // hedge_loss in 海外扩张
  const atoms = checkMeaningAtoms(SRC, bad)
  const secs = buildSections(SRC, bad, { atoms })
  const by = Object.fromEntries(secs.map((s) => [s.title, s]))
  assert.ok(by['公司概况'].flags.some((f) => f.kind === 'number_drift'), '公司概况 flagged for the changed year')
  assert.ok(!by['公司概况'].flags.some((f) => f.kind === 'hedge_loss'), '公司概况 not flagged for hedge (its hedges intact)')
  assert.ok(by['海外扩张'].flags.some((f) => f.kind === 'hedge_loss'), '海外扩张 flagged for the wiped hedges')
  assert.ok(!by['海外扩张'].flags.some((f) => f.kind === 'number_drift'), '海外扩张 has no number drift')
})

test('buildSections: no ## headings → empty sections[]', () => {
  assert.deepEqual(buildSections(SRC, '沈其安：一段没有小标题的成稿。', {}), [])
})

test('auditPair returns sections[] and the mutated section is discoverable through it', () => {
  const bad = GOOD.replace('2019 年', '2021 年')
  const r = auditPair({ sourceText: SRC, refinedText: bad, mode: 'refine' })
  assert.ok(Array.isArray(r.sections) && r.sections.length === 2, 'sections attached to the pair result')
  assert.ok(r.sections.some((s) => s.flags.some((f) => f.kind === 'number_drift')), 'the drift is localized to a section')
})

// ---------- artifacts: 逐节复核清单 rendering ----------

// Synthetic audit result carrying flagged + trusted sections (fictional titles only).
const auditResultWithSections = {
  outputDir: '/tmp/out',
  audit: {
    status: 'ok',
    files: [{
      file: '/tmp/out/Transcripts/示例访谈.md', status: 'ok', failed: [],
      sections: [
        { title: '财务与账期', refinedLines: { start: 13, end: 24 }, sourceRange: { startLine: 340, endLine: 360 }, ts: '15:17-16:02',
          flags: [{ kind: 'number_drift', count: 2, sample: '不到 30%、亏损 2 亿' }, { kind: 'hedge_loss', count: 1 }] },
        { title: '公司概况', refinedLines: { start: 5, end: 12 }, sourceRange: { startLine: 1, endLine: 11 }, ts: '00:05-02:31', flags: [] },
        { title: '海外扩张', refinedLines: { start: 25, end: 30 }, sourceRange: { startLine: 40, endLine: 44 }, ts: null,
          flags: [{ kind: 'missing_yin', count: 1 }, { kind: 'weak_anchor', count: 1 }] },
      ],
    }],
  },
}

test('sectionReviewItems / sectionReviewSummary: only flagged sections listed; summary counts flagged vs total', () => {
  const items = sectionReviewItems(auditResultWithSections)
  assert.equal(items.length, 2, 'two flagged sections (the trusted 公司概况 is omitted)')
  assert.ok(items[0].includes('§财务与账期') && items[0].includes('源 L340-L360 · 15:17-16:02'), 'source line + timestamp rendered')
  assert.ok(items[0].includes('存疑数字 2 处') && items[0].includes('语气弱化 1 处') && items[0].includes('对照录音'), 'flag summary + call to action')
  assert.deepEqual(sectionReviewSummary(auditResultWithSections), { flagged: 2, total: 3 })
})

test('reviewSections + buildReviewMarkdown render the 逐节复核清单 section (medium priority, full-width quotes / Arabic / Pangu spacing)', () => {
  const secs = reviewSections(auditResultWithSections, [])
  const m5 = secs.find((s) => s.title.includes('逐节复核'))
  assert.ok(m5, 'the 逐节复核清单 section is present')
  assert.equal(m5.priority, 'medium')
  const md = buildReviewMarkdown(auditResultWithSections, { topic: '示例项目' })
  assert.match(md, /## 逐节复核清单/)
  assert.match(md, /§财务与账期 — 源 L340-L360 · 15:17-16:02/)
  // no ASCII straight quotes leaked into the Chinese line; the marker uses 全角 lenticular brackets
  assert.ok(!/["']/.test(m5.items[0]), 'no ASCII quotes in the review line')
})

test('manifest carries the sections summary and only the flagged sections per file', () => {
  const manifest = buildRunManifest(auditResultWithSections, { A: { topic: '示例项目' } })
  assert.deepEqual(manifest.audit.sections, { flagged: 2, total: 3 }, 'manifest audit.sections summary')
  const f = manifest.audit.files[0]
  assert.equal(f.sections.length, 2, 'only the two flagged sections persisted')
  assert.ok(f.sections.every((s) => s.flags.length), 'every persisted section has flags')
})

test('a clean pair produces a manifest with zero flagged sections and no 逐节复核 review line', () => {
  const clean = { audit: { status: 'ok', files: [{ file: '/tmp/x.md', status: 'ok', failed: [], sections: buildSections(SRC, GOOD, { atoms: checkMeaningAtoms(SRC, GOOD) }) }] } }
  assert.equal(sectionReviewSummary(clean).flagged, 0, 'no flagged sections on a faithful refine')
  assert.equal(sectionReviewItems(clean).length, 0, 'no 逐节复核 lines')
  assert.ok(!reviewSections(clean, []).some((s) => s.title.includes('逐节复核')), 'the section is omitted entirely when empty')
})
