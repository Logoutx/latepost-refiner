import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditText, auditPair, parseSourceTurns, annotateGaps, scanCoverage, annotateAnchors, sectionRange, normalizeWithMap } from '../scripts/audit_refined.mjs'

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
