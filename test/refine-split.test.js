import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  splitForRefine, splitForScout, mergeScoutChunks, partPath, stitchParts, stitchPartsWithReport, contentLength,
  REFINE_CHUNK_CHARS, MAX_SPEED_REFINE_CHUNKS, SCOUT_CHUNK_CHARS, MAX_SCOUT_CHUNKS,
  renderGlossary, renderRefineGlossary,
  clusterEntities, entityWorth, verifyChunks, suspectUnverified,
  endsWithQuestion, parseTurns,
} from '../core/spec.js'
import { resolveSpeakerMapping } from '../scripts/speaker-resolver.js'
import { checkMissingYin, parseGlossaryLite } from '../scripts/audit_refined.mjs'
import { readPlanRange, refinePrompt, stitchPrompt, scoutPrompt, summaryPrompt } from '../core/prompts.js'
import { concatFiles, makeFilePolicy } from '../engines/fileops.js'
import { runPipeline } from '../core/pipeline.js'

// ---------- splitForRefine ----------

// Contiguity invariant: chunks cover [1, lines] with no gap and no overlap.
function assertContiguous(chunks, lines) {
  assert.equal(chunks[0].startLine, 1, 'first chunk starts at line 1')
  assert.equal(chunks[chunks.length - 1].endLine, lines, 'last chunk ends at the last line')
  assert.ok(chunks[0].isFirst && chunks[chunks.length - 1].isLast, 'first/last flags set')
  for (let i = 1; i < chunks.length; i += 1) {
    assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1, `chunk ${i} is contiguous with ${i - 1}`)
    assert.ok(!chunks[i].isFirst, 'only chunk 0 is first')
  }
  for (const c of chunks) assert.equal(c.count, chunks.length, 'count matches actual chunk count')
}

test('contentLength counts 汉字 + each English-word/number run as 1 (the size metric)', () => {
  assert.equal(contentLength('你好 world 2024 测试'), 6) // 你好(2)+world(1)+2024(1)+测试(2)
  assert.equal(contentLength(''), 0)
  assert.equal(contentLength('纯中文一二三'), 6)
})

test('cost mode (default / no mode) never chunks — one agent regardless of 字数', () => {
  for (const chars of [0, 4000, 12000, 30000]) {
    for (const mode of [undefined, 'cost']) {
      const chunks = splitForRefine({ lines: 2000, chars, label: 'A' }, mode)
      assert.equal(chunks.length, 1, `chars=${chars}, mode=${mode} → 1 chunk`)
      assert.ok(chunks[0].isFirst && chunks[0].isLast)
      assert.equal(chunks[0].endLine, 2000)
    }
  }
})

test('speed mode fallback: files ≤ char threshold stay single; just over → 2 contiguous chunks', () => {
  for (const chars of [0, 4000, REFINE_CHUNK_CHARS]) {
    assert.equal(splitForRefine({ lines: 2000, chars, label: 'A' }, 'speed').length, 1, `${chars} 字 ≤ threshold → 1`)
  }
  const chunks = splitForRefine({ lines: 2000, chars: REFINE_CHUNK_CHARS + 1, label: 'A' }, 'speed') // 6001/4000 → 2
  assert.equal(chunks.length, 2)
  assertContiguous(chunks, 2000)
})

test('speed mode: large files split into up to 2 contiguous chunks by 字数 (conservative cap)', () => {
  for (const [lines, chars] of [[2130, 29599], [1467, 21000], [1350, 20764]]) {
    const chunks = splitForRefine({ lines, chars, label: 'A' }, 'speed')
    assert.equal(chunks.length, 2, `${chars} 字 → 2 chunks (MAX ${MAX_SPEED_REFINE_CHUNKS})`)
    assertContiguous(chunks, lines)
  }
})

test('speed mode: very large files capped at MAX_SPEED_REFINE_CHUNKS', () => {
  const chunks = splitForRefine({ lines: 9000, chars: 120000, label: 'A' }, 'speed')
  assert.equal(chunks.length, MAX_SPEED_REFINE_CHUNKS, 'capped at MAX_SPEED_REFINE_CHUNKS')
  assertContiguous(chunks, 9000)
})

test('size falls back to bytes, then lines, when chars is absent', () => {
  assert.ok(splitForRefine({ lines: 2000, bytes: 100000, label: 'A' }, 'speed').length >= 2, 'big bytes → chunk')
  assert.equal(splitForRefine({ lines: 50, label: 'A' }, 'speed').length, 1, 'few lines → single')
})

// ---------- budget-driven auto-chunk (provider-aware, uncapped) ----------

test('budget auto-chunk: a file over the model budget splits into ceil(字数/budget) balanced turn-boundary chunks', () => {
  const chunks = splitForRefine({ lines: 2400, chars: 53576, label: 'A' }, undefined, 28000) // 53,576 / 28,000 → 2 (the headline case)
  assert.equal(chunks.length, 2, '53,576 字 at budget 28,000 → 2 balanced chunks (≈ 27K each, inside the proven-good zone)')
  assertContiguous(chunks, 2400)
  const many = splitForRefine({ lines: 3000, chars: 90000, label: 'A' }, undefined, 18000) // 90,000 / 18,000 → 5
  assert.equal(many.length, 5, 'budget mode is UNCAPPED — 5 chunks, unlike speed mode\'s cap of 2')
  assertContiguous(many, 3000)
})

test('budget auto-chunk triggers only when 字数 EXCEEDS the budget (>, not ≥) — the exact boundary', () => {
  assert.equal(splitForRefine({ lines: 2000, chars: 28000, label: 'A' }, undefined, 28000).length, 1, 'exactly at budget → 1 (no trigger)')
  assert.equal(splitForRefine({ lines: 2000, chars: 28001, label: 'A' }, undefined, 28000).length, 2, 'one 字 over the budget → 2')
})

test('no budget (undefined) is zero behaviour change — cost mode stays a single agent regardless of 字数', () => {
  for (const chars of [4000, 30000, 120000]) {
    assert.equal(splitForRefine({ lines: 2000, chars, label: 'A' }, undefined, undefined).length, 1, `${chars} 字, no budget → 1`)
    assert.equal(splitForRefine({ lines: 2000, chars, label: 'A' }, 'cost', undefined).length, 1, `${chars} 字, cost mode, no budget → 1`)
  }
})

test('chunk off: disables ALL chunking, including a budget that would otherwise fire', () => {
  assert.equal(splitForRefine({ lines: 2000, chars: 90000, label: 'A' }, 'off', 18000).length, 1, 'off beats an over-budget file')
  assert.equal(splitForRefine({ lines: 2000, chars: 90000, label: 'A' }, 'off').length, 1, 'off with no budget → 1')
  assert.equal(splitForRefine({ lines: 2000, chars: 90000, label: 'A' }, 'off', undefined).length, 1)
})

test('speed + budget: chunk count is the max of the speed cap and the (uncapped) budget count', () => {
  const budgetWins = splitForRefine({ lines: 3000, chars: 90000, label: 'A' }, 'speed', 18000) // speedK=2, budgetK=5 → 5
  assert.equal(budgetWins.length, 5, 'budget-derived 5 > speed cap 2 → 5')
  assertContiguous(budgetWins, 3000)
  const speedWins = splitForRefine({ lines: 2000, chars: 20000, label: 'A' }, 'speed', 28000) // speedK=2, budgetK=1 (20K ≤ 28K) → 2
  assert.equal(speedWins.length, 2, 'speed cap 2 > budget count 1 → 2 (speed still fires when the budget alone would not)')
})

// ---------- explicit --chunk-size knob (Feature 1) ----------

// A synthetic ~53K-字 interview: 240 evenly-spaced turns, one opening every 10 lines (startLines 1,11,…,2391),
// none ending on a question. Fictional-safe: no real names, just the line geometry the splitter reasons about.
function evenTurns(count, step, { question = () => false } = {}) {
  return Array.from({ length: count }, (_, t) => ({ startLine: t * step + 1, q: !!question(t) }))
}
const BIG = { lines: 2400, chars: 53576, label: 'A', turns: evenTurns(240, 10) }

test('--chunk-size 10000 on a ~53K-字 doc → 6 balanced chunks, every boundary on a turn edge', () => {
  const chunks = splitForRefine(BIG, undefined, undefined, 10000) // ceil(53576/10000) = 6
  assert.equal(chunks.length, 6, '53,576 字 at 10,000 字/块 → 6 chunks')
  assertContiguous(chunks, 2400)
  const turnStarts = new Set(BIG.turns.map((t) => t.startLine))
  for (let i = 1; i < chunks.length; i += 1) assert.ok(turnStarts.has(chunks[i].startLine), `chunk ${i} starts on a turn edge (line ${chunks[i].startLine})`)
  const sizes = chunks.map((c) => c.endLine - c.startLine + 1)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 10, `balanced: sizes ${sizes.join('/')} within a turn of each other`)
})

test('--chunk-size OVERRIDES a smaller budget-derived count and a speed-mode count; --chunk off still wins', () => {
  // budget 28,000 alone → 2 chunks; the explicit 10,000 knob overrides it to 6.
  assert.equal(splitForRefine(BIG, undefined, 28000, 10000).length, 6, 'chunk-size overrides the provider budget count')
  // speed mode alone caps at 2; the knob overrides to 6.
  assert.equal(splitForRefine(BIG, 'speed', undefined, 10000).length, 6, 'chunk-size overrides the speed-mode cap')
  // both a budget and speed present: still exactly the knob's count.
  assert.equal(splitForRefine(BIG, 'speed', 28000, 10000).length, 6, 'chunk-size overrides both at once')
  // off beats everything, including an explicit chunk-size.
  assert.equal(splitForRefine(BIG, 'off', 28000, 10000).length, 1, '--chunk off suppresses chunking despite --chunk-size')
})

test('--chunk-size below the content length is a single chunk (ceil = 1, no split)', () => {
  assert.equal(splitForRefine({ lines: 2000, chars: 8000, label: 'A' }, undefined, undefined, 10000).length, 1, '8,000 字 at 10,000 字/块 → 1')
})

// ---------- question-boundary rule (Feature 2) ----------

// 5 turns opening at lines 1/21/41/61/81 over a 100-line file; split into 2. The even split point is line 50, whose
// nearest turn boundaries are the end of turn 1 (line 40) and turn 2 (line 60) — a tie the splitter breaks toward the
// earlier one (line 40). We drive K=2 with a 字-budget of 10,000 on a 20,000-字 file.
const QF = (qflags) => ({ lines: 100, chars: 20000, label: 'A', turns: [1, 21, 41, 61, 81].map((startLine, i) => ({ startLine, q: !!qflags[i] })) })

test('question boundary: a non-question split lands on the nominal nearest turn edge (regression baseline)', () => {
  const chunks = splitForRefine(QF([false, false, false, false, false]), undefined, 10000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].endLine, 40, 'no questions → boundary stays at the nominal nearest turn edge (line 40)')
  assertContiguous(chunks, 100)
})

test('question boundary: when the chunk-ending turn IS a question, the cut moves earlier so the question keeps its answer', () => {
  // turn index 1 (lines 21–40) ends on a question → must not end chunk 0; the earlier turn 0 (ends line 20) is eligible.
  const chunks = splitForRefine(QF([false, true, false, false, false]), undefined, 10000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].endLine, 20, 'boundary moved earlier (40 → 20); the question turn stays with its answer in chunk 1')
  assert.equal(chunks[1].startLine, 21, 'the question turn now opens chunk 1')
  assertContiguous(chunks, 100)
})

test('question boundary: falls FORWARD when no earlier eligible boundary exists in the chunk', () => {
  // turns 0 and 1 both end on questions; the nominal cut (turn 1) and the only earlier candidate (turn 0) are both
  // questions → fall forward to turn 2 (ends line 60), which is not a question.
  const chunks = splitForRefine(QF([true, true, false, false, false]), undefined, 10000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].endLine, 60, 'no earlier eligible boundary → fall forward to the next non-question edge (line 60)')
  assertContiguous(chunks, 100)
})

test('question boundary: pathological all-questions text falls back to the nominal boundary (never a giant chunk)', () => {
  const chunks = splitForRefine(QF([true, true, true, true, true]), undefined, 10000)
  assert.equal(chunks.length, 2, 'still two chunks — the fallback does not merge them into one giant chunk')
  assert.equal(chunks[0].endLine, 40, 'no eligible boundary anywhere → keep the nominal nearest turn edge (line 40)')
  assertContiguous(chunks, 100)
})

test('a file without a turn map falls back to the line divider, byte-identical to before', () => {
  const noTurns = { lines: 2400, chars: 53576, label: 'A' }
  const chunks = splitForRefine(noTurns, undefined, undefined, 10000)
  assert.equal(chunks.length, 6, 'still 6 chunks by the line divider')
  assertContiguous(chunks, 2400)
})

// ---------- endsWithQuestion / parseTurns (turn-map building blocks) ----------

test('endsWithQuestion ignores trailing whitespace, closing quotes/brackets, and 溯源 HTML comments', () => {
  assert.ok(endsWithQuestion('这是什么？'))
  assert.ok(endsWithQuestion('这是什么?  '), 'trailing whitespace ignored')
  assert.ok(endsWithQuestion('他问“这是什么？”'), 'trailing closing quote ignored')
  assert.ok(endsWithQuestion('这是什么？<!-- 源 L21-L40 -->'), 'trailing provenance comment ignored')
  assert.ok(endsWithQuestion('这是什么？）'), 'trailing bracket ignored')
  assert.ok(!endsWithQuestion('这是一个陈述。'), 'a statement is not a question')
  assert.ok(!endsWithQuestion('问号在中间？不在末尾。'), 'a mid-text question mark does not count')
})

test('parseTurns maps each 名字：label line to its opening line and question flag', () => {
  const content = ['记者：你们怎么定价？', '张三：我们按成本加成。', '记者：为什么不涨价', '张三：客户会跑。'].join('\n')
  const turns = parseTurns(content)
  assert.deepEqual(turns, [
    { startLine: 1, q: true },   // ends on ？
    { startLine: 2, q: false },
    { startLine: 3, q: false },  // 「为什么不涨价」 has no trailing ？
    { startLine: 4, q: false },
  ])
  assert.deepEqual(parseTurns('没有任何发言人标签的纯文本'), [{ startLine: 1, q: false }], 'label-less text → one paragraph block boundary')
})

// ---------- splitForScout / mergeScoutChunks (oversized-file scout resilience) ----------

test('splitForScout: a normal interview stays one scout agent; only oversized merges chunk', () => {
  for (const chars of [5000, 20000, SCOUT_CHUNK_CHARS]) {
    assert.equal(splitForScout({ lines: 2000, chars, label: 'A' }).length, 1, `${chars} 字 ≤ threshold → 1 scout`)
  }
  const chunks = splitForScout({ lines: 4000, chars: SCOUT_CHUNK_CHARS + 1, label: 'A' })
  assert.ok(chunks.length >= 2, 'just over the threshold → chunks')
  assertContiguous(chunks, 4000)            // no gap / no overlap; last chunk reaches the final line
})

test('splitForScout: chunk count scales with 字数 and caps at MAX_SCOUT_CHUNKS', () => {
  assert.equal(splitForScout({ lines: 5000, chars: 90000, label: 'A' }).length, 5, 'ceil(90000/20000) = 5 段')
  const huge = splitForScout({ lines: 9000, chars: 500000, label: 'A' })   // would be 25 → capped
  assert.equal(huge.length, MAX_SCOUT_CHUNKS, 'capped at the runaway guard')
  assertContiguous(huge, 9000)
})

test('splitForScout: not gated by chunkMode (resilience, always on) and unsplittable files stay single', () => {
  assert.equal(splitForScout({ lines: 1, chars: 999999, label: 'A' }).length, 1, 'lines ≤ 1 can\'t be split → single')
  assert.ok(splitForScout({ lines: 4000, chars: 80000, label: 'A' }).length >= 2, 'oversized chunks regardless of any speed/cost preference (no mode arg exists)')
})

test('mergeScoutChunks unions per-chunk findings into one and keeps the file-end anchor', () => {
  const parts = [
    { speakers: [{ label: '记者', role: '记者' }, { label: '发言人1', role: '受访者' }], people: [{ canonical: '张三' }], brands: [], terms: [{ canonical: '甲术语' }], errors: [{ kind: '同音字错', examples: ['A'] }], themes: ['开场'], has_existing_headings: false, ending_anchor: { line: 700, text: '中段。' }, special_notes: ['注一'] },
    { speakers: [{ label: '发言人 1', role: '受访者', identity: '李四，创始人', output_label: '李四' }], people: [{ canonical: '李四' }], brands: [{ canonical: '某品牌' }], terms: [{ canonical: '甲术语' }], errors: [{ kind: '同音字错', examples: ['B'] }], themes: ['收尾'], has_existing_headings: true, ending_anchor: { line: 2000, text: '就到这里。' }, special_notes: ['注二'] },
  ]
  const m = mergeScoutChunks(parts, { lines: 2000 })
  assert.deepEqual(m.speakers.map((s) => s.label), ['记者', '发言人1'], 'speakers unioned, deduped by label')
  assert.equal(m.speakers[1].output_label, '李四', 'a later chunk with a specific identity upgrades the shared speaker record')
  assert.equal(m.people.length, 2, 'people concatenated (downstream clusterEntities dedups across chunks, as it does across files)')
  assert.deepEqual(m.themes, ['开场', '收尾'], 'themes unioned')
  assert.equal(m.has_existing_headings, true, 'has_existing_headings is OR across chunks')
  assert.equal(m.errors.length, 1, 'same-kind errors merged into one entry')
  assert.deepEqual(m.errors[0].examples, ['A', 'B'], 'examples concatenated under that kind')
  assert.deepEqual(m.ending_anchor, { line: 2000, text: '就到这里。' }, 'anchor comes from the chunk that actually saw the file end')
})

test('mergeScoutChunks drops the ending anchor when the last chunk did not return (refine/check then read the tail)', () => {
  const parts = [{ speakers: [{ label: '记者' }], people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 600, text: '中段。' }, special_notes: [] }]
  const m = mergeScoutChunks(parts, { lines: 2000 })   // best anchor 600 « 2000×0.9 → ending unknown
  assert.deepEqual(m.ending_anchor, {}, 'short anchor dropped → empty; downstream reads the real tail itself')
})

test('mergeScoutChunks returns null only if every chunk failed; a partial set still yields a finding', () => {
  assert.equal(mergeScoutChunks([null, null], { lines: 2000 }), null, 'all chunks failed → null (→ scoutFailed; refine still runs from source)')
  const m = mergeScoutChunks([null, { speakers: [{ label: '记者' }], people: [{ canonical: '张三' }], ending_anchor: { line: 2000, text: '尾。' } }], { lines: 2000 })
  assert.ok(m && m.people.length === 1, 'one surviving chunk still produces a usable glossary')
})

// ---------- mergeScoutChunks: 分段侦察对同一说话人给出矛盾高置信姓名时的降级处理 ----------

test('分段侦察对同一轨道给出矛盾高置信姓名时降级并显式记录', () => {
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '开场自我介绍', role: '受访者' }] },
    { speakers: [{ label: '说话人 1', output_label: '陈遥', output_label_confidence: 'high', output_label_evidence: '对方称呼', role: '受访者' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.equal(m.speakers[0].output_label, '', '矛盾姓名一律放弃自动命名')
  assert.equal(m.speakers[0].output_label_confidence, 'low')
  assert.equal(m.speakers[0].label, '说话人 1', '仍保留原始数字标签，等人工确认')
  assert.ok(m.special_notes.some((n) => n.includes('林洄') && n.includes('陈遥')), '矛盾双方姓名都要显式出现在提示里')
})

test('矛盾姓名即使分数不同也降级', () => {
  // 第二条记录多带一个 identity，打分会更高；但“分数更高”不能替代“姓名互相矛盾”的判断——
  // 即使换成分数占优的一方，两个不同的人名本身就是需要人工确认的分歧，不能自动定论。
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '开场自我介绍', role: '受访者' }] },
    { speakers: [{ label: '说话人 1', output_label: '陈遥', output_label_confidence: 'high', output_label_evidence: '对方称呼', role: '受访者', identity: '陈遥' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.equal(m.speakers[0].output_label, '', '分数占优的一方也不能绕过冲突降级')
  assert.equal(m.speakers[0].output_label_confidence, 'low')
  assert.ok(m.special_notes.some((n) => n.includes('林洄') && n.includes('陈遥')))
})

test('同名不冲突，高分替换保留首次拼写', () => {
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '开场自我介绍', role: '受访者' }] },
    // 第二段的标签写法不带空格（说话人1），但按 generic key 仍归到同一轨道；且姓名相同不构成矛盾。
    { speakers: [{ label: '说话人1', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '对方称呼', role: '受访者', identity: '林洄，创始人' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.equal(m.speakers[0].output_label, '林洄')
  assert.equal(m.speakers[0].output_label_confidence, 'high', '同名不触发降级，高分记录正常替换')
  assert.equal(m.speakers[0].label, '说话人 1', '标签拼写保留第一次出现的写法')
  assert.ok(!m.special_notes.some((n) => n.includes('矛盾') || n.includes('冲突')), '同名不应产生冲突提示')
})

test('角色输出不触发姓名冲突', () => {
  // 记者/受访者这类角色词从不代表某个具体的人，不适用“矛盾姓名”判断——它们只按老逻辑比分数。
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '记者', output_label_confidence: 'high', output_label_evidence: '开场自称记者' }] },
    { speakers: [{ label: '说话人 1', output_label: '受访者', output_label_confidence: 'high', output_label_evidence: '对方称呼' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.ok(!m.special_notes.some((n) => n.includes('矛盾') || n.includes('冲突')), '角色词之间的差异不算姓名冲突')
  assert.equal(m.speakers[0].output_label, '记者', '两条角色记录分数打平，保留先到的一条（既有比分逻辑不变）')
})

test('mergeScoutChunks 在无姓名冲突时人物/品牌/术语合并与结尾锚点逻辑保持不变', () => {
  const parts = [
    { speakers: [{ label: '记者', role: '记者' }], people: [{ canonical: '苍璧科技' }], brands: [{ canonical: '苍璧牌' }], terms: [{ canonical: '乙术语' }], errors: [], themes: ['开场'], has_existing_headings: false, ending_anchor: { line: 500, text: '中段。' }, special_notes: [] },
    { speakers: [{ label: '发言人 1', role: '受访者', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '开场自我介绍' }], people: [{ canonical: '陈遥' }], brands: [{ canonical: '苍璧牌' }], terms: [{ canonical: '乙术语' }], errors: [], themes: ['收尾'], has_existing_headings: true, ending_anchor: { line: 1000, text: '就到这里。' }, special_notes: [] },
  ]
  const m = mergeScoutChunks(parts, { lines: 1000 })
  assert.equal(m.speakers.length, 2, '两个不同轨道各自保留，互不冲突')
  assert.deepEqual(m.people.map((p) => p.canonical), ['苍璧科技', '陈遥'], 'people 按 chunk 顺序拼接，跨 chunk 去重交给下游 clusterEntities')
  assert.deepEqual(m.brands.map((b) => b.canonical), ['苍璧牌', '苍璧牌'], 'brands 同样直接拼接，不在此处去重')
  assert.deepEqual(m.ending_anchor, { line: 1000, text: '就到这里。' }, '结尾锚点取覆盖到文件末尾的那个 chunk')
})

test('partPath derives sibling intermediate paths', () => {
  assert.equal(partPath('/out/Transcripts/X.md', 1), '/out/Transcripts/X.md.part1')
  assert.equal(partPath('/out/Transcripts/X.md', 3), '/out/Transcripts/X.md.part3')
})

// ---------- stitchParts ----------

test('stitchParts joins parts with one blank line and a trailing newline', () => {
  const merged = stitchParts(['# 标题\n\n## 甲\n\n李明：你好。', '## 乙\n\n王某：再见。'])
  assert.equal(merged, '# 标题\n\n## 甲\n\n李明：你好。\n\n## 乙\n\n王某：再见。\n')
})

test('stitchParts collapses an exact-duplicate heading straddling a seam', () => {
  const merged = stitchParts(['## 甲\n\n李明：上。\n\n## 乙', '## 乙\n\n王某：下。'])
  // the duplicated "## 乙" at the seam appears once
  assert.equal(merged.match(/## 乙/g).length, 1)
  assert.ok(merged.includes('李明：上。') && merged.includes('王某：下。'))
})

test('stitchParts collapses typography-only duplicate H2 sections and an exact replayed turn', () => {
  const question = '小君：你对 2026 年的 agent 发展还会有什么预期吗？年初 OpenClaw 已经这么火了。'
  const merged = stitchParts([
    `## 2026 年 agent 的关键瓶颈：continual learning\n\n苏煜：关键在持续学习。\n\n${question}`,
    `## 2026年agent的关键瓶颈：continual learning\n\n${question}\n\n苏煜：接下来会出现很多不同路线。`,
  ])
  assert.equal((merged.match(/关键瓶颈：continual learning/g) || []).length, 1, 'spacing-only duplicate heading is unified')
  assert.equal((merged.match(/OpenClaw 已经这么火了/g) || []).length, 1, 'the exact seam replay is removed once')
  assert.match(merged, /接下来会出现很多不同路线/, 'new substantive content remains')
})

test('stitchParts removes a high-confidence semantic duplicate at a chunk seam', () => {
  const repeated = '周砚：我们在东南亚先后设立了本地团队，并在中东建设区域中转仓，欧洲则通过跨境电商做小规模验证；这套路径的共同点是先验证需求，再逐步增加固定投入。'
  const paraphrase = '周砚：我们在东南亚先后设立本地团队，也在中东建设区域中转仓；欧洲主要通过跨境电商做小规模验证。这套路径共同点是先验证需求，再逐步增加固定投入。'
  const merged = stitchParts([`## 海外\n\n${repeated}`, `## 下一块\n\n${paraphrase}\n\n记者：后来进展如何？`])
  assert.equal((merged.match(/先验证需求/g) || []).length, 1, 'near-identical repeated turn appears once')
  assert.match(merged, /记者：后来进展如何/)
})

test('stitchParts removes a multi-turn duplicated suffix/prefix sequence at a chunk seam', () => {
  const a = '沈其安：我们做了一个桌面智能体，让模型像人一样先看屏幕，再判断下一步操作，并直接点击对应位置；这个方向后来成为多种电脑使用产品的基础。'
  const b = '这个系统与过去依赖 HTML 的方案不同，它使用视觉感知和像素级动作，因此面对普通应用界面也能完成连续操作。'
  const c = '随后多家公司推出类似产品，到了第二年，代码智能体也因为基础模型能力提升而快速普及，团队的工作方式在几个月里明显改变。'
  const ap = '沈其安：我们做了一个桌面智能体，让模型像人一样先看屏幕、判断下一步操作，再直接点击对应位置；这个方向后来成为多种电脑使用产品的基础。'
  const bp = '这个系统和过去依赖 HTML 的方案不同，使用视觉感知与像素级动作，因此面对普通应用界面也可以完成连续操作。'
  const cp = '随后多家公司推出了类似产品。到了第二年，代码智能体也因基础模型能力提升而迅速普及，团队工作方式在几个月里明显改变。'
  const merged = stitchParts([`## 前块\n\n${a}\n\n${b}\n\n${c}`, `## 后块\n\n${ap}\n\n${bp}\n\n${cp}\n\n记者：接下来你们准备做什么？`])
  assert.equal((merged.match(/桌面智能体/g) || []).length, 1, 'the repeated three-turn sequence appears once')
  assert.match(merged, /接下来你们准备做什么/)
})

test('stitchPartsWithReport repairs a long replay beyond the normal four-block seam window', () => {
  const blocks = Array.from({ length: 6 }, (_, i) => `受访者：第${i + 1}段说明包含一组足够具体的事实和完整限定条件，用来验证超长接缝回放不会在最终正文中重复出现。`)
  const report = stitchPartsWithReport([
    `## 前块\n\n${blocks.join('\n\n')}`,
    `## 后块\n\n${blocks.join('\n\n')}\n\n记者：接下来发生了什么？`,
  ])
  assert.ok(report.seamRepairs.some((x) => x.removedBlocks >= 6), 'the extended deterministic pass records its repair')
  assert.deepEqual(report.seamDuplicates, [], 'the repaired seam has no residual hard duplicate')
  assert.equal((report.text.match(/接下来发生了什么/g) || []).length, 1)
  for (const block of blocks) assert.equal((report.text.match(new RegExp(block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1)
})

test('stitchParts keeps short or differently attributed repetition', () => {
  const merged = stitchParts(['## 甲\n\n记者：这个结论很重要。', '## 乙\n\n受访者：这个结论很重要。'])
  assert.equal((merged.match(/这个结论很重要/g) || []).length, 2, 'short common wording is never deleted')
})

test('stitchParts ignores empty parts and returns "" for none', () => {
  assert.equal(stitchParts([]), '')
  assert.equal(stitchParts(['', '   ', null]), '')
  assert.equal(stitchParts(['只有一块的正文'], ), '只有一块的正文\n')
})

// ---------- readPlanRange ----------

function coverage(steps) {
  return steps.map((s) => {
    const m = s.match(/offset=(\d+), limit=(\d+)/)
    return { offset: Number(m[1]), limit: Number(m[2]) }
  })
}

test('readPlanRange reads its span plus a lead-in/lead-out margin, contiguously', () => {
  const f = { lines: 1467 }
  const steps = coverage(readPlanRange(f, 490, 978))
  assert.equal(steps[0].offset, 459, 'starts 30 lines before the span (490-30 → 0-based 459)')
  const lastEnd = steps[steps.length - 1].offset + steps[steps.length - 1].limit
  assert.equal(lastEnd, 1008, 'reads to 30 lines past the span (978+30)')
  for (let i = 1; i < steps.length; i += 1) assert.equal(steps[i].offset, steps[i - 1].offset + steps[i - 1].limit, 'pages are contiguous')
})

test('readPlanRange clamps the margin at the file edges', () => {
  const f = { lines: 1467 }
  const first = coverage(readPlanRange(f, 1, 489))
  assert.equal(first[0].offset, 0, 'first chunk starts at line 1 (offset 0)')
  const last = coverage(readPlanRange(f, 979, 1467))
  const lastEnd = last[last.length - 1].offset + last[last.length - 1].limit
  assert.equal(lastEnd, 1467, 'last chunk reads to EOF, not past it')
})

test('readPlanRange shrinks page size for dense files (bytes-aware)', () => {
  const dense = { lines: 1467, bytes: 1467 * 200 } // ~200 B/line → page must drop below 600
  const steps = coverage(readPlanRange(dense, 490, 978))
  assert.ok(steps[0].limit < 600, `dense page ${steps[0].limit} < 600`)
  assert.ok(steps.length > 1, 'dense span needs multiple reads')
})

// ---------- chunk-aware refinePrompt ----------

const F = { path: '/src/A.txt', label: 'A', lines: 1467, chars: 21000, title: 'A 访谈', subtitle: '*A访谈 · 采访时间 2025-02*', outPath: '/out/Transcripts/A.md' }
const FINDING = { speakers: [{ label: '记者' }], ending_anchor: { line: 1467, text: '就到这里。' } }
const A = { headingPolicy: 'none' }

test('refinePrompt without a chunk arg is the unchanged single-agent prompt (writes outPath, no parts)', () => {
  const p = refinePrompt(F, '校对表', FINDING, A)
  assert.ok(p.includes(`Write 到 ${F.outPath}`))
  assert.ok(!p.includes('.part'), 'no part file in single mode')
  assert.ok(!p.includes('分块'), 'no chunk framing in single mode')
})

test('contracted Refine maps stable source turns to output blocks while the host owns labels and rendering', () => {
  const contracted = {
    ...F,
    refinePath: '/out/.converted/A.turns.md',
    refineContract: { records: [{ id: 'T000001' }, { id: 'T000002' }] },
  }
  const chunk = {
    idx: 1, count: 2, inputPath: '/out/.converted/A.turns.part1.md',
    turnIds: ['T000001'],
  }
  const p = refinePrompt(contracted, '校对表', FINDING, A, chunk)
  assert.match(p, /不可变的 source turn 账本/u)
  assert.match(p, /output block/u)
  assert.match(p, /来源 ID 必须按原顺序完整记账/u)
  assert.match(p, /keep.*merge.*split.*fold_noise/u)
  assert.match(p, /不要输出或猜测 speaker_track_id/u)
  assert.match(p, /不要输出 H1、说明行/u)
  assert.match(p, /不要再按原稿行号自行切边界/u)
  assert.ok(p.includes(`Write 到 ${F.outPath}.part1`))
  assert.ok(p.includes(chunk.inputPath))
})

test('ambiguous speaker structure uses content-block boundaries and forbids guessing labels', () => {
  const ambiguous = {
    ...F,
    speakerMode: 'ambiguous',
    speakerResolution: { speakerMode: 'ambiguous', mappings: [], structureWarnings: [{ kind: 'scout_parser_disagreement' }] },
  }
  const chunks = splitForRefine(ambiguous, 'speed')
  const p = refinePrompt(ambiguous, '校对表', FINDING, A, chunks[0])
  assert.match(p, /疑似说话人格式未确认/)
  assert.match(p, /以段落或列表内容块为边界/)
  assert.match(p, /不得猜姓名、创造标签、合并轨道/)
  assert.doesNotMatch(p, /源文没有说话人标签/)
})

test('first chunk writes the H1 title, its part file, and the non-last end-boundary rule', () => {
  const chunks = splitForRefine(F, 'speed')
  const p = refinePrompt(F, '校对表', FINDING, A, chunks[0])
  assert.ok(p.includes(`# ${F.title}`), 'first chunk writes the H1 title')
  assert.ok(p.includes(`Write 到 ${F.outPath}.part1`))
  assert.ok(p.includes('第 1 块'))
  assert.ok(p.includes(`第 ${chunks[0].startLine}–${chunks[0].endLine} 行`), 'states its line span')
  assert.ok(p.includes('不要开始') && p.includes('那是下一块的'), 'non-last end-boundary rule present')
})

test('last chunk suppresses the title, starts at ##, carries the start-skip rule, and must reach the ending', () => {
  const chunks = splitForRefine(F, 'speed')
  const last = refinePrompt(F, '校对表', FINDING, A, chunks[chunks.length - 1])
  assert.ok(last.includes('不要写 H1 标题'), 'later chunk has no title')
  assert.ok(last.includes(`Write 到 ${F.outPath}.part${chunks.length}`))
  assert.ok(last.includes('标签行号'), 'boundary ownership rule present')
  assert.ok(last.includes('跳过'), 'start-skip rule present (turn owned by previous chunk)')
  assert.ok(last.includes('覆盖到源文件结尾'), 'last chunk must reach the ending')
})

test('stitchPrompt lists every part in order and offers Concat / cat', () => {
  const chunks = splitForRefine(F, 'speed')
  const p = stitchPrompt(F, chunks)
  assert.ok(p.includes(`${F.outPath}.part1`) && p.includes(`${F.outPath}.part2`))
  assert.ok(p.indexOf('.part1') < p.indexOf('.part2'), 'parts listed in order')
  assert.ok(p.includes('Concat') && p.includes('cat '), 'offers both merge mechanisms')
  assert.ok(p.includes(F.outPath))
})

// ---------- Concat file tool (deterministic merge, end-to-end through the sandbox policy) ----------

test('Concat tool merges part files in order, respecting the write/read policy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpr-concat-'))
  const out = path.join(dir, 'Transcripts', 'A.md')
  const parts = [partPath(out, 1), partPath(out, 2)]
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(parts[0], '# A\n\n## 甲\n\n李明：上半。')
  fs.writeFileSync(parts[1], '## 乙\n\n王某：下半。')
  const policy = makeFilePolicy({ readRoots: [dir], writeRoots: [dir] })
  const r = concatFiles({ file_path: out, sources: parts }, policy)
  assert.ok(r.ok, r.text)
  assert.equal(fs.readFileSync(out, 'utf8'), stitchParts([fs.readFileSync(parts[0], 'utf8'), fs.readFileSync(parts[1], 'utf8')]))
  assert.ok(fs.readFileSync(out, 'utf8').includes('李明：上半。') && fs.readFileSync(out, 'utf8').includes('王某：下半。'))
})

test('Concat refuses sources outside the read sandbox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpr-concat-deny-'))
  const out = path.join(dir, 'A.md')
  const policy = makeFilePolicy({ readRoots: [dir], writeRoots: [dir] })
  const r = concatFiles({ file_path: out, sources: ['/etc/hosts'] }, policy)
  assert.equal(r.ok, false)
})

// ---------- condensed refine glossary (token-cost lever) ----------

const MERGED = {
  speakersByFile: [{ label: 'A', speakers: [{ label: '记者', role: '记者', identity: '主持' }, { label: '王某', role: '受访者', identity: '示例公司研发' }] }],
  people: [
    { canonical: '王某', variants: ['王总'], hint: '示例公司研发负责人，2016 年入职，很长一段身份描述继续延伸占很多字符以模拟真实校对表的冗长身份说明', files: ['A'], crossFile: false },
  ],
  brands: [{ canonical: '示例公司', variants: ['示例', 'X 公司'], hint: '本访谈对象企业，背景说明也可能很长很长很长很长很长很长', files: ['A'], crossFile: true }],
  terms: [{ canonical: '真鲜纯', variants: ['臻鲜纯'], hint: '核心战略', files: ['A'], crossFile: false }],
  errors: [{ file: 'A', kind: '同音字错', examples: ['臻鲜纯 vs 真鲜纯', '肌底乳 vs 基底乳'] }],
  notes: ['[A] 受访者身份未明确', '[A] 后半段进入保密话题'],
}
const VERIFIED = { resolved: [{ query: '臻鲜纯', canonical: '真鲜纯', identity: '品质战略', source: '据公开资料' }], unresolved: [] }
const DEDUP = { suspects: [{ members: ['真鲜纯', '臻鲜纯'], kind: 'term', preferred: '真鲜纯', why: '同音异写' }] }
const GA = { topic: '示例公司', date: '2025-02', background: '这是很长的采访背景，含行业、公司、人物、产品、事件，通常几百字，会被全量塞进每个精校代理。', doNotMerge: [] }

test('renderRefineGlossary keeps the spelling info but drops the archival prose, and is much shorter', () => {
  const full = renderGlossary(MERGED, VERIFIED, DEDUP, GA)
  const slim = renderRefineGlossary(MERGED, VERIFIED, DEDUP, GA)
  // keeps what a refiner needs
  assert.ok(slim.includes('王某') && slim.includes('示例公司') && slim.includes('真鲜纯'), 'entity canonicals present')
  assert.ok(slim.includes('记者') && slim.includes('王某'), 'speaker labels present')
  assert.ok(slim.includes('写法统一') && slim.includes('臻鲜纯') && slim.includes('真鲜纯'), '写法统一 directive present')
  // drops the archival prose
  assert.ok(!slim.includes('采访背景') && !slim.includes(GA.background), 'background dropped')
  assert.ok(!slim.includes('需特别处理的转写错误'), 'error examples dropped')
  assert.ok(!slim.includes('各份特别提醒'), 'per-file notes dropped')
  // materially shorter than the full archival glossary
  assert.ok(slim.length < full.length * 0.7, `slim ${slim.length} < 70% of full ${full.length}`)
})

// ---------- ASR-error correction: scout knowledge-canonical + force-verify suspects (fictional names) ----------

test('clusterEntities propagates suspect_asr — a scout flag survives the merge', () => {
  const [c] = clusterEntities([{ canonical: '苍璧科技', variants: ['苍碧科技'], suspect_asr: true }])
  assert.equal(c.suspect_asr, true, 'a flagged entity stays flagged after clustering')
  const [d] = clusterEntities([{ canonical: '示例公司', variants: [] }])
  assert.ok(!d.suspect_asr, 'an unflagged entity is not flagged')
})

test('the ASR blind spot: a consistently mis-heard name is worth 0 (so key-mode verify would skip it)', () => {
  assert.equal(entityWorth({ canonical: '卫昭', variants: [] }), 0, 'single spelling, no variant, not public → worth 0')
})

test('verifyChunks force-includes a worth-0 suspect in key mode (the core fix), but not a worth-0 non-suspect', () => {
  const merged = {
    people: [{ canonical: '卫昭', variants: [], suspect_asr: true }],   // worth 0 BUT suspected → must be sent
    brands: [{ canonical: '无关公司', variants: [] }],                  // worth 0, not suspected → still skipped
    terms: [],
  }
  const { chunks, eligible } = verifyChunks(merged, 'key')
  const sent = chunks.join('\n')
  assert.ok(sent.includes('卫昭'), 'the worth-0 suspect IS sent to verify')
  assert.ok(!sent.includes('无关公司'), 'a worth-0 non-suspect stays skipped')
  assert.equal(eligible, 1, 'exactly the suspect is eligible')
  assert.ok(sent.includes('⚠'), 'the suspect row is flagged so the verify agent prioritises it')
})

test('suspectUnverified asks about a suspect verify could not resolve, and goes quiet once resolved', () => {
  const merged = { people: [{ canonical: '苍璧科技', variants: ['苍碧科技'], suspect_asr: true, hint: '激光雷达公司' }], brands: [], terms: [] }
  const open = suspectUnverified(merged, { resolved: [], unresolved: [] })
  assert.equal(open.length, 1, 'unresolved suspect → one openQuestion')
  assert.ok(open[0].includes('苍璧科技'), 'it names the suspect')
  const done = suspectUnverified(merged, { resolved: [{ query: '苍碧科技', canonical: '苍璧科技' }], unresolved: [] })
  assert.equal(done.length, 0, 'once verify resolves any of its spellings, no question')
})

test('renderGlossary flags an unresolved suspect in the archival table (never ships silently)', () => {
  const merged = { speakersByFile: [], people: [{ canonical: '卫昭', variants: [], suspect_asr: true, hint: 'x' }], brands: [], terms: [], errors: [], notes: [] }
  const g = renderGlossary(merged, { resolved: [], unresolved: [] }, null, { topic: 'T', date: '2025-09', background: 'bg', doNotMerge: [] })
  assert.ok(/卫昭.*⚠ 侦察疑为转录误写/.test(g), 'unresolved suspect carries a ⚠ note in the glossary body')
})

test('renderGlossary trusts user-supplied speakers without forcing （音） everywhere', () => {
  const merged = {
    speakersByFile: [{ label: '访谈 A', speakers: [{ label: '方岑', role: '受访者', identity: '星桥航天副总工程师' }] }],
    people: [{ canonical: '方岑', variants: ['方琛'], suspect_asr: true, hint: '星桥航天副总工程师、受访者', files: ['访谈 A'] }],
    brands: [],
    terms: [],
    errors: [],
    notes: [],
  }
  const g = renderGlossary(merged, { resolved: [], unresolved: [{ query: '方岑', note: '公开网页未找到直接身份页' }] }, null, {
    topic: 'T',
    date: '2025-09',
    background: 'bg',
    doNotMerge: [],
    files: [{ speakerHints: '方岑=星桥航天副总工程师、受访者' }],
  })
  assert.ok(!/方岑.*⚠ 侦察疑为转录误写/.test(g), 'trusted speaker row is not treated as unsafe ASR')
  assert.ok(/方岑：公开核实不足；按发言人信息使用/.test(g), 'public lookup gap is still recorded')
  assert.ok(!/方岑：未能核实，保留（音）/.test(g), 'trusted speaker does not become a missing_yin trigger')
  const glossary = parseGlossaryLite(g)
  assert.equal(checkMissingYin('方岑：我来解释天隼三号。', glossary).count, 0)
})

test('scoutPrompt instructs knowledge-canonical and the suspect_asr flag', () => {
  const p = scoutPrompt({ path: '/s/A.txt', label: 'A', lines: 100 }, { background: 'bg' })
  assert.ok(p.includes('知名实体用你已知的正确写法') && p.includes('苍璧科技'), 'knowledge-canonical instruction present')
  assert.ok(p.includes('suspect_asr=true'), 'suspect-flag instruction present')
  assert.ok(p.includes('一整行') && p.includes('逐字照抄') && p.includes('行首时间码'), 'Scout sample is an exact source-line evidence contract')
})

test('summaryPrompt avoids duplicate 访谈 suffix in output filename', () => {
  const A = { topic: '星桥航天方岑访谈', outputDir: '/out', skillDir: '/skill', date: '2026-07' }
  const p = summaryPrompt(A, [{ outPath: '/out/Transcripts/a.md' }])
  assert.ok(p.includes('/out/星桥航天方岑访谈总结.md'))
  assert.ok(!p.includes('访谈访谈总结'))
  const q = summaryPrompt({ ...A, topic: '示例公司' }, [{ outPath: '/out/Transcripts/a.md' }])
  assert.ok(q.includes('/out/示例公司访谈总结.md'))
})

// ---------- pipeline routing (mock engine, zero tokens) ----------

function mockEngine(labels, opts = {}) {
  const reply = (label) => {
    if (/^scout/.test(label)) return { speakers: [{ label: '记者', role: '记者' }], people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 1467, text: '就到这里。' }, special_notes: [] }
    if (/^refine/.test(label)) return { path: 'x', headings: ['某节'], key_fixes: [], open_questions: [] }
    if (/^stitch/.test(label)) return '已合并'
    if (/^dedup/.test(label)) return { suspects: [] }
    if (/^(summary|timeline)/.test(label)) return `/out/${label}.md`
    return null
  }
  const e = {
    agent: async (_p, o) => { labels.push(o.label); return (opts.fail && opts.fail(o.label)) ? null : reply(o.label) },
    parallel: (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all((items || []).map(async (item, i) => {
      let v = item
      for (const s of stages) { try { v = await s(v, item, i) } catch { return null } if (!v) return null }
      return v
    })),
    phase: () => {}, log: () => {},
  }
  // Only a budgeted engine (DeepSeek etc.) exposes refineBudget; omitting it mirrors Anthropic / the CC sandbox.
  if (opts.refineBudget) e.refineBudget = opts.refineBudget
  return e
}

test('speed mode: pipeline routes a large file through 2 chunk agents + a stitch agent (no separate check phase)', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1467, chars: 21000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', chunkMode: 'speed', files: [file] }, mockEngine(labels))
  assert.ok(labels.includes('refine:A#1/2') && labels.includes('refine:A#2/2'), 'two chunk agents (conservative cap)')
  assert.ok(labels.includes('stitch:A'), 'a stitch agent ran (no fs capability injected → agent fallback)')
  assert.ok(!labels.some((l) => /^check/.test(l)), 'the separate haiku completeness check phase is gone — completeness now comes from the deterministic audit')
})

test('deterministic stitch: when a stitch capability is injected, chunked refine uses it and does NOT dispatch the stitch agent', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1467, chars: 21000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const stitchCalls = []
  const capabilities = {
    stitch: (f, chunks) => { stitchCalls.push({ outPath: f.outPath, parts: chunks.map((c) => c.idx) }); return { path: f.outPath, merged: chunks.length } },
    // No runAudit → the audit gate falls back to an agent (returns null in the mock → unavailable), which is fine here.
  }
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', chunkMode: 'speed', capabilities, files: [file] }, mockEngine(labels))
  assert.ok(labels.includes('refine:A#1/2') && labels.includes('refine:A#2/2'), 'both chunk agents still ran')
  assert.equal(stitchCalls.length, 1, 'the deterministic stitch capability was invoked exactly once')
  assert.deepEqual(stitchCalls[0], { outPath: '/out/Transcripts/A.md', parts: [1, 2] }, 'it received the file outPath and both chunk indices')
  assert.ok(!labels.some((l) => /^stitch/.test(l)), 'the stitch AGENT was NOT dispatched when the capability is present')
  assert.equal(r.refined.length, 1, 'the file was still refined (stitched deterministically)')
})

test('deterministic stitch: without a stitch capability (Workflow sandbox), the stitch agent fallback IS dispatched', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1467, chars: 21000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  // No capabilities at all → the no-fs fallback path.
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', chunkMode: 'speed', files: [file] }, mockEngine(labels))
  assert.ok(labels.includes('refine:A#1/2') && labels.includes('refine:A#2/2'), 'both chunk agents ran')
  assert.ok(labels.includes('stitch:A'), 'the stitch agent fallback ran when no stitch capability is injected')
  assert.equal(r.refined.length, 1, 'the file was still refined (stitched by the agent)')
})

test('cost mode (default): pipeline keeps a single refine agent even for a large file (no chunk, no stitch)', async () => {
  const labels = []
  // two files so we take the multi-file (scout/verify/refine) branch; neither chunks in cost mode
  const files = [
    { path: '/src/A.txt', label: 'A', lines: 1467, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' },
    { path: '/src/B.txt', label: 'B', lines: 1488, title: 'B', subtitle: '*s*', outPath: '/out/Transcripts/B.md' },
  ]
  await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files }, mockEngine(labels))
  assert.ok(labels.includes('refine:A') && labels.includes('refine:B'), 'single refine agent per file')
  assert.ok(!labels.some((l) => /#/.test(l)), 'no chunk agents in cost mode')
  assert.ok(!labels.some((l) => /^stitch/.test(l)), 'no stitch agent in cost mode')
})

// ---------- provider-aware auto-chunk (pipeline wiring, mock engine) ----------

// A stub budget resolver stands in for a real provider engine's refineBudget(tier). 25,000 字 / 10,000 budget → 3
// chunks — an uncapped N-way split speed mode (max 2) could never produce, so it also proves budget≠speed.
const stubBudget = (model, budget) => (() => ({ model, budget }))

test('auto-chunk: an over-budget file on a budgeted engine splits into ceil(字数/budget) agents and records autoChunk', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1500, chars: 25000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline(
    { topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [file] },
    mockEngine(labels, { refineBudget: stubBudget('stub-pro', 10000) }), // 25000/10000 → 3
  )
  assert.ok(labels.includes('refine:A#1/3') && labels.includes('refine:A#2/3') && labels.includes('refine:A#3/3'), 'three chunk agents from the budget (uncapped)')
  assert.equal(r.autoChunk.length, 1, 'one autoChunk record for the file')
  assert.deepEqual(r.autoChunk[0], { label: 'A', model: 'stub-pro', budget: 10000, contentLength: 25000, parts: 3 }, 'the record carries model/budget/字数/parts')
  assert.equal(r.refined.length, 1, 'the file is still refined (stitched)')
})

test('a failed provider-budget chunk still leaves its complete pre-dispatch plan in the result', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1500, chars: 25000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline(
    { topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [file] },
    mockEngine(labels, { refineBudget: stubBudget('stub-pro', 10000), fail: (label) => /(?:refine|refine-retry):A#3\/3/.test(label) }),
  )

  assert.deepEqual(r.failed, ['A'])
  assert.equal(r.refined.length, 0)
  assert.equal(r.plannedChunks.length, 1)
  assert.deepEqual(r.plannedChunks[0].parts.map((part) => part.path), ['/out/Transcripts/A.md.part1', '/out/Transcripts/A.md.part2', '/out/Transcripts/A.md.part3'])
  assert.deepEqual(r.autoChunk[0], { label: 'A', model: 'stub-pro', budget: 10000, contentLength: 25000, parts: 3 })
})

test('no auto-chunk when the engine declares no budget (Anthropic / CC path unchanged)', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1500, chars: 25000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline(
    { topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [file] },
    mockEngine(labels), // no refineBudget method
  )
  assert.ok(labels.includes('refine:A'), 'a single refine agent')
  assert.ok(!labels.some((l) => /refine:A#/.test(l)), 'no chunk agents without a declared budget')
  assert.deepEqual(r.autoChunk, [], 'nothing recorded')
})

test('--chunk off suppresses auto-chunk even when the file exceeds the model budget (the escape hatch)', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1500, chars: 25000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline(
    { topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', chunkMode: 'off', files: [file] },
    mockEngine(labels, { refineBudget: stubBudget('stub-pro', 10000) }),
  )
  assert.ok(labels.includes('refine:A') && !labels.some((l) => /refine:A#/.test(l)), 'off → one agent despite the budget')
  assert.deepEqual(r.autoChunk, [], 'no autoChunk recorded when chunking is off')
})

test('--chunk-size drives the split and the autoChunk trace carries requestedChunkSize', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 1500, chars: 25000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline(
    { topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', chunkSize: 10000, files: [file] },
    mockEngine(labels), // no provider budget → the knob alone drives the split
  )
  assert.ok(labels.includes('refine:A#1/3') && labels.includes('refine:A#3/3'), '25,000 字 at 10,000 字/块 → 3 chunk agents')
  assert.equal(r.autoChunk.length, 1, 'one autoChunk record')
  assert.deepEqual(r.autoChunk[0], { label: 'A', contentLength: 25000, parts: 3, requestedChunkSize: 10000 }, 'record carries requestedChunkSize (and no model/budget, since no budgeted provider)')
  assert.equal(r.refined.length, 1)
})

// ---------- resilience: cheap gate agents can't hold the expensive refine hostage ----------

test('refine runs even when scout fails for a file (scout decoupled; surfaced as scoutFailed)', async () => {
  const labels = []
  const files = [
    { path: '/s/A.txt', label: 'A', lines: 500, chars: 5000, title: 'A', subtitle: '*s*', outPath: '/o/Transcripts/A.md' },
    { path: '/s/B.txt', label: 'B', lines: 500, chars: 5000, title: 'B', subtitle: '*s*', outPath: '/o/Transcripts/B.md' },
  ]
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/o', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files }, mockEngine(labels, { fail: (l) => l === 'scout:B' }))
  assert.ok(labels.includes('refine:B'), 'B is still refined despite its scout failing')
  assert.ok(!r.failed.includes('B'), 'a scout failure does not mark the file failed')
  assert.deepEqual(r.scoutFailed, ['B'], 'B surfaced as scoutFailed (glossary degraded, re-scout later)')
  assert.equal(r.refined.length, 2, 'both files refined')
})

test('an unavailable audit (no fs capability, fallback agent fails to parse) is kept on disk but FAILS the run loudly', async () => {
  const labels = []
  const file = { path: '/s/A.txt', label: 'A', lines: 500, chars: 5000, title: 'A', subtitle: '*s*', outPath: '/o/Transcripts/A.md' }
  // No capabilities are injected (CC-sandbox shape), so the audit gate falls back to an agent; the mock returns
  // null for every audit/audit-retry label → the audit is "unavailable".
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/o', scope: ['refine', 'summary'], verifyDepth: 'none', headingPolicy: 'none', files: [file] }, mockEngine(labels, { fail: (l) => l.startsWith('audit') }))
  // The main body is preserved, but a derivative must never treat an unaudited body as final.
  assert.equal(r.refined.length, 1, 'the main transcript is preserved')
  assert.equal(r.summary, null, 'summary is withheld until the body has a valid audit')
  assert.deepEqual(r.derivativesSkipped, [{ kind: 'summary', reason: '正文未完成或忠实性审计未通过' }])
  assert.ok(!labels.some((l) => /^check/.test(l)), 'no separate completeness check phase exists anymore')
  assert.deepEqual(r.unchecked, ['/o/Transcripts/A.md'], 'an unavailable audit still surfaces the file as unchecked')
  assert.deepEqual(r.incomplete, [], 'unavailable ≠ incomplete: an audit that could not run must not be reported as a truncated ending')
  assert.equal(r.failed.length, 0, 'the refine itself succeeded')
  // … but P7: the run is now marked FAILED — an unaudited deliverable is not a passed one.
  assert.deepEqual(r.auditUnavailable, [{ path: '/o/Transcripts/A.md', label: 'A' }], 'the run is marked failed via top-level auditUnavailable')
})

// ---------- resilience: an oversized merged file can't stall the scout (auto-chunked) ----------

test('oversized file: the SCOUT auto-chunks into parallel sub-scouts, merged into one finding', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 4000, chars: 90000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [file] }, mockEngine(labels))
  const subScouts = labels.filter((l) => /^scout:A#\d+\/\d+$/.test(l))
  assert.ok(subScouts.length >= 2, 'the oversized file fanned out into ≥2 sub-scouts (not one whole-file scout)')
  assert.ok(!labels.includes('scout:A'), 'no single whole-file scout agent for the oversized file')
  assert.ok(labels.includes('refine:A'), 'refine still runs, on the merged finding')
  assert.equal(r.refined.length, 1)
  assert.equal(r.scoutFailed.length, 0, 'the merge produced a finding → not scoutFailed')
})

test('oversized file: one sub-scout stalling still yields a partial finding — refine unaffected', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 4000, chars: 90000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [file] }, mockEngine(labels, { fail: (l) => l === 'scout:A#2/5' }))
  assert.ok(labels.includes('refine:A'), 'refine runs')
  assert.equal(r.scoutFailed.length, 0, 'a surviving partial merge is still a finding (the whole scout no longer stalls on one bad chunk)')
  assert.equal(r.refined.length, 1)
})

test('oversized file: if every sub-scout stalls, it degrades to scoutFailed — refine still runs from source', async () => {
  const labels = []
  const file = { path: '/src/A.txt', label: 'A', lines: 4000, chars: 90000, title: 'A', subtitle: '*s*', outPath: '/out/Transcripts/A.md' }
  const r = await runPipeline({ topic: 'X', date: '2025-02', background: 'bg', outputDir: '/out', scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', files: [file] }, mockEngine(labels, { fail: (l) => /^scout:A#/.test(l) }))
  assert.ok(labels.includes('refine:A'), 'refine still runs even when the whole chunked scout fails')
  assert.deepEqual(r.scoutFailed, ['A'], 'all chunks failed → scoutFailed (same graceful path as a single failed scout)')
  assert.equal(r.refined.length, 1)
})

test('mergeScoutChunks：仅空格差异的同名不算冲突（张三 vs 张 三）', () => {
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '张三', output_label_confidence: 'high', output_label_evidence: '开场自我介绍' }] },
    { speakers: [{ label: '说话人 1', output_label: '张 三', output_label_confidence: 'high', output_label_evidence: '对方称呼', identity: '张 三' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.notEqual(m.speakers[0].output_label, '', '同名不同空格不应触发降级')
  assert.equal(m.special_notes.some((n) => n.includes('矛盾')), false)
})

test('mergeScoutChunks：已冲突轨道仍可回填缺失的角色，但不能翻案命名', () => {
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '自我介绍' }] },
    { speakers: [{ label: '说话人 1', output_label: '陈遥', output_label_confidence: 'high', output_label_evidence: '对方称呼' }] },
    { speakers: [{ label: '说话人 1', output_label: '苏澈', output_label_confidence: 'high', output_label_evidence: '再次称呼', role: '受访者' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.equal(m.speakers[0].output_label, '', '冲突后第三个分段不能翻案命名')
  assert.equal(m.speakers[0].role, '受访者', '角色应从后续分段回填')
})

test('mergeScoutChunks + resolver：冲突降级不被 sample 别名记录翻案', () => {
  // 第三个分段把人名当 label、sample 首行指回“说话人 1”——旧逻辑里这条记录会以高分抢回
  // generic:1 的映射，让刚被降级的轨道重新拿到人名。
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '自我介绍' }] },
    { speakers: [{ label: '说话人 1', output_label: '陈遥', output_label_confidence: 'high', output_label_evidence: '对方称呼' }] },
    { speakers: [{ label: '林洄', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '再次称呼', sample: '说话人 1 00:03\n我先说' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  const doc = ['说话人 1 00:01\\', '你好。', '', '说话人 2 00:05\\', '你好。'].join('\n')
  const { mappings } = resolveSpeakerMapping(doc, m.speakers)
  const track1 = mappings.find((x) => x.sourceLabel === '说话人 1')
  assert.notEqual(track1.outputLabel, '林洄', '冲突轨道不能经 sample 别名重新拿到人名')
  assert.notEqual(track1.outputLabel, '陈遥')
})

test('mergeScoutChunks：identity 路径的跨段姓名冲突同样降级（评审复现样本）', () => {
  const parts = [
    { speakers: [{ label: '说话人 1', identity: '张三', output_label: '', output_label_confidence: 'high', output_label_evidence: '开场自我介绍' }] },
    { speakers: [{ label: '说话人 1', identity: '李四', output_label: '', output_label_confidence: 'high', output_label_evidence: '对方称呼' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers.length, 1)
  assert.equal(m.speakers[0].name_conflict, true, 'identity 冲突必须打上冲突标记')
  assert.equal(m.speakers[0].identity, '', '冲突后 identity 必须清空')
  assert.ok(m.special_notes.some((n) => n.includes('张三') && n.includes('李四')), '冲突备注要点名两个候选')
  const doc = ['说话人 1 00:01\\', '你好。', '', '说话人 2 00:05\\', '你好。'].join('\n')
  const { mappings } = resolveSpeakerMapping(doc, m.speakers)
  const track1 = mappings.find((x) => x.sourceLabel === '说话人 1')
  assert.notEqual(track1.outputLabel, '张三', '冲突轨道不能经 identity 拿到人名')
  assert.notEqual(track1.outputLabel, '李四')
})

test('mergeScoutChunks：output_label 与 identity 交叉给名也按同一套解释比较', () => {
  const parts = [
    { speakers: [{ label: '说话人 1', output_label: '张三', output_label_confidence: 'high', output_label_evidence: '开场自我介绍' }] },
    { speakers: [{ label: '说话人 1', identity: '李四', output_label: '', output_label_confidence: 'high', output_label_evidence: '对方称呼' }] },
  ]
  const m = mergeScoutChunks(parts, { lines: 100 })
  assert.equal(m.speakers[0].name_conflict, true)
  const same = [
    { speakers: [{ label: '说话人 1', output_label: '张三', output_label_confidence: 'high', output_label_evidence: '开场自我介绍' }] },
    { speakers: [{ label: '说话人 1', identity: '张三', output_label: '', output_label_confidence: 'high', output_label_evidence: '对方称呼' }] },
  ]
  const m2 = mergeScoutChunks(same, { lines: 100 })
  assert.notEqual(m2.speakers[0].name_conflict, true, '两条路径给出同一个人不算冲突')
})
