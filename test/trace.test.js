import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRunTrace } from '../universal/trace.js'

test('per-run trace persists stage, planned chunks, typed tool failures, heartbeat, and final execution state', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-trace-'))
  let tick = 0
  const trace = makeRunTrace(outputDir, { now: () => `2026-07-20T00:00:${String(tick++).padStart(2, '0')}Z` })
  trace.stage('Refine')
  trace.plan({
    label: 'A', driver: 'provider_budget', model: 'deepseek-v4-pro', contentLength: 25000,
    parts: [1, 2, 3].map((idx) => ({ idx, startLine: idx * 100 - 99, endLine: idx * 100, path: path.join(outputDir, `A.md.part${idx}`) })),
  })
  trace.agent({ status: 'started', label: 'refine:A#3/3', phase: 'Refine', model: 'deepseek-v4-pro' })
  trace.tool({ label: 'refine:A#3/3', tool: 'Write', ok: false, code: 'TOOL_PATH_DENIED', path: path.join(outputDir, 'A.md.part3') })
  const providerSignal = {
    provider: 'deepseek', finishReason: 'content_filter', refusalPresent: false, choiceCount: 1,
    httpStatus: null, requestId: 'req_filter-1', responseBody: 'must not persist',
  }
  trace.agent({ status: 'failed', label: 'refine:A#3/3', phase: 'Refine', model: 'deepseek-v4-pro', code: 'CONTENT_FILTER', retryable: false, providerSignal })
  trace.heartbeat()
  trace.finish({ status: 'failed', failure: { code: 'CONTENT_FILTER', retryable: false, message: 'provider body', providerSignal } })

  const state = JSON.parse(fs.readFileSync(trace.statePath, 'utf8'))
  const events = fs.readFileSync(trace.eventsPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(state.status, 'failed')
  assert.equal(state.stage, 'finished')
  assert.equal(state.progress.partsPlanned, 3)
  assert.equal(state.progress.toolsFailed, 1)
  assert.equal(state.progress.agentsFailed, 1)
  assert.equal(state.failure.code, 'CONTENT_FILTER')
  assert.equal(state.failure.message, undefined)
  assert.equal(state.failure.providerSignal.requestId, 'req_filter-1')
  assert.equal(state.failure.providerSignal.responseBody, undefined)
  assert.deepEqual(events.map((event) => event.type), [
    'run.started', 'stage.changed', 'refine.planned', 'agent.started', 'tool.completed', 'agent.failed', 'run.heartbeat', 'run.finished',
  ])
  assert.equal(events.find((event) => event.type === 'tool.completed').code, 'TOOL_PATH_DENIED')
  const failedAgent = events.find((event) => event.type === 'agent.failed')
  assert.equal(failedAgent.providerSignal.finishReason, 'content_filter')
  assert.equal(failedAgent.providerSignal.responseBody, undefined)
  assert.equal(fs.statSync(trace.statePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(trace.eventsPath).mode & 0o777, 0o600)
})

test('run-state exposes the active repair round and keeps failed repair tool counts append-only', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-repair-trace-'))
  const trace = makeRunTrace(outputDir)
  const label = 'repair:A#2/2'
  trace.agent({ status: 'started', label, phase: 'Audit', model: 'deepseek-v4-pro' })
  trace.tool({ label, tool: 'Edit', ok: false, code: 'TOOL_EDIT_TARGET_MISMATCH' })
  trace.tool({ label, tool: 'Edit', ok: true, path: path.join(outputDir, 'A.md'), bytes: 1200 })
  trace.agent({ status: 'completed', label, phase: 'Audit', model: 'deepseek-v4-pro' })

  const state = JSON.parse(fs.readFileSync(trace.statePath, 'utf8'))
  assert.equal(state.progress.repairRound, 2)
  assert.equal(state.progress.repairMaxRounds, 2)
  assert.equal(state.progress.repairToolsFailed, 1, 'the later successful Edit does not erase the prior failure')
  assert.equal(state.progress.toolsFailed, 1)
  assert.equal(state.progress.toolsSucceeded, 1)
})
