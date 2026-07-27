import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artifactQualityScorecard, buildReviewMarkdown, buildRunManifest, qualityScorecard, reviewSections, writeRunArtifacts } from '../universal/artifacts.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-artifacts-'))
}

const baseResult = {
  outputDir: '/tmp/out',
  glossaryPath: '/tmp/out/校对表.md',
  refined: [{ outPath: '/tmp/out/Transcripts/A.md', complete: false, checkNote: 'missing ending', open_questions: ['确认人名'] }],
  failed: ['B'],
  incomplete: [{ path: '/tmp/out/Transcripts/A.md', note: 'missing ending' }],
  unchecked: ['/tmp/out/Transcripts/C.md'],
  headingConflicts: ['A'],
  scoutSuspect: ['D'],
  suspectedDuplicates: [{ members: ['张三', '章三'], why: '同音且同职位' }],
  networkUnverified: [{ query: '某品牌', note: 'network timeout' }],
  logic: [{ label: 'A', path: '/tmp/out/逻辑顺序/A.md', missingSections: ['## 研发'] }],
  openQuestions: ['确认人名'],
  warnings: ['源文件已带小标题'],
  provider: 'mock',
  providerInfo: { label: 'Mock', keyVar: 'MOCK_API_KEY' },
  usage: { agents: 2, input: 10, output: 5 },
}

test('reviewSections groups actionable warnings for handoff', () => {
  const sections = reviewSections(baseResult, baseResult.warnings)
  const titles = sections.map((s) => s.title)

  assert.equal(titles.includes('未完成，需要补做'), true)
  assert.equal(titles.includes('疑似中途截断，需要检查结尾'), true)
  assert.equal(titles.includes('疑似同指，待人工确认'), true)
  assert.equal(titles.includes('预检提示'), true)
})

test('buildReviewMarkdown renders review queue and generated artifacts', () => {
  const md = buildReviewMarkdown(baseResult, { topic: '测试项目', finishedAt: '2026-06-19T00:00:00.000Z', warnings: baseResult.warnings })

  assert.match(md, /^# Review Queue/)
  assert.match(md, /主题：测试项目/)
  assert.match(md, /## 质量摘要/)
  assert.match(md, /状态：Blocked/)
  assert.match(md, /未完成，需要补做/)
  assert.match(md, /张三 \/ 章三/)
  assert.match(md, /校对表：校对表\.md/)
  assert.match(md, /精校稿：Transcripts\/A\.md/)
})

test('qualityScorecard classifies ready, review-needed, and blocked runs', () => {
  assert.equal(qualityScorecard({ audit: { status: 'ok', files: [] }, refined: [] }).status, 'ready')
  assert.equal(qualityScorecard({ audit: { status: 'ok', files: [] }, networkUnverified: [{ query: '示例品牌' }] }).status, 'review_needed')
  assert.equal(qualityScorecard({ audit: { status: 'fail', files: [{ file: 'A.md', status: 'fail', failed: ['content_gap'] }] } }).status, 'blocked')
  assert.equal(qualityScorecard({ audit: { status: 'fail', files: [{ file: 'A.md', status: 'fail', failed: ['detector_candidate_only'] }] } }).status, 'ready', 'unknown detector failures cannot silently become publication gates')
})

test('artifactQualityScorecard isolates a blocked timeline from a review-only transcript', () => {
  const result = {
    outputDir: '/tmp/out',
    refined: [{ outPath: '/tmp/out/Transcripts/A.md' }],
    timeline: { path: '/tmp/out/T时间线.md' },
    audit: { status: 'ok', files: [{ file: '/tmp/out/Transcripts/A.md', status: 'ok', failed: [], findings: [{ name: 'hedge_loss', severity: 'soft', count: 1 }], sections: [] }] },
    auditFailed: [{ path: '/tmp/out/T时间线.md', findings: ['derivative_attribution'] }],
    derivativeAudit: { status: 'fail', files: [{ file: '/tmp/out/T时间线.md', kind: 'timeline', status: 'fail', hardFail: [{ value: '17' }], reporterVerify: [], review: [] }] },
  }
  const q = artifactQualityScorecard(result, { A: { topic: 'T' }, outputDir: '/tmp/out' })
  assert.equal(q.refined[0].status, 'review_needed')
  assert.equal(q.timeline.status, 'blocked')
  assert.deepEqual(q.timeline.blockingFindings, ['derivative_attribution'])
})

test('artifactQualityScorecard exposes a failed logic draft without downgrading the passed transcript', () => {
  const result = {
    refined: [{ outPath: '/tmp/out/Transcripts/A.md' }],
    logic: [{ label: 'A', path: '/tmp/out/逻辑顺序/A.md' }],
    audit: { status: 'ok', files: [{ file: '/tmp/out/Transcripts/A.md', status: 'ok', failed: [], findings: [], sections: [] }] },
    logicAudit: { status: 'fail', files: [{ file: '/tmp/out/逻辑顺序/A.md', status: 'fail', failed: ['logic_order_unchanged'], findings: [] }] },
  }
  const q = artifactQualityScorecard(result, { outputDir: '/tmp/out' })
  assert.equal(q.refined[0].status, 'ready')
  assert.equal(q.logic[0].status, 'blocked')
  assert.deepEqual(q.logic[0].blockingFindings, ['logic_order_unchanged'])
})

test('buildRunManifest records run config without secrets and hashes source files', () => {
  const dir = tmpdir()
  const source = path.join(dir, 'source.md')
  fs.writeFileSync(source, 'hello\n', 'utf8')

  const manifest = buildRunManifest(baseResult, {
    A: {
      topic: '测试项目',
      date: '2026-06',
      background: 'sensitive background',
      scope: ['refine'],
      verifyDepth: 'key',
      headingPolicy: 'none',
      searchProvider: 'serper',
      fetchProvider: 'jina-reader+local-fallback',
      outputDir: dir,
      skillDir: '/repo/skill',
      files: [{ label: 'source', title: 'source', path: source, outPath: path.join(dir, 'Transcripts/source.md'), lines: 1, bytes: 6 }],
    },
    outputDir: dir,
    provider: 'mock',
    providerInfo: { label: 'Mock', apiKey: 'secret', keyVar: 'MOCK_API_KEY' },
    usage: baseResult.usage,
  })

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.quality.status, 'blocked')
  assert.equal(manifest.config.topic, '测试项目')
  assert.equal(manifest.config.searchProvider, 'serper')
  assert.equal(manifest.config.fetchProvider, 'jina-reader+local-fallback')
  assert.equal(manifest.config.backgroundLength, 'sensitive background'.length)
  assert.equal(manifest.config.backgroundSha256.length, 64)
  assert.equal(manifest.config.files[0].sha256.length, 64)
  assert.equal(manifest.provider.info.apiKey, undefined)
  assert.equal(manifest.provider.info.keyVar, 'MOCK_API_KEY')
})

test('run manifest persists only the whitelisted repair ledger and retains earlier tool failures', () => {
  const qualityRepair = {
    schemaVersion: 99,
    maxRounds: 2,
    roundsUsed: 1,
    stopReason: 'passed',
    prompt: 'must not persist',
    attempts: [{
      file: '/tmp/out/Transcripts/A.md', round: 1, action: 'targeted_repair', model: 'deepseek-v4-pro',
      failedBefore: ['residual_noise'], hardIssueCountsBefore: { confirmation_repeats: 5 },
      toolSummary: {
        succeeded: { Read: 30, Edit: 30 },
        failed: [{ tool: 'Edit', code: 'TOOL_EDIT_TARGET_MISMATCH', count: 6 }],
        oldString: 'must not persist',
      },
      bytesBefore: 1000, bytesAfter: 1010, changed: true, agentCompleted: true,
      failedAfter: [], hardIssueCountsAfter: {}, outcome: 'passed_with_tool_errors', errorCode: null,
      response: 'must not persist',
    }],
  }
  const manifest = buildRunManifest({ ...baseResult, qualityRepair }, { outputDir: '/tmp/out', topic: 'T' })
  assert.equal(manifest.qualityRepair.schemaVersion, 1)
  assert.equal(manifest.qualityRepair.maxRounds, 2)
  assert.equal(manifest.qualityRepair.attempts[0].toolSummary.failed[0].count, 6)
  assert.equal(manifest.qualityRepair.attempts[0].outcome, 'passed_with_tool_errors')
  assert.equal(JSON.stringify(manifest).includes('must not persist'), false)
})

test('run manifest persists the full-text speaker mapping and every deterministic output enforcement pass', () => {
  const speakerResolutions = [{
    label: '访谈 A',
    path: '/tmp/out/.converted/A.speaker-resolved.md',
    changedLines: 12,
    labelLines: 12,
    unresolved: [],
    mappings: [{
      key: 'generic:1',
      sourceLabel: '说话人 1',
      outputLabel: '记者',
      role: '记者',
      basis: 'scout_role',
      firstLine: 1,
      labelLines: 6,
    }],
  }]
  const speakerOutputNormalizations = [{
    sequence: 2,
    phase: 'post_repair_round_1',
    label: '访谈 A',
    path: '/tmp/out/Transcripts/A.md',
    changedLines: 1,
    labelLines: 11,
    replacements: [{ line: 20, from: '访谈者', to: '记者' }],
    unknownLabels: [{ line: 30, label: '神秘人' }],
  }]
  const manifest = buildRunManifest({ ...baseResult, speakerResolutions, speakerOutputNormalizations }, { outputDir: '/tmp/out', topic: 'T' })

  assert.equal(manifest.speaker.resolutions[0].mappings[0].outputLabel, '记者')
  assert.equal(manifest.speaker.resolutions[0].mappings[0].key, undefined, 'internal track keys/Feishu ids are not persisted')
  assert.equal(manifest.speaker.outputEnforcements[0].phase, 'post_repair_round_1')
  assert.deepEqual(manifest.speaker.outputEnforcements[0].replacements[0], { line: 20, from: '访谈者', to: '记者' })
  assert.deepEqual(manifest.speaker.outputEnforcements[0].unknownLabels[0], { line: 30, label: '神秘人' })
})

test('writeRunArtifacts writes review.md and run.json', () => {
  const dir = tmpdir()
  const paths = writeRunArtifacts({ ...baseResult, outputDir: dir }, { outputDir: dir, topic: '测试项目', warnings: baseResult.warnings })

  assert.equal(fs.existsSync(paths.reviewPath), true)
  assert.equal(fs.existsSync(paths.manifestPath), true)
  assert.match(fs.readFileSync(paths.reviewPath, 'utf8'), /Review Queue/)
  assert.equal(JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8')).artifacts.reviewPath, paths.reviewPath)
})

test('run manifest persists web telemetry without credentials', () => {
  const webTelemetry = { searchCalls: 3, searchAttempts: 2, searchBilled: 2, searchCacheHits: 1, searchBudgetRejected: 0, searchFailures: 0, fetchCalls: 1, fetchCacheHits: 0, fetchJinaAttempts: 1, fetchJinaSuccess: 1, fetchLocalAttempts: 0, fetchLocalSuccess: 0, fetchFailures: 0 }
  const manifest = buildRunManifest({ ...baseResult, webTelemetry }, { outputDir: '/tmp/out', topic: 'T', A: { searchProvider: 'serper', fetchProvider: 'jina-reader+local-fallback' } })
  assert.deepEqual(manifest.webTelemetry, webTelemetry)
  assert.equal(JSON.stringify(manifest).includes('SERPER_API_KEY'), false)
})

test('provider-budget auto-chunk is traced in run.json and rendered as a plain-language review.md line', () => {
  const withAuto = {
    ...baseResult,
    autoChunk: [{ label: '甲', model: 'deepseek-v4-pro', budget: 28000, contentLength: 53576, parts: 2 }],
  }
  const manifest = buildRunManifest(withAuto, { outputDir: '/tmp/out', topic: 'T' })
  assert.deepEqual(manifest.autoChunk, [{ label: '甲', model: 'deepseek-v4-pro', budget: 28000, contentLength: 53576, parts: 2 }], 'run.json carries the structured autoChunk record')
  const md = buildReviewMarkdown(withAuto, { outputDir: '/tmp/out', topic: 'T' })
  assert.match(md, /已按发言轮边界分为 2 段精校/, 'review.md states the split in plain language')
  assert.match(md, /超过 deepseek-v4-pro 忠实处理长度 28000 字/, 'review.md names the model and its budget')
  // Empty by default → no autoChunk key noise and no review section
  const bare = buildRunManifest(baseResult, { outputDir: '/tmp/out', topic: 'T' })
  assert.deepEqual(bare.autoChunk, [], 'no auto-chunk → empty array')
  assert.ok(!reviewSections(baseResult, []).some((s) => s.title.includes('已自动分段精校')), 'no section when nothing auto-chunked')
})

test('manifest separates execution failure from quality and preserves the failed file pre-dispatch chunk plan', () => {
  const execution = {
    schemaVersion: 1, status: 'failed', stage: 'finished',
    failure: { code: 'OUTPUT_MISSING', retryable: false, message: 'part3 missing' },
    failures: [{ label: 'refine:甲#3/3', code: 'OUTPUT_MISSING', retryable: false, message: 'part3 missing' }],
    progress: { filesTotal: 1, filesRefined: 0, filesFailed: 1, partsPlanned: 3 },
    eventsPath: '/tmp/out/events.jsonl', statePath: '/tmp/out/run-state.json',
  }
  const plannedChunks = [{
    label: '甲', outPath: '/tmp/out/Transcripts/甲.md', model: 'deepseek-v4-pro', budget: 10000,
    contentLength: 25000, driver: 'provider_budget',
    parts: [1, 2, 3].map((idx) => ({ idx, startLine: idx * 100 - 99, endLine: idx * 100, path: `/tmp/out/Transcripts/甲.md.part${idx}` })),
  }]
  const manifest = buildRunManifest({ outputDir: '/tmp/out', refined: [], failed: ['甲'], execution, plannedChunks, audit: { status: 'ok', files: [] } }, { outputDir: '/tmp/out', topic: 'T' })

  assert.equal(manifest.execution.status, 'failed')
  assert.equal(manifest.execution.failure.code, 'OUTPUT_MISSING')
  assert.equal(manifest.quality.status, 'ready', 'quality remains a separate editorial dimension and does not mask execution failure')
  assert.equal(manifest.plannedChunks[0].parts.length, 3)
  assert.equal(manifest.plannedChunks[0].parts[2].path, '/tmp/out/Transcripts/甲.md.part3')
})

test('manifest carries content-gap details and annotations; review renders 内容缺口', () => {
  const gap = { startLine: 25, endLine: 38, turns: 5, chars: 434, severity: 'hard', trace: false }
  const withGaps = {
    ...baseResult,
    audit: { status: 'fail', files: [{ file: '/tmp/out/Transcripts/A.md', status: 'fail', failed: ['content_gap'], metrics: { charRatio: 0.7 }, gaps: [gap], modelMarkers: [] }] },
    annotations: [{ path: '/tmp/out/Transcripts/A.md', inserted: [gap], skipped: [] }],
  }
  const manifest = buildRunManifest(withGaps, { outputDir: '/tmp/out', topic: 'T' })
  assert.equal(manifest.audit.files[0].gaps.length, 1, 'gaps survive into run.json (not silently dropped)')
  assert.equal(manifest.audit.files[0].gaps[0].startLine, 25)
  assert.equal(manifest.annotations.length, 1)
  assert.deepEqual(manifest.annotations[0].inserted[0], { startLine: 25, endLine: 38, chars: 434 })
  const sections = reviewSections(withGaps, [])
  const quality = sections.find((s) => s.title.includes('成稿质量抽查未过'))
  assert.ok(quality && quality.items[0].includes('内容缺口 第 25-38 行'), 'formatAudit renders the gap with line range')
  const ann = sections.find((s) => s.title.includes('已在成稿中插入内容缺口标记'))
  assert.ok(ann && ann.items[0].includes('插入 1 处标记'), 'annotation section present with count')
})
