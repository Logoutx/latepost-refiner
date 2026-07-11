import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRunParams, parseArgs, computeExitCode } from '../universal/cli.js'

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
    '--prior-glossary', path.join(dir, '往次校对表.md'),
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
  assert.equal(params.priorGlossaryPath, path.join(dir, '往次校对表.md'), '--prior-glossary resolves to an absolute path')
})

test('parseArgs: --prior-glossary is undefined when the flag is absent', () => {
  const params = buildRunParams(parseArgs(['--files', '/tmp/a.md', '--topic', 'T']), { env: { HOME: '/tmp' } })
  assert.equal(params.priorGlossaryPath, undefined)
})

// ---------- --chunk-size validation (Feature 1) ----------

test('--chunk-size parses a valid ≥2000 integer into params.chunkSize', () => {
  const params = buildRunParams(parseArgs(['--files', '/tmp/a.md', '--topic', 'T', '--chunk-size', '10000']), { env: { HOME: '/tmp' } })
  assert.equal(params.chunkSize, 10000)
})

test('--chunk-size is undefined when the flag is absent (no override)', () => {
  const params = buildRunParams(parseArgs(['--files', '/tmp/a.md', '--topic', 'T']), { env: { HOME: '/tmp' } })
  assert.equal(params.chunkSize, undefined)
})

test('--chunk-size below 2000 is rejected with a clear CONFIG_ERROR', () => {
  assert.throws(
    () => buildRunParams(parseArgs(['--files', '/tmp/a.md', '--topic', 'T', '--chunk-size', '500']), { env: { HOME: '/tmp' } }),
    (e) => e && e.code === 'CONFIG_ERROR' && /chunk-size/.test(e.message) && /2000/.test(e.message),
    'a sub-2000 chunk size errors out with a message naming the flag and the floor',
  )
})

test('--chunk-size rejects a non-integer', () => {
  assert.throws(
    () => buildRunParams(parseArgs(['--files', '/tmp/a.md', '--topic', 'T', '--chunk-size', '9000.5']), { env: { HOME: '/tmp' } }),
    (e) => e && e.code === 'CONFIG_ERROR',
  )
})

// ---------- SF-6: --allow-audit-fail exit-code semantics ----------

test('parseArgs recognises --allow-audit-fail as a boolean flag', () => {
  assert.equal(parseArgs(['--files', 'a.md', '--allow-audit-fail']).allowAuditFail, true)
  assert.equal(parseArgs(['--files', 'a.md']).allowAuditFail, undefined, 'absent by default')
})

test('computeExitCode: a pipeline error always exits 1 (even with --allow-audit-fail)', () => {
  assert.equal(computeExitCode({ error: 'boom' }, { allowAuditFail: true }), 1)
})

test('computeExitCode: a clean run exits 0', () => {
  assert.equal(computeExitCode({ refined: [{ path: '/o/A.md' }], auditFailed: [] }), 0)
})

test('computeExitCode: audit gate failure exits 1 by DEFAULT even though products were generated', () => {
  const result = { refined: [{ path: '/o/A.md' }], auditFailed: [{ path: '/o/A.md', findings: ['content_gap'] }] }
  assert.equal(computeExitCode(result), 1, 'default: auditFailed → exit 1')
  assert.equal(computeExitCode(result, { allowAuditFail: false }), 1)
})

test('computeExitCode: --allow-audit-fail exits 0 when products exist and the ONLY problem is auditFailed', () => {
  const result = { refined: [{ path: '/o/A.md' }], auditFailed: [{ path: '/o/A.md', findings: ['content_gap'] }] }
  assert.equal(computeExitCode(result, { allowAuditFail: true }), 0)
})

test('computeExitCode: --allow-audit-fail still exits 1 when NO product was generated', () => {
  // auditFailed but nothing produced (an edge case) — --allow-audit-fail must NOT mask a fruitless run.
  const result = { refined: [], auditFailed: [{ path: '/o/A.md', findings: ['content_gap'] }] }
  assert.equal(computeExitCode(result, { allowAuditFail: true }), 1)
})

test('computeExitCode (P7): an audit that could not run exits 1 and is NOT bypassable by --allow-audit-fail', () => {
  // "audit unavailable" (deliverables unaudited) is a distinct, harder failure than "audit ran and found a hard
  // issue I accept" — --allow-audit-fail covers the latter, never the former.
  const result = { refined: [{ path: '/o/A.md' }], auditFailed: [], auditUnavailable: [{ path: '/o/A.md', label: 'A' }] }
  assert.equal(computeExitCode(result), 1, 'default: auditUnavailable → exit 1')
  assert.equal(computeExitCode(result, { allowAuditFail: true }), 1, '--allow-audit-fail cannot mask an audit that never ran')
})
