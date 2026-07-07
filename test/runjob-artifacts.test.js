import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runJob } from '../universal/jobs.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-runjob-'))
}

function mockEngine() {
  const usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {},
    log() {},
    usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async () => [],
    agent: async (_prompt, opts = {}) => {
      usage.agents++
      if (opts.label && opts.label.startsWith('refine:')) {
        return { path: 'unused.md', headings: ['## 开场'], key_fixes: [], open_questions: ['确认受访者姓名'] }
      }
      return null
    },
  }
}

// A source whose distinctive last sentence the refine will DROP, so the deterministic audit's ending_missing
// gate fires → the file lands in `incomplete`. The omitted tail is a single short closing turn (well under the
// content_gap single-turn threshold), so ending_missing is the only finding — no hard content_gap, no marker.
const TRUNC_SOURCE = [
  '采访者：先请你介绍一下自己。',
  '受访者：我在一家虚构的工业检测公司做研发，入行差不多十年了，主要负责视觉算法这一块。',
  '采访者：这些年最大的变化是什么？',
  '受访者：客户从只看价格，变成开始认真评估检测精度和交付周期，这对我们其实是好事。',
  '采访者：好的，那今天就先聊到这里，非常感谢你抽空接受这次访谈。',
].join('\n') + '\n'

// The refined output faithfully covers everything EXCEPT the closing "今天就先聊到这里，非常感谢……" line.
const TRUNC_REFINED = [
  '# tiny',
  '*测试项目访谈*',
  '',
  '## 开场',
  '',
  '采访者：先请你介绍一下自己。',
  '',
  '受访者：我在一家虚构的工业检测公司做研发，入行差不多十年了，主要负责视觉算法这一块。',
  '',
  '采访者：这些年最大的变化是什么？',
  '',
  '受访者：客户从只看价格，变成开始认真评估检测精度和交付周期，这对我们其实是好事。',
  '',
].join('\n')

function truncatedEndingEngine() {
  const usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    // Single short file → one-pass branch → runJob refines via a `refine:` agent (not the pipeline stage).
    // The agent reports success; the test pre-writes the 成稿 on disk for the deterministic audit to read.
    agent: async (_prompt, opts = {}) => {
      usage.agents++
      if (opts.label && opts.label.startsWith('refine:')) {
        return { path: 'unused.md', headings: ['## 开场'], key_fixes: [], open_questions: ['确认受访者姓名'] }
      }
      return null
    },
  }
}

test('runJob writes review queue and manifest artifacts (deterministic audit ending_missing → incomplete)', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, 'tiny-src.md')
  fs.writeFileSync(src, TRUNC_SOURCE, 'utf8')
  // Pre-write the refined output that the one-pass refine agent "produces" (the injected engine reports success
  // but does not itself write a 成稿; the deterministic audit reads this file from disk and detects the dropped ending).
  const outPath = path.join(outputDir, 'Transcripts', 'tiny-src.md')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, TRUNC_REFINED, 'utf8')

  const result = await runJob({
    __engine: truncatedEndingEngine(),
    files: [{ path: src }],
    topic: '测试项目',
    date: '2026-06',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    anchors: false, // keep the pre-written 成稿 byte-stable so the ending check reads exactly what we wrote
  })

  assert.equal(result.provider, 'injected')
  assert.equal(fs.existsSync(result.reviewPath), true)
  assert.equal(fs.existsSync(result.manifestPath), true)

  // Completeness now comes from the deterministic source-aware audit (ending_missing), not a haiku check agent.
  assert.equal(result.incomplete.length, 1, 'the dropped ending is caught by the deterministic audit')
  assert.match(result.incomplete[0].note, /ending_missing/)

  const review = fs.readFileSync(result.reviewPath, 'utf8')
  assert.match(review, /疑似中途截断，需要检查结尾/)
  assert.match(review, /确认受访者姓名/)

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.config.topic, '测试项目')
  assert.equal(manifest.config.files.length, 1)
  assert.equal(manifest.artifacts.reviewPath, result.reviewPath)
  assert.equal(manifest.result.incomplete.length, 1)
})

// End-to-end content-gap annotation: the injected engine "refines" by writing an output that omits a
// whole source section (the coverage fixtures) — runJob's audit must detect the hard gap and insert a
// visible 内容缺口 marker into the refined file; --no-annotate (annotate:false) must leave it untouched.
import { fileURLToPath as f2p } from 'node:url'
const covFixture = (name) => fs.readFileSync(f2p(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')

function gapEngine() {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    // The refine stage: write a refined output that silently omits the 账期 section.
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, covFixture('coverage-refined-gap.md'))
      return { path: f.outPath, headings: ['## 公司概况'], key_fixes: [], open_questions: [] }
    }),
    agent: async () => { usage.agents++; return null }, // scouts/checks fail → resilience paths, refine unaffected
  }
}

async function runGapJob(extra = {}) {
  const outputDir = tmpdir()
  const src64 = Buffer.from(covFixture('coverage-source.md')).toString('base64')
  return runJob({
    __engine: gapEngine(),
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }], // 2 files → multi-file branch
    topic: '缺口测试', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    ...extra,
  })
}

test('runJob detects a hard content gap, annotates the 成稿, and records it in the manifest', async () => {
  const result = await runGapJob()
  assert.ok(result.audit.files.some((f) => f.failed.includes('content_gap')), 'audit gates content_gap')
  assert.ok(result.annotations.length >= 1, 'annotation happened')
  const annotated = fs.readFileSync(result.annotations[0].path, 'utf8')
  assert.match(annotated, /内容缺口：源文件第 \d+-\d+ 行/, 'visible marker inserted into the refined file')
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.ok(manifest.audit.files[0].gaps.length >= 1, 'gaps in run.json')
  assert.ok(manifest.annotations.length >= 1, 'annotations in run.json')
  assert.match(fs.readFileSync(result.reviewPath, 'utf8'), /内容缺口/, 'review.md surfaces the gap')
  // source anchors ran on the same pass: sections carry <!-- 源 … --> comments, manifest records them
  assert.ok(result.anchors.length >= 1, 'anchors attached to the result')
  assert.match(fs.readFileSync(result.anchors[0].path, 'utf8'), /<!-- 源 L\d+-L\d+/, 'anchor comment in the 成稿')
  assert.ok(manifest.anchors.length >= 1 && manifest.anchors[0].sections >= 1, 'anchors in run.json')
})

test('annotate:false leaves the refined files untouched (still audited and reported)', async () => {
  const result = await runGapJob({ annotate: false })
  assert.ok(result.audit.files.some((f) => f.failed.includes('content_gap')), 'still gated')
  assert.equal(result.annotations.length, 0, 'no annotations written')
  for (const f of result.refined) {
    assert.ok(!fs.readFileSync(f.outPath || f.path, 'utf8').includes('内容缺口'), 'no marker in file')
  }
})

// §2: with fs (Universal), jobs.js injects runAudit/annotate/annotateAnchors but NOT repair — so a hard
// content_gap that jobs can't auto-fix surfaces as result.auditFailed (→ non-zero CLI exit) and each refined
// entry carries an audit summary. This is the in-pipeline gate replacing the old post-run wrapper.
test('runJob surfaces an un-repairable hard gap as auditFailed and attaches a per-file audit summary', async () => {
  const result = await runGapJob()
  assert.ok((result.auditFailed || []).length >= 1, 'a still-hard gap is recorded in auditFailed')
  assert.ok(result.auditFailed.every((x) => x.findings.includes('content_gap')), 'the finding is content_gap')
  const r0 = result.refined.find((r) => (result.auditFailed[0].path === (r.outPath || r.path)))
  assert.ok(r0 && r0.audit && r0.audit.status === 'fail', 'the refined entry carries audit.status=fail')
  assert.equal(r0.audit.repaired, false, 'no repair capability injected in the Universal path → not repaired')
})

// A clean refine (no gap) must not populate auditFailed, and each refined entry gets audit.status='ok'.
function cleanEngine() {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, covFixture('coverage-refined-good.md'))
      return { path: f.outPath, headings: ['## 公司概况'], key_fixes: [], open_questions: [] }
    }),
    agent: async () => { usage.agents++; return null },
  }
}

test('runJob: a faithful refine leaves auditFailed empty and marks each entry audit ok', async () => {
  const outputDir = tmpdir()
  const src64 = Buffer.from(covFixture('coverage-source.md')).toString('base64')
  const result = await runJob({
    __engine: cleanEngine(),
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }],
    topic: '干净测试', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
  })
  assert.deepEqual(result.auditFailed, [], 'no hard findings → auditFailed empty')
  assert.ok(result.refined.every((r) => r.audit && r.audit.status === 'ok'), 'every refined entry audited ok')
  assert.ok((result.anchors || []).length >= 1, 'anchors still ran on the clean 成稿')
})

// §1 + §4 through runJob: canonicalOverrides reach the pipeline (glossary carries 〔用户钦定〕) and an explicit
// priorGlossaryPath seeds the cumulative glossary. The engine's scout reports 王总; the decree forces 王志远.
function overrideEngine() {
  return {
    phase() {}, log() {}, usage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    // The refine stage writes a small clean 成稿 so the in-pipeline audit passes.
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, `# ${f.title}\n${f.subtitle}\n\n## 某节\n记者：请介绍一下。\n\n王志远：我们做工业检测，这是虚构样本。\n`)
      return { path: f.outPath, headings: ['某节'], key_fixes: [], open_questions: [] }
    }),
    agent: async (_p, o) => {
      if (/^scout/.test(o.label)) return { speakers: [{ label: '记者', role: '记者' }], people: [{ canonical: '王总', variants: [], hint: '受访者' }], brands: [], terms: [], errors: [], themes: [], ending_anchor: { line: 2, text: '虚构样本。' }, special_notes: [] }
      return null // dedup/verify/audit-agent → null (audit uses the injected capability, not an agent)
    },
  }
}

test('runJob threads canonicalOverrides + an explicit priorGlossaryPath into the pipeline', async () => {
  const inputDir = tmpdir()
  const outputDir = tmpdir()
  const src = path.join(inputDir, '访谈.md')
  const src2 = path.join(inputDir, '访谈2.md')
  fs.writeFileSync(src, '记者：请介绍一下。\n王总：我们做工业检测。虚构样本，内容足够长以走多份分支。\n', 'utf8')
  fs.writeFileSync(src2, '记者：再聊聊渠道。\n王总：渠道这块也在铺。虚构样本第二份。\n', 'utf8')
  const priorPath = path.join(inputDir, '外部校对表.md')
  fs.writeFileSync(priorPath, ['# 示例公司 统一校对表（采访时间 2025-01）', '', '## 人名（写法 → 统一）', '- **沈其安** ← 沈总 ｜ 创始人 〔核实·2025-01〕'].join('\n'), 'utf8')

  const result = await runJob({
    __engine: overrideEngine(),
    files: [{ path: src }, { path: src2 }], // 2 files → multi-file (scout/verify/refine) branch
    topic: '示例公司', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    priorGlossaryPath: priorPath,
    canonicalOverrides: [{ canonical: '王志远', variants: ['王总'] }],
  })
  assert.ok(result.glossary.includes('王志远') && result.glossary.includes('用户钦定'), 'the decree landed as 〔用户钦定〕')
  assert.ok(result.glossary.includes('沈其安'), 'the explicit priorGlossaryPath seeded the cumulative glossary')
})

test('runJob accepts filesystem path entries and records prepared file metadata', async () => {
  const inputDir = tmpdir()
  const outputDir = tmpdir()
  const src = path.join(inputDir, 'path-fixture.md')
  fs.writeFileSync(src, '采访者：请介绍背景\n受访者：这是虚构样本。\n', 'utf8')

  const result = await runJob({
    __engine: mockEngine(),
    files: [{ path: src }],
    topic: '路径样本',
    date: '2026-07',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
  })

  assert.equal(result.provider, 'injected')
  assert.equal(result.refined.length, 1)
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.config.files.length, 1)
  assert.equal(manifest.config.files[0].path, src)
  assert.equal(manifest.config.files[0].outPath, path.join(outputDir, 'Transcripts', 'path-fixture.md'))
})
