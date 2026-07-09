import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditText, auditPair, auditLogicPair, parseSourceTurns, annotateGaps, scanCoverage, annotateAnchors, sectionRange, normalizeWithMap, parseGlossaryLite, checkQuoteStyle, checkSpeakerLabelStyle, checkGhostName, checkMissingYin, auditGlossary, parseGlossaryEntities, normalizeSrtTranscript } from '../scripts/audit_refined.mjs'

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')

// ---------- output-only audit (cleanliness) ----------

test('hard-fails on leftover filler, confirmation/stutter repeats, and run-on paragraphs', () => {
  const bad = '李明：对对对，嗯，我我觉得是这样。\n\n王某：' + '这是一段很长的独白内容反复说。'.repeat(200)
  const r = auditText(bad, 'bad.md')
  assert.equal(r.status, 'fail')
  const hard = r.findings.filter((f) => f.severity === 'hard' && f.count).map((f) => f.name)
  assert.ok(hard.includes('confirmation_repeats'), '对对对')
  assert.ok(hard.includes('filler_particles'), '嗯')
  assert.ok(hard.includes('stutter_repeats'), '我我')
  assert.equal(r.long_paragraphs.length, 1) // the >900-char monologue
})

test('sentence-final modal particles 啊/哦/欸 and 这个/那个 are soft — they do NOT fail the audit', () => {
  const ok = '李明：太贵了啊。\n\n王某：这个方案我们做过，那个先放放。\n\n李明：哦，明白了。'
  const r = auditText(ok, 'ok.md')
  assert.equal(r.status, 'ok')
  assert.equal(r.hard_issues, 0)
  const soft = r.findings.filter((f) => f.severity === 'soft' && f.count).map((f) => f.name)
  assert.ok(soft.includes('modal_particles'), '啊/哦 surfaced as soft')
  assert.ok(soft.includes('empty_phrase_candidates'), '这个/那个 surfaced as soft')
})

test('headings are skipped and a clean transcript passes', () => {
  const clean = '## 创业初期\n\n李明：我们 2018 年成立。\n\n王某：主要做供应链。'
  const r = auditText(clean, 'clean.md')
  assert.equal(r.status, 'ok')
  assert.equal(r.hard_issues, 0)
})

// ---------- source-aware audit (compression / under-refinement) ----------

test('refine mode hard-fails a compressed (summarized) output, primarily on charRatio', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('compressed.md'), mode: 'refine' })
  assert.equal(r.status, 'fail')
  assert.ok(r.failed.includes('compression_risk'), 'compression_risk fires')
  assert.ok(r.metrics.charRatio < 0.55, `charRatio ${r.metrics.charRatio} below floor`)
})

test('refine mode fails an under-refined output (coverage kept, filler not removed) via emptyReduction', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('under-refined.md'), mode: 'refine' })
  assert.equal(r.status, 'fail')
  assert.ok(r.failed.includes('under_refined'), 'under_refined fires')
  assert.ok(!r.failed.includes('compression_risk'), 'charRatio is high — not compression')
  assert.ok(r.metrics.charRatio >= 0.55, `charRatio ${r.metrics.charRatio} stays high`)
})

test('refine mode passes a faithful, properly-cleaned refine', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('clean.md'), mode: 'refine' })
  assert.equal(r.status, 'ok')
  assert.equal(r.failed.length, 0)
})

test('summary mode does NOT apply the compression gate (a summary is meant to be short)', () => {
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('compressed.md'), mode: 'summary' })
  assert.ok(!r.failed.includes('compression_risk'), 'no compression gate in summary mode')
  assert.equal(r.status, 'ok')
})

test('speakerTurnRatio is reported but never an independent gate (confirming-only)', () => {
  // A faithful refine that merges same-speaker fragments keeps a healthy ratio;
  // even a low ratio must not fail on its own when charRatio is fine.
  const r = auditPair({ sourceText: fixture('source-excerpt.md'), refinedText: fixture('clean.md'), mode: 'refine' })
  assert.equal(typeof r.metrics.speakerTurnRatio, 'number')
  assert.equal(r.status, 'ok')
})

// ---------- content-gap detection (coverage scan) ----------

const covSource = () => fixture('coverage-source.md')

test('parseSourceTurns handles all three label formats with line ranges', () => {
  const ts = parseSourceTurns(covSource()) // 名字 MM:SS format (trailing space in fixture)
  assert.equal(ts.length, 18, '18 turns in the coverage source')
  assert.deepEqual({ speaker: ts[0].speaker, startLine: ts[0].startLine }, { speaker: '记者', startLine: 1 })
  assert.ok(ts[1].text.includes('云舟仪器'), 'content lines attached to the label')
  const bold = parseSourceTurns('**发言人 1 00:03:22**\n大家好，我先说两句。\n\n**发言人 2**\n好的您请讲。')
  assert.deepEqual(bold.map((t) => t.speaker), ['发言人1', '发言人2'], 'bold 发言人 labels, with and without timestamp')
  const inline = parseSourceTurns('张三：今天聊聊供应链。\n李四: 好，从原料说起。')
  assert.deepEqual(inline.map((t) => t.speaker), ['张三', '李四'])
  assert.equal(inline[0].text, '今天聊聊供应链。', 'inline remainder captured as content')
})

const srtSource = () => [
  '1',
  '00:00:01,000 --> 00:00:04,500',
  '发言人 1：我们 2026 年做了 3 次试验，成功率大概 80%，每次都会复盘供应、测试窗口和团队分工，确保下一轮安排更稳。',
  '',
  '2',
  '00:00:05,000 --> 00:00:09,000',
  '发言人 2：后来又增加到 5 台设备，主要覆盖低温、振动和连续运行场景，今天就先聊到这里。',
  '',
].join('\n')

const srtRefined = (tail = '5 台设备') => [
  '# 字幕访谈',
  '',
  '## 开场',
  '',
  '发言人 1：我们 2026 年做了 3 次试验，成功率大概 80%，每次都会复盘供应、测试窗口和团队分工，确保下一轮安排更稳。',
  '',
  `发言人 2：后来又增加到 ${tail}，主要覆盖低温、振动和连续运行场景，今天就先聊到这里。`,
  '',
].join('\n')

test('SRT normalization turns cue blocks into speaker turns without leaking cue/timecode numbers', () => {
  const normalized = normalizeSrtTranscript(srtSource(), { sourceFile: '示例字幕.srt' })
  assert.ok(!/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(normalized), 'raw SRT timecode arrow is not source prose')
  const turns = parseSourceTurns(normalized)
  assert.deepEqual(turns.map((t) => t.speaker), ['发言人1', '发言人2'])
  assert.deepEqual(turns.map((t) => t.ts), ['00:00:01', '00:00:05'])

  const r = auditPair({ sourceText: srtSource(), sourceFile: '示例字幕.srt', refinedText: srtRefined(), mode: 'refine' })
  assert.equal(r.status, 'ok')
  assert.equal(r.findings.find((f) => f.name === 'number_drift').count, 0, 'cue indexes and timestamps do not become drift')
  assert.equal(r.metrics.atoms.sourceNumbers, 4, 'only spoken facts are counted as source numbers')
})

test('SRT source still catches a real spoken-number drift', () => {
  const r = auditPair({ sourceText: srtSource(), sourceFile: '示例字幕.srt', refinedText: srtRefined('6 台设备'), mode: 'refine' })
  const drift = r.findings.find((f) => f.name === 'number_drift')
  assert.ok(drift.count >= 1, 'changed spoken number is still flagged')
  assert.ok(drift.samples.some((s) => s.text.includes('增 5')), 'sample cites the spoken fact, not a timestamp')
})

test('a faithful refine passes coverage despite 数字 conversion, spelling correction, reordering and a small traced fold', () => {
  // The good refined output: strips filler, converts 汉字数字→阿拉伯, corrects 云舟→云洲,
  // moves one section, and folds the tail chit-chat into a stage direction.
  const r = auditPair({ sourceText: covSource(), refinedText: fixture('coverage-refined-good.md'), mode: 'refine' })
  assert.ok(!r.failed.includes('content_gap'), 'no content_gap on a faithful refine')
  assert.equal(r.gaps.filter((g) => g.severity === 'hard').length, 0, 'zero hard gaps')
  assert.ok(r.metrics.coverage.assessed, 'coverage assessed')
  assert.ok(r.metrics.coverage.lostRatio < 0.15, `lostRatio ${r.metrics.coverage.lostRatio} stays low`)
})

test('a silently omitted section hard-fails content_gap with an accurate source line range', () => {
  const r = auditPair({ sourceText: covSource(), refinedText: fixture('coverage-refined-gap.md'), mode: 'refine' })
  assert.ok(r.failed.includes('content_gap'), 'content_gap fires')
  const hard = r.gaps.filter((g) => g.severity === 'hard')
  assert.equal(hard.length, 1, 'exactly one hard gap')
  // ground truth: the omitted 账期 section spans source lines 25–38
  assert.ok(Math.abs(hard[0].startLine - 25) <= 3 && Math.abs(hard[0].endLine - 38) <= 3, `range ${hard[0].startLine}-${hard[0].endLine} ≈ 25-38`)
  assert.ok(hard[0].chars >= 400 && hard[0].turns >= 3, 'meets the hard thresholds')
  assert.equal(hard[0].trace, false, 'no fold trace — the discriminator for silent omission')
  // summary mode never gates on coverage
  const s = auditPair({ sourceText: covSource(), refinedText: fixture('coverage-refined-gap.md'), mode: 'summary' })
  assert.ok(!s.failed.includes('content_gap'), 'summary mode does not gate')
})

test('the same omission WITH a stage-direction fold trace is downgraded to soft (cooperative fold, not censorship)', () => {
  const r = auditPair({ sourceText: covSource(), refinedText: fixture('coverage-refined-fold-long.md'), mode: 'refine' })
  assert.ok(!r.failed.includes('content_gap'), 'traced fold does not gate')
  const g = r.gaps.find((x) => x.startLine >= 20 && x.startLine <= 30)
  assert.ok(g && g.severity === 'soft' && g.trace === true, 'the folded stretch is a soft, traced gap')
})

test('a model-inserted 未精校段 marker is detected and also acts as a fold trace', () => {
  const r = auditPair({ sourceText: covSource(), refinedText: fixture('coverage-refined-model-marker.md'), mode: 'refine' })
  assert.equal(r.modelMarkers.length, 1, 'model marker surfaced')
  assert.ok(r.modelMarkers[0].text.includes('未精校段'))
  assert.ok(!r.failed.includes('content_gap'), 'marker counts as a trace → no hard gate')
  assert.ok(r.findings.some((f) => f.name === 'model_marker' && f.count === 1), 'model_marker finding present')
})

test('annotateGaps inserts the marker at a paragraph boundary, is overlap-idempotent, and preserves CRLF', () => {
  const src = covSource()
  const refined = fixture('coverage-refined-gap.md')
  const r = auditPair({ sourceText: src, refinedText: refined, mode: 'refine' })
  const a1 = annotateGaps(refined, r.gaps)
  assert.equal(a1.inserted.length, 1, 'the hard gap is annotated')
  assert.ok(a1.text.includes('内容缺口：源文件第') && a1.text.includes('请对照源文件人工补回'), 'marker wording')
  const markerLineIdx = a1.text.split('\n').findIndex((l) => l.includes('内容缺口'))
  assert.ok(markerLineIdx > 0 && a1.text.split('\n')[markerLineIdx - 1].trim() === '', 'inserted after a blank line (paragraph boundary)')
  // the marker line is a blockquote → invisible to the output-only audit
  assert.equal(auditText(a1.text).findings.find((f) => f.name === 'confirmation_repeats').count, 0)
  // re-scan + re-annotate: overlap-idempotent (a near-identical range must not double-mark)
  const r2 = auditPair({ sourceText: src, refinedText: a1.text, mode: 'refine' })
  const a2 = annotateGaps(a1.text, r2.gaps.concat([{ ...r.gaps[0], startLine: r.gaps[0].startLine - 1, endLine: r.gaps[0].endLine + 2 }]))
  assert.equal(a2.inserted.length, 0, 'no second insertion')
  assert.ok(a2.skipped.some((s) => s.reason === 'already-marked'), 'skipped as already marked')
  assert.equal((a2.text.match(/内容缺口/g) || []).length, 1, 'still exactly one marker')
  // soft gaps are never annotated
  const soft = annotateGaps(refined, [{ startLine: 5, endLine: 9, turns: 2, chars: 200, severity: 'soft', trace: false }])
  assert.equal(soft.inserted.length, 0)
  assert.equal(soft.skipped[0].reason, 'soft')
  // CRLF preserved
  const crlf = refined.replace(/\n/g, '\r\n')
  const a3 = annotateGaps(crlf, r.gaps)
  assert.ok(a3.text.includes('\r\n') && !/[^\r]\n/.test(a3.text.slice(0, 500)), 'CRLF endings preserved')
})

test('annotateGaps falls back to header block / EOF when a gap has no anchors', () => {
  const doc = '# 标题\n\n*说明行*\n\n记者：只有一段。'
  const noAnchors = annotateGaps(doc, [{ startLine: 3, endLine: 9, turns: 3, chars: 500, severity: 'hard', trace: false, preAnchor: null, postAnchor: null }])
  assert.equal(noAnchors.inserted.length, 1)
  assert.ok(noAnchors.text.trimEnd().endsWith('】'), 'appended at EOF when nothing to anchor on')
  const startGap = annotateGaps(doc, [{ startLine: 1, endLine: 6, turns: 3, chars: 450, severity: 'hard', trace: false, preAnchor: null, postAnchor: { normIdx: 0, line: 5 } }])
  const lines = startGap.text.split('\n')
  const at = lines.findIndex((l) => l.includes('内容缺口'))
  assert.ok(at > 0 && at < lines.length - 1 && lines.findIndex((l) => l.startsWith('记者：')) > at, 'file-start gap lands after the header block, before the body')
})

test('an unparseable source degrades to assessed:false and never gates', () => {
  const r = auditPair({ sourceText: '这是一段没有任何发言人标签的连续文字。\n再来一行还是没有标签。', refinedText: '# 标题\n\n随便的成稿。', mode: 'refine' })
  assert.equal(r.metrics.coverage.assessed, false)
  assert.ok(!r.failed.includes('content_gap'))
  const s = scanCoverage('无标签文字。', '成稿。')
  assert.equal(s.assessed, false)
  assert.deepEqual(s.gaps, [])
})

// ---------- source anchors (provenance: quote → source line → recording timestamp) ----------

test('parseSourceTurns attaches the label timestamp as .ts (raw, precision preserved; null when absent)', () => {
  const ts = parseSourceTurns(covSource())
  assert.equal(ts[0].ts, '00:05', '名字 MM:SS label')
  const bold = parseSourceTurns('**发言人 1 00:03:22**\n大家好，我先说两句。\n\n**发言人 2**\n好的您请讲。')
  assert.equal(bold[0].ts, '00:03:22', 'HH:MM:SS precision preserved')
  assert.equal(bold[1].ts, null, 'no timestamp → null')
})

test('annotateAnchors inverts the coverage scan into per-section source ranges + timestamps (load-bearing)', () => {
  const r = annotateAnchors(covSource(), fixture('coverage-refined-good.md'))
  assert.equal(r.updated.length, 4, 'all four sections anchored')
  const by = Object.fromEntries(r.updated.map((u) => [u.title, u]))
  assert.deepEqual({ s: by['经销商账期与仲裁风波'].startLine, e: by['经销商账期与仲裁风波'].endLine, ts: by['经销商账期与仲裁风波'].ts }, { s: 25, e: 38, ts: '08:00-12:05' })
  assert.deepEqual({ s: by['公司概况'].startLine, e: by['公司概况'].endLine, ts: by['公司概况'].ts }, { s: 1, e: 11, ts: '00:05-02:31' })
  // the REORDERED section (moved to the end of the refined file) still gets its true source range —
  // out-of-source-order and overlapping ranges are allowed by design (anchors follow content)
  assert.deepEqual({ s: by['与进口品牌的差异'].startLine, e: by['与进口品牌的差异'].endLine, ts: by['与进口品牌的差异'].ts }, { s: 19, e: 23, ts: '05:30-05:45' })
  assert.match(r.text, /## 经销商账期与仲裁风波\n<!-- 源 L25-L38 · 08:00-12:05 -->/, 'comment glued directly under the heading')
})

test('a section with zero matched turns gets NO anchor (wrong anchor is worse than none)', () => {
  const withExtra = fixture('coverage-refined-good.md') + '\n## 现场花絮\n\n（现场花絮与合影，从略。）\n'
  const r = annotateAnchors(covSource(), withExtra)
  assert.equal(r.updated.length, 4, 'real sections still anchored')
  assert.ok(r.skipped.some((s) => s.title === '现场花絮' && s.reason === 'no-matched-turns'))
  assert.ok(!/## 现场花絮\n<!-- 源/.test(r.text), 'no comment under the empty section')
})

test('anchors degrade to lines-only when the source has no timestamps, and no-heading files are untouched', () => {
  // strip label timestamps by converting `名字 MM:SS` label lines to inline `名字：` labels
  const noTs = covSource().replace(/^([一-龥A-Za-z]{2,7}) \d{1,2}:\d{2}(?::\d{2})?\s*$/gm, '$1：')
  const r = annotateAnchors(noTs, fixture('coverage-refined-good.md'))
  assert.ok(r.updated.length >= 3, 'sections still anchored via line ranges')
  assert.ok(r.updated.every((u) => u.ts === null), 'no timestamps anywhere')
  assert.match(r.text, /<!-- 源 L\d+-L\d+ -->/, 'lines-only comment format (no ·)')
  const plain = '没有小标题的成稿正文而已。'
  assert.deepEqual(annotateAnchors(covSource(), plain), { text: plain, updated: [], skipped: [] })
})

test('annotateAnchors is idempotent (replace, not duplicate) and coexists with the coverage scan', () => {
  const src = covSource()
  const once = annotateAnchors(src, fixture('coverage-refined-good.md'))
  const twice = annotateAnchors(src, once.text)
  assert.deepEqual(twice.updated, once.updated, 'ranges identical on re-run (source lines are invariant)')
  assert.equal((twice.text.match(/<!-- 源/g) || []).length, 4, 'exactly one comment per section')
  const c1 = scanCoverage(src, fixture('coverage-refined-good.md'))
  const c2 = scanCoverage(src, twice.text)
  assert.equal(c1.turnsLost, c2.turnsLost, 'anchored text scans identically')
  assert.equal(c1.gaps.length, c2.gaps.length)
  // CRLF preserved
  const crlf = annotateAnchors(src, fixture('coverage-refined-good.md').replace(/\n/g, '\r\n'))
  assert.ok(crlf.text.includes('\r\n') && crlf.updated.length === 4)
  // the anchored output stays invisible to the output-only audit
  const a = auditText(once.text)
  assert.equal(a.status, 'ok')
})

test('normalizeWithMap strips HTML comments without shifting the line map', () => {
  assert.equal(normalizeWithMap('## 概况\n<!-- 源 L4-L11 · 00:05-02:31 -->\n正文内容').norm.startsWith('概况正文'), true, '源 does not leak into the norm')
  const multi = normalizeWithMap('<!--\n注释\n-->\n汉字')
  assert.equal(multi.norm, '汉字')
  assert.equal(multi.lineOf[0], 4, 'newlines inside the comment preserved → line map intact')
})

test('sectionRange keeps the largest contiguous source run (outlier bag-matches rejected)', () => {
  const t = (s, e, n = 30) => ({ startLine: s, endLine: e, norm: '字'.repeat(n) })
  const withOutlier = sectionRange([t(4, 5), t(10, 11), t(49, 50)])
  assert.deepEqual({ s: withOutlier.startLine, e: withOutlier.endLine }, { s: 4, e: 11 }, 'stray turn 40 lines away forms its own run and loses')
  const twoRuns = sectionRange([t(4, 5), t(49, 50)])
  assert.deepEqual({ s: twoRuns.startLine, e: twoRuns.endLine }, { s: 4, e: 5 }, 'tie → first run kept')
})

// ---------- editorial deterministic checks (typesetting + glossary residue) ----------
// Rules a prose skill used to self-apply — now hard-coded so they cannot drift per engine. All fixtures
// use fictional names; the ghost-name homophone pair is 陈涛/陈焘 (虚构同音对), per the repo red line.

const covSrc = () => fixture('coverage-source.md')

// A rendered 校对表 in this repo's exact format (- **正字** ← 变体 / 变体 ｜ …), with a ⚠ suspect row and a
// 未能核实 web-verify line. Fictional entities only.
const glossaryText = [
  '# 示例项目 统一校对表（采访时间 2025-05）',
  '',
  '## 人名（写法 → 统一）',
  '- **陈焘** ← 陈涛 / 陈韬 ｜ 示例公司创始人',
  '- **周砚** ← — ｜ 受访者 ｜ ⚠ 侦察疑为转录误写、未能核实——请人工确认正确写法',
  '',
  '## 品牌 / 公司 / 产品（写法 → 统一）',
  '- **云洲仪器** ← 云舟仪器 / 云舟',
  '',
  '## 联网核实结论（已采纳的已应用到上表正文；标 ⚠ 的与正文强名冲突、未采纳，待人工确认）',
  '- 蓝湖科技：未能核实，保留（音） ｜ 无公开信息',
].join('\n')

test('quote_style: ASCII 直引号紧贴 CJK hard-fails, pure-English quotes do NOT, and 「」『』 hard-fails', () => {
  // CJK-adjacent ASCII quote → hard
  const bad = '## 标题\n\n周砚：他说"这个太贵"，我不认同。'
  const qf = checkQuoteStyle(bad).find((f) => f.name === 'quote_style')
  assert.equal(qf.severity, 'hard')
  assert.ok(qf.count >= 1, 'CJK-adjacent straight quote fires')
  assert.equal(qf.samples[0].line, 3, 'sample carries the body line number')
  // via auditPair the hard finding opens the quote_style gate → status fail
  const src = '记者 00:05\n你好。\n\n周砚 00:12\n我们的检测设备卖给电子厂客户很多在苏州团队规模一百多人营收八千万。'
  const paired = auditPair({ sourceText: src, refinedText: bad, mode: 'refine' })
  assert.ok(paired.failed.includes('quote_style'), 'quote_style is a gate')
  assert.equal(paired.status, 'fail')

  // pure-English quotes with non-CJK neighbours → NOT reported (it's fine / "ok" surrounded by spaces)
  const ok = '## 标题\n\n周砚：产品线叫 "Aurora" 系列，我们觉得 it\'s fine 就行。'
  assert.equal(checkQuoteStyle(ok).find((f) => f.name === 'quote_style').count, 0, 'English-internal quotes ignored')

  // 直角引号 → hard
  const corner = '## 标题\n\n周砚：他说「这个太贵」也说『再等等』。'
  const cf = checkQuoteStyle(corner).find((f) => f.name === 'quote_style')
  assert.equal(cf.severity, 'hard')
  assert.ok(cf.count >= 2, '「」『』 all flagged')
})

test('quote_style: inline code / URLs / code fences do not trip the straight-quote check', () => {
  const doc = [
    '## 代码',
    '',
    '```',
    '周砚："这段在围栏里不算正文"',
    '```',
    '',
    '周砚：命令是 `grep "x" file` 参见 https://example.com/a?q="b" 就好。',
  ].join('\n')
  assert.equal(checkQuoteStyle(doc).find((f) => f.name === 'quote_style').count, 0, 'fenced code, inline code and URL quotes all skipped')
})

test('quote_style (SF-4): a markdown-link title with CJK-adjacent ASCII quotes does NOT fire; a real body straight quote still does', () => {
  // The link title "行业惯例" puts ASCII quotes hugging CJK — but it is inside the ](...) target+title segment,
  // which is masked before scanning, so it must NOT be flagged.
  const link = '## 出处\n\n周砚：详见 [报告](https://example.com/a "行业惯例") 里的口径说明。'
  assert.equal(checkQuoteStyle(link).find((f) => f.name === 'quote_style').count, 0, 'a CJK link title is masked, not flagged')
  // A genuine straight quote in the prose still fires (the masking is scoped to the link segment only).
  const real = '## 出处\n\n周砚：他说"这个太贵"，详见 [报告](https://example.com/a "行业惯例")。'
  assert.ok(checkQuoteStyle(real).find((f) => f.name === 'quote_style').count >= 1, 'a real prose straight quote still fires alongside a masked link title')
})

test('quote_density_low: a long body with zero 弯引号 emits a soft hint (never a gate)', () => {
  const many = Array.from({ length: 205 }, (_, i) => `周砚：这是第 ${i} 段正文没有任何引号内容。`).join('\n\n')
  const f = checkQuoteStyle(many).find((x) => x.name === 'quote_density_low')
  assert.ok(f && f.severity === 'soft' && f.count === 1, 'soft density hint present past 200 body lines')
  // short docs never emit it
  assert.ok(!checkQuoteStyle('周砚：短稿一句话。').some((x) => x.name === 'quote_density_low'), 'short body: no density hint')
})

test('parseGlossaryLite reads canonical/variants and unverified names from the repo glossary format', () => {
  const g = parseGlossaryLite(glossaryText)
  const by = Object.fromEntries(g.entries.map((e) => [e.canonical, e.variants]))
  assert.deepEqual(by['陈焘'], ['陈涛', '陈韬'], 'variants split on / under 人名')
  assert.deepEqual(by['云洲仪器'], ['云舟仪器', '云舟'], 'brand section parsed too')
  assert.deepEqual(by['周砚'], [], '— means no variants')
  assert.ok(g.unverified.includes('周砚'), '⚠ suspect canonical marked unverified')
  assert.ok(!g.unverified.includes('蓝湖科技'), 'unresolved brand rows do not force （音） markers')
  assert.deepEqual(parseGlossaryLite(null), { entries: [], unverified: [] }, 'no glossary → empty')
})

test('ghost_name: a corrected-away variant left in the prose fires soft; canonical use does not; no glossary skips', () => {
  const g = parseGlossaryLite(glossaryText)
  const withGhost = '## 概况\n\n记者：你和陈涛是怎么认识的？\n\n周砚：我们把名字写成云舟了。'
  const f = checkGhostName(withGhost, g)
  assert.equal(f.severity, 'soft')
  assert.equal(f.count, 2, '陈涛 variant + 云舟 variant both caught')
  assert.ok(f.samples.some((s) => s.text.includes('陈焘')), 'sample names the canonical it should have been')
  // canonical spellings only → clean
  const clean = '## 概况\n\n记者：你和陈焘是怎么认识的？\n\n周砚：正确写法是云洲仪器。'
  assert.equal(checkGhostName(clean, g).count, 0, 'canonical use is not a ghost')
  // overlap guard: a variant that is a substring of its canonical must not fire on the canonical
  const g2 = parseGlossaryLite('## 人名（写法 → 统一）\n- **陈焘明** ← 陈焘')
  assert.equal(checkGhostName('周砚：这位是陈焘明先生。', g2).count, 0, 'canonical 陈焘明 does not count as stray 陈焘')
  assert.equal(checkGhostName('周砚：另一位叫陈焘，不是陈焘明。', g2).count, 1, 'a bare 陈焘 still fires despite the substring guard')
  // no glossary → silently skipped
  assert.equal(checkGhostName(withGhost, parseGlossaryLite(null)).count, 0, 'no glossary → no ghost check')
})

test('missing_yin: a ⚠/未能核实 name written bare fires soft; with （音） it does not; no glossary skips', () => {
  const g = parseGlossaryLite(glossaryText)
  const bare = '## 概况\n\n记者：周砚您好，请介绍一下蓝湖科技。'
  const f = checkMissingYin(bare, g)
  assert.equal(f.severity, 'soft')
  assert.equal(f.count, 1, 'only uncertain people need （音）; unresolved brands stay review-only')
  const annotated = '## 概况\n\n记者：周砚（音）您好，请介绍一下蓝湖科技。'
  assert.equal(checkMissingYin(annotated, g).count, 0, '（音 on the line clears it')
  assert.equal(checkMissingYin(bare, parseGlossaryLite(null)).count, 0, 'no glossary → skipped')
})

test('missing_yin ignores warning marks that are not unresolved person spellings', () => {
  const g = parseGlossaryLite([
    '## 人名',
    '- **林湛** ← — ｜ ⚠ 联网核实给出“林湛之”，与本条强名不符，未采用',
    '## 术语 / 专名',
    '- **薄壁铝合金** ← 铝合金 ｜ ⚠ 侦察疑为转录误写、未能核实',
    '',
    '## 联网核实结论',
    '- 薄壁铝合金：未能核实，保留（音）',
  ].join('\n'))
  const f = checkMissingYin('方岑：林湛谈过薄壁铝合金。', g)
  assert.equal(f.count, 0)
})

test('speaker_label_style: mixing 名字 12:34 and 名字： each ≥3 times fires soft; a uniform file does not', () => {
  const mixed = [
    '周砚 00:12', '这是带时间戳的第一段内容。',
    '记者 00:20', '这是带时间戳的第二段内容。',
    '周砚 00:35', '这是带时间戳的第三段内容。',
    '记者：换成冒号风格的第一句。',
    '周砚：换成冒号风格的第二句。',
    '记者：换成冒号风格的第三句。',
  ].join('\n')
  const f = checkSpeakerLabelStyle(mixed)[0]
  assert.equal(f.severity, 'soft')
  assert.ok(f.count >= 6, 'both styles counted')
  assert.equal(f.samples.length, 4, 'two samples of each shape')
  // uniform colon-only file → no mix
  const uniform = ['周砚：一。', '记者：二。', '周砚：三。', '记者：四。', '周砚：五。'].join('\n')
  assert.equal(checkSpeakerLabelStyle(uniform)[0].count, 0, 'single style → not flagged')
})

test('logic_size_sanity: 逻辑稿 > 成稿×1.10 fires; a duplicated long line fires; a normal draft passes', () => {
  const refined = '正文内容' .repeat(60)            // 240 汉字
  // bloat: 逻辑稿 well past 1.10×
  const bloated = '正文内容'.repeat(80)              // 320 汉字 → 1.33×
  const r1 = auditLogicPair(refined, bloated)
  assert.equal(r1.mode, 'logic')
  assert.equal(r1.status, 'ok', 'logic findings are soft — never a fail')
  const sz = r1.findings.find((f) => f.name === 'logic_size_sanity')
  assert.ok(sz.severity === 'soft' && sz.count === 1, 'size gate fires soft')
  assert.ok(r1.metrics.sizeRatio > 1.10, `ratio ${r1.metrics.sizeRatio}`)
  // duplicated long paragraph (≥25 CJK chars, identical, twice)
  const line = '这是一段用于测试重复段检测的足够长的完全相同的句子内容确保超过二十五个汉字。'
  const dupLogic = `## 导读\n\n${line}\n\n中间隔一段短的。\n\n${line}`
  const dupF = auditLogicPair('正文内容'.repeat(200), dupLogic).findings.find((f) => f.name === 'logic_duplicate_para')
  assert.ok(dupF.count === 1 && dupF.samples[0].text.includes('重复长行'), 'duplicate long line reported with line numbers')
  // normal: small growth, no dups → both clean
  const normal = '正文内容'.repeat(63)              // 252 → 1.05×
  const r2 = auditLogicPair(refined, `## 导读\n\n${normal}`)
  assert.equal(r2.findings.find((f) => f.name === 'logic_size_sanity').count, 0, 'within tolerance')
  assert.equal(r2.findings.find((f) => f.name === 'logic_duplicate_para').count, 0, 'no duplicates')
})

const logicSections = ['创业起点', '客户变化', '产品迭代', '渠道调整', '供应协同', '组织搭建']
function makeLogicFixture(order = logicSections, provenance = logicSections) {
  const body = (title) => [
    `记者：请讲讲${title}这件事的背景。`,
    `受访者：${title}里面有一个关键事实，我们当时先做内部验证，再和外部客户逐步确认。`,
    `记者：这个变化对公司节奏有什么影响？`,
    `受访者：影响主要体现在交付节奏、团队分工和后续复盘上，每一步都有明确责任人。`,
  ].join('\n\n')
  const refined = [
    '# 示例访谈',
    '*测试项目访谈精校稿*',
    '',
    ...logicSections.flatMap((title) => [`## ${title}`, '', body(title), '']),
  ].join('\n')
  const logic = [
    '# 示例访谈 · 逻辑顺序稿',
    '*基于精校稿重排为叙事顺序，内容照搬未改，仅调顺序。*',
    '',
    '## 主线脉络（导读）',
    '',
    '这份稿件按主线重排。',
    '',
    ...order.flatMap((title) => [`## ${title}`, `*〔取自精校稿：${provenance.includes(title) ? title : provenance[0]}〕*`, '', body(title), '']),
  ].join('\n')
  return { refined, logic }
}

test('auditLogicPair hard-fails a fake logic draft that keeps the refined order', () => {
  const { refined, logic } = makeLogicFixture()
  const r = auditLogicPair(refined, logic)
  assert.equal(r.status, 'fail')
  assert.ok(r.failed.includes('logic_order_unchanged'), 'same-order copy is a hard logic failure')
  assert.ok(r.metrics.sameOrderRatio > 0.85, `sameOrderRatio ${r.metrics.sameOrderRatio}`)
})

test('auditLogicPair passes a real reorder with full provenance', () => {
  const { refined, logic } = makeLogicFixture(['产品迭代', '创业起点', '供应协同', '客户变化', '组织搭建', '渠道调整'])
  const r = auditLogicPair(refined, logic)
  assert.equal(r.status, 'ok')
  assert.ok(!r.failed.includes('logic_order_unchanged'))
  assert.equal(r.metrics.missingSections, 0)
})

test('auditLogicPair accepts provenance titles that contain Chinese separators', () => {
  const titles = ['供应链、IPO 与发射传播口径', '可靠性、未知与工程师心态', '远星航天、星舟与可复用标杆']
  const refined = [
    '# 示例访谈',
    '',
    ...titles.flatMap((title) => [
      `## ${title}`,
      '',
      `记者：请讲讲${title}。`,
      `受访者：${title}这里有一组事实，需要完整保留。`,
      '',
    ]),
  ].join('\n')
  const logic = [
    '# 示例访谈 · 逻辑顺序稿',
    '',
    '## 主线脉络（导读）',
    '',
    '这份稿件按主线重排。',
    '',
    `## ${titles[2]}`,
    `*〔取自精校稿：${titles[2]}、${titles[0]}、${titles[1]}〕*`,
    '',
    ...[titles[2], titles[0], titles[1]].flatMap((title) => [
      `记者：请讲讲${title}。`,
      `受访者：${title}这里有一组事实，需要完整保留。`,
      '',
    ]),
  ].join('\n')
  const r = auditLogicPair(refined, logic)
  assert.equal(r.status, 'ok')
  assert.equal(r.metrics.missingSections, 0)
})

test('auditLogicPair hard-fails logic drafts that omit refined section provenance', () => {
  const { refined, logic } = makeLogicFixture(['产品迭代', '创业起点', '供应协同', '客户变化', '组织搭建', '渠道调整'])
  const missingProvenance = logic.replace('*〔取自精校稿：渠道调整〕*', '*〔取自精校稿：组织搭建〕*')
  const r = auditLogicPair(refined, missingProvenance)
  assert.equal(r.status, 'fail')
  assert.ok(r.failed.includes('logic_section_coverage'))
})

test('auditPair threads a glossary into ghost_name / missing_yin and stays silent without one', () => {
  const src = covSrc()
  const refined = fixture('coverage-refined-good.md')
  // no glossary passed → both checks present but zero
  const bare = auditPair({ sourceText: src, refinedText: refined, mode: 'refine' })
  assert.ok(bare.findings.some((f) => f.name === 'ghost_name' && f.count === 0), 'ghost_name dormant without glossary')
  assert.ok(bare.findings.some((f) => f.name === 'missing_yin' && f.count === 0), 'missing_yin dormant without glossary')
  // inject a variant (云舟) into the refined text and pass the glossary → ghost_name lights up
  const dirtied = refined.replace('云洲仪器是 2019', '云舟仪器是 2019')
  const withG = auditPair({ sourceText: src, refinedText: dirtied, mode: 'refine', glossaryText })
  const gf = withG.findings.find((f) => f.name === 'ghost_name')
  assert.ok(gf.count >= 1, 'variant residue caught when glossary supplied')
  assert.equal(gf.severity, 'soft', 'ghost_name is soft — does not fail the pair')
})

// ---------- 校对表 structural lint (E13) ----------

// A healthy glossary: ≥3 人名/品牌 rows, all with an identity hint, most with variants.
const healthyGlossary = [
  '# 示例项目 统一校对表（采访时间 2025-05）',
  '',
  '## 人名（写法 → 统一）',
  '- **陈焘** ← 陈涛 / 陈韬 ｜ 示例公司创始人 ｜ 多份互证',
  '- **周砚** ← 周研 ｜ 产品负责人 ｜ 〔核实·2025-05〕',
  '- **林越** ← 林悦 ｜ 早期投资人',
  '',
  '## 品牌 / 公司 / 产品（写法 → 统一）',
  '- **云洲仪器** ← 云舟仪器 / 云舟 ｜ 自家公司',
  '- **青萍资本** ← 青苹资本 ｜ A 轮领投方',
  '',
  '## 术语 / 专名（写法 → 统一）',
  '- **边缘计算** ← — ｜ 技术方向',   // term row: must NOT be counted by the lint
].join('\n')

const grep = (r, name) => r.findings.find((f) => f.name === name)

test('parseGlossaryEntities reads 人名/品牌 rows, splits hint from markers, and excludes 术语', () => {
  const es = parseGlossaryEntities(healthyGlossary)
  assert.equal(es.length, 5, '3 people + 2 brands; the 术语 row is excluded')
  assert.equal(es.filter((e) => e.section === 'person').length, 3)
  assert.equal(es.filter((e) => e.section === 'brand').length, 2)
  const chen = es.find((e) => e.canonical === '陈焘')
  assert.ok(chen.hasVariants && chen.hasHint, '陈焘: variants + hint (多份互证 is not the hint)')
  // 多份互证 / 〔核实〕 must not be mistaken for an identity hint
  const withOnlyMarkers = parseGlossaryEntities('## 人名（写法 → 统一）\n- **甲** ← 乙 ｜ 多份互证 ｜ 〔核实·2025-05〕')
  assert.equal(withOnlyMarkers[0].hasHint, false, 'cross-file/confidence markers are not hints')
  assert.equal(withOnlyMarkers[0].hasVariants, true, 'but the variant is still recorded')
  // — / （无变体） / empty all mean "no variant"
  assert.equal(parseGlossaryEntities('## 人名（写法 → 统一）\n- **丙** ← — ｜ 某身份')[0].hasVariants, false)
  assert.deepEqual(parseGlossaryEntities(null), [], 'null → empty')
  // renderGlossary appends the 〔核实〕 confidence marker onto the LAST segment, so a crossFile-but-hintless
  // row reads `← v ｜ 多份互证 〔核实·2025-05〕` — the marker must be peeled so this counts as NO hint.
  const crossOnly = parseGlossaryEntities('## 人名（写法 → 统一）\n- **甲** ← 乙 ｜ 多份互证 〔核实·2025-05〕')
  assert.equal(crossOnly[0].hasHint, false, '多份互证 + confidence marker is not an identity hint')
  // …but a real hint that happens to carry a trailing confidence marker still counts as a hint
  const hintPlusMark = parseGlossaryEntities('## 人名（写法 → 统一）\n- **甲** ← 乙 ｜ 创始人 〔核实·2025-05〕')
  assert.equal(hintPlusMark[0].hasHint, true, 'a real hint with a trailing marker is still a hint')
})

test('auditGlossary: a healthy table fires no warnings and reports the right metrics', () => {
  const r = auditGlossary(healthyGlossary)
  assert.equal(r.status, 'ok', 'all soft → status stays ok')
  assert.equal(r.metrics.entities, 5)
  assert.equal(r.metrics.people, 3)
  assert.equal(r.metrics.brands, 2)
  assert.equal(r.metrics.hintRatio, 1, 'every counted row has a hint')
  assert.equal(grep(r, 'glossary_thin').count, 0)
  assert.equal(grep(r, 'glossary_hints_sparse').count, 0)
  assert.equal(grep(r, 'glossary_variants_sparse').count, 0)
})

test('auditGlossary: a thin table (<3 entities) fires glossary_thin and skips the ratio warnings', () => {
  const thin = '## 人名（写法 → 统一）\n- **陈焘** ← 陈涛 ｜ 创始人\n- **周砚** ← 周研 ｜ 负责人'
  const r = auditGlossary(thin)
  assert.equal(grep(r, 'glossary_thin').count, 1, '2 < MIN_ENTITIES(3)')
  assert.ok(grep(r, 'glossary_thin').samples[0].text.includes('2 条'), 'sample states the count')
  // ratio warnings are not even emitted below the entity floor (a proportion over <3 rows is meaningless)
  assert.equal(grep(r, 'glossary_hints_sparse'), undefined, 'no hint-ratio warning below the floor')
  assert.equal(grep(r, 'glossary_variants_sparse'), undefined, 'no variant-ratio warning below the floor')
})

test('auditGlossary: enough rows but few identity clues → glossary_hints_sparse (only)', () => {
  // 4 people, only 1 with a hint (25% < 50%); all have variants so the variant warning stays quiet
  const g = [
    '## 人名（写法 → 统一）',
    '- **陈焘** ← 陈涛 ｜ 创始人',   // hint
    '- **周砚** ← 周研',            // no hint
    '- **林越** ← 林悦',            // no hint
    '- **顾岚** ← 顾兰',            // no hint
  ].join('\n')
  const r = auditGlossary(g)
  assert.equal(grep(r, 'glossary_thin').count, 0, '4 ≥ floor')
  assert.equal(grep(r, 'glossary_hints_sparse').count, 1, '25% < HINT_RATIO_MIN')
  assert.equal(grep(r, 'glossary_variants_sparse').count, 0, 'all four have variants')
  assert.equal(r.metrics.hintRatio, 0.25)
})

test('auditGlossary: enough rows but almost no variants → glossary_variants_sparse (only)', () => {
  // 4 rows, all with hints, none with variants (0% < 30%)
  const g = [
    '## 人名（写法 → 统一）',
    '- **陈焘** ← — ｜ 创始人',
    '- **周砚** ← — ｜ 负责人',
    '- **林越** ← — ｜ 投资人',
    '- **顾岚** ← — ｜ 顾问',
  ].join('\n')
  const r = auditGlossary(g)
  assert.equal(grep(r, 'glossary_hints_sparse').count, 0, 'all have hints')
  assert.equal(grep(r, 'glossary_variants_sparse').count, 1, '0% < VARIANT_RATIO_MIN')
  assert.equal(r.metrics.variantRatio, 0)
})

test('auditGlossary: empty / entity-less input reports 0 entities and only glossary_thin', () => {
  for (const empty of ['', null, undefined, '# 校对表\n\n## 采访背景\n- 时间：2025-05']) {
    const r = auditGlossary(empty)
    assert.equal(r.metrics.entities, 0, 'no entities parsed')
    assert.equal(grep(r, 'glossary_thin').count, 1, 'empty table is thin')
    assert.equal(r.status, 'ok', 'still never fails')
    assert.equal(grep(r, 'glossary_hints_sparse'), undefined, 'no ratio warning with zero rows')
  }
})
