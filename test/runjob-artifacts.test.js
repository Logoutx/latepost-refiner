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
