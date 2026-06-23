import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditAndRepairRefined } from '../universal/jobs.js'

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'latepost-quality-repair-'))
}

test('auditAndRepairRefined repairs a failed transcript and re-audits before handoff', async () => {
  const dir = tmpdir()
  const sourcePath = path.join(dir, 'source.md')
  const refinedPath = path.join(dir, 'Transcripts', 'source.md')
  fs.mkdirSync(path.dirname(refinedPath), { recursive: true })
  fs.writeFileSync(sourcePath, fixture('source-excerpt.md'), 'utf8')
  fs.writeFileSync(refinedPath, fixture('under-refined.md'), 'utf8')

  const calls = []
  const engine = {
    phase() {},
    log() {},
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    agent: async (prompt, opts = {}) => {
      calls.push({ prompt, opts })
      fs.writeFileSync(refinedPath, fixture('clean.md'), 'utf8')
      return '已写回 source.md；修复策略=full_cleanup；备注=清理口癖并保留覆盖。'
    },
  }
  const result = {}
  await auditAndRepairRefined({
    A: {
      topic: '测试项目',
      models: { refine: 'gpt-test-refine' },
      files: [{ path: sourcePath, outPath: refinedPath, label: 'source', lines: 12 }],
    },
    result,
    engine,
    maxRetries: 2,
  })

  assert.equal(result.audit.status, 'ok')
  assert.equal(result.qualityRepair.attempts.length, 1)
  assert.equal(result.qualityRepair.attempts[0].action, 'full_cleanup')
  assert.equal(result.qualityRepair.attempts[0].model, 'gpt-test-refine')
  assert.equal(calls[0].opts.label, 'repair:source')
  assert.match(calls[0].prompt, /欠精校风险/)
})
