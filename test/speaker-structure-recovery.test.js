import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enforceCanonicalSpeakerLabels,
  parseSpeakerDocument,
  resolveSpeakerMapping,
  rewriteSpeakerLabels,
  splitLeadingTimestamp,
} from '../scripts/speaker-resolver.js'

const confident = (label, outputLabel, role, sample) => ({
  label,
  role,
  output_label: outputLabel,
  output_label_confidence: 'high',
  output_label_evidence: `原文直接支持 ${outputLabel}`,
  sample,
})

test('leading-timecode grammar factors wrappers, precision, label spellings, colon width and hard breaks', () => {
  const timecodes = ['0:03', '00:03:22', '[00:03]', '(00:03.250)', '【00:03,250】', '00′03″', 'T+00:03']
  const labels = [
    ['说话人 1', 'generic:1'],
    ['讲者2', 'generic:2'],
    ['Speaker ３', 'generic:3'],
  ]
  const colons = ['：', ':']
  let cases = 0
  for (const timecode of timecodes) {
    for (const [label, key] of labels) {
      for (const colon of colons) {
        for (const hardBreak of [false, true]) {
          const source = `${timecode} ${label}${colon}正文${hardBreak ? '\\' : ''}`
          const parsed = parseSpeakerDocument(source)
          assert.equal(parsed.speakerMode, 'tracked', source)
          assert.equal(parsed.tracks.length, 1, source)
          assert.equal(parsed.tracks[0].key, key, source)
          assert.equal(parsed.units[0].text, `正文${hardBreak ? '\\' : ''}`, source)
          assert.ok(parsed.units[0].ts, source)
          cases += 1
        }
      }
    }
  }
  assert.equal(cases, 84)
})

test('leading timecodes support generic label-only and Feishu cite shapes without changing line count', () => {
  const source = [
    '[00:03.120] 说话人 1',
    '第一段。',
    '【00:05,250】 <cite uid-ref="ou_1" user-name="李四"></cite>',
    '第二段。',
  ].join('\n')
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.speakerMode, 'tracked')
  assert.deepEqual(parsed.tracks.map((track) => track.sourceLabel), ['说话人 1', '李四'])
  assert.deepEqual(parsed.units.map((unit) => unit.ts), ['00:03.120', '00:05,250'])

  const rewritten = rewriteSpeakerLabels(source, [
    confident('说话人 1', '记者', '记者', '[00:03.120] 说话人 1'),
  ], { keepTimestamps: true })
  assert.equal(rewritten.text.split('\n').length, source.split('\n').length)
  assert.match(rewritten.text, /^记者 00:03\.120：/u)
})

test('already parsed generic tracks do not require Scout sample text to match exactly', () => {
  const source = '说话人 1 00:01\n第一段。\n说话人 1 00:02\n第二段。'
  const resolution = resolveSpeakerMapping(source, [
    confident('说话人 1', '受访者', '受访者', '说话人 1：模型改写过的非原文样例'),
  ])
  assert.equal(resolution.speakerMode, 'tracked')
  assert.deepEqual(resolution.structureWarnings, [])
  assert.deepEqual(resolution.mappings.map((mapping) => mapping.outputLabel), ['受访者'])
})

test('already parsed Feishu cite tracks accept the verbatim cite label without a redundant exact sample', () => {
  const source = '<cite type="user" uid-ref="u1" user-name="李梓楠"></cite> 00:00:03\n先问一个问题。'
  const resolution = resolveSpeakerMapping(source, [
    confident('<cite type="user" uid-ref="u1" user-name="李梓楠"></cite>', '李梓楠', '记者', '李梓楠：非原文样例'),
  ])
  assert.equal(resolution.speakerMode, 'tracked')
  assert.deepEqual(resolution.structureWarnings, [])
  assert.deepEqual(resolution.mappings.map((mapping) => mapping.outputLabel), ['李梓楠'])
})

test('one known label recovers the same track behind an unfamiliar timestamp wrapper', () => {
  const source = [
    '说话人 1：第一段。',
    '⟦00:03⟧ 说话人 1',
    '第二段。',
  ].join('\n')
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.speakerMode, 'tracked')
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.tracks[0].labelLines, 2)
  assert.deepEqual(parsed.units.map((unit) => unit.text), ['第一段。', '第二段。'])
  assert.deepEqual(parsed.recoveredByKnownLabel, [{ line: 2, label: '说话人 1' }])
})

test('a leading timecode is metadata: named inline tracks wait for exact Scout evidence', () => {
  const source = [
    '[00:03] 张三：先说结论。',
    '(00:05.250) 李四：我再追问。',
  ].join('\n')
  const beforeScout = parseSpeakerDocument(source)
  assert.equal(beforeScout.speakerMode, 'ambiguous')
  assert.equal(beforeScout.tracks.length, 0)

  const scouts = [
    confident('张三', '张三', '受访者', '[00:03] 张三：先说结论。'),
    confident('李四', '李四', '记者', '(00:05.250) 李四：我再追问。'),
  ]
  const resolution = resolveSpeakerMapping(source, scouts)
  assert.equal(resolution.speakerMode, 'tracked')
  assert.deepEqual(resolution.mappings.map((mapping) => mapping.outputLabel), ['张三', '李四'])
  assert.deepEqual(resolution.recoveredByScout.map((item) => item.line), [1, 2])

  const rewritten = rewriteSpeakerLabels(source, scouts)
  assert.equal(rewritten.text, '张三：先说结论。\n李四：我再追问。')
})

test('Scout can recover label-only named turns from exact source-line evidence', () => {
  const source = [
    '⟦00:03⟧ 张三',
    '先说结论。',
    '',
    '⟦00:05⟧ 李四',
    '我再追问。',
  ].join('\n')
  assert.equal(parseSpeakerDocument(source).speakerMode, 'ambiguous', 'unknown decorator is not guessed or silently treated as monologue')

  const scouts = [
    confident('张三', '张三', '受访者', '⟦00:03⟧ 张三'),
    confident('李四', '李四', '记者', '⟦00:05⟧ 李四'),
  ]
  const resolution = resolveSpeakerMapping(source, scouts)
  assert.equal(resolution.speakerMode, 'tracked')
  assert.equal(resolution.parsed.labelLines, 2)
  const recovered = parseSpeakerDocument(source, { scoutSpeakers: scouts })
  assert.deepEqual(recovered.units.map((unit) => [unit.speaker, unit.text]), [
    ['张三', '先说结论。'],
    ['李四', '我再追问。'],
  ])
})

test('Scout roles count as structural evidence even though they are not concrete person names', () => {
  const source = '⟦00:03⟧ 甲方开始。\n⟦00:05⟧ 乙方继续。'
  const resolution = resolveSpeakerMapping(source, [
    confident('说话人 1', '记者', '记者', '并非原文逐字行'),
    confident('说话人 2', '受访者', '受访者', '也并非原文逐字行'),
  ])
  assert.equal(resolution.speakerMode, 'ambiguous')
  assert.equal(resolution.parsed.tracks.length, 0)
  assert.ok(resolution.structureWarnings.some((warning) => warning.kind === 'scout_parser_disagreement'))
})

test('one unsupported Scout claim cannot turn a valid monologue into an ambiguous interview', () => {
  const source = '这是第一段独白。\n\n这是第二段独白。'
  const result = resolveSpeakerMapping(source, [
    confident('主讲人', '张三', '主讲人', '源文没有这一行'),
  ])
  assert.equal(result.speakerMode, 'untracked')
  assert.equal(result.parsed.tracks.length, 0)
})

test('agenda markers and time-prefixed prose never become speakers without verified evidence', () => {
  const source = [
    '00:03 开场',
    '00:10 议程介绍',
    '3:30 的会议改到周五，他问张三：可以吗？',
    '[00:20](https://example.test/time) 项目链接',
    '02:01 是最终比分。',
  ].join('\n')
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.speakerMode, 'ambiguous', 'two label-shaped agenda rows are honestly ambiguous')
  assert.equal(parsed.tracks.length, 0)
})

test('label-only names after known timecodes are ambiguous until Scout verifies an exact line', () => {
  const source = '[00:03] 张三\n第一段。\n[00:05] 李四\n第二段。'
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.speakerMode, 'ambiguous')
  assert.equal(parsed.tracks.length, 0)
  assert.deepEqual(parsed.structureWarnings[0].lines, [1, 3])
})

test('an unfamiliar full-width timecode falls back to verified Scout evidence instead of a format enum', () => {
  const source = '００：０３ 张三：第一段。\n００：０５ 李四：第二段。'
  assert.equal(parseSpeakerDocument(source).speakerMode, 'ambiguous')

  const resolution = resolveSpeakerMapping(source, [
    confident('张三', '张三', '受访者', '００：０３ 张三：第一段。'),
    confident('李四', '李四', '记者', '００：０５ 李四：第二段。'),
  ])
  assert.equal(resolution.speakerMode, 'tracked')
  assert.deepEqual(resolution.mappings.map((mapping) => mapping.outputLabel), ['张三', '李四'])
})

test('a recognized track cannot hide a second unresolved label format', () => {
  const source = [
    '说话人 1：先问一个问题。',
    '⟦00:03⟧ 张三',
    '这是第一段回答。',
    '说话人 1：继续追问。',
    '⟦00:05⟧ 张三',
    '这是第二段回答。',
  ].join('\n')
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.speakerMode, 'ambiguous')
  assert.ok(parsed.structureWarnings.some((warning) => warning.kind === 'unrecognized_speaker_structure'))

  const resolution = resolveSpeakerMapping(source, [
    confident('说话人 1', '记者', '记者', '说话人 1：先问一个问题。'),
    confident('张三', '张三', '受访者', '⟦00:03⟧ 张三'),
  ])
  assert.equal(resolution.speakerMode, 'tracked')
  assert.deepEqual(resolution.mappings.map((mapping) => mapping.outputLabel), ['记者', '张三'])
})

test('repeated time-prefixed prose with a colon stays ambiguous instead of being promoted by occurrence count', () => {
  const source = [
    '3:30 他说：会议改到周五。',
    '3:40 他说：大家都同意了。',
  ].join('\n')
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.speakerMode, 'ambiguous')
  assert.equal(parsed.tracks.length, 0)
})

test('Scout evidence must match a complete source line before it can create a track', () => {
  const source = '[00:03] 张三：先说结论。\n[00:05] 李四：继续。'
  const resolution = resolveSpeakerMapping(source, [
    confident('张三', '张三', '受访者', '张三：先说结论。'),
    confident('李四', '李四', '记者', '李四：继续。'),
  ])
  assert.equal(resolution.speakerMode, 'ambiguous')
  assert.equal(resolution.parsed.tracks.length, 0)
  assert.ok(resolution.structureWarnings.some((warning) => warning.kind === 'scout_parser_disagreement'))
})

test('mismatched wrappers are not accepted by the deterministic timecode grammar', () => {
  for (const line of ['[00:03) 说话人 1：正文', '(00:03] 说话人 1：正文', '【00:03) 说话人 1：正文']) {
    const split = splitLeadingTimestamp(line)
    assert.equal(split.matched, false, line)
    assert.equal(parseSpeakerDocument(line).tracks.length, 0, line)
  }
})

test('NFKC comma folding cannot mint a prose fragment as a recurring speaker label', () => {
  const source = '我跟他说，这周：先别排。\n我跟他说，这周：下周再看。'
  const parsed = parseSpeakerDocument(source)
  assert.equal(parsed.speakerMode, 'untracked')
  assert.equal(parsed.tracks.length, 0)
})

test('ambiguous output labels fail closed with their own violation kind', () => {
  const result = enforceCanonicalSpeakerLabels('记者：第一段。\n受访者：第二段。', [], {
    speakerMode: 'ambiguous',
  })
  assert.equal(result.valid, false)
  assert.deepEqual(result.violations.map((item) => item.kind), [
    'unverified_speaker_label',
    'unverified_speaker_label',
  ])
})
