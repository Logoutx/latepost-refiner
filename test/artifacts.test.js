import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildReviewMarkdown, buildRunManifest, reviewSections, writeRunArtifacts } from '../universal/artifacts.js'

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
  assert.match(md, /未完成，需要补做/)
  assert.match(md, /张三 \/ 章三/)
  assert.match(md, /校对表：校对表\.md/)
  assert.match(md, /精校稿：Transcripts\/A\.md/)
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
