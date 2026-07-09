import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildReviewMarkdown, buildRunManifest, qualityScorecard, reviewSections, writeRunArtifacts } from '../universal/artifacts.js'

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
  assert.equal(manifest.config.backgroundLength, 'sensitive background'.length)
  assert.equal(manifest.config.backgroundSha256.length, 64)
  assert.equal(manifest.config.files[0].sha256.length, 64)
  assert.equal(manifest.provider.info.apiKey, undefined)
  assert.equal(manifest.provider.info.keyVar, 'MOCK_API_KEY')
})

test('writeRunArtifacts writes review.md and run.json', () => {
  const dir = tmpdir()
  const paths = writeRunArtifacts({ ...baseResult, outputDir: dir }, { outputDir: dir, topic: '测试项目', warnings: baseResult.warnings })

  assert.equal(fs.existsSync(paths.reviewPath), true)
  assert.equal(fs.existsSync(paths.manifestPath), true)
  assert.match(fs.readFileSync(paths.reviewPath, 'utf8'), /Review Queue/)
  assert.equal(JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8')).artifacts.reviewPath, paths.reviewPath)
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
