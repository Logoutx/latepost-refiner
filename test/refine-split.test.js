import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  splitForRefine, splitForScout, mergeScoutChunks, partPath, stitchParts, contentLength,
  REFINE_CHUNK_CHARS, MAX_REFINE_CHUNKS, SCOUT_CHUNK_CHARS, MAX_SCOUT_CHUNKS,
  renderGlossary, renderRefineGlossary,
  clusterEntities, entityWorth, verifyChunks, suspectUnverified,
} from '../core/spec.js'
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
    assert.equal(chunks.length, 2, `${chars} 字 → 2 chunks (MAX ${MAX_REFINE_CHUNKS})`)
    assertContiguous(chunks, lines)
  }
})

test('speed mode: very large files capped at MAX_REFINE_CHUNKS', () => {
  const chunks = splitForRefine({ lines: 9000, chars: 120000, label: 'A' }, 'speed')
  assert.equal(chunks.length, MAX_REFINE_CHUNKS, 'capped at MAX_REFINE_CHUNKS')
  assertContiguous(chunks, 9000)
})

test('size falls back to bytes, then lines, when chars is absent', () => {
  assert.ok(splitForRefine({ lines: 2000, bytes: 100000, label: 'A' }, 'speed').length >= 2, 'big bytes → chunk')
  assert.equal(splitForRefine({ lines: 50, label: 'A' }, 'speed').length, 1, 'few lines → single')
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
    { speakers: [{ label: '发言人1', role: '受访者' }], people: [{ canonical: '李四' }], brands: [{ canonical: '某品牌' }], terms: [{ canonical: '甲术语' }], errors: [{ kind: '同音字错', examples: ['B'] }], themes: ['收尾'], has_existing_headings: true, ending_anchor: { line: 2000, text: '就到这里。' }, special_notes: ['注二'] },
  ]
  const m = mergeScoutChunks(parts, { lines: 2000 })
  assert.deepEqual(m.speakers.map((s) => s.label), ['记者', '发言人1'], 'speakers unioned, deduped by label')
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
  return {
    agent: async (_p, o) => { labels.push(o.label); return (opts.fail && opts.fail(o.label)) ? null : reply(o.label) },
    parallel: (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all((items || []).map(async (item, i) => {
      let v = item
      for (const s of stages) { try { v = await s(v, item, i) } catch { return null } if (!v) return null }
      return v
    })),
    phase: () => {}, log: () => {},
  }
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
  // Deliverables are PRESERVED (work not destroyed) …
  assert.ok(r.summary, 'the summary deliverable is still produced (work is preserved, just marked unaudited)')
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
