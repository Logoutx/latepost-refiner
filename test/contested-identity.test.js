import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseGlossary,
  renderGlossary,
  renderRefineGlossary,
  mergeIntoPrior,
  mergeVerified,
  confidenceMark,
  contestedQuestions,
} from '../core/spec.js'
import { verifyPrompt, looksPhoneticallySuspect } from '../core/prompts.js'

// Coattail-mishear failure class, motivated abstractly with fictional placeholders only:
//   spoken/literal form "K Frame"  ·  real product "Keyframe"  ·  coattail SEO site "kframe.ai" (resells Keyframe).
// A verify agent that satisfies the two-key rule keeps "K Frame" and records BOTH hypotheses as 〔同指两解〕.

const GA = { topic: '示例产品', date: '2026-02', background: '虚构离线测试背景。', doNotMerge: [], files: [] }
const emptyMerged = (over = {}) => ({ people: [], brands: [], terms: [], speakersByFile: [], errors: [], notes: [], ...over })
// A verify result whose contested list flags "K Frame": literal A weak (SEO), correction B strong (official).
const CONTESTED_V = {
  resolved: [], unresolved: [],
  contested: [{ query: 'K Frame', literal: 'K Frame', literal_tier: '目录站/SEO 博客', correction: 'Keyframe', correction_tier: '官方域名', note: '字面命中仅为 Keyframe 的分销站，属搭便车反转' }],
}

// ---------- B. round-trip of 〔同指两解〕 through parse/render ----------

test('〔同指两解〕 round-trips: render → parse → render is byte-stable', () => {
  const merged = emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '受访者提到的工具', suspect_asr: true }] })
  const md1 = renderGlossary(merged, CONTESTED_V, { suspects: [] }, GA)
  assert.ok(/- \*\*K Frame\*\*.*〔同指两解〕\s*$/m.test(md1), 'the contested brand row carries the 〔同指两解〕 marker')
  assert.ok(md1.includes('更可能「Keyframe」'), 'both hypotheses are written into the row hint')

  const parsed = parseGlossary(md1)
  const e = parsed.brands.find((x) => x.canonical === 'K Frame')
  assert.equal(e.confidence, 'contested', 'the marker decodes to confidence:contested')

  // Re-render from the parsed structures (no fresh verify this round) must equal the first render.
  const md2 = renderGlossary({ ...emptyMerged(), brands: parsed.brands, speakersByFile: parsed.speakersByFile }, { resolved: [], unresolved: [] }, { suspects: [] }, GA)
  assert.equal(md2, md1, 'render → parse → render is byte-stable for a contested row')
})

test('confidenceMark: a prior contested entry with no fresh decisive hit re-emits 〔同指两解〕', () => {
  const e0 = { canonical: 'K Frame', variants: [], confidence: 'contested', hint: '同指两解·字面「K Frame」（SEO），更可能「Keyframe」（官方）' }
  assert.equal(confidenceMark(e0, new Map(), '2026-02'), ' 〔同指两解〕', 'prior contested is preserved, not silently dropped')
})

// ---------- B. mergeIntoPrior preservation + legitimate upgrade ----------

test('mergeIntoPrior: a fresh NON-decisive verify does NOT overwrite contested → 已核实', () => {
  // Prior glossary carries the contested row; this batch re-mentions it but verify returns only a vague resolved
  // hit (no concrete source). The name must stay contested — the coattail must not be able to "confirm" itself.
  const priorMd = renderGlossary(emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '工具' }] }), CONTESTED_V, { suspects: [] }, GA)
  const prior = parseGlossary(priorMd)
  const fresh = emptyMerged({ brands: [{ canonical: 'K Frame', variants: [] }] })
  const merged = mergeIntoPrior(prior, fresh)
  // A vague resolved hit (source is a blocklisted hedge → not concrete) that would rename it.
  const vagueV = { resolved: [{ query: 'K Frame', canonical: 'Keyframe', identity: '视频工具', source: '网络搜索' }], unresolved: [] }
  const md = renderGlossary(merged, vagueV, { suspects: [] }, GA)
  const line = md.split('\n').find((l) => l.includes('K Frame')) || ''
  assert.ok(line.includes('〔同指两解〕'), 'stays contested under a non-decisive verdict')
  assert.ok(!line.includes('〔核实'), 'was NOT upgraded to 已核实 by a vague source')
  assert.ok(/\*\*K Frame\*\*/.test(line), 'the spoken/literal form is kept as canonical (no referent substitution)')
})

test('mergeIntoPrior: a later DECISIVE verify (two_key) DOES upgrade contested → 已核实', () => {
  const priorMd = renderGlossary(emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '工具' }] }), CONTESTED_V, { suspects: [] }, GA)
  const prior = parseGlossary(priorMd)
  const merged = mergeIntoPrior(prior, emptyMerged({ brands: [{ canonical: 'K Frame', variants: [] }] }))
  // A decisive verdict now requires two_key:true (high-tier source AND context-fit), not bare concreteness.
  const decisiveV = { resolved: [{ query: 'K Frame', canonical: 'Keyframe', identity: '官方产品', source: 'keyframe.example.com 官网 about 页', two_key: true }], unresolved: [] }
  const md = renderGlossary(merged, decisiveV, { suspects: [] }, GA)
  const line = md.split('\n').find((l) => l.includes('Keyframe')) || ''
  assert.ok(line.includes('〔核实'), 'a concrete-source verdict upgrades the row to 已核实')
  assert.ok(!line.includes('〔同指两解〕'), 'the contested marker is retired by the decisive verdict')
  assert.ok(/\*\*Keyframe\*\*/.test(line), 'canonical is now the corrected form')
})

// FIX 1 (a): a self-confirmation of the literal (canonical === spoken form) retires contested ONLY with two_key.
test('two-batch: a self-confirm without two_key stays contested; with two_key it retires to 核实', () => {
  const priorMd = renderGlossary(emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '工具' }] }), CONTESTED_V, { suspects: [] }, GA)
  const prior = parseGlossary(priorMd)
  const merged = mergeIntoPrior(prior, emptyMerged({ brands: [{ canonical: 'K Frame', variants: [] }] }))
  // Batch 2: the coattail site "confirms" the literal (canonical === spoken form) off a derivative domain, no two_key.
  const noKey = { resolved: [{ query: 'K Frame', canonical: 'K Frame', identity: '剪辑工具', source: 'kframe.ai' }], unresolved: [] }
  const lineNo = renderGlossary(merged, noKey, { suspects: [] }, GA).split('\n').find((l) => l.startsWith('- **K Frame**')) || ''
  assert.ok(lineNo.includes('〔同指两解〕'), 'a self-confirm off a coattail site (no two_key) stays contested')
  assert.ok(!lineNo.includes('〔核实'), 'bare concreteness of the literal does NOT retire the contested row')

  // Same self-confirm, now with two_key attested → legitimate retirement toward the literal.
  const withKey = { resolved: [{ query: 'K Frame', canonical: 'K Frame', identity: '剪辑工具', source: 'kframe.ai', two_key: true }], unresolved: [] }
  const lineYes = renderGlossary(merged, withKey, { suspects: [] }, GA).split('\n').find((l) => l.startsWith('- **K Frame**')) || ''
  assert.ok(lineYes.includes('〔核实'), 'a two_key self-confirmation retires the contested row toward the literal')
  assert.ok(!lineYes.includes('〔同指两解〕'), 'the contested marker is gone once two_key confirms the literal')
})

// FIX 1 (b): a name-guard-rejected rename (张冠李戴) must NOT upgrade to 核实, even with a concrete source + two_key.
test('two-batch: a name-guard-rejected person rename keeps the row contested (never 核实)', () => {
  const contestedPersonV = {
    resolved: [], unresolved: [],
    contested: [{ query: '林川', literal: '林川', literal_tier: '目录站/SEO 博客', correction: '林传', correction_tier: '官方域名', note: '字面命中仅为分销站，属搭便车反转' }],
  }
  const priorMd = renderGlossary(emptyMerged({ people: [{ canonical: '林川', variants: [], hint: '受访者提到' }] }), contestedPersonV, { suspects: [] }, GA)
  const prior = parseGlossary(priorMd)
  const merged = mergeIntoPrior(prior, emptyMerged({ people: [{ canonical: '林川', variants: [] }] }))
  // A DIFFERENT strong name, concrete source, two_key:true — but the person name-guard rejects it as 张冠李戴.
  const v = { resolved: [{ query: '林川', canonical: '林传', identity: '某公司创始人', source: 'lin-chuan.example.com 官网团队页', two_key: true }], unresolved: [] }
  const md = renderGlossary(merged, v, { suspects: [] }, GA)
  const line = md.split('\n').find((l) => l.startsWith('- **林川**')) || ''
  assert.ok(line.includes('〔同指两解〕'), 'the name-guard rejection leaves the row contested')
  assert.ok(!line.includes('〔核实'), 'a rejected rename must NOT flip the marker to 核实 (no body/marker contradiction)')
  assert.ok(/- \*\*林川\*\*/.test(line), 'the spoken form is kept as canonical — the rename was not applied')
  assert.ok(line.includes('张冠李戴') || line.includes('未采用'), 'the name-guard note is recorded on the row')
})

test('mergeVerified: carries contested forward; a decisive resolved for the same query retires it', () => {
  const prior = { resolved: [], unresolved: [], contested: [{ query: 'K Frame', literal: 'K Frame', correction: 'Keyframe' }] }
  const carried = mergeVerified(prior, { resolved: [], unresolved: [] })
  assert.equal(carried.contested.length, 1, 'a contested verdict with no fresh word is carried forward')
  const upgraded = mergeVerified(prior, { resolved: [{ query: 'K Frame', canonical: 'Keyframe', source: 'official.example.com' }], unresolved: [] })
  assert.equal(upgraded.contested.length, 0, 'a fresh resolved for the same query removes it from contested')
  assert.equal(upgraded.resolved.length, 1)
})

// ---------- B. renderRefineGlossary no-substitution instruction ----------

test('renderRefineGlossary emits an explicit no-substitution instruction for a contested entity', () => {
  const merged = emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '工具' }] })
  const g = renderRefineGlossary(merged, CONTESTED_V, { suspects: [] }, GA)
  assert.ok(g.includes('## 同指两解'), 'a dedicated 同指两解 section is emitted for the refiner')
  assert.ok(g.includes('保留原形'), 'the refiner is told to keep the spoken written form')
  assert.ok(g.includes('（音，存疑：或为 Keyframe）'), 'the first-occurrence annotation names the candidate')
  assert.ok(g.includes('绝不写成 Keyframe') || g.includes('绝不可把候选名替换'), 'substitution is explicitly forbidden')
  assert.ok(/- \*\*K Frame\*\*.*〔同指两解〕/.test(g), 'the entity row itself also carries the contested marker')
})

test('renderRefineGlossary: a clean glossary has NO 同指两解 section', () => {
  const merged = emptyMerged({ brands: [{ canonical: '示例品牌', variants: [] }] })
  const g = renderRefineGlossary(merged, { resolved: [], unresolved: [] }, { suspects: [] }, GA)
  assert.ok(!g.includes('同指两解'), 'no contested section when nothing is contested')
})

// ---------- A. verify prompt builder: heavy protocol only when suspect ----------

test('verifyPrompt includes the hypothesis-driven protocol for a suspect chunk', () => {
  const table = '【品牌/公司/产品】\n- K Frame ← （无变体） ｜ 受访者提到的剪辑工具 ｜ ⚠侦察疑为转录误写、请优先核实正确写法'
  const p = verifyPrompt(table, { background: '视频剪辑领域 · 某工具', verifyDepth: 'key' })
  assert.ok(p.includes('候选'), 'instructs writing candidate corrections before searching')
  assert.ok(p.includes('证据分级') || p.includes('分级取信'), 'instructs tiered evidence weighting')
  assert.ok(p.includes('搭便车反转'), 'includes the coattail-inversion rule')
  assert.ok(p.includes('两把钥匙规则'), 'includes the two-key rule')
  assert.ok(p.includes('假设优先核实法'), 'includes the hypothesis-first protocol header')
})

test('verifyPrompt OMITS the heavy protocol for a clean chunk (stays lean)', () => {
  const table = '【人名】\n- 沈其安 ← 沈总 ｜ 创始人'
  const p = verifyPrompt(table, { background: '某公司 · 创始人访谈', verifyDepth: 'key' })
  assert.ok(!p.includes('搭便车反转'), 'no coattail rule for a clean chunk')
  assert.ok(!p.includes('假设优先核实法'), 'no hypothesis-first protocol block for a clean chunk')
  // The schema-return line still names contested (always allowed), but the heavy protocol is gone — verify that.
  assert.ok(!p.includes('两把钥匙规则'), 'no two-key protocol section for a clean chunk')
})

test('looksPhoneticallySuspect: signals and clean cases', () => {
  assert.ok(looksPhoneticallySuspect('- X ← Y ｜ ⚠侦察疑为转录误写'), '⚠ suspicion mark is a signal')
  assert.ok(looksPhoneticallySuspect('- 某词 ← 某 ｜ 同音存疑'), '同音/存疑 note is a signal')
  assert.ok(looksPhoneticallySuspect('- K Frame ← （无变体）'), 'a spaced letter+Word Latin token is a signal')
  assert.ok(looksPhoneticallySuspect('- K-Frame ← （无变体）'), 'a hyphenated letter+Word token is a signal')
  assert.ok(!looksPhoneticallySuspect('- ABC ← （无变体）'), 'a bare all-caps token is NOT a signal (AI/CEO/API would trip it otherwise)')
  assert.ok(!looksPhoneticallySuspect('- 沈其安 ← 沈总 ｜ 创始人'), 'a plain Chinese entity is clean')
})

// FIX 2: an all-caps run in ordinary hint text must NOT trip the heavy protocol.
test('looksPhoneticallySuspect: all-caps in hint text (CEO/AI) stays lean', () => {
  assert.ok(!looksPhoneticallySuspect('- 沈其安 ← 沈总 ｜ 联合创始人兼 CEO，负责 AI 业务'), 'CEO/AI in a hint is not a phonetic signal')
  assert.ok(!looksPhoneticallySuspect('- 某产品 ← — ｜ 基于 GPU 的 API 与 SDK'), 'GPU/API/SDK in a hint is not a phonetic signal')
})

// FIX 3: the letter+Word separator must span Unicode hyphen/dash variants and wide spaces, not just ASCII.
test('looksPhoneticallySuspect: a letter+Word split by a Unicode hyphen (U+2011) is a signal', () => {
  assert.ok(looksPhoneticallySuspect('- K‑Frame ← （无变体）'), 'U+2011 non-breaking hyphen letter+Word is a signal')
  assert.ok(looksPhoneticallySuspect('- K—Frame ← （无变体）'), 'U+2014 em dash letter+Word is a signal')
  assert.ok(looksPhoneticallySuspect('- K Frame ← （无变体）'), 'U+00A0 NBSP letter+Word is a signal')
  assert.ok(looksPhoneticallySuspect('- K　Frame ← （无变体）'), 'U+3000 full-width space letter+Word is a signal')
})

// ---------- C. wrap-up 收尾待问 line ----------

test('contestedQuestions produces one 收尾待问 line per contested entity, both hypotheses + tiers', () => {
  const merged = emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '工具' }] })
  const qs = contestedQuestions(merged, CONTESTED_V)
  assert.equal(qs.length, 1)
  assert.ok(qs[0].startsWith('〔同指两解〕K Frame：'), 'leads with the marker and the spoken form')
  assert.ok(qs[0].includes('A=K Frame（目录站/SEO 博客）'), 'hypothesis A with its evidence tier')
  assert.ok(qs[0].includes('B=Keyframe（官方域名）'), 'hypothesis B with its evidence tier')
  assert.ok(qs[0].includes('正文已保留口播形并标注，请定夺'), 'states the text kept the spoken form for the human to settle')
})

test('contestedQuestions works for a prior contested entity (no fresh verify) via the round-tripped hint', () => {
  const priorMd = renderGlossary(emptyMerged({ brands: [{ canonical: 'K Frame', variants: [], hint: '工具' }] }), CONTESTED_V, { suspects: [] }, GA)
  const prior = parseGlossary(priorMd)
  const qs = contestedQuestions({ ...emptyMerged(), brands: prior.brands }, { resolved: [], unresolved: [] })
  assert.equal(qs.length, 1, 'a carried-forward contested entity still surfaces its wrap-up line')
  assert.ok(qs[0].includes('B=Keyframe'), 'the candidate is recovered from the persisted row')
})
