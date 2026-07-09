import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  afterDeliver,
  afterLogicPlan,
  afterRefine,
  afterScout,
  afterVerify,
  auditNativeResult,
  deliverPrompts,
  prepareNativeRun,
  writeNativeArtifacts,
} from '../codex-skills/latepost-refiner/scripts/codex-native.mjs'
import { partPath, safeName } from '../codex-skills/latepost-refiner/core/spec.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lpr-codex-native-'))
}

function sourceLines(count = 16) {
  const lines = []
  const headings = ['创业起点', '客户变化', '产品迭代', '渠道调整', '供应协同', '组织搭建', '商业结果', '后续判断']
  for (let i = 0; i < count; i += 1) {
    const h = headings[i % headings.length]
    const speaker = i % 2 === 0 ? '记者' : '受访者'
    lines.push(`${speaker}：${h}这一段保留一个关键事实，第 ${i + 1} 轮讲到交付节奏、团队分工和复盘安排。`)
  }
  return lines.join('\n') + '\n'
}

function refinedDoc(title = '示例访谈') {
  const sections = ['创业起点', '客户变化', '产品迭代', '渠道调整', '供应协同', '组织搭建', '商业结果', '后续判断']
  return [
    `# ${title}`,
    '*测试项目访谈精校稿*',
    '',
    ...sections.flatMap((h, i) => [
      `## ${h}`,
      '',
      `记者：${h}这一段保留一个关键事实，第 ${i * 2 + 1} 轮讲到交付节奏、团队分工和复盘安排。`,
      '',
      `受访者：${h}这一段保留一个关键事实，第 ${i * 2 + 2} 轮讲到交付节奏、团队分工和复盘安排。`,
      '',
    ]),
  ].join('\n')
}

test('Codex native prepare normalizes SRT sources into local markdown before prompts', () => {
  const out = tmpdir()
  const src = path.join(out, '2026-07-01_示例字幕.srt')
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

  const prepared = prepareNativeRun({
    topic: '测试项目',
    outputDir: out,
    skillDir: path.resolve('codex-skills/latepost-refiner'),
    scope: ['refine'],
    verifyDepth: 'none',
    files: [{ path: src }],
  })
  const args = JSON.parse(fs.readFileSync(prepared.argsPath, 'utf8'))
  assert.equal(args.files[0].sourceKind, 'srt')
  assert.equal(args.files[0].originalPath, src)
  assert.match(args.files[0].path, /_codex-native\/sources\/.+\.md$/)
  const normalized = fs.readFileSync(args.files[0].path, 'utf8')
  assert.ok(!/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(normalized), 'raw timecode arrows are not sent to native prompts')
  assert.ok(normalized.includes('发言人 1 00:00:01'))
})

test('Codex native helper runs the no-key staged flow with chunked refine, logic-plan gate, audit, anchors, and artifacts', () => {
  const out = tmpdir()
  const src = path.join(out, 'source.md')
  fs.writeFileSync(src, sourceLines(), 'utf8')
  const args = {
    topic: '测试项目',
    date: '2026-07',
    outputDir: out,
    skillDir: path.resolve('codex-skills/latepost-refiner'),
    scope: ['refine', 'logic', 'summary', 'timeline'],
    verifyDepth: 'none',
    files: [{ path: src, label: '示例访谈', title: '示例访谈', lines: 16, chars: 24000 }],
  }

  const prepared = prepareNativeRun(args)
  assert.equal(prepared.prompts[0].stage, 'scout')
  assert.equal(prepared.prompts[0].model, 'gpt-5.4-mini')

  const scout = afterScout(args, {
    '示例访谈': {
      speakers: [{ label: '记者', role: '记者' }, { label: '受访者', role: '受访者' }],
      people: [],
      brands: [],
      terms: [],
      errors: [],
      themes: ['创业起点', '客户变化'],
      has_existing_headings: false,
      ending_anchor: { line: 16, text: '后续判断这一段保留一个关键事实。' },
      special_notes: [],
    },
  })
  const verifyState = JSON.parse(fs.readFileSync(scout.statePath, 'utf8'))
  const verified = afterVerify(args, verifyState, { resolved: [], unresolved: [] }, { suspects: [] })
  assert.equal(verified.refinePrompts.length, 2, 'speed mode chunks the oversized file')
  assert.ok(verified.refinePrompts.every((p) => p.model === 'gpt-5.5'), 'refine uses the strongest Codex model')

  const afterVerifyState = JSON.parse(fs.readFileSync(verified.statePath, 'utf8'))
  const finalPath = afterVerifyState.refinePlan[0].outPath
  fs.writeFileSync(partPath(finalPath, 1), refinedDoc('示例访谈').split('## 供应协同')[0], 'utf8')
  fs.writeFileSync(partPath(finalPath, 2), '## 供应协同' + refinedDoc('示例访谈').split('## 供应协同')[1], 'utf8')
  const refined = afterRefine(args, afterVerifyState, {
    parts: [
      { label: '示例访谈#1/2', partPath: partPath(finalPath, 1), headings: ['创业起点', '客户变化', '产品迭代', '渠道调整'], key_fixes: [], open_questions: [] },
      { label: '示例访谈#2/2', partPath: partPath(finalPath, 2), headings: ['供应协同', '组织搭建', '商业结果', '后续判断'], key_fixes: [], open_questions: [] },
    ],
  })
  assert.equal(fs.existsSync(finalPath), true)
  assert.equal(refined.checkPrompts.length, 0, 'ending completeness is handled by deterministic audit, not a check agent')
  assert.equal(JSON.parse(fs.readFileSync(refined.sectionMapPath, 'utf8')).files[0].sections.length, 8)

  const afterRefineState = JSON.parse(fs.readFileSync(refined.statePath, 'utf8'))
  const deliver = deliverPrompts(args, afterRefineState)
  const logicPlanPrompt = deliver.prompts.find((p) => p.stage === 'logic-plan')
  assert.equal(logicPlanPrompt.model, 'gpt-5.5')
  const planPath = path.join(out, '_codex-native', 'logic-plans', `${safeName('示例访谈')}.json`)
  const logicPlan = afterLogicPlan(args, afterRefineState, [{
    label: '示例访谈',
    path: planPath,
    mainline: '按产品与组织两条主线重排。',
    no_reorder_needed: false,
    reason: '源稿是录音顺序，叙事线索分散。',
    threads: [
      { title: '产品形成', logic: '起点→迭代', source_sections: ['产品迭代', '创业起点'], source_order: [3, 1] },
      { title: '客户与渠道', logic: '客户→渠道', source_sections: ['渠道调整', '客户变化'], source_order: [4, 2] },
      { title: '交付组织', logic: '供应→组织', source_sections: ['组织搭建', '供应协同'], source_order: [6, 5] },
      { title: '结果判断', logic: '结果→判断', source_sections: ['后续判断', '商业结果'], source_order: [8, 7] },
    ],
    open_questions: [],
  }])
  assert.equal(logicPlan.logicWritePrompts.length, 1)

  const logicPath = path.join(out, '逻辑顺序', `${safeName('示例访谈')}.md`)
  fs.mkdirSync(path.dirname(logicPath), { recursive: true })
  fs.writeFileSync(logicPath, [
    '# 示例访谈 · 逻辑顺序稿',
    '*基于精校稿重排为叙事顺序，内容照搬未改，仅调顺序。*',
    '',
    '## 主线脉络（导读）',
    '',
    '按产品、客户、组织和结果重排。',
    '',
    ...['产品迭代', '创业起点', '渠道调整', '客户变化', '组织搭建', '供应协同', '后续判断', '商业结果'].flatMap((h) => [
      `## ${h}`,
      `*〔取自精校稿：${h}〕*`,
      '',
      `记者：${h}这一段保留一个关键事实，第 1 轮讲到交付节奏、团队分工和复盘安排。`,
      '',
      `受访者：${h}这一段保留一个关键事实，第 2 轮讲到交付节奏、团队分工和复盘安排。`,
      '',
    ]),
  ].join('\n'), 'utf8')

  const afterPlanState = JSON.parse(fs.readFileSync(logicPlan.statePath, 'utf8'))
  const delivered = afterDeliver(args, afterPlanState, {
    logicRaw: [{ label: '示例访谈', path: logicPath, mainline: '按产品、客户、组织和结果重排。', threads: [{ title: '产品形成', source_sections: ['产品迭代', '创业起点'] }], open_questions: [] }],
    summaryRaw: { path: path.join(out, '测试项目访谈总结.md') },
    timelineRaw: { path: path.join(out, '测试项目时间线.md') },
    checksRaw: [{ label: '示例访谈', outPath: finalPath, complete: true, note: '' }],
  })
  const audited = auditNativeResult(args, delivered.result)
  const auditedResult = JSON.parse(fs.readFileSync(audited.resultPath, 'utf8'))
  assert.equal(auditedResult.audit.status, 'ok')
  assert.equal(auditedResult.logicAudit.status, 'ok')
  assert.ok((auditedResult.anchors || []).length >= 1, 'source anchors added in native audit')

  const artifacts = writeNativeArtifacts(args, auditedResult)
  assert.equal(fs.existsSync(artifacts.reviewPath), true)
  const manifest = JSON.parse(fs.readFileSync(artifacts.manifestPath, 'utf8'))
  assert.equal(manifest.provider.name, 'codex-subscription')
  assert.notEqual(manifest.quality.status, 'blocked')
  assert.equal(manifest.provider.info.apiKey, undefined)
})

test('Codex native retry does not treat its own generated glossary as prior input', () => {
  const out = tmpdir()
  const src = path.join(out, 'source.md')
  fs.writeFileSync(src, sourceLines(20), 'utf8')
  const args = {
    topic: '测试项目',
    date: '2026-07',
    outputDir: out,
    skillDir: path.resolve('codex-skills/latepost-refiner'),
    scope: ['refine'],
    verifyDepth: 'none',
    files: [{ path: src, label: '示例访谈', title: '示例访谈', lines: 20, chars: 24000, speakerHints: '方岑=受访者' }],
  }
  const prepared = prepareNativeRun(args)
  const normalizedArgs = JSON.parse(fs.readFileSync(prepared.argsPath, 'utf8'))
  assert.equal(normalizedArgs.priorGlossaryResolved, true)

  fs.writeFileSync(path.join(out, '校对表.md'), [
    '# stale',
    '',
    '## 人名（写法 → 统一）',
    '- **旧名** ← — ｜ 不应进入本轮',
  ].join('\n'), 'utf8')

  const scout = afterScout(normalizedArgs, {
    '示例访谈': {
      speakers: [{ label: '方岑', role: '受访者' }],
      people: [{ canonical: '方岑', variants: ['方琛'], hint: '受访者', suspect_asr: true }],
      brands: [],
      terms: [],
      errors: [],
      themes: [],
      ending_anchor: { line: 20, text: '就到这里。' },
      special_notes: [],
    },
  })
  const verifyState = JSON.parse(fs.readFileSync(scout.statePath, 'utf8'))
  const verified = afterVerify(normalizedArgs, verifyState, { resolved: [], unresolved: [{ query: '方岑' }] }, { suspects: [] })
  const glossary = fs.readFileSync(verified.glossaryPath, 'utf8')
  assert.ok(!glossary.includes('旧名'), 'stale generated glossary was not loaded as prior')
  assert.ok(/方岑：公开核实不足；按发言人信息使用/.test(glossary), 'trusted speaker handling still applies on retry')
})

test('Codex native logic-plan audit rejects same-order fake reorder before writing logic稿', () => {
  const out = tmpdir()
  const src = path.join(out, 'source.md')
  fs.writeFileSync(src, sourceLines(), 'utf8')
  const args = {
    topic: '测试项目',
    outputDir: out,
    skillDir: path.resolve('codex-skills/latepost-refiner'),
    scope: ['refine', 'logic'],
    verifyDepth: 'none',
    files: [{ path: src, label: '示例访谈', title: '示例访谈', lines: 16, chars: 10000 }],
  }
  const outPath = path.join(out, 'Transcripts', '示例访谈.md')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, refinedDoc('示例访谈'), 'utf8')
  const sections = ['创业起点', '客户变化', '产品迭代', '渠道调整', '供应协同', '组织搭建', '商业结果', '后续判断']
  const state = {
    sectionMap: { files: [{ label: '示例访谈', path: outPath, sections: sections.map((title, i) => ({ title, startLine: i * 5 + 1, endLine: i * 5 + 5 })) }] },
    resultSeed: { logic: [], openQuestions: [] },
  }
  const plan = {
    label: '示例访谈',
    mainline: '只是照原顺序列出。',
    no_reorder_needed: false,
    reason: '测试同序方案。',
    threads: [
      { title: '一', logic: '原顺序', source_sections: ['创业起点', '客户变化'], source_order: [1, 2] },
      { title: '二', logic: '原顺序', source_sections: ['产品迭代', '渠道调整'], source_order: [3, 4] },
      { title: '三', logic: '原顺序', source_sections: ['供应协同', '组织搭建'], source_order: [5, 6] },
      { title: '四', logic: '原顺序', source_sections: ['商业结果', '后续判断'], source_order: [7, 8] },
    ],
    open_questions: [],
  }
  const res = afterLogicPlan(args, state, [plan])
  assert.equal(res.logicWritePrompts.length, 0)
  assert.equal(res.logicPlanAudit[0].status, 'fail')
  assert.ok(res.logicPlanAudit[0].issues.some((x) => x.includes('同序率') || x.includes('位移')))
  const next = JSON.parse(fs.readFileSync(res.statePath, 'utf8'))
  assert.equal(next.resultSeed.logic[0].failedPlan, true)
})
