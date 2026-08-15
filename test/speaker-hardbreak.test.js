import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseSpeakerDocument,
  resolveSpeakerMapping,
  rewriteSpeakerLabels,
  enforceCanonicalSpeakerLabels,
} from '../scripts/speaker-resolver.js'

// Pandoc(docx→md) 导出的转录稿会在每一行行尾加一个 Markdown 硬换行：一个反斜杠，紧贴在换行符之前，
// 如 `说话人 1 00:01\`。旧解析器的严格标签正则不吃这个反斜杠，于是说话人标签行退化成普通正文，
// 兜底的“姓名：正文”通用匹配又会在时间戳内部的冒号处误切，铸出“说话人 1 00”这样的假标签。
// 本文件覆盖“行尾硬换行”这一类场景下说话人标签解析、重写与出稿校验的正确行为。

test('Pandoc 行尾硬换行的编号说话人标签解析为正确轨道数', () => {
  const doc = [
    '**测试访谈**',
    '',
    '说话人 1 00:01\\',
    '你最近项目节奏怎么样？\\',
    '',
    '说话人 2 00:06\\',
    '最近还行，主要在做迁移。\\',
    '',
    '说话人 1 01:12\\',
    '那你们物流环节呢？\\',
    '',
    '说话人 2 01:20\\',
    '这块最近压力挺大的。\\',
  ].join('\n')

  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.speakerMode, 'tracked')
  assert.equal(parsed.labelLines, 4)
  assert.equal(parsed.tracks.length, 2)
  assert.deepEqual(parsed.tracks.map((track) => track.key).sort(), ['generic:1', 'generic:2'])
  // 正文本身的行尾硬换行不属于标签，必须原样保留，不能被标签解析顺手吃掉。
  assert.ok(parsed.units.every((unit) => unit.text.endsWith('\\')), '正文逐条保留行尾反斜杠')
})

test('同一说话人跨分钟不会按分钟裂成多轨', () => {
  // 40 轮对话，分钟数 00..19 递增；旧的“时间戳内部冒号误切”兜底一旦触发，
  // 每个不同分钟数都会长成一个独一无二的假标签，轨道数会随分钟数膨胀。
  const lines = []
  for (let m = 0; m < 20; m += 1) {
    const mm = String(m).padStart(2, '0')
    lines.push(`说话人 1 ${mm}:00\\`, '继续。\\', '')
    lines.push(`说话人 2 ${mm}:30\\`, '好的。\\', '')
  }
  const doc = lines.join('\n')

  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2, '不能因为分钟数不同而裂成多轨（回归防护：102 轨爆炸）')
  assert.equal(parsed.labelLines, 40)
})

test('加粗标签加硬换行仍解析', () => {
  const doc = ['**发言人 1 00:00:01**\\', '你好。\\'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.tracks[0].key, 'generic:1')
})

test('飞书 cite 标签加硬换行仍解析', () => {
  const doc = ['<cite uid-ref="ou_1" user-name="陈遥"></cite> 00:00:03\\', '继续。\\'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 1)
  // cite 分支自带的 key 才带 feishu: 前缀（轨道去重用的是按标签文本算出的 matchKey）。
  assert.equal(parsed.labels[0].key, 'feishu:ou_1')
  assert.equal(parsed.labels[0].kind, 'cite')
})

test('具名时间戳加硬换行仍解析（多轮出现）', () => {
  const doc = ['林洄 00:00:04\\', '先说结论。\\', '', '林洄 00:01:10\\', '继续回答。\\'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.tracks[0].key, 'label:林洄')
  assert.equal(parsed.labelLines, 2)
})

test('重写标签时默认去时间戳、保留正文硬换行', () => {
  const doc = [
    '**测试访谈**',
    '',
    '说话人 1 00:01\\',
    '你最近项目节奏怎么样？\\',
    '',
    '说话人 2 00:06\\',
    '最近还行，主要在做迁移。\\',
    '',
    '说话人 1 01:12\\',
    '那你们物流环节呢？\\',
    '',
    '说话人 2 01:20\\',
    '这块最近压力挺大的。\\',
  ].join('\n')
  const records = [
    { label: '说话人 1', role: '记者', output_label: '记者', output_label_confidence: 'high', output_label_evidence: '自称记者' },
    { label: '说话人 2', role: '受访者', identity: '林洄', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '对方称呼' },
  ]
  const result = rewriteSpeakerLabels(doc, records)

  assert.equal(result.text, [
    '**测试访谈**',
    '',
    '记者：',
    '你最近项目节奏怎么样？\\',
    '',
    '林洄：',
    '最近还行，主要在做迁移。\\',
    '',
    '记者：',
    '那你们物流环节呢？\\',
    '',
    '林洄：',
    '这块最近压力挺大的。\\',
  ].join('\n'))
  assert.equal(result.mappings.length, 2)
  assert.deepEqual(result.unresolved, [])
})

test('保留时间戳选项在硬换行标签上生效', () => {
  const doc = [
    '**测试访谈**',
    '',
    '说话人 1 00:01\\',
    '你最近项目节奏怎么样？\\',
    '',
    '说话人 2 00:06\\',
    '最近还行，主要在做迁移。\\',
    '',
    '说话人 1 01:12\\',
    '那你们物流环节呢？\\',
    '',
    '说话人 2 01:20\\',
    '这块最近压力挺大的。\\',
  ].join('\n')
  const records = [
    { label: '说话人 1', role: '记者', output_label: '记者', output_label_confidence: 'high', output_label_evidence: '自称记者' },
    { label: '说话人 2', role: '受访者', identity: '林洄', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '对方称呼' },
  ]
  const result = rewriteSpeakerLabels(doc, records, { keepTimestamps: true })

  assert.equal(result.text, [
    '**测试访谈**',
    '',
    '记者 00:01：',
    '你最近项目节奏怎么样？\\',
    '',
    '林洄 00:06：',
    '最近还行，主要在做迁移。\\',
    '',
    '记者 01:12：',
    '那你们物流环节呢？\\',
    '',
    '林洄 01:20：',
    '这块最近压力挺大的。\\',
  ].join('\n'))
})

test('通用行内标签的正文保留行尾反斜杠', () => {
  // “姓名：正文”这种一行内既有标签又有正文的形式，不属于“仅标签、行尾锚定”的模式，
  // 修复不应该去碰它——正文的硬换行必须原样留在正文里。
  const doc = '说话人 1：这是正文\\'
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 1)

  const result = rewriteSpeakerLabels(doc, [
    { label: '说话人 1', output_label: '记者', output_label_confidence: 'high', output_label_evidence: '自称记者', role: '记者' },
  ])
  assert.ok(result.text.endsWith('\\'), '行内标签的正文部分保留行尾反斜杠')
})

test('截断式伪标签在成稿 enforcement 中仍被判未知', () => {
  // 说明：这一行没有硬换行——它模拟的是模型精校后残留的“说话人 1 00”这类截断伪标签。
  // 只出现一次的行内标签过不了 parseSpeakerLabels 的准入门槛（需重复 ≥2 次或是角色词），
  // 不会被识别为标签；enforcement 里的 TRUNCATED_GENERIC_RE 兜底专门盯这类
  // “通用前缀 + 编号 + 第二个数字”的截断签名，把它计入未知标签、fail closed。
  const result = enforceCanonicalSpeakerLabels('说话人 1 00：正文。', [
    { sourceLabel: '说话人 1', outputLabel: '记者', role: '记者' },
  ])
  assert.equal(result.valid, false, '截断伪标签不应被判定为合法成稿')
  assert.ok(result.unknownLabels.some((item) => item.label === '说话人 1 00'), '截断伪标签应出现在未知标签清单里')
})

test('无硬换行文档行为与修复前一致', () => {
  const doc = [
    '**测试访谈**',
    '',
    '说话人 1 00:01',
    '你最近项目节奏怎么样？',
    '',
    '说话人 2 00:06',
    '最近还行，主要在做迁移。',
    '',
    '说话人 1 01:12',
    '那你们物流环节呢？',
    '',
    '说话人 2 01:20',
    '这块最近压力挺大的。',
  ].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2)
  assert.equal(parsed.labelLines, 4)

  const colonDoc = [
    '记者：你最近项目节奏怎么样？',
    '林洄：最近还行，主要在做迁移。',
    '记者：那你们物流环节呢？',
    '林洄：这块最近压力挺大的。',
  ].join('\n')
  const colonParsed = parseSpeakerDocument(colonDoc)
  assert.equal(colonParsed.tracks.length, 2)
  assert.equal(colonParsed.labelLines, 4)
})

test('resolveSpeakerMapping 在硬换行文档上产出两条映射', () => {
  const doc = [
    '**测试访谈**',
    '',
    '说话人 1 00:01\\',
    '你最近项目节奏怎么样？\\',
    '',
    '说话人 2 00:06\\',
    '最近还行，主要在做迁移。\\',
    '',
    '说话人 1 01:12\\',
    '那你们物流环节呢？\\',
    '',
    '说话人 2 01:20\\',
    '这块最近压力挺大的。\\',
  ].join('\n')
  const records = [
    { label: '说话人 1', role: '记者', output_label: '记者', output_label_confidence: 'high', output_label_evidence: '自称记者' },
    { label: '说话人 2', role: '受访者', identity: '林洄', output_label: '林洄', output_label_confidence: 'high', output_label_evidence: '对方称呼' },
  ]
  const result = resolveSpeakerMapping(doc, records)

  assert.equal(result.mappings.length, 2)
  assert.equal(result.parsed.needsResolution, true)
  assert.deepEqual(result.mappings.map((mapping) => mapping.key).sort(), ['generic:1', 'generic:2'])
  const byKey = new Map(result.mappings.map((mapping) => [mapping.key, mapping.outputLabel]))
  assert.equal(byKey.get('generic:1'), '记者')
  assert.equal(byKey.get('generic:2'), '林洄')
})

// ---------- 对抗评审回归（2026-07-28 Grok/Codex 评审发现） ----------

test('周姓人名不被星期误杀：周一鸣带时间戳硬换行仍是合法轨道', () => {
  const doc = [
    '周一鸣 00:04\\', '我先介绍一下背景。\\', '',
    '陈遥 00:12\\', '好的，你说。', '',
    '周一鸣 00:40\\', '我们是 2024 年立项的。\\', '',
    '陈遥 01:05\\', '规模有多大？',
  ].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2)
  assert.ok(parsed.tracks.some((track) => track.key === 'label:周一鸣'))
})

test('编号称呼（选手2号）不被日期形态误杀', () => {
  const doc = ['选手2号：我准备好了。', '教练：开始吧。', '选手2号：好。', '教练：注意节奏。'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.ok(parsed.tracks.some((track) => track.sourceLabel === '选手2号'))
})

test('日期与时段标签仍被拒绝：日期头行不成轨、纯时段词不成轨', () => {
  const doc = ['2026年7月2日 下午 3:37\\', '', '说话人 1 00:01\\', '你好。\\', '', '说话人 2 00:05\\', '你好。'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2, '日期头行不应成为第三条轨道')
  const weekday = parseSpeakerDocument(['周三 14:00\\', '例会内容。', '', '下午 15:00\\', '继续讨论。'].join('\n'))
  assert.equal(weekday.tracks.filter((track) => ['周三', '下午'].includes(track.sourceLabel)).length, 0)
})

test('截断签名兜底不误伤叙述行，只抓冒号或行尾', () => {
  const mappings = [{ sourceLabel: '说话人 1', outputLabel: '记者', role: '记者' }]
  const prose = enforceCanonicalSpeakerLabels('发言人 2 15 分钟后回来，我们继续聊。', mappings)
  assert.equal(prose.valid, true, '叙述行不应触发 fail closed')
  const bare = enforceCanonicalSpeakerLabels('说话人 1 00', mappings)
  assert.equal(bare.valid, false)
  const colon = enforceCanonicalSpeakerLabels('说话人 1 00：正文。', mappings)
  assert.equal(colon.valid, false)
})

test('反斜杠后带尾随空格的硬换行同样容忍', () => {
  const doc = ['说话人 1 00:01\\ ', '你好。', '', '说话人 2 00:05\\  ', '你好。'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2)
  assert.equal(parsed.labelLines, 2)
})

// ---------- 评审第 2 轮回归（2026-07-28 whuhzx Request changes） ----------

test('只发言一次的具名说话人不被吸进上一人（评审复现样本）', () => {
  const doc = ['张三 00:01\\', '第一段。', '李四 00:02\\', '唯一一次发言。', '张三 00:03\\', '第三段。'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2, '李四必须是独立轨道')
  const liSi = parsed.units.find((unit) => unit.speaker === '李四')
  assert.ok(liSi && liSi.text.includes('唯一一次发言'), '李四的话必须归在李四名下')
  const zhangSanFirst = parsed.units.find((unit) => unit.speaker === '张三')
  assert.equal(zhangSanFirst.text.includes('李四'), false, '张三的 turn 里不能出现李四的标签或正文')
})

test('具名时间戳加硬换行：单次出现、自起段落即成轨', () => {
  const doc = ['林洄 00:00:04\\', '继续回答。'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 1)
  assert.equal(parsed.tracks[0].key, 'label:林洄')
})

test('段落续行里以时间结尾的正文仍不成轨（上一行以硬换行结尾）', () => {
  const doc = ['说话人 1 00:01\\', '会议改到下午 3:30\\', '我们到时见。', '', '说话人 2 00:20\\', '好。'].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2, '“会议改到下午”是段落续行，不能成为第三条轨道')
})

// ---------- 评审第 3 轮回归（2026-07-28 whuhzx：真实 Pandoc 骨架） ----------

test('单独一行反斜杠是段落分隔，不是续行：具名标签保留（评审真实骨架）', () => {
  const doc = [
    '张三 00:01\\', '第一段。\\', '\\',
    '李四 00:02\\', '唯一一次发言。\\', '\\',
    '张三 00:03\\', '第三段。\\',
  ].join('\n')
  const parsed = parseSpeakerDocument(doc)
  assert.equal(parsed.tracks.length, 2, '李四必须独立成轨')
  assert.equal(parsed.labelLines, 3)
  const liSi = parsed.units.find((unit) => unit.speaker === '李四')
  assert.ok(liSi && liSi.text.includes('唯一一次发言'), '李四的话必须归在李四名下')
})

test('保持 Job 58 的行结构、换成具名标签后仍是 2 轨 480 标签行', () => {
  // 完整复刻生产 Pandoc 骨架（虚构内容）：每个 turn 是“标签\ + 若干正文行（行行以 \ 结尾）”，
  // turn 之间用单独一行 \ 分隔；240 轮交替 = 480 个标签行，与真实 Job 58 同量级同结构。
  const lines = []
  for (let turn = 0; turn < 480; turn += 1) {
    const name = turn % 2 === 0 ? '张三' : '李四'
    const mm = String(Math.floor(turn / 8)).padStart(2, '0')
    const ss = String((turn * 7) % 60).padStart(2, '0')
    lines.push(`${name} ${mm}:${ss}\\`)
    lines.push(`第 ${turn + 1} 轮的正文，第一行。\\`)
    if (turn % 3 === 0) lines.push('折行的第二行正文。\\')
    lines.push('\\')
  }
  const parsed = parseSpeakerDocument(lines.join('\n'))
  assert.equal(parsed.tracks.length, 2, '不能因截断时间戳伪轨再次爆裂')
  assert.equal(parsed.labelLines, 480)
  assert.deepEqual(parsed.tracks.map((t) => t.sourceLabel).sort(), ['张三', '李四'].sort())
})

test('被判为正文时间片段的行不得再被行内兜底铸成假标签', () => {
  // “会议改到下午 3:30\”是段落续行（上一行有实质文字且以 \ 结尾），被强规则降级后，
  // 即使同样的片段出现多次，也不能经“名字：正文”兜底按时间戳冒号切出“会议改到下午 3”。
  const lines = []
  for (let i = 0; i < 3; i += 1) {
    lines.push(`张三 0${i}:00\\`, `我们约的是这周，\\`, `会议改到下午 3:30\\`, `别迟到。\\`, '\\')
    lines.push(`李四 0${i}:30\\`, '好，我记下了。\\', '\\')
  }
  const parsed = parseSpeakerDocument(lines.join('\n'))
  assert.equal(parsed.tracks.length, 2)
  assert.equal(parsed.tracks.some((t) => t.sourceLabel.includes('会议') || t.sourceLabel.includes('下午')), false)
})
