import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectDeclaredAiSummary,
  enforceCanonicalSpeakerLabels,
  parseSpeakerDocument,
  parseSpeakerLabels,
  resolveSpeakerMapping,
  rewriteSpeakerLabels,
} from '../scripts/speaker-resolver.js'

test('canonical speaker document distinguishes tracked transcripts from valid untracked monologues', () => {
  const tracked = parseSpeakerDocument('讲者1：第一段。\n讲者2：第二段。')
  assert.equal(tracked.speakerMode, 'tracked')
  assert.deepEqual(tracked.units.map((unit) => [unit.speaker, unit.text]), [
    ['讲者 1', '第一段。'],
    ['讲者 2', '第二段。'],
  ])

  const untracked = parseSpeakerDocument('第一段独白。\n仍是第一段。\n\n第二段独白。')
  assert.equal(untracked.speakerMode, 'untracked')
  assert.deepEqual(untracked.units.map((unit) => unit.text), ['第一段独白。\n仍是第一段。', '第二段独白。'])
})

test('AI-summary gate requires an explicit provenance disclosure, not a title or monologue shape', () => {
  const declared = detectDeclaredAiSummary('<title>智能纪要：示例</title>\n> 智能纪要由 AI 生成，可能不准确，请谨慎甄别后使用')
  assert.equal(declared.declared, true)
  assert.equal(declared.kind, 'declared_ai_summary')
  assert.equal(declared.line, 2)

  assert.equal(detectDeclaredAiSummary('# 智能纪要\n\n这是一篇没有说话人标签的正常独白。').declared, false)
  assert.equal(detectDeclaredAiSummary('这是人工整理的会议摘要，但没有声明由 AI 生成。').declared, false)
})

test('speaker resolver recognizes generic, 讲者, Feishu cite, timestamp and recurring inline labels', () => {
  const source = [
    '**发言人 1 00:00:01**',
    '你好。',
    '讲者2：我先回答。',
    '<cite uid-ref="ou_123" user-name="陈佳惠"></cite> 00:00:03',
    '我再追问。',
    '张月光 00:00:04',
    '继续回答。',
    '记者：问题一。',
    '记者：问题二。',
  ].join('\n')
  const parsed = parseSpeakerLabels(source)
  assert.deepEqual(parsed.tracks.map((track) => track.sourceLabel), ['发言人 1', '讲者 2', '陈佳惠', '张月光', '记者'])
  assert.equal(parsed.labelLines, 6)
  assert.equal(parsed.needsResolution, true)
})

test('speaker resolver uses the Scout visible label, then identity, then role fallback', () => {
  const source = [
    '发言人1 00:01',
    '我是刘益枫。',
    '发言人2 00:02',
    '请介绍一下。',
    '发言人3 00:03',
    '我补充一句。',
  ].join('\n')
  const result = resolveSpeakerMapping(source, [
    { label: '发言人 1', output_label: '刘益枫', output_label_confidence: 'high', output_label_evidence: '开场自我介绍“我是刘益枫”', role: '受访者', identity: '刘益枫，某公司创始人' },
    { label: '发言人2', role: '记者', identity: '陈佳惠，记者', output_label_confidence: 'high', output_label_evidence: '受访者直接称呼“佳惠”' },
    { label: '发言人3', role: 'PR' },
  ])
  assert.deepEqual(result.mappings.map((mapping) => [mapping.sourceLabel, mapping.outputLabel, mapping.basis]), [
    ['发言人 1', '刘益枫', 'scout_output_label'],
    ['发言人 2', '陈佳惠', 'scout_identity'],
    ['发言人 3', 'PR', 'scout_role'],
  ])
})

test('speaker resolver refuses a guessed person name without high-confidence transcript evidence', () => {
  const source = '说话人1 00:01\n赵磊，你们组多少个人？'
  const result = resolveSpeakerMapping(source, [{
    label: '说话人1',
    role: '受访者',
    identity: '赵磊，疑似受访者',
    output_label: '赵磊',
    output_label_confidence: 'medium',
    output_label_evidence: '该轨道正文提到赵磊',
  }])
  assert.equal(result.mappings[0].outputLabel, '受访者')
  assert.equal(result.mappings[0].basis, 'scout_role')
})

test('speaker resolver never downgrades an existing person name to a generic role', () => {
  const source = '<cite uid-ref="ou_123" user-name="陈佳惠"></cite> 00:00:03\n请介绍一下。'
  const result = resolveSpeakerMapping(source, [{ label: '陈佳惠 (uid-ref=ou_123)', output_label: '记者', role: '记者' }])
  assert.equal(result.mappings[0].outputLabel, '陈佳惠')
  assert.equal(result.mappings[0].basis, 'source_name')
})

test('speaker resolver distinguishes two unidentified tracks with the same role', () => {
  const source = '说话人1 00:01\n问题一。\n说话人2 00:02\n问题二。'
  const result = resolveSpeakerMapping(source, [
    { label: '说话人1', role: '记者' },
    { label: '说话人2', role: '记者' },
  ])
  assert.deepEqual(result.mappings.map((mapping) => mapping.outputLabel), ['记者 1', '记者 2'])
})

test('speaker rewrite changes label lines only, removes timestamps and preserves line count/body', () => {
  const source = [
    '**发言人 1 00:00:01**',
    '我们今年做了 3 次试验。',
    '',
    '发言人2：那成功率呢？',
    '这行正文不能动：其中的冒号也不能触发替换。',
  ].join('\n')
  const result = rewriteSpeakerLabels(source, [
    { label: '发言人1', output_label: '张月光', output_label_confidence: 'high', output_label_evidence: '本人自我介绍', role: '受访者' },
    { label: '发言人 2', output_label: '陈佳惠', output_label_confidence: 'high', output_label_evidence: '对方直接称呼', role: '记者' },
  ])
  assert.equal(result.text, [
    '张月光：',
    '我们今年做了 3 次试验。',
    '',
    '陈佳惠：那成功率呢？',
    '这行正文不能动：其中的冒号也不能触发替换。',
  ].join('\n'))
  assert.equal(result.text.split('\n').length, source.split('\n').length)
  assert.equal(result.changedLines, 2)
})

test('speaker rewrite can preserve timestamps without changing the pipeline contract', () => {
  const result = rewriteSpeakerLabels('发言人1 00:01:02\n正文。', [{
    label: '发言人1',
    output_label: '张月光',
    output_label_confidence: 'high',
    output_label_evidence: '本人自我介绍',
    role: '受访者',
  }], { keepTimestamps: true })
  assert.equal(result.text, '张月光 00:01:02：\n正文。')
})

test('output enforcement applies the same canonical mapping without re-inferring identities', () => {
  const refined = [
    '记者/访谈者：请介绍一下。',
    '受访者/业内工程师：我们先说产品。',
    '说话人 1：再追问一个问题。',
    '说话人 2：我继续回答。',
  ].join('\n')
  const mappings = [
    { sourceLabel: '说话人 1', outputLabel: '陈佳惠', role: '记者' },
    { sourceLabel: '说话人 2', outputLabel: '刘益枫', role: '受访者' },
  ]
  const result = enforceCanonicalSpeakerLabels(refined, mappings)
  assert.equal(result.text, [
    '陈佳惠：请介绍一下。',
    '刘益枫：我们先说产品。',
    '陈佳惠：再追问一个问题。',
    '刘益枫：我继续回答。',
  ].join('\n'))
  assert.equal(result.changedLines, 4)
  assert.deepEqual(result.unknownLabels, [])
})

test('output enforcement moves a confirmed label-only turn body onto the label line', () => {
  const refined = [
    '记者：',
    '请介绍一下。',
    '',
    '受访者：',
    '',
    '我们先说产品。',
    '这是同一轮的第二段。',
  ].join('\n')
  const mappings = [
    { sourceLabel: '说话人 1', outputLabel: '记者', role: '记者' },
    { sourceLabel: '说话人 2', outputLabel: '受访者', role: '受访者' },
  ]
  const result = enforceCanonicalSpeakerLabels(refined, mappings)
  assert.equal(result.text, [
    '记者：请介绍一下。',
    '',
    '受访者：我们先说产品。',
    '这是同一轮的第二段。',
  ].join('\n'))
  assert.equal(result.labelLines, 2)
  assert.equal(result.valid, true)
})

test('output enforcement leaves inline turns and structural followers unchanged', () => {
  const refined = [
    '记者：已经同行。',
    '',
    '受访者：',
    '## 新话题',
    '',
    '记者：',
    '<!-- 源 L10-L20 -->',
  ].join('\n')
  const mappings = [
    { sourceLabel: '说话人 1', outputLabel: '记者', role: '记者' },
    { sourceLabel: '说话人 2', outputLabel: '受访者', role: '受访者' },
  ]
  const once = enforceCanonicalSpeakerLabels(refined, mappings)
  const twice = enforceCanonicalSpeakerLabels(once.text, mappings)
  assert.equal(once.text, refined)
  assert.equal(twice.text, refined)
  assert.equal(once.valid, true)
})

test('output enforcement leaves an unknown invented name untouched for audit instead of guessing', () => {
  const refined = '王小明：这句话是谁说的并不确定。\n王小明：第二次出现后可确认它是一个未知标签。'
  const result = enforceCanonicalSpeakerLabels(refined, [
    { sourceLabel: '说话人 1', outputLabel: '记者', role: '记者' },
    { sourceLabel: '说话人 2', outputLabel: '受访者', role: '受访者' },
  ])
  assert.equal(result.text, refined)
  assert.deepEqual(result.unknownLabels, [{ line: 1, label: '王小明' }, { line: 2, label: '王小明' }])
})

test('untracked source contract rejects model-invented speaker labels and accepts a label-free monologue', () => {
  const invented = enforceCanonicalSpeakerLabels('记者：第一段。\n记者：第二段。', [], { speakerMode: 'untracked' })
  assert.equal(invented.valid, false)
  assert.deepEqual(invented.violations.map((item) => item.kind), ['invented_speaker_label', 'invented_speaker_label'])

  const faithful = enforceCanonicalSpeakerLabels('第一段独白。\n\n第二段独白。', [], { speakerMode: 'untracked' })
  assert.equal(faithful.valid, true)
  assert.deepEqual(faithful.violations, [])
})
