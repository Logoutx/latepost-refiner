import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRunLogEntry, estimateCost, appendRunLog } from '../universal/runlog.js'
import { runJob } from '../universal/jobs.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-runlog-'))
}

// ---------- buildRunLogEntry ----------

test('buildRunLogEntry: shape from a fake result (all fields, worked-example cost)', () => {
  const params = {
    topic: '虚构示例项目',
    scope: ['refine', 'summary'],
    files: [{ path: '/in/a.md' }, { path: '/in/b.md' }],
  }
  const result = {
    finishedAt: '2026-07-08T10:00:00.000Z',
    durationMs: 732000, // 12.2 min exactly
    usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, agents: 9, failed: 0 },
    audit: { status: 'ok', files: [] },
    outputDir: '/out/虚构示例项目',
  }

  const entry = buildRunLogEntry({ params, result, provider: 'anthropic', models: null })

  assert.equal(entry.finishedAt, '2026-07-08T10:00:00.000Z')
  assert.equal(entry.topic, '虚构示例项目')
  assert.equal(entry.engine, 'universal')
  assert.equal(entry.provider, 'anthropic')
  assert.equal(entry.models, null)
  assert.deepEqual(entry.scope, ['refine', 'summary'])
  assert.equal(entry.files, 2)
  assert.equal(entry.durationMs, 732000)
  assert.equal(entry.durationMin, 12.2)
  // usage is re-shaped to exactly these 5 fields — engine's `failed` counter is not part of the log entry
  assert.deepEqual(entry.usage, { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, agents: 9 })
  assert.deepEqual(entry.estCost, { value: 0.018225, currency: 'USD', note: null })
  assert.equal(entry.auditStatus, 'ok')
  assert.equal(entry.outputDir, '/out/虚构示例项目')
})

test('buildRunLogEntry: auditStatus is "unavailable" when result.audit is absent, "fail" when audit failed', () => {
  const base = { params: { topic: 'T', files: [] }, provider: 'anthropic', models: null }
  assert.equal(buildRunLogEntry({ ...base, result: {} }).auditStatus, 'unavailable')
  assert.equal(buildRunLogEntry({ ...base, result: { audit: { status: 'fail' } } }).auditStatus, 'fail')
  assert.equal(buildRunLogEntry({ ...base, result: { audit: { status: 'ok' } } }).auditStatus, 'ok')
})

test('buildRunLogEntry: defaults topic to "untitled" and scope to ["refine"] when params is sparse', () => {
  const entry = buildRunLogEntry({ params: {}, result: {}, provider: 'deepseek', models: null })
  assert.equal(entry.topic, 'untitled')
  assert.deepEqual(entry.scope, ['refine'])
  assert.equal(entry.files, 0)
  assert.equal(entry.estCost, null, 'deepseek with no models map → no price data')
})

// ---------- estimateCost ----------

test('estimateCost: DeepSeek flash+pro mixed tiers — input-includes-cacheRead subtraction, worked example', () => {
  // models mirrors PROVIDERS.deepseek.models: mechanical tiers on flash, writing (opus) tier on pro.
  const models = { haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', opus: 'deepseek-v4-pro' }
  const usage = { input: 100000, output: 20000, cacheRead: 40000, cacheWrite: 0 }
  // usage.input (100000) INCLUDES cacheRead (40000) as a subset → fresh = 60000.
  // cheaper model for input = flash (inMiss 0.14 < pro's 0.435); writing-stage (opus) model for output = pro (out 0.87).
  // cost = (60000*0.14 + 40000*0.0028 + 20000*0.87) / 1e6 = (8400 + 112 + 17400) / 1e6 = 0.025912
  const cost = estimateCost('deepseek', models, usage)
  assert.deepEqual(cost, { value: 0.025912, currency: 'USD', note: 'mixed-tier approximation' })
})

test('estimateCost: DeepSeek single model (no mixing) computes exactly, no approximation note', () => {
  const models = { haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', opus: 'deepseek-v4-flash' }
  const usage = { input: 10000, output: 3000, cacheRead: 2000, cacheWrite: 0 }
  // fresh = 8000; cost = (8000*0.14 + 2000*0.0028 + 3000*0.28) / 1e6 = (1120 + 5.6 + 840) / 1e6 = 0.0019656,
  // rounded to estimateCost's 6dp = 0.001966
  const cost = estimateCost('deepseek', models, usage)
  assert.deepEqual(cost, { value: 0.001966, currency: 'USD', note: null })
})

test('estimateCost: deepseek-chat prices the same as deepseek-v4-flash (legacy alias)', () => {
  const usage = { input: 10000, output: 3000, cacheRead: 2000, cacheWrite: 0 }
  const flash = estimateCost('deepseek', { haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', opus: 'deepseek-v4-flash' }, usage)
  const chat = estimateCost('deepseek', { haiku: 'deepseek-chat', sonnet: 'deepseek-chat', opus: 'deepseek-chat' }, usage)
  assert.deepEqual(chat, flash)
})

test('estimateCost: anthropic — flat rate ignores the models map, worked example', () => {
  const usage = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }
  // cost = (1000*5 + 200*0.5 + 100*6.25 + 500*25) / 1e6 = (5000 + 100 + 625 + 12500) / 1e6 = 0.018225
  const cost = estimateCost('anthropic', null, usage)
  assert.deepEqual(cost, { value: 0.018225, currency: 'USD', note: null })
})

test('estimateCost: unknown provider → null', () => {
  const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
  assert.equal(estimateCost('glm', { haiku: 'glm-4.7-flash', sonnet: 'glm-4.7-flashx', opus: 'glm-5.2' }, usage), null)
  assert.equal(estimateCost('openai', { haiku: 'gpt-5.4-mini', sonnet: 'gpt-5.4-mini', opus: 'gpt-5.5' }, usage), null)
  assert.equal(estimateCost('router', null, usage), null)
  assert.equal(estimateCost('injected', null, usage), null)
})

test('estimateCost: known provider (deepseek) with no/unknown model data → null', () => {
  const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
  assert.equal(estimateCost('deepseek', null, usage), null, 'no models map at all')
  assert.equal(estimateCost('deepseek', {}, usage), null, 'empty models map')
  assert.equal(estimateCost('deepseek', { haiku: 'deepseek-v5-mystery' }, usage), null, 'model id with no price row')
})

// ---------- appendRunLog ----------

test('appendRunLog: creates the directory, appends lines, returns the running line count', () => {
  const base = tmpdir()
  const logPath = path.join(base, 'nested', 'dir', 'runs.jsonl')
  assert.equal(fs.existsSync(path.dirname(logPath)), false, 'nested dir does not exist yet')

  const r1 = appendRunLog({ topic: '虚构一号', n: 1 }, { logPath })
  assert.deepEqual(r1, { ok: true, path: logPath, lineCount: 1 })
  assert.equal(fs.existsSync(logPath), true)

  const r2 = appendRunLog({ topic: '虚构二号', n: 2 }, { logPath })
  assert.deepEqual(r2, { ok: true, path: logPath, lineCount: 2 })

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { topic: '虚构一号', n: 1 })
  assert.deepEqual(JSON.parse(lines[1]), { topic: '虚构二号', n: 2 })
})

test('appendRunLog: an unwritable path never throws — returns {ok:false, error}', () => {
  const base = tmpdir()
  // A regular file standing where a directory is needed makes mkdirSync fail with ENOTDIR.
  const blocker = path.join(base, 'im-a-file-not-a-dir')
  fs.writeFileSync(blocker, 'x', 'utf8')
  const logPath = path.join(blocker, 'sub', 'runs.jsonl')

  assert.doesNotThrow(() => {
    const res = appendRunLog({ n: 1 }, { logPath })
    assert.equal(res.ok, false)
    assert.equal(typeof res.error, 'string')
    assert.ok(res.error.length > 0)
  })
})

test('appendRunLog: defaults to ~/.config/latepost-refiner/runs.jsonl when no logPath is given', async () => {
  const { DEFAULT_LOG_PATH } = await import('../universal/runlog.js')
  assert.equal(DEFAULT_LOG_PATH, path.join(os.homedir(), '.config', 'latepost-refiner', 'runs.jsonl'))
})

// ---------- jobs.js integration (mock-engine pattern from test/runjob-artifacts.test.js) ----------

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
        return { path: 'unused.md', headings: ['## 开场'], key_fixes: [], open_questions: [] }
      }
      return null
    },
  }
}

test('runJob integration: a completed run appends exactly one log line with the right topic', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, 'src.md')
  fs.writeFileSync(src, '采访者：请介绍背景\n受访者：这是虚构样本，仅用于测试。\n', 'utf8')
  const runLogPath = path.join(tmpdir(), 'runs.jsonl')

  const result = await runJob({
    __engine: mockEngine(),
    files: [{ path: src }],
    topic: '虚构示例集团',
    date: '2026-07',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    runLogPath,
  })

  assert.ok(result.runLog, 'runJob attaches a runLog summary')
  assert.equal(result.runLog.path, runLogPath)
  assert.equal(result.runLog.lineCount, 1)
  assert.equal(fs.existsSync(runLogPath), true)

  const lines = fs.readFileSync(runLogPath, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.topic, '虚构示例集团')
  assert.equal(entry.engine, 'universal')
  assert.equal(entry.provider, 'injected')
  assert.ok(['ok', 'fail', 'unavailable'].includes(entry.auditStatus))
})

test('runJob integration: params.runLog:false disables logging — no file is created', async () => {
  const outputDir = tmpdir()
  const src = path.join(outputDir, 'src.md')
  fs.writeFileSync(src, '采访者：请介绍背景\n受访者：这是虚构样本，仅用于测试。\n', 'utf8')
  const runLogPath = path.join(tmpdir(), 'never-created', 'runs.jsonl')

  const result = await runJob({
    __engine: mockEngine(),
    files: [{ path: src }],
    topic: '虚构示例集团二号',
    date: '2026-07',
    outputDir,
    scope: ['refine'],
    verifyDepth: 'none',
    runLogPath,
    runLog: false,
  })

  assert.equal(result.runLog, null)
  assert.equal(fs.existsSync(runLogPath), false)
})
