import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeSpeakerTrace, scanSpeakerNearMiss } from '../universal/speaker-trace.js'
import { buildRunParams, parseArgs } from '../universal/cli.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-speaker-trace-'))
}

// 完全虚构的样本：一份被截断时间戳弄坏标签的转录（“讲话人 1 00：12”被冒号切成标签“讲话人 1 00”）。
// 这里直接构造“已解析”的结构，所以本测试不依赖 speaker-resolver 的实现细节。
const BODY_LINE_1 = '我们在 2029 年做了第一台样机。'
const BODY_LINE_2 = '那一版一共只做了三台。'
function fakeParsedDocument() {
  return {
    speakerMode: 'tracked',
    labelLines: 2,
    needsResolution: false,
    lines: [
      `讲话人 1 00：12 ${BODY_LINE_1}`,
      '',
      `讲话人 1 00：40 ${BODY_LINE_2}`,
      '',
      '讲话人 2 这一行没有冒号，所以没被认成标签。',
    ],
    labels: [
      { line: 1, label: '讲话人 1 00', key: 'label:讲话人 1 00', kind: 'inline', generic: false },
      { line: 3, label: '讲话人 1 00', key: 'label:讲话人 1 00', kind: 'inline', generic: false },
    ],
    tracks: [
      { key: 'label:讲话人 1 00', sourceLabel: '讲话人 1 00', generic: false, roleLike: false, firstLine: 1, labelLines: 2 },
    ],
  }
}

test('近似漏判扫描认出截断时间戳、漏判的标签行和弱兜底占多数', () => {
  const scan = scanSpeakerNearMiss(fakeParsedDocument())

  assert.equal(scan.digitTailLabels.count, 2)
  assert.equal(scan.digitTailLabels.examples[0].labelToken, '讲话人 1 00')
  assert.equal(scan.missedGenericLines.count, 1)
  assert.equal(scan.missedGenericLines.examples[0].line, 5)
  assert.ok(!/没有冒号/.test(scan.missedGenericLines.examples[0].labelToken), '漏判样例只记标签片段，不带正文')
  assert.equal(scan.weakInlineLabels.inline, 2)
  assert.equal(scan.weakInlineLabels.strong, 0)
  assert.equal(scan.weakInlineLabels.dominates, true)
  assert.equal(scan.warnings.length, 3)
})

test('正常的泛称标签不会被当成截断时间戳', () => {
  const scan = scanSpeakerNearMiss({
    lines: ['说话人 1', '第一段。', 'Speaker 2', '第二段。'],
    labels: [
      { line: 1, label: '说话人 1', key: 'generic:1', kind: 'generic', generic: true },
      { line: 3, label: 'Speaker 2', key: 'generic:2', kind: 'generic', generic: true },
    ],
    tracks: [],
  })

  assert.equal(scan.digitTailLabels.count, 0)
  assert.equal(scan.missedGenericLines.count, 0, '已经认成标签的行不重复报')
  assert.equal(scan.warnings.length, 0)
})

test('关闭时一个文件都不写，所有方法可调用，finish() 返回 null', () => {
  const outputDir = tmpdir()
  const trace = makeSpeakerTrace(outputDir)

  assert.equal(trace.enabled, false)
  trace.parse('甲', fakeParsedDocument())
  trace.scout('甲', { chunkCount: 1, chunks: [], merged: {} })
  trace.mapping('甲', { mappings: [], unresolved: [] })
  trace.rewrite('甲', { changedLines: 2, labelLines: 2 })
  trace.enforce('甲', 'post_refine', { valid: true })
  trace.audit('甲', { mismatches: 0 })
  assert.equal(trace.finish(), null)

  assert.deepEqual(fs.readdirSync(outputDir), [], '默认关闭时不产生任何目录或文件')
})

test('开启后写出 .dev-trace 目录、只追加的事件文件，并且不落正文', () => {
  const outputDir = tmpdir()
  let tick = 0
  const trace = makeSpeakerTrace(outputDir, { enabled: true, now: () => `2029-03-04T00:00:${String(tick++).padStart(2, '0')}Z` })

  trace.parse('样本访谈', fakeParsedDocument())
  trace.scout('样本访谈', {
    chunkCount: 2,
    chunks: [
      { idx: 1, ok: true, speakers: [{ label: '讲话人 1 00', output_label: '林知远', output_label_confidence: 'high', role: '受访者' }] },
      { idx: 2, ok: false, speakers: [] },
    ],
    merged: {
      speakers: [{ label: '讲话人 1 00', output_label: '林知远', output_label_confidence: 'medium', role: '受访者' }],
      special_notes: ['第二块与第一块对同一人的称呼有冲突', `无关提醒：${BODY_LINE_2}`],
    },
  })
  trace.mapping('样本访谈', {
    mappings: [{ sourceLabel: '讲话人 1 00', outputLabel: '林知远', basis: 'scout_output_label', role: '受访者', labelLines: 2 }],
    unresolved: ['讲话人 2'],
    needsResolution: true,
  })
  trace.rewrite('样本访谈', { changedLines: 2, labelLines: 2 })
  trace.enforce('样本访谈', 'post_refine', {
    valid: false, changedLines: 1, labelLines: 3,
    replacements: [{ line: 1, from: '讲话人 1 00', to: '林知远' }],
    unknownLabels: [{ line: 9, label: '陈宁' }],
  })
  trace.audit('样本访谈', { phase: 'pre_audit', assessed: true, partyCount: 2, mismatches: 1, samples: [{ text: BODY_LINE_1 }] })

  const dir = path.join(outputDir, '.dev-trace')
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(trace.eventsPath).mode & 0o777, 0o600)
  assert.equal(path.basename(trace.eventsPath), 'speaker-trace.jsonl')

  const raw = fs.readFileSync(trace.eventsPath, 'utf8')
  const events = raw.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(events.map((e) => e.type), [
    'speaker_trace_started', 'speaker.parse', 'speaker.scout', 'speaker.mapping', 'speaker.rewrite', 'speaker.enforce', 'speaker.audit',
  ])
  assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3, 4, 5, 6, 7])
  for (const event of events) assert.match(event.at, /^2029-03-04T/)

  const parseEvent = events.find((e) => e.type === 'speaker.parse')
  assert.equal(parseEvent.fileLabel, '样本访谈')
  assert.equal(parseEvent.speakerMode, 'tracked')
  assert.equal(parseEvent.trackCount, 1)
  assert.equal(parseEvent.tracks[0].kind, 'inline')
  assert.equal(parseEvent.nearMiss.digitTailLabels.count, 2)

  const enforceEvent = events.find((e) => e.type === 'speaker.enforce')
  assert.equal(enforceEvent.phase, 'post_refine')
  assert.equal(enforceEvent.valid, false)
  assert.equal(enforceEvent.replacements, 1, '替换只记条数')
  assert.deepEqual(enforceEvent.unknownLabels, [{ line: 9, label: '陈宁' }])

  const scoutEvent = events.find((e) => e.type === 'speaker.scout')
  assert.equal(scoutEvent.chunks.length, 2)
  assert.equal(scoutEvent.chunks[1].ok, false)
  // 模型自由书写的备注可能逐字引用访谈内容，只计数、不落盘（只有“分段侦察对……”模板会保留原文）。
  assert.deepEqual(scoutEvent.merged.conflictNotes, [])
  assert.equal(scoutEvent.merged.otherNoteCount, 2)

  const auditEvent = events.find((e) => e.type === 'speaker.audit')
  assert.equal(auditEvent.summary.mismatches, 1)
  assert.equal(auditEvent.summary.samples, undefined, 'audit 摘要只留标量，样本不进来')

  assert.ok(!raw.includes(BODY_LINE_1), '访谈正文不得进入事件文件')
  assert.ok(!raw.includes(BODY_LINE_2), '与说话人无关的侦察提醒不得进入事件文件')
})

test('finish() 写出人读小结，含疑似问题信号', () => {
  const outputDir = tmpdir()
  const trace = makeSpeakerTrace(outputDir, { enabled: true })

  trace.parse('样本访谈', fakeParsedDocument())
  trace.mapping('样本访谈', { mappings: [], unresolved: ['讲话人 2'] })
  trace.enforce('样本访谈', 'final_contract', { valid: false, unknownLabels: [{ line: 9, label: '陈宁' }] })
  const done = trace.finish()

  assert.equal(done.summaryPath, path.join(outputDir, '.dev-trace', 'speaker-trace.md'))
  assert.equal(fs.statSync(done.summaryPath).mode & 0o777, 0o600)
  const summary = fs.readFileSync(done.summaryPath, 'utf8')
  assert.match(summary, /## 疑似问题信号/)
  assert.match(summary, /第 1 关　解析源文件/)
  assert.match(summary, /像被截断的时间戳/)
  assert.match(summary, /陈宁/)
  assert.match(summary, /讲话人 2/)
  assert.ok(!summary.includes(BODY_LINE_1), '小结里不得出现访谈正文')

  const events = fs.readFileSync(done.eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.at(-1).type, 'speaker_trace_finished')
  assert.equal(events.at(-1).fileCount, 1)
})

test('参数缺胳膊少腿也不抛异常，链路照跑', () => {
  const outputDir = tmpdir()
  const trace = makeSpeakerTrace(outputDir, { enabled: true })

  assert.doesNotThrow(() => {
    trace.parse(undefined, undefined)
    trace.parse('', { lines: 'not-an-array', labels: null, tracks: undefined })
    trace.scout('乙', null)
    trace.scout('乙', { chunkCount: '二', chunks: 'nope', merged: { speakers: null, special_notes: '冲突' } })
    trace.mapping('乙', { mappings: 'nope', unresolved: null })
    trace.rewrite('乙', {})
    trace.enforce('乙', undefined, { unknownLabels: 'nope', replacements: 'nope' })
    trace.audit('乙', 42)
    trace.audit('乙')
  })
  const done = trace.finish()
  assert.ok(fs.existsSync(done.summaryPath))
  const summary = fs.readFileSync(done.summaryPath, 'utf8')
  assert.match(summary, /（未命名文件）/)
  assert.match(summary, /## 疑似问题信号/)
})

test('--dev-trace 与 REFINER_DEV_TRACE=1 都能开出开发记录，默认不开', () => {
  const env = { HOME: '/tmp/refiner-home' }

  const args = parseArgs(['--dev-trace', '--topic', '样本项目', '--files', 'a.md'])
  assert.equal(args.devTrace, true)
  assert.equal(args.topic, '样本项目', '布尔开关不能吞掉后面的参数')
  assert.deepEqual(args.files, ['a.md'])

  assert.equal(buildRunParams({ topic: '样本项目' }, { env }).devTrace, undefined)
  assert.equal(buildRunParams(args, { env }).devTrace, true)
  assert.equal(buildRunParams({ topic: '样本项目' }, { env: { ...env, REFINER_DEV_TRACE: '1' } }).devTrace, true)
  assert.equal(buildRunParams({ topic: '样本项目' }, { env: { ...env, REFINER_DEV_TRACE: '0' } }).devTrace, undefined)
})

test('侦察备注只落盘流水线自己的冲突模板，模型自由书写的备注只计数', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-strace-notes-'))
  const trace = makeSpeakerTrace(outputDir, { enabled: true })
  trace.scout('A', {
    chunkCount: 2,
    chunks: [],
    merged: {
      speakers: [],
      special_notes: [
        '冲突：受访者原话“我们下周裁员 300 人，名单尚未公布”与另一段说法不一致',
        '分段侦察对“说话人 1”给出相互矛盾的高置信姓名（“林洄”与“陈遥”），已放弃自动命名，保留原始标签待人工确认。',
      ],
    },
  })
  trace.finish()
  const dir = path.join(outputDir, '.dev-trace')
  const all = fs.readFileSync(path.join(dir, 'speaker-trace.jsonl'), 'utf8')
    + fs.readFileSync(path.join(dir, 'speaker-trace.md'), 'utf8')
  assert.equal(all.includes('裁员'), false, '模型自由书写的备注内容不能落盘')
  assert.ok(all.includes('分段侦察对'), '流水线自己的冲突模板应保留')
  const scoutEvent = fs.readFileSync(path.join(dir, 'speaker-trace.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'speaker.scout')
  assert.equal(scoutEvent.merged.otherNoteCount, 1)
})

test('复用同一输出目录连跑两轮：本轮文件只含本轮，上一轮轮转为 prev', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-strace-rerun-'))
  const round1 = makeSpeakerTrace(outputDir, { enabled: true })
  round1.rewrite('第一轮', { changedLines: 1, labelLines: 1 })
  round1.finish()
  const round2 = makeSpeakerTrace(outputDir, { enabled: true })
  round2.rewrite('第二轮', { changedLines: 2, labelLines: 2 })
  round2.finish()
  const dir = path.join(outputDir, '.dev-trace')
  const events = fs.readFileSync(path.join(dir, 'speaker-trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.filter((e) => e.type === 'speaker_trace_started').length, 1, '本轮文件只允许一个开始事件')
  assert.equal(events[0].sequence, 1, '序号从 1 重新开始且不与上一轮混排')
  assert.ok(events.some((e) => e.fileLabel === '第二轮'))
  assert.equal(events.some((e) => e.fileLabel === '第一轮'), false, '上一轮事件不得留在本轮文件里')
  const prev = fs.readFileSync(path.join(dir, 'speaker-trace-prev.jsonl'), 'utf8')
  assert.ok(prev.includes('第一轮'), '上一轮完整轮转到 prev 文件')
  const md = fs.readFileSync(path.join(dir, 'speaker-trace.md'), 'utf8')
  assert.ok(md.includes('第二轮') && !md.includes('第一轮'), '小结与本轮 jsonl 一一对应')
})
