import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFilePolicy, computeLogicAudit, prepareFile, runJob, stitchRefineParts } from '../universal/jobs.js'
import { computeExitCode } from '../universal/cli.js'
import { timelineDeliverableName } from '../core/prompts.js'
import { writeFile } from '../engines/fileops.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-runjob-'))
}

test('prepareFile normalizes SRT sources before the model sees them', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, '2026-07-01_示例字幕.srt')
  fs.writeFileSync(src, [
    '1',
    '00:00:01,000 --> 00:00:04,500',
    'Speaker 1: 我们 2026 年做了 3 次试验。',
    '',
    '2',
    '00:00:05,000 --> 00:00:09,000',
    'Speaker 2: 今天就先聊到这里。',
    '',
  ].join('\n'), 'utf8')

  const { entry } = await prepareFile(src, {
    topic: '测试项目',
    date: '2026-07',
    headingPolicy: 'none',
    outputDir,
    workDir: path.join(outputDir, '.converted'),
  })

  assert.equal(entry.sourceKind, 'srt')
  assert.equal(entry.originalPath, src)
  assert.equal(path.extname(entry.path), '.md')
  const prepared = fs.readFileSync(entry.path, 'utf8')
  assert.ok(!/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(prepared), 'raw SRT timecode arrow is not sent to prompts')
  assert.ok(prepared.includes('发言人 1 00:00:01'))
  assert.ok(prepared.includes('我们 2026 年做了 3 次试验。'))
})

test('buildFilePolicy only allows this run\'s declared deliverable paths', () => {
  const outputDir = tmpdir()
  const refined = path.join(outputDir, 'Transcripts', 'A.md')
  const policy = buildFilePolicy({
    outputDir,
    topic: '很长的访谈主题',
    scope: ['refine', 'logic', 'summary', 'timeline'],
    files: [{ title: 'A', path: '/source/A.md', outPath: refined }],
  })
  assert.ok(policy.writePaths.includes(refined))
  assert.ok(policy.writePartBases.includes(refined))
  assert.ok(policy.writePaths.includes(path.join(outputDir, '逻辑顺序', 'A.md')))
  assert.ok(policy.writePaths.some((p) => p.endsWith('访谈总结.md')))
  assert.ok(policy.writePaths.some((p) => p.endsWith('时间线.md')))
  assert.ok(!policy.writePaths.some((p) => p.includes('test_quotes')))
})

for (const partCount of [2, 3, 4, 9]) {
  test(`declared ${partCount}-part output writes and stitches through the real file policy`, () => {
    const outputDir = tmpdir()
    const refined = path.join(outputDir, 'Transcripts', 'A.md')
    const entry = { title: 'A', path: path.join(outputDir, 'source.md'), outPath: refined }
    const policy = buildFilePolicy({ outputDir, files: [entry], scope: ['refine'] })
    const chunks = Array.from({ length: partCount }, (_, i) => ({ idx: i + 1 }))

    for (const chunk of chunks) {
      const wrote = writeFile({ file_path: `${refined}.part${chunk.idx}`, content: `采访者：问题 ${chunk.idx}\n\n受访者：回答 ${chunk.idx}\n` }, policy)
      assert.equal(wrote.ok, true, wrote.text)
    }
    const report = stitchRefineParts(entry, chunks)
    assert.equal(report.merged, partCount)
    assert.match(fs.readFileSync(refined, 'utf8'), new RegExp(`回答 ${partCount}`))
    for (const chunk of chunks) assert.equal(fs.existsSync(`${refined}.part${chunk.idx}`), false)
    assert.equal(writeFile({ file_path: path.join(outputDir, 'Transcripts', 'scratch.md'), content: 'nope' }, policy).ok, false)
  })
}

test('failed stitch preserves every successfully written part for diagnosis and targeted retry', () => {
  const outputDir = tmpdir()
  const refined = path.join(outputDir, 'Transcripts', 'A.md')
  const entry = { title: 'A', path: path.join(outputDir, 'source.md'), outPath: refined }
  const policy = buildFilePolicy({ outputDir, files: [entry], scope: ['refine'] })
  assert.equal(writeFile({ file_path: `${refined}.part1`, content: '第一块\n' }, policy).ok, true)
  assert.equal(writeFile({ file_path: `${refined}.part2`, content: '第二块\n' }, policy).ok, true)

  assert.throws(() => stitchRefineParts(entry, [{ idx: 1 }, { idx: 2 }, { idx: 3 }]), /part3/)
  assert.equal(fs.existsSync(`${refined}.part1`), true)
  assert.equal(fs.existsSync(`${refined}.part2`), true)
  assert.equal(fs.existsSync(refined), false)
})

test('runJob failure injection records part3 plan, typed execution failure, trace, and preserves good parts', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, 'long-source.md')
  const turns = Array.from({ length: 360 }, (_, i) => `采访者：请说明第 ${i + 1} 个问题的背景和影响。\n\n受访者：第 ${i + 1} 个问题包含一段需要完整保留的事实、例子、判断、限定语与后续安排，不能压缩成摘要。`)
  fs.writeFileSync(src, turns.join('\n\n'), 'utf8')
  const failure = {
    label: 'refine:long-source#3/3', code: 'OUTPUT_MISSING', retryable: false, message: '声明产物未生成：part3',
    providerSignal: { provider: 'deepseek', finishReason: 'stop', refusalPresent: false, choiceCount: 1, httpStatus: null, requestId: 'req_part3' },
  }
  const usage = { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, agents: 5, failed: 1, byModel: {} }
  const engine = {
    phase() {}, log() {},
    usage: () => ({ ...usage }),
    failures: () => [{ ...failure }],
    refineBudget: () => ({ model: 'deepseek-v4-pro', budget: 10000 }),
    parallel: async (thunks) => Promise.all(thunks.map((task) => task())),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, i) => {
      let value = item
      for (const stage of stages) { value = await stage(value, item, i); if (!value) return null }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      if (opts.label?.startsWith('scout:')) return { speakers: [], people: [], brands: [], terms: [], errors: [], themes: [], ending_anchor: {}, special_notes: [] }
      if (/^refine(?:-retry)?:.*#3\/3$/.test(opts.label || '')) return null
      if (opts.label?.startsWith('refine:')) {
        fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
        fs.writeFileSync(opts.outputPath, `采访者：问题\n\n受访者：${opts.label}\n`, 'utf8')
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      return null
    },
  }

  const result = await runJob({
    files: [{ path: src }], topic: '失败注入', outputDir, scope: ['refine'], verifyDepth: 'none', headingPolicy: 'none', runLog: false,
    __engine: engine,
  })
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'run-state.json'), 'utf8'))
  const plan = manifest.plannedChunks[0]

  assert.equal(result.execution.status, 'failed')
  assert.equal(result.execution.failure.code, 'OUTPUT_MISSING')
  assert.equal(manifest.execution.failure.retryable, false)
  assert.equal(manifest.execution.failure.providerSignal.requestId, 'req_part3')
  assert.equal(plan.parts.length, 3)
  assert.match(plan.parts[2].path, /\.part3$/)
  assert.equal(fs.existsSync(plan.parts[0].path), true)
  assert.equal(fs.existsSync(plan.parts[1].path), true)
  assert.equal(fs.existsSync(plan.parts[2].path), false)
  assert.equal(state.status, 'failed')
  assert.equal(state.progress.partsPlanned, 3)
  assert.equal(computeExitCode(result), 1)
})

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

test('computeLogicAudit independently blocks a same-order fake logic draft', () => {
  const outputDir = tmpdir()
  const refinedPath = path.join(outputDir, 'Transcripts', 'A.md')
  const logicPath = path.join(outputDir, '逻辑顺序', 'A.md')
  fs.mkdirSync(path.dirname(refinedPath), { recursive: true })
  fs.mkdirSync(path.dirname(logicPath), { recursive: true })
  const sections = ['创业起点', '产品迭代', '客户变化', '渠道调整', '供应协同', '组织搭建']
  const body = (title) => [
    `记者：请讲讲${title}这件事的背景。`,
    `受访者：${title}包含一组完整事实，我们先做内部验证，再和外部客户逐步确认。`,
    '记者：这个变化对公司节奏有什么影响？',
    '受访者：影响主要体现在交付节奏、团队分工和后续复盘上，每一步都有明确责任人。',
  ].join('\n\n')
  fs.writeFileSync(refinedPath, [
    '# 示例访谈', '',
    ...sections.flatMap((title) => [`## ${title}`, '', body(title), '']),
  ].join('\n'), 'utf8')
  fs.writeFileSync(logicPath, [
    '# 示例访谈 · 逻辑顺序稿', '', '## 主线脉络（导读）', '', '按原顺序复制。', '',
    ...sections.flatMap((title) => [`## ${title}`, `*〔取自精校稿：${title}〕*`, '', body(title), '']),
  ].join('\n'), 'utf8')

  const audit = computeLogicAudit({
    scope: ['logic'],
    files: [{ label: 'A', outPath: refinedPath }],
  }, { logic: [{ label: 'A', path: logicPath }] })
  assert.equal(audit.status, 'fail')
  assert.ok(audit.files[0].failed.includes('logic_order_unchanged'))
})

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

// Universal injects one targeted repair. This mock deliberately returns null and leaves the file byte-identical,
// so the attempt is rejected and the hard gap still surfaces.
test('runJob surfaces an un-repairable hard gap as auditFailed and attaches a per-file audit summary', async () => {
  const result = await runGapJob()
  assert.ok((result.auditFailed || []).length >= 1, 'a still-hard gap is recorded in auditFailed')
  assert.ok(result.auditFailed.every((x) => x.findings.includes('content_gap')), 'the finding is content_gap')
  const r0 = result.refined.find((r) => (result.auditFailed[0].path === (r.outPath || r.path)))
  assert.ok(r0 && r0.audit && r0.audit.status === 'fail', 'the refined entry carries audit.status=fail')
  assert.equal(r0.audit.repaired, false, 'a null/byte-identical repair is not counted as repaired')
  assert.ok(result.qualityRepair.attempts.length >= 1 && result.qualityRepair.attempts.every((x) => !x.ok))
})

function repairableGapEngine() {
  const e = gapEngine()
  e.agent = async (prompt, opts = {}) => {
    if (opts.label && opts.label.startsWith('repair:')) {
      const m = prompt.match(/【当前成稿】([^\n]+)/)
      assert.ok(m, 'repair prompt names the exact output file')
      assert.match(prompt, /"startLine"/, 'repair prompt carries exact gap ranges')
      fs.writeFileSync(m[1].trim(), covFixture('coverage-refined-good.md'), 'utf8')
      return `已写回 ${m[1].trim()}`
    }
    return null
  }
  return e
}

test('runJob targeted repair closes content_gap, replaces the first audit result, and avoids annotation', async () => {
  const outputDir = tmpdir()
  const src64 = Buffer.from(covFixture('coverage-source.md')).toString('base64')
  const result = await runJob({
    __engine: repairableGapEngine(),
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }],
    topic: '定向修复测试', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
  })
  assert.deepEqual(result.auditFailed, [])
  assert.equal(result.audit.files.length, 2, 'one latest audit record per file, not fail+pass duplicates')
  assert.ok(result.audit.files.every((f) => f.status === 'ok'))
  assert.ok(result.refined.every((r) => r.audit.repaired === true))
  assert.ok(result.qualityRepair.attempts.every((x) => x.ok))
  assert.equal(result.annotations.length, 0, 'a repaired gap needs no visible failure marker')
})

// A clean refine (no gap) must not populate auditFailed, and each refined entry gets audit.status='ok'.
function cleanEngine() {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  const webTelemetry = { searchCalls: 2, searchAttempts: 1, searchBilled: 1, searchCacheHits: 1, searchBudgetRejected: 0, searchFailures: 0, fetchCalls: 1, fetchCacheHits: 0, fetchJinaAttempts: 1, fetchJinaSuccess: 1, fetchLocalAttempts: 0, fetchLocalSuccess: 0, fetchFailures: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }), webTelemetry: () => ({ ...webTelemetry }),
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
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.deepEqual(manifest.webTelemetry, result.webTelemetry, 'runJob persists job-scoped web telemetry in run.json')
  assert.equal(manifest.config.searchProvider, 'serper')
  assert.equal(manifest.config.fetchProvider, 'jina-reader+local-fallback')
})

test('runJob preserves models override and run.json records the complete effective routing', async () => {
  const outputDir = tmpdir()
  const src64 = Buffer.from(covFixture('coverage-source.md')).toString('base64')
  const result = await runJob({
    __engine: cleanEngine(),
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }],
    topic: '模型契约', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    models: { refine: 'deepseek-v4-flash', repair: 'deepseek-v4-pro' },
  })
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.config.models.refine, 'deepseek-v4-flash')
  assert.equal(manifest.config.models.repair, 'deepseek-v4-pro')
  assert.equal(manifest.config.models.scout, 'deepseek-v4-flash', 'defaults are expanded, not silently absent')
  assert.deepEqual(manifest.config.modelOverrides, { refine: 'deepseek-v4-flash', repair: 'deepseek-v4-pro' })
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

// P1 end-to-end: the produced 时间线 is audited against the interview corpus (source + 成稿). A 【访谈】-tagged
// magnitude the interviewee never said surfaces as auditFailed (derivative_attribution) → non-zero exit; a
// legitimate 成稿 figure passes and a 公开·待记者核实 figure is a reporter-verify item, not a hard fail.
// Fixtures fictional (远山物流 / 沈其安 — logistics, nothing aerospace).
function deliverEngine(refinedText) {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, refinedText)
      return { path: f.outPath, headings: ['## 车型'], key_fixes: [], open_questions: [] }
    }),
    // The 时间线 agent "produces" the deliverable (the test pre-writes the file the audit reads, as the other
    // runJob tests do for the 成稿); every other label returns null.
    agent: async (_prompt, opts = {}) => { usage.agents++; return opts.label === 'timeline' ? '已写到 远山物流时间线.md\n- 车型' : null },
  }
}

test('runJob (P1): a fabricated 访谈 figure in the produced 时间线 → auditFailed (derivative_attribution) + non-zero exit', async () => {
  const outputDir = tmpdir()
  const s1 = path.join(outputDir, '远山物流甲.md'), s2 = path.join(outputDir, '远山物流乙.md')
  const srcText = '# 远山物流\n\n沈其安：我们主力车型载重 6 吨，本轮融资 2 亿元。\n'
  fs.writeFileSync(s1, srcText, 'utf8'); fs.writeFileSync(s2, srcText, 'utf8')
  const refined = '# 远山物流\n*访谈*\n\n## 车型\n\n沈其安：我们主力车型载重 6 吨，本轮融资 2 亿元。\n'
  // Pre-write the 时间线 the timeline agent "produces": 载重 6 吨 is真实（在成稿）; 航程 88 公里【访谈】 was NEVER
  // said (fabricated); 500 亿元 is【公开·待记者核实】(reporter-verify, not a hard fail).
  const timelinePath = path.join(outputDir, timelineDeliverableName('远山物流'))
  fs.writeFileSync(timelinePath, [
    '# 远山物流 时间线',
    '## 时间线',
    '- **2021 年**【访谈】主力车型载重 6 吨。',
    '- **2022 年**【访谈】单程航程 88 公里。',
    '- **2023 年**【公开·待记者核实】行业估值约 500 亿元。',
  ].join('\n'), 'utf8')

  const result = await runJob({
    __engine: deliverEngine(refined),
    files: [{ path: s1 }, { path: s2 }],
    topic: '远山物流', date: '2026-07', outputDir,
    scope: ['refine', 'timeline'], verifyDepth: 'none', anchors: false,
  })

  assert.ok(result.derivativeAudit && result.derivativeAudit.status === 'fail', 'the derivative audit ran and failed')
  assert.ok((result.auditFailed || []).some((x) => x.findings.includes('derivative_attribution')), 'fabricated 访谈 figure → auditFailed')
  const df = (result.derivativeAudit.files || []).find((f) => f.kind === 'timeline')
  assert.equal(df.hardFail.length, 1, 'only the fabricated 88 公里 is a hard fail')
  assert.equal(df.hardFail[0].unit, '公里')
  assert.ok(df.reporterVerify.length >= 1, 'the 公开·待记者核实 figure is a reporter-verification item, not a hard fail')
  assert.equal(computeExitCode(result), 1, 'a fabricated interview figure drives a non-zero exit')
  assert.match(fs.readFileSync(result.reviewPath, 'utf8'), /派生件溯源/, 'review.md surfaces the derivative finding')
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.derivativeAudit.status, 'fail', 'run.json records the derivative audit')
})
