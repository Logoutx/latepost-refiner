import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TURN_CONTRACT_HEADER,
  TurnContractError,
  applySpeakerIdentityAssignments,
  bindOutputBlocksToSourceRecords,
  buildTurnContract,
  makeInitialOutputBlocks,
  mergeOutputBlockEnvelopes,
  parseOutputBlockEnvelope,
  reconcileSpeakerResolutionWithRegistry,
  recordsForChunk,
  renderTurnContract,
  serializeOutputBlockEnvelope,
  validateOutputBlockEnvelope,
} from '../universal/output-contract.js'
import { auditPair, checkContractAttribution } from '../scripts/audit_refined.mjs'
import { endsWithQuestion, splitForRefine } from '../core/spec.js'
import { refinePrompt, turnIrV2PromptBlock } from '../core/prompts.js'
import { qualityRepairPrompt } from '../universal/jobs.js'

const TRACKED_SOURCE = `# 文字记录：产品访谈

> 会议主题：产品

高洪浩：第一轮原文。

陈佳惠：第二轮原文？`

const envelope = (body) => `${TURN_CONTRACT_HEADER}\n${body.trim()}\n`

test('source turn ledger excludes document chrome and output blocks render host-owned labels', () => {
  const contract = buildTurnContract(TRACKED_SOURCE, {
    title: '产品访谈',
    subtitle: '*产品访谈 · 采访时间 2026 年 7 月*',
  })
  assert.equal(contract.mode, 'tracked')
  assert.deepEqual(contract.records.map((record) => [record.id, record.speaker, record.speakerTrackId]), [
    ['T000001', '高洪浩', 'S000001'],
    ['T000002', '陈佳惠', 'S000002'],
  ])
  const input = serializeOutputBlockEnvelope(makeInitialOutputBlocks(contract), { sourceMeta: true })
  assert.ok(!input.includes('文字记录：产品访谈'))
  assert.match(input, /LRB_OUTPUT_BLOCK sources=T000001 disposition=keep/u)
  assert.match(input, /LRB_SOURCE_REFS T000001:track=S000001:lines=5-5/u)

  const output = envelope(`
## 产品起点
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
第一轮精校。
<!-- /LRB_OUTPUT_BLOCK -->

<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
第二轮精校？
<!-- /LRB_OUTPUT_BLOCK -->
`)
  const blocks = parseOutputBlockEnvelope(output, contract)
  assert.equal(renderTurnContract(contract, blocks), `# 产品访谈

*产品访谈 · 采访时间 2026 年 7 月*

## 产品起点

高洪浩：第一轮精校。

陈佳惠：第二轮精校？
`)
})

test('final identity updates the track registry and renderer without replacing body strings', () => {
  const source = [
    '说话人 1 00:01',
    '请介绍一下背景。',
    '说话人 2 00:02',
    '我是田渊栋；这里提到“说话人 2”只是正文里的原始称呼。',
  ].join('\n')
  const resolution = {
    speakerMode: 'tracked',
    mappings: [
      { key: 'generic:1', sourceLabel: '说话人 1', outputLabel: '记者', role: '记者', basis: 'scout_role' },
      { key: 'generic:2', sourceLabel: '说话人 2', outputLabel: '说话人 2', role: '受访者', basis: 'unresolved' },
    ],
    unresolved: ['说话人 2'],
  }
  const contract = buildTurnContract(source, { speakerResolution: resolution })
  const blocks = makeInitialOutputBlocks(contract)
  assert.deepEqual(contract.records.map((record) => record.speaker), ['说话人 1', '说话人 2'], 'source records keep source labels')
  assert.deepEqual(contract.speakerTracks.map((track) => [track.id, track.canonicalLabel, track.identityStatus]), [
    ['S000001', '记者', 'role_only'],
    ['S000002', '说话人 2', 'unresolved'],
  ])

  const finalized = applySpeakerIdentityAssignments(contract, [{
    speaker_track_id: 'S000002',
    canonical_name: '田渊栋',
    confidence: 'high',
    evidence: '该轨道开场直接说“我是田渊栋”。',
  }])
  const rendered = renderTurnContract(finalized.contract, blocks)
  assert.match(rendered, /^田渊栋：我是田渊栋；这里提到“说话人 2”只是正文里的原始称呼。$/mu)
  assert.doesNotMatch(rendered, /^说话人 2：/mu)
  assert.match(rendered, /这里提到“说话人 2”只是正文里的原始称呼/u, 'body text is untouched')
  assert.deepEqual(finalized.changes, [{ speakerTrackId: 'S000002', from: '说话人 2', to: '田渊栋' }])

  const reconciled = reconcileSpeakerResolutionWithRegistry(resolution, finalized.speakerTracks)
  assert.equal(reconciled.mappings[1].outputLabel, '田渊栋')
  assert.equal(reconciled.mappings[1].basis, 'final_metadata')
  assert.deepEqual(reconciled.unresolved, [])
})

test('track registry rejects weak, unknown, conflicting, and confirmed-name overrides', () => {
  const contract = buildTurnContract('沈其安：原名已明确。\n\n说话人 2：身份待确认。\n\n沈其安：再次发言确认轨道。', {
    speakerResolution: {
      mappings: [
        { key: 'label:沈其安', sourceLabel: '沈其安', outputLabel: '沈其安', basis: 'source_name' },
        { key: 'generic:2', sourceLabel: '说话人 2', outputLabel: '说话人 2', basis: 'unresolved' },
      ],
    },
  })
  const result = applySpeakerIdentityAssignments(contract, [
    { speaker_track_id: 'S000001', canonical_name: '另一个人', confidence: 'high', evidence: '与源稿冲突。' },
    { speaker_track_id: 'S000002', canonical_name: '张三', confidence: 'medium', evidence: '只有弱线索。' },
    { speaker_track_id: 'S000002', canonical_name: '记者', confidence: 'high', evidence: '只有角色。' },
    { speaker_track_id: 'S999999', canonical_name: '李四', confidence: 'high', evidence: '不存在的轨道。' },
  ])
  assert.deepEqual(result.speakerTracks.map((track) => track.canonicalLabel), ['沈其安', '说话人 2'])
  assert.deepEqual(new Set(result.rejected.map((entry) => entry.reason)), new Set([
    'conflicts_with_confirmed_identity',
    'insufficient_identity_evidence',
    'unknown_track',
  ]))
})

test('source headings remain explicit boundaries without becoming model-editable transcript prose', () => {
  const source = `# 文档标题

## 起点

高洪浩：第一轮原文。

### 进展

陈佳惠：第二轮原文。`
  const contract = buildTurnContract(source, { title: '产品访谈' })
  assert.deepEqual(contract.records.map((record) => record.headingsBefore), [
    ['## 起点'],
    ['## 进展'],
  ])
  const input = serializeOutputBlockEnvelope(makeInitialOutputBlocks(contract), { sourceMeta: true })
  assert.match(input, /## 起点[\s\S]*LRB_OUTPUT_BLOCK sources=T000001 disposition=keep/u)
  const blocks = parseOutputBlockEnvelope(envelope(`
## 新起点
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
第一轮精校。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
第二轮精校。
<!-- /LRB_OUTPUT_BLOCK -->
`), contract)
  assert.match(renderTurnContract(contract, blocks), /## 新起点[\s\S]*高洪浩：第一轮精校。/u)
})

test('output contract rejects free text outside blocks instead of guessing document structure', () => {
  const contract = buildTurnContract(TRACKED_SOURCE)
  const output = envelope(`
*文字记录：产品访谈*
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
正文。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(
    () => parseOutputBlockEnvelope(output, contract),
    (error) => error instanceof TurnContractError && error.code === 'TURN_CONTRACT_OUTSIDE_CONTENT',
  )
})

test('turn contract syntax validation reports missing header, H1 and subtitle in one diagnostic pass', () => {
  const contract = buildTurnContract(TRACKED_SOURCE)
  const output = `# 模型标题

*模型说明行*

<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
正文。
<!-- /LRB_OUTPUT_BLOCK -->
`
  const validation = validateOutputBlockEnvelope(output, contract)
  assert.equal(validation.ok, false)
  assert.equal(validation.phase, 'syntax')
  assert.deepEqual(validation.errors.map((error) => [error.code, error.line]), [
    ['TURN_CONTRACT_HEADER_MISSING', 1],
    ['TURN_CONTRACT_OUTSIDE_CONTENT', 1],
    ['TURN_CONTRACT_OUTSIDE_CONTENT', 3],
  ])
  assert.doesNotMatch(validation.message, /TURN_CONTRACT_COVERAGE_INVALID/u, 'relation checks wait for clean syntax')
})

test('initial Refine and contracted quality repair share one Turn IR block without legacy Markdown ownership', () => {
  const f = {
    path: '/src/A.md', refinePath: '/work/A.turns.md', outPath: '/out/A.md', label: 'A', title: 'A', subtitle: '*A*', lines: 20,
    refineContract: { records: [{ id: 'T000001' }] }, refineContractFinalized: true,
  }
  const common = turnIrV2PromptBlock()
  const initial = refinePrompt(f, '校对表', { special_notes: [] }, { headingPolicy: 'none' }, { idx: 1, count: 1, turnIds: ['T000001'] })
  const repair = qualityRepairPrompt({ topic: 'A' }, f, { failed: ['content_gap'], findings: [], gaps: [], metrics: {} }, 1)
  for (const prompt of [initial, repair]) {
    assert.ok(prompt.includes(common))
    assert.doesNotMatch(prompt, /传统 Markdown 输出规范|文件抬头由模型写入|先 Write 抬头|发言人标签一律/u)
  }
})

test('output relation rejects missing, duplicate, unknown and out-of-order source IDs', () => {
  const contract = buildTurnContract(TRACKED_SOURCE)
  const missing = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
第一轮。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(() => parseOutputBlockEnvelope(missing, contract), { code: 'TURN_CONTRACT_COVERAGE_INVALID' })

  const duplicate = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001,T000001 disposition=merge -->
正文。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(() => parseOutputBlockEnvelope(duplicate, contract), { code: 'TURN_CONTRACT_DUPLICATE_ID' })

  const unknown = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T999999 disposition=keep -->
正文。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(() => parseOutputBlockEnvelope(unknown, contract), { code: 'TURN_CONTRACT_UNKNOWN_ID' })

  const reversed = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
第二轮。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
第一轮。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(() => parseOutputBlockEnvelope(reversed, contract), { code: 'TURN_CONTRACT_ORDER_INVALID' })
})

test('renderer removes redundant model speaker prefixes and owns the canonical labels', () => {
  const contract = buildTurnContract(TRACKED_SOURCE, { title: '产品访谈' })
  const output = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
高洪浩：第一轮精校。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
陈佳惠: 第二轮精校。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  const rendered = renderTurnContract(contract, parseOutputBlockEnvelope(output, contract))
  assert.match(rendered, /高洪浩：第一轮精校。/u)
  assert.match(rendered, /陈佳惠：第二轮精校。/u)
  assert.doesNotMatch(rendered, /高洪浩：高洪浩：/u)
})

test('one source turn can split into multiple output blocks while retaining one source identity', () => {
  const contract = buildTurnContract(TRACKED_SOURCE)
  const output = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=split -->
第一段正文。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=split -->
第二段正文。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
第二轮正文。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  const blocks = parseOutputBlockEnvelope(output, contract)
  assert.deepEqual(blocks.map((block) => [block.sourceTurnIds, block.disposition]), [
    [['T000001'], 'split'],
    [['T000001'], 'split'],
    [['T000002'], 'keep'],
  ])
  assert.match(renderTurnContract(contract, blocks), /高洪浩：第一段正文。\n\n高洪浩：第二段正文。/u)
  const bound = bindOutputBlocksToSourceRecords({ ...contract, blocks })
  assert.equal(bound[0].outputBlockIds.length, 2)
  assert.match(bound[0].body, /第一段正文。[\s\S]*第二段正文。/u)
})

test('adjacent source turns on the same confirmed track can merge into one output block', () => {
  const contract = buildTurnContract('高洪浩：上半句。\n\n高洪浩：下半句。')
  const blocks = parseOutputBlockEnvelope(envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001,T000002 disposition=merge -->
合并后的完整一句。
<!-- /LRB_OUTPUT_BLOCK -->
`), contract)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].speakerTrackId, 'S000001')
  assert.equal(renderTurnContract(contract, blocks), '\n高洪浩：合并后的完整一句。\n')
})

test('different speakers cannot silently merge into one speech block', () => {
  const contract = buildTurnContract(TRACKED_SOURCE)
  const output = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001,T000002 disposition=merge -->
错误合并。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(() => parseOutputBlockEnvelope(output, contract), { code: 'TURN_CONTRACT_SPEAKER_MERGE' })
})

test('explicit fold_noise can account for adjacent cross-speaker small talk without assigning it to either speaker', () => {
  const contract = buildTurnContract(TRACKED_SOURCE, { title: '产品访谈' })
  const blocks = parseOutputBlockEnvelope(envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001,T000002 disposition=fold_noise -->
开场寒暄从略
<!-- /LRB_OUTPUT_BLOCK -->
`), contract)
  const rendered = renderTurnContract(contract, blocks)
  assert.match(rendered, /（开场寒暄从略）/u)
  assert.doesNotMatch(rendered, /高洪浩：|陈佳惠：/u)
})

test('split is a real one-to-many relation, not a one-block label', () => {
  const contract = buildTurnContract(TRACKED_SOURCE)
  const output = envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=split -->
只有一个 block。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
第二轮。
<!-- /LRB_OUTPUT_BLOCK -->
`)
  assert.throws(() => parseOutputBlockEnvelope(output, contract), { code: 'TURN_CONTRACT_RELATION_INVALID' })
})

test('untracked documents retain source IDs and render without invented labels', () => {
  const contract = buildTurnContract('第一段独白。\n\n第二段独白。', {
    title: '独白',
    subtitle: '*访谈*',
  })
  assert.equal(contract.mode, 'untracked')
  assert.deepEqual(contract.records.map((record) => record.speakerTrackId), [null, null])
  const blocks = parseOutputBlockEnvelope(envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
第一段独白。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
第二段独白。
<!-- /LRB_OUTPUT_BLOCK -->
`), contract)
  assert.equal(renderTurnContract(contract, blocks), '# 独白\n\n*访谈*\n\n第一段独白。\n\n第二段独白。\n')
})

test('chunk envelopes merge only when output relations cover the complete source ledger', () => {
  const contract = buildTurnContract(TRACKED_SOURCE, { title: '产品访谈' })
  const boundary = contract.records[0].endLine
  const leftExpected = recordsForChunk(contract, { idx: 1, startLine: 1, endLine: boundary })
  const rightExpected = recordsForChunk(contract, { idx: 2, startLine: boundary + 1, endLine: 20 })
  const leftBlocks = [{
    sourceTurnIds: ['T000001'],
    disposition: 'keep',
    body: '第一轮精校。',
  }]
  const rightBlocks = [{
    sourceTurnIds: ['T000002'],
    disposition: 'keep',
    body: '第二轮精校。',
  }]
  const merged = mergeOutputBlockEnvelopes(contract, [
    { expectedRecords: leftExpected, text: serializeOutputBlockEnvelope(leftBlocks) },
    { expectedRecords: rightExpected, text: serializeOutputBlockEnvelope(rightBlocks) },
  ])
  assert.deepEqual(merged.blocks.flatMap((block) => block.sourceTurnIds), ['T000001', 'T000002'])
  assert.match(merged.text, /高洪浩：第一轮精校。[\s\S]*陈佳惠：第二轮精校。/u)
})

test('real refine chunk planning assigns every stable source turn ID exactly once', () => {
  const source = Array.from({ length: 80 }, (_, index) => {
    const speaker = index % 2 ? '陈佳惠' : '高洪浩'
    return `${speaker}：第 ${index + 1} 轮包含完整背景、约束、判断、例子和后续安排，分块时不能拆散或重复。`
  }).join('\n\n')
  const contract = buildTurnContract(source)
  const file = {
    lines: source.split('\n').length,
    chars: 20000,
    bytes: Buffer.byteLength(source, 'utf8'),
    turns: contract.records.map((record) => ({
      startLine: record.startLine,
      q: endsWithQuestion(record.sourceText),
    })),
  }
  const chunks = splitForRefine(file, undefined, 5000)
  assert.ok(chunks.length > 1)
  const assigned = chunks.flatMap((chunk) => recordsForChunk(contract, chunk).map((record) => record.id))
  assert.deepEqual(assigned, contract.records.map((record) => record.id))
  assert.equal(new Set(assigned).size, assigned.length)
})

test('source-aware audit consumes provenance bindings instead of reparsing rendered labels', () => {
  const source = `高洪浩：我们先完整说明产品起点、目标用户、研发过程和几次关键调整，这些事实都必须保留。

陈佳惠：接下来核对发布时间、团队分工、市场反馈和后续计划，也要保留数字与判断。`
  const contract = buildTurnContract(source, {
    title: '产品访谈',
    subtitle: '*文字记录：产品访谈 2026 年 7 月 30 日*',
  })
  const blocks = parseOutputBlockEnvelope(envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
我们先完整说明产品起点、目标用户、研发过程和几次关键调整，这些事实都必须保留。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
接下来核对发布时间、团队分工、市场反馈和后续计划，也要保留数字与判断。
<!-- /LRB_OUTPUT_BLOCK -->
`), contract)
  const refined = renderTurnContract(contract, blocks)
  const audit = auditPair({
    sourceText: source,
    refinedText: refined,
    mode: 'refine',
    speakerMode: 'tracked',
    turnRecords: bindOutputBlocksToSourceRecords({ ...contract, blocks }),
  })
  assert.equal(audit.metrics.attribution.mismatches, 0)
  assert.equal(audit.metrics.attribution.mapped, 2)
  assert.equal(audit.findings.some((finding) => finding.name === 'speaker_label_style'), false)
})

test('provenance-aware attribution detects substantive content moved to another speaker block', () => {
  const source = `高洪浩：我们先完整说明产品起点、目标用户、研发过程、技术路线、决策依据和几次关键调整，这些事实、数字与判断都必须保留。

陈佳惠：接下来核对发布时间、团队分工、市场反馈、渠道变化、客户案例和后续计划，也要保留其中全部数字、事实与判断。`
  const contract = buildTurnContract(source)
  const blocks = parseOutputBlockEnvelope(envelope(`
<!-- LRB_OUTPUT_BLOCK sources=T000001 disposition=keep -->
接下来核对发布时间、团队分工、市场反馈、渠道变化、客户案例和后续计划，也要保留其中全部数字、事实与判断。
<!-- /LRB_OUTPUT_BLOCK -->
<!-- LRB_OUTPUT_BLOCK sources=T000002 disposition=keep -->
我们先完整说明产品起点、目标用户、研发过程、技术路线、决策依据和几次关键调整，这些事实、数字与判断都必须保留。
<!-- /LRB_OUTPUT_BLOCK -->
`), contract)
  const bound = bindOutputBlocksToSourceRecords({ ...contract, blocks })
  const attribution = checkContractAttribution(bound, renderTurnContract(contract, blocks), { speakerMode: 'tracked' })
  assert.equal(attribution.assessed, true)
  assert.ok(attribution.mismatches >= 1)
  assert.match(attribution.samples[0].text, /T00000[12]/u)
})
