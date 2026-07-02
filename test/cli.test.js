import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRunParams, parseArgs } from '../universal/cli.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-cli-'))
}

test('parseArgs output maps CLI flags to runJob params', () => {
  const dir = tmpdir()
  const bg = path.join(dir, 'background.txt')
  const out = path.join(dir, 'out')
  const skill = path.join(dir, 'skill')
  const a = path.join(dir, 'a.md')
  const b = path.join(dir, 'b.md')
  fs.writeFileSync(bg, '虚构背景材料\n', 'utf8')

  const args = parseArgs([
    '--files', a, b,
    '--fresh',
    '--no-annotate',
    '--chunk', 'speed',
    '--models', 'scout=haiku,refine=opus',
    '--provider', 'openai',
    '--base-url', 'https://api.example.invalid/v1',
    '--concurrency', '7',
    '--verify', 'deep',
    '--heading-policy', 'keep',
    '--background-file', bg,
    '--out', out,
    '--skill-dir', skill,
    '--topic', '虚构项目',
    '--date', '2026-07',
    '--background', '会被背景文件覆盖',
    '--scope', 'refine,summary,timeline',
  ])
  const params = buildRunParams(args, { env: { HOME: dir } })

  assert.deepEqual(params.files, [{ path: a }, { path: b }])
  assert.equal(params.topic, '虚构项目')
  assert.equal(params.date, '2026-07')
  assert.equal(params.background, '虚构背景材料')
  assert.equal(params.outputDir, out)
  assert.equal(params.skillDir, skill)
  assert.deepEqual(params.scope, ['refine', 'summary', 'timeline'])
  assert.equal(params.verifyDepth, 'deep')
  assert.equal(params.headingPolicy, 'keep')
  assert.deepEqual(params.models, { scout: 'haiku', refine: 'opus' })
  assert.equal(params.chunkMode, 'speed')
  assert.equal(params.provider, 'openai')
  assert.equal(params.baseURL, 'https://api.example.invalid/v1')
  assert.equal(params.concurrency, 7)
  assert.equal(params.fresh, true)
  assert.equal(params.annotate, false)
})
