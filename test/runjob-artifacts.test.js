import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFilePolicy, computeLogicAudit, JobConfigError, prepareFile, runJob, stitchRefineParts } from '../universal/jobs.js'
import { computeExitCode } from '../universal/cli.js'
import { timelineDeliverableName } from '../core/prompts.js'
import { writeFile } from '../engines/fileops.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-runjob-'))
}

function writeContractOutput(prompt, outputPath, transform = (text) => text) {
  const match = String(prompt || '').match(/【结构化输入】([^\n]+)/u)
  assert.ok(match, 'Refine prompt exposes the host-generated turn contract path')
  const defaultOutput = fs.readFileSync(match[1].trim(), 'utf8')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, transform(defaultOutput), 'utf8')
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
  assert.equal(entry.speakerLabelLines, 2)
  assert.equal(entry.needsSpeakerResolution, true, 'generic SRT speakers force Scout even when the transcript is short')
  const prepared = fs.readFileSync(entry.path, 'utf8')
  assert.ok(!/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(prepared), 'raw SRT timecode arrow is not sent to prompts')
  assert.ok(prepared.includes('发言人 1 00:00:01'))
  assert.ok(prepared.includes('我们 2026 年做了 3 次试验。'))
})

test('runJob rejects an explicitly declared AI smart summary before selecting or calling an engine', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, '总结.md')
  fs.writeFileSync(src, [
    '<title>智能纪要：示例访谈</title>',
    '',
    '> 智能纪要由 AI 生成，可能不准确，请谨慎甄别后使用',
    '',
    '# 总结',
    '这不是妙记转录全文。',
  ].join('\n'), 'utf8')
  let engineCalls = 0

  await assert.rejects(
    runJob({
      __engine: { agent: async () => { engineCalls += 1; return null } },
      files: [{ path: src }],
      topic: '测试项目',
      outputDir,
      scope: ['refine'],
    }),
    (error) => error instanceof JobConfigError && /AI 智能纪要/.test(error.message),
  )

  assert.equal(engineCalls, 0)
  assert.equal(fs.existsSync(path.join(outputDir, 'Transcripts')), false, 'the pre-model gate emits no refined main draft')
})

test('runJob keeps a valid untracked monologue untracked through the turn contract', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, '独白.md')
  const source = [
    '这是第一段独白，完整说明项目背景和当前进展。',
    '',
    '这是第二段独白，完整说明下一步安排和最终结论。',
  ].join('\n')
  fs.writeFileSync(src, source, 'utf8')
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  let metadataCalls = 0
  const engine = {
    phase() {},
    log() {},
    usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      usage.agents += 1
      if (opts.label && opts.label.startsWith('metadata:')) {
        metadataCalls += 1
        return null
      }
      if (opts.label && opts.label.startsWith('scout:')) {
        return { speakers: [], people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [] }
      }
      if (opts.label && opts.label.startsWith('refine:')) {
        writeContractOutput(_prompt, opts.outputPath)
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      if (opts.label && opts.label.startsWith('speaker-adjudicate:')) {
        return {
          decisions: [3, 5].map((line) => ({
            line,
            label: '记者',
            verdict: 'invented_speaker',
            confidence: 'high',
            reason: 'dialogue_turn_without_source',
          })),
        }
      }
      return null
    },
  }

  const result = await runJob({
    __engine: engine,
    files: [{ path: src }],
    topic: '测试项目',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    anchors: false,
  })

  assert.equal(result.refined.length, 1)
  assert.deepEqual(result.failed, [])
  assert.equal(result.speakerResolutions[0].speakerMode, 'untracked')
  assert.equal(result.speakerStructuralFailures.length, 0)
  assert.doesNotMatch(fs.readFileSync(result.refined[0].outPath, 'utf8'), /^记者：/mu)

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.artifacts.refined.length, 1)
  assert.ok(manifest.speaker.outputEnforcements.every((entry) => entry.contract === 'turn_ir_v2'))
})

test('runJob reports a typed contract failure instead of falling back to Markdown speaker inference', async () => {
  const outputDir = tmpdir()
  const source = '记者：请介绍背景。\n\n沈其安：这是完整回答，包含研发过程、判断依据和后续安排。'
  const engine = {
    phase() {}, log() {},
    usage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }),
    parallel: async (thunks) => Promise.all(thunks.map((task) => task())),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      if ((opts.label || '').startsWith('scout:')) {
        return {
          speakers: [
            { label: '记者', role: '记者', output_label: '记者' },
            { label: '沈其安', role: '受访者', output_label: '沈其安' },
          ],
          people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [],
        }
      }
      if ((opts.label || '').startsWith('refine:')) {
        fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
        fs.writeFileSync(opts.outputPath, '# 模型自行生成的旧 Markdown\n\n文字记录：错误结构\n', 'utf8')
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      return null
    },
  }
  const result = await runJob({
    __engine: engine,
    files: [{ name: '契约失败.md', base64: Buffer.from(source).toString('base64') }],
    topic: '契约失败', outputDir, scope: ['refine'], verifyDepth: 'none',
  })

  assert.deepEqual(result.failed, ['契约失败'])
  assert.equal(result.refined.length, 0)
  assert.equal(result.execution.failure.code, 'TURN_CONTRACT_HEADER_MISSING')
  assert.equal(result.execution.failure.retryable, false)
  assert.equal(result.turnContractFailures.length, 1)
  assert.equal(result.speakerStructuralFailures.length, 0, 'legacy speaker inference never runs on a rejected envelope')
})

test('runJob recovers unfamiliar speaker decorators from exact Scout evidence and keeps audit/enforcement on one mapping', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, '陌生格式.md')
  const sourceTurns = []
  for (let i = 0; i < 8; i += 1) {
    const sec = String(i * 2 + 3).padStart(2, '0')
    const answer = `这是受访者第 ${i + 1} 次完整回答，包含项目背景、判断依据、执行过程和阶段结果，所有信息均来自本次虚构测试。`
    const question = `这是记者第 ${i + 1} 次完整提问，请继续解释相关决策的原因、约束条件和后续安排。`
    sourceTurns.push(`⟦00:${sec}⟧ 张三：${answer}`, `⟦00:${String(i * 2 + 4).padStart(2, '0')}⟧ 李四：${question}`)
  }
  const source = sourceTurns.join('\n')
  fs.writeFileSync(src, source, 'utf8')

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  const engine = {
    phase() {},
    log() {},
    usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      usage.agents += 1
      if (opts.label && opts.label.startsWith('scout:')) {
        return {
          speakers: [
            {
              label: '张三',
              role: '受访者',
              output_label: '张三',
              output_label_confidence: 'high',
              output_label_evidence: '原文直接标注张三',
              sample: sourceTurns[0],
            },
            {
              label: '李四',
              role: '记者',
              output_label: '李四',
              output_label_confidence: 'high',
              output_label_evidence: '原文直接标注李四',
              sample: sourceTurns[1],
            },
          ],
          people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [],
        }
      }
      if (opts.label && opts.label.startsWith('refine:')) {
        writeContractOutput(_prompt, opts.outputPath)
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      return null
    },
  }

  const result = await runJob({
    __engine: engine,
    files: [{ path: src }],
    topic: '测试项目',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    anchors: false,
  })

  assert.equal(result.refined.length, 1)
  assert.equal(result.speakerResolutions[0].speakerMode, 'tracked')
  assert.equal(result.speakerResolutions[0].mappings.length, 2)
  assert.equal(result.speakerResolutions[0].recoveredByScout.length, 16)
  assert.deepEqual(result.speakerStructureWarnings, [])
  assert.ok(result.speakerOutputNormalizations.every((item) => item.valid))
  assert.equal(result.audit.files[0].metrics.attribution.status, 'assessed')
})

test('runJob keeps unsupported evidence ambiguous and makes the review state user-visible instead of calling it a monologue', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, '待确认格式.md')
  const source = [
    '[00:03] 张三：这是第一段完整回答，说明项目背景、实际约束和当前判断。',
    '[00:05] 李四：这是第二段完整提问，希望继续解释执行过程和后续安排。',
  ].join('\n')
  fs.writeFileSync(src, source, 'utf8')
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  const engine = {
    phase() {},
    log() {},
    usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      usage.agents += 1
      if (opts.label && opts.label.startsWith('scout:')) {
        return {
          speakers: [
            confidentScout('张三', '受访者', '张三：这是第一段完整回答。'),
            confidentScout('李四', '记者', '李四：这是第二段完整提问。'),
          ],
          people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [],
        }
      }
      if (opts.label && opts.label.startsWith('refine:')) {
        writeContractOutput(_prompt, opts.outputPath)
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      return null
    },
  }
  function confidentScout(label, role, sample) {
    return {
      label,
      role,
      output_label: label,
      output_label_confidence: 'high',
      output_label_evidence: `原文疑似显示 ${label}`,
      sample,
    }
  }

  const result = await runJob({
    __engine: engine,
    files: [{ path: src }],
    topic: '测试项目',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    anchors: false,
  })

  assert.equal(result.refined.length, 1, 'the source is preserved rather than discarded')
  assert.equal(result.speakerResolutions[0].speakerMode, 'ambiguous')
  assert.ok(result.speakerStructureWarnings.some((item) =>
    item.warnings.some((warning) => warning.kind === 'scout_parser_disagreement')))
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.quality.status, 'review_needed')
  assert.ok(Object.keys(manifest.issues).some((title) => title.includes('疑似说话人结构未能完全确认')))
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
  assert.equal(policy.writePaths.some((p) => p.includes('.repair-candidates')), false, 'repair candidates are not writable outside the repair agent')
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
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, i) => {
      let value = item
      for (const stage of stages) { value = await stage(value, item, i); if (!value) return null }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      usage.agents++
      if (opts.label && opts.label.startsWith('scout:')) {
        return {
          speakers: [{ label: '采访者', role: '记者' }, { label: '受访者', role: '受访者' }],
          people: [], brands: [], terms: [], errors: [], themes: [],
          ending_anchor: { line: 9, text: '今天先到这里，后续我们再补充渠道数据和客户案例。' },
          special_notes: [],
        }
      }
      if (opts.label && opts.label.startsWith('refine:')) {
        writeContractOutput(_prompt, opts.outputPath, (input) => input.replace(
          '<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->',
          '## 开场\n\n<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->',
        ))
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

// A short closing pleasantry is deliberately omitted. This is below the substantive coverage threshold and must
// not be promoted into a publication failure by a separate lexical-tail heuristic.
const TRUNC_SOURCE = [
  '采访者：先请你介绍一下自己。',
  '受访者：我在一家虚构的工业检测公司做研发，入行差不多十年了，主要负责视觉算法这一块。',
  '采访者：这些年最大的变化是什么？',
  '受访者：客户从只看价格，变成开始认真评估检测精度和交付周期，这对我们其实是好事。',
  '采访者：好的，那今天就先聊到这里，非常感谢你抽空接受这次访谈。',
].join('\n') + '\n'

function truncatedEndingEngine() {
  const usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, i) => {
      let value = item
      for (const stage of stages) { value = await stage(value, item, i); if (!value) return null }
      return value
    })),
    // Role-only speaker labels force Scout before Refine even on a short file. The refine agent preserves every
    // stable turn ID but deliberately leaves the final pure-pleasantry body empty.
    agent: async (_prompt, opts = {}) => {
      usage.agents++
      if (opts.label && opts.label.startsWith('scout:')) {
        return {
          speakers: [{ label: '采访者', role: '记者' }, { label: '受访者', role: '受访者' }],
          people: [], brands: [], terms: [], errors: [], themes: [],
          ending_anchor: { line: TRUNC_SOURCE.split('\n').length, text: '今天就先聊到这里。' },
          special_notes: [],
        }
      }
      if (opts.label && opts.label.startsWith('refine:')) {
        writeContractOutput(_prompt, opts.outputPath, (input) => input
          .replace(
            '<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->',
            '## 开场\n\n<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->',
          )
          .replace(
            /<!-- LRB_OUTPUT_BLOCK sources=T000005 disposition=keep -->\n[\s\S]*?\n<!-- \/LRB_OUTPUT_BLOCK -->/u,
            '<!-- LRB_OUTPUT_BLOCK sources=T000005 disposition=fold_noise -->\n<!-- /LRB_OUTPUT_BLOCK -->',
          ))
        return { path: 'unused.md', headings: ['## 开场'], key_fixes: [], open_questions: ['确认受访者姓名'] }
      }
      return null
    },
  }
}

test('runJob does not hard-fail a short omitted closing pleasantry through lexical tail matching', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, 'tiny-src.md')
  fs.writeFileSync(src, TRUNC_SOURCE, 'utf8')
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

  assert.equal(result.incomplete.length, 0, 'legacy incomplete stays empty without an evidence-backed body gap')
  assert.ok(result.audit.files.every((f) => !(f.failed || []).includes('ending_missing')))

  const review = fs.readFileSync(result.reviewPath, 'utf8')
  assert.doesNotMatch(review, /疑似中途截断，需要检查结尾/)
  assert.match(review, /确认受访者姓名/)

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.config.topic, '测试项目')
  assert.equal(manifest.config.files.length, 1)
  assert.equal(manifest.artifacts.reviewPath, result.reviewPath)
  assert.equal(manifest.result.incomplete.length, 0)
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

// Universal injects at most two targeted repair rounds. This mock deliberately returns null and leaves the file
// byte-identical, so both attempts are recorded and the hard gap still surfaces.
test('runJob surfaces an un-repairable hard gap as auditFailed and attaches a per-file audit summary', async () => {
  const result = await runGapJob()
  assert.ok((result.auditFailed || []).length >= 1, 'a still-hard gap is recorded in auditFailed')
  assert.ok(result.auditFailed.every((x) => x.findings.includes('content_gap')), 'the finding is content_gap')
  const r0 = result.refined.find((r) => (result.auditFailed[0].path === (r.outPath || r.path)))
  assert.ok(r0 && r0.audit && r0.audit.status === 'fail', 'the refined entry carries audit.status=fail')
  assert.equal(r0.audit.repaired, false, 'a null/byte-identical repair is not counted as repaired')
  assert.equal(result.qualityRepair.maxRounds, 2)
  assert.equal(result.qualityRepair.roundsUsed, 2)
  assert.equal(result.qualityRepair.stopReason, 'max_rounds')
  assert.equal(result.qualityRepair.attempts.length, 4, 'two files each receive two repair rounds')
  assert.ok(result.qualityRepair.attempts.every((x) => x.outcome === 'agent_failed' && x.changed === false))
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.qualityRepair.maxRounds, 2)
  assert.equal(manifest.qualityRepair.attempts.length, 4)
})

function repairableGapEngine() {
  const e = gapEngine()
  e.agent = async (prompt, opts = {}) => {
    if (opts.label && opts.label.startsWith('repair:')) {
      const m = prompt.match(/【当前成稿】([^\n]+)/)
      assert.ok(m && m[1].includes('.repair-candidates'), 'repair writes a bounded candidate, not the current main transcript')
      assert.deepEqual(opts.filePolicy.writePaths, [m[1].trim()])
      assert.match(prompt, /"startLine"/, 'repair prompt carries exact gap ranges')
      assert.match(prompt, /允许的输出标签只有：记者、沈其安/, 'repair receives the exact canonical speaker registry')
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
  assert.equal(result.qualityRepair.roundsUsed, 1)
  assert.equal(result.qualityRepair.stopReason, 'passed')
  assert.ok(result.qualityRepair.attempts.every((x) => x.outcome === 'passed' && x.changed === true))
  assert.ok(result.qualityRepair.attempts.every((x) => x.candidatePromoted === true && x.candidateSpeakerValid === true))
  assert.equal(fs.existsSync(path.join(outputDir, '.repair-candidates')), true)
  assert.deepEqual(fs.readdirSync(path.join(outputDir, '.repair-candidates')), [], 'promoted candidates leave no scratch files')
  assert.equal(result.annotations.length, 0, 'a repaired gap needs no visible failure marker')
})

test('structured repair preserves turn IDs while restoring a hard content gap', async () => {
  const outputDir = tmpdir()
  const longAnswer = Array.from(
    { length: 12 },
    (_, index) => `这一部分说明研发约束、客户反馈、判断依据和执行结果，细节序号为 ${index + 1}，不能被摘要掉。`,
  ).join('')
  const source = [
    '记者：请完整介绍这段研发过程。',
    `沈其安：${longAnswer}`,
    '记者：这段过程最后得到什么结论？',
    '沈其安：结论是先完成内部验证，再逐步扩大客户范围，同时保留每次复盘记录。',
  ].join('\n\n')
  let fullEnvelope = ''
  let repairCalls = 0
  const engine = {
    phase() {}, log() {},
    usage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }),
    parallel: async (thunks) => Promise.all(thunks.map((task) => Promise.resolve().then(task).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (prompt, opts = {}) => {
      if ((opts.label || '').startsWith('scout:')) {
        return {
          speakers: [
            { label: '记者', role: '记者', output_label: '记者' },
            { label: '沈其安', role: '受访者', output_label: '沈其安' },
          ],
          people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [],
        }
      }
      if ((opts.label || '').startsWith('refine:')) {
        writeContractOutput(prompt, opts.outputPath, (input) => {
          fullEnvelope = input
          return input.replace(
            /<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->\n[\s\S]*?\n<!-- \/LRB_OUTPUT_BLOCK -->/u,
            '<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=fold_noise -->\n<!-- /LRB_OUTPUT_BLOCK -->',
          )
        })
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      if ((opts.label || '').startsWith('repair:')) {
        repairCalls += 1
        const match = prompt.match(/【结构化候选】([^\n]+)/u)
        assert.ok(match && fullEnvelope)
        fs.writeFileSync(match[1].trim(), fullEnvelope, 'utf8')
        return `已写回 ${match[1].trim()}`
      }
      return null
    },
  }
  const result = await runJob({
    __engine: engine,
    files: [{ name: '结构修复.md', base64: Buffer.from(source).toString('base64') }],
    topic: '结构修复', outputDir, scope: ['refine'], verifyDepth: 'none',
  })

  assert.equal(repairCalls, 1)
  assert.deepEqual(result.auditFailed, [])
  assert.equal(result.qualityRepair.attempts[0].candidatePromoted, true)
  assert.equal(result.qualityRepair.attempts[0].candidateSpeakerValid, true)
  assert.match(fs.readFileSync(result.refined[0].outPath, 'utf8'), /研发约束、客户反馈/u)
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.ok(manifest.speaker.outputEnforcements.every((entry) => entry.contract === 'turn_ir_v2'))
})

test('runJob fixes a quote-only failure deterministically without calling the repair model', async () => {
  const outputDir = tmpdir()
  const source = [
    '记者：请介绍一下你们主要做什么？',
    '沈其安：我们主要做工业检测，为制造业客户提供设备和软件。项目周期通常是半年，交付后还会继续维护。',
  ].join('\n')
  let repairCalls = 0
  const engine = {
    phase() {}, log() {},
    usage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (_prompt, opts = {}) => {
      if ((opts.label || '').startsWith('scout:')) {
        return {
          speakers: [
            { label: '记者', role: '记者', output_label: '记者' },
            { label: '沈其安', role: '受访者', output_label: '沈其安' },
          ],
          people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [],
        }
      }
      if ((opts.label || '').startsWith('refine:')) {
        writeContractOutput(_prompt, opts.outputPath, (input) => input.replace('工业检测', '"工业检测"'))
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      if ((opts.label || '').startsWith('repair:')) repairCalls += 1
      return null
    },
  }
  const result = await runJob({
    __engine: engine,
    files: [{ name: '引号.md', base64: Buffer.from(source).toString('base64') }],
    topic: '确定性引号修复', outputDir, scope: ['refine'], verifyDepth: 'none',
  })

  assert.equal(repairCalls, 0)
  assert.deepEqual(result.auditFailed, [])
  assert.equal(result.qualityRepair.attempts.length, 1)
  assert.equal(result.qualityRepair.attempts[0].model, 'deterministic')
  assert.equal(result.qualityRepair.attempts[0].candidatePromoted, true)
  assert.match(fs.readFileSync(result.refined[0].outPath, 'utf8'), /“工业检测”/)
})

function inventedSpeakerRepairEngine() {
  const e = gapEngine()
  e.agent = async (prompt, opts = {}) => {
    if (opts.label && opts.label.startsWith('repair:')) {
      const m = prompt.match(/【当前成稿】([^\n]+)/)
      assert.ok(m && m[1].includes('.repair-candidates'))
      assert.deepEqual(opts.filePolicy.writePaths, [m[1].trim()])
      const invented = covFixture('coverage-refined-good.md').replaceAll('沈其安：', '温：')
      fs.writeFileSync(m[1].trim(), invented, 'utf8')
      return `已写回 ${m[1].trim()}`
    }
    if (opts.label && opts.label.startsWith('speaker-adjudicate:')) {
      return {
        decisions: [{
          line: 1,
          label: '温',
          verdict: 'invented_speaker',
          confidence: 'high',
          reason: 'dialogue_turn_without_source',
        }],
      }
    }
    return null
  }
  return e
}

test('runJob rejects a repair candidate that invents a speaker and preserves the current transcript', async () => {
  const outputDir = tmpdir()
  const src64 = Buffer.from(covFixture('coverage-source.md')).toString('base64')
  const result = await runJob({
    __engine: inventedSpeakerRepairEngine(),
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }],
    topic: '候选事务测试', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
  })
  assert.ok(result.auditFailed.every((x) => x.findings.includes('content_gap')))
  assert.equal(result.qualityRepair.roundsUsed, 2)
  assert.ok(result.qualityRepair.attempts.every((x) => x.outcome === 'candidate_rejected'))
  assert.ok(result.qualityRepair.attempts.every((x) => x.candidatePromoted === false && x.candidateSpeakerValid === false))
  for (const entry of result.refined) {
    const text = fs.readFileSync(entry.outPath, 'utf8')
    assert.doesNotMatch(text, /^温：/m, 'unknown speaker candidate never replaces the current transcript')
  }
  assert.deepEqual(fs.readdirSync(path.join(outputDir, '.repair-candidates')), [], 'rejected candidates are removed')
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
  assert.equal(manifest.config.searchProvider, 'tavily')
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

test('runJob finalizes single-transcript identity after the refined file exists', async () => {
  const inputDir = tmpdir()
  const outputDir = tmpdir()
  const src = path.join(inputDir, 'identity-order.md')
  fs.writeFileSync(src, '记者：请介绍背景\n受访者：我是沈其安，负责示例公司的研发。\n', 'utf8')
  const base = mockEngine()
  const labels = []
  const originalAgent = base.agent
  base.agent = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    if ((opts.label || '').startsWith('metadata:')) {
      const refinedPath = path.join(outputDir, 'Transcripts', 'identity-order.md')
      assert.equal(fs.existsSync(refinedPath), true, 'identity finalization must wait for the final transcript')
      assert.match(prompt, new RegExp(refinedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(prompt, /源稿是身份事实的最高依据/)
      return {
        interviewee_name: '沈其安',
        organization_name: '示例公司',
        role_title: '研发负责人',
        interviewee_intro: '示例公司研发负责人，本次介绍项目背景。',
        confidence: 'high',
        evidence: '原稿自我介绍明确。',
      }
    }
    return originalAgent(prompt, opts)
  }

  const result = await runJob({
    __engine: base,
    files: [{ path: src }],
    topic: '身份顺序样本',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
  })

  assert.ok(labels.findIndex((label) => label.startsWith('metadata:'))
    > labels.findIndex((label) => label.startsWith('refine:')))
  assert.equal(result.transcriptMetadata.interviewee_name, '沈其安')
  assert.equal(result.transcriptMetadata.role_title, '研发负责人')
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.transcriptMetadata.role_title, '研发负责人')
})

test('runJob applies final track identity through the registry, re-renders, and re-audits', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, '逐轨身份.md')
  const source = [
    '说话人 1 00:01',
    '请介绍一下你的背景和目前负责的工作。',
    '说话人 2 00:02',
    '我是田渊栋，主要研究人工智能；这里提到“说话人 2”只是正文里的原始称呼。',
    '说话人 1 00:03',
    '你如何判断这一轮技术变化？',
    '说话人 2 00:04',
    '我的判断来自长期研究和实际观察，今天先完整说明这些依据。',
  ].join('\n')
  fs.writeFileSync(src, source, 'utf8')
  const labels = []
  const engine = {
    phase() {}, log() {},
    usage: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: labels.length, failed: 0 }),
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item
      for (const stage of stages) {
        value = await stage(value, item, index)
        if (!value) return null
      }
      return value
    })),
    agent: async (prompt, opts = {}) => {
      labels.push(opts.label || '')
      if ((opts.label || '').startsWith('scout:')) {
        return { speakers: [], people: [], brands: [], terms: [], errors: [], themes: [], special_notes: [] }
      }
      if ((opts.label || '').startsWith('refine:')) {
        writeContractOutput(prompt, opts.outputPath)
        assert.deepEqual(await opts.validateOutput(), { ok: true })
        return { path: opts.outputPath, headings: [], key_fixes: [], open_questions: [] }
      }
      if ((opts.label || '').startsWith('metadata:')) {
        assert.match(prompt, /"speaker_track_id":"S000002"/)
        return {
          interviewee_name: '田渊栋',
          organization_name: '',
          role_title: '人工智能研究者',
          interviewee_intro: '人工智能研究者，本次讨论技术变化。',
          speaker_assignments: [
            { speaker_track_id: 'S000001', canonical_name: '', role: '记者', confidence: 'low', evidence: '源稿没有记者姓名。' },
            { speaker_track_id: 'S000002', canonical_name: '田渊栋', role: '受访者', confidence: 'high', evidence: '该轨道直接说“我是田渊栋”。' },
          ],
          confidence: 'high',
          evidence: '源稿有直接自我介绍。',
        }
      }
      return null
    },
  }

  const result = await runJob({
    __engine: engine,
    files: [{ path: src }],
    topic: '逐轨身份',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    anchors: false,
  })

  assert.equal(result.refined.length, 1)
  const finalText = fs.readFileSync(result.refined[0].outPath, 'utf8')
  assert.match(finalText, /^田渊栋：我是田渊栋/mu)
  assert.doesNotMatch(finalText, /^说话人 2：/mu)
  assert.match(finalText, /这里提到“说话人 2”只是正文里的原始称呼/u, 'body content is not string-replaced')
  assert.equal(result.speakerResolutions[0].mappings[1].outputLabel, '田渊栋')
  assert.deepEqual(result.speakerResolutions[0].unresolved, ['说话人 1'])
  assert.ok(result.speakerOutputNormalizations.some((entry) => entry.phase === 'post_identity_finalization'))
  assert.equal(result.audit.status, 'ok')
  assert.ok(labels.findIndex((label) => label.startsWith('metadata:'))
    > labels.findIndex((label) => label.startsWith('refine:')))

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.speaker.identityFinalizations[0].contract, 'speaker_registry_v1')
  assert.deepEqual(manifest.speaker.identityFinalizations[0].changes, [{
    speakerTrackId: 'S000002',
    from: '说话人 2',
    to: '田渊栋',
  }])
  assert.equal(manifest.speaker.identityFinalizations[0].speakerTracks[1].canonicalLabel, '田渊栋')
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
