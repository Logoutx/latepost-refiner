import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderTrace, resolveTracePath, parseLines, collectSignals } from '../scripts/dev-trace-view.mjs'
import { makeSpeakerTrace } from '../universal/speaker-trace.js'
import { parseSpeakerDocument } from '../scripts/speaker-resolver.js'

// 所有样本均为虚构。

function sampleEvents() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-view-'))
  const trace = makeSpeakerTrace(outputDir, { enabled: true })
  const parsed = parseSpeakerDocument(['说话人 1 00:01\\', '你好。', '', '说话人 2 00:05\\', '你好。'].join('\n'))
  trace.parse('甲', parsed)
  trace.scout('甲', {
    chunkCount: 2,
    chunks: [{ idx: 1, ok: true, speakers: [] }, { idx: 2, ok: true, speakers: [] }],
    merged: { speakers: [{ label: '说话人 1', output_label: '记者', output_label_confidence: 'high', role: '记者' }], special_notes: ['分段侦察对“说话人 1”给出相互矛盾的高置信姓名（“林洄”与“陈遥”），已放弃自动命名，保留原始标签待人工确认。', '自由备注不落盘'] },
  })
  trace.mapping('甲', { needsResolution: true, mappings: [{ sourceLabel: '说话人 1', outputLabel: '记者', basis: 'scout_output_label', role: '记者', labelLines: 1 }], unresolved: ['说话人 2'] })
  trace.rewrite('甲', { changedLines: 2, labelLines: 2 })
  trace.enforce('甲', 'post_refine', { valid: false, unknownLabels: [{ line: 9, label: '陈宁' }], replacements: [], changedLines: 0, labelLines: 2 })
  trace.audit('甲', { phase: 'pre_audit', assessed: false, mismatches: 0 })
  trace.finish()
  const jsonl = path.join(outputDir, '.dev-trace', 'speaker-trace.jsonl')
  return { outputDir, jsonl, events: parseLines(fs.readFileSync(jsonl, 'utf8')) }
}

test('渲染视图覆盖 6 个阶段，并汇总疑似问题信号', () => {
  const { events } = sampleEvents()
  const text = renderTrace(events)
  for (const heading of ['第 1 关 解析', '第 2 关 侦察', '第 3 关 映射', '第 4 关 改写', '第 5 关 出稿校验', '第 6 关 审计']) {
    assert.ok(text.includes(heading), `缺少 ${heading}`)
  }
  assert.ok(text.includes('运行已结束'))
  assert.ok(text.includes('疑似问题信号'))
  assert.ok(text.includes('陈宁'), '出稿校验的未知标签应出现在视图里')
  assert.ok(text.includes('仍未确定身份'), '未定映射应出现在视图里')
  assert.ok(text.includes('相互矛盾'), '侦察冲突模板应出现在视图里')
  assert.ok(text.includes('自由备注不落盘') === false, '自由备注内容不应出现在任何视图里')
})

test('信号汇总：校验不通过、审计未评估、映射未定都会被点名', () => {
  const { events } = sampleEvents()
  const signals = collectSignals(events)
  assert.ok(signals.some((s) => s.includes('出稿校验') && s.includes('不通过')))
  assert.ok(signals.some((s) => s.includes('未能评估')))
  assert.ok(signals.some((s) => s.includes('仍未确定身份')))
})

test('路径解析接受运行输出目录、.dev-trace 目录或 jsonl 文件本身', () => {
  const { outputDir, jsonl } = sampleEvents()
  assert.equal(resolveTracePath(outputDir).jsonl, jsonl)
  assert.equal(resolveTracePath(path.join(outputDir, '.dev-trace')).jsonl, jsonl)
  assert.equal(resolveTracePath(jsonl).jsonl, jsonl)
  assert.equal(resolveTracePath(outputDir).exists, true)
})

test('损坏或半截的 jsonl 行被跳过，不影响其余渲染', () => {
  const events = parseLines('{"type":"speaker_trace_started","at":"2026-07-28T00:00:00Z"}\n{oops\n{"type":"speaker_trace_finished","at":"2026-07-28T00:01:00Z","fileCount":1}\n')
  assert.equal(events.length, 2)
  assert.ok(renderTrace(events).includes('运行已结束'))
})
