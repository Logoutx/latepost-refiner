import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runJob } from '../universal/jobs.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-runjob-'))
}

function mockEngine() {
  const usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {},
    log() {},
    usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async () => [],
    agent: async (_prompt, opts = {}) => {
      usage.agents++
      if (opts.label && opts.label.startsWith('refine:')) {
        return { path: 'unused.md', headings: ['## 开场'], key_fixes: [], open_questions: ['确认受访者姓名'] }
      }
      if (opts.label && opts.label.startsWith('check:')) return { complete: false, note: '结尾未覆盖' }
      return null
    },
  }
}

test('runJob writes review queue and manifest artifacts', async () => {
  const outputDir = tmpdir()
  const result = await runJob({
    __engine: mockEngine(),
    files: [{ name: 'tiny.txt', base64: Buffer.from('采访者：你好\n受访者：你好\n').toString('base64') }],
    topic: '测试项目',
    date: '2026-06',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
  })

  assert.equal(result.provider, 'injected')
  assert.equal(fs.existsSync(result.reviewPath), true)
  assert.equal(fs.existsSync(result.manifestPath), true)

  const review = fs.readFileSync(result.reviewPath, 'utf8')
  assert.match(review, /疑似中途截断，需要检查结尾/)
  assert.match(review, /确认受访者姓名/)

  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.config.topic, '测试项目')
  assert.equal(manifest.config.files.length, 1)
  assert.equal(manifest.artifacts.reviewPath, result.reviewPath)
  assert.equal(manifest.result.incomplete.length, 1)
})

// End-to-end content-gap annotation: the injected engine "refines" by writing an output that omits a
// whole source section (the coverage fixtures) — runJob's audit must detect the hard gap and insert a
// visible 内容缺口 marker into the refined file; --no-annotate (annotate:false) must leave it untouched.
import { fileURLToPath as f2p } from 'node:url'
const covFixture = (name) => fs.readFileSync(f2p(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')

function gapEngine() {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 }
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    // The refine stage: write a refined output that silently omits the 账期 section.
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, covFixture('coverage-refined-gap.md'))
      return { path: f.outPath, headings: ['## 公司概况'], key_fixes: [], open_questions: [] }
    }),
    agent: async () => { usage.agents++; return null }, // scouts/checks fail → resilience paths, refine unaffected
  }
}

async function runGapJob(extra = {}) {
  const outputDir = tmpdir()
  const src64 = Buffer.from(covFixture('coverage-source.md')).toString('base64')
  return runJob({
    __engine: gapEngine(),
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }], // 2 files → multi-file branch
    topic: '缺口测试', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    ...extra,
  })
}

test('runJob detects a hard content gap, annotates the 成稿, and records it in the manifest', async () => {
  const result = await runGapJob()
  assert.ok(result.audit.files.some((f) => f.failed.includes('content_gap')), 'audit gates content_gap')
  assert.ok(result.annotations.length >= 1, 'annotation happened')
  const annotated = fs.readFileSync(result.annotations[0].path, 'utf8')
  assert.match(annotated, /内容缺口：源文件第 \d+-\d+ 行/, 'visible marker inserted into the refined file')
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.ok(manifest.audit.files[0].gaps.length >= 1, 'gaps in run.json')
  assert.ok(manifest.annotations.length >= 1, 'annotations in run.json')
  assert.match(fs.readFileSync(result.reviewPath, 'utf8'), /内容缺口/, 'review.md surfaces the gap')
  // source anchors ran on the same pass: sections carry <!-- 源 … --> comments, manifest records them
  assert.ok(result.anchors.length >= 1, 'anchors attached to the result')
  assert.match(fs.readFileSync(result.anchors[0].path, 'utf8'), /<!-- 源 L\d+-L\d+/, 'anchor comment in the 成稿')
  assert.ok(manifest.anchors.length >= 1 && manifest.anchors[0].sections >= 1, 'anchors in run.json')
})

test('annotate:false leaves the refined files untouched (still audited and reported)', async () => {
  const result = await runGapJob({ annotate: false })
  assert.ok(result.audit.files.some((f) => f.failed.includes('content_gap')), 'still gated')
  assert.equal(result.annotations.length, 0, 'no annotations written')
  for (const f of result.refined) {
    assert.ok(!fs.readFileSync(f.outPath || f.path, 'utf8').includes('内容缺口'), 'no marker in file')
  }
})

test('runJob accepts filesystem path entries and records prepared file metadata', async () => {
  const inputDir = tmpdir()
  const outputDir = tmpdir()
  const src = path.join(inputDir, 'path-fixture.md')
  fs.writeFileSync(src, '采访者：请介绍背景\n受访者：这是虚构样本。\n', 'utf8')

  const result = await runJob({
    __engine: mockEngine(),
    files: [{ path: src }],
    topic: '路径样本',
    date: '2026-07',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
  })

  assert.equal(result.provider, 'injected')
  assert.equal(result.refined.length, 1)
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.config.files.length, 1)
  assert.equal(manifest.config.files[0].path, src)
  assert.equal(manifest.config.files[0].outPath, path.join(outputDir, 'Transcripts', 'path-fixture.md'))
})
