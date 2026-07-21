// Per-run operational trace. This is intentionally separate from the global runs.jsonl cost log:
// it lives inside the job output directory, is always on, and records only metadata (never prompts,
// transcript text, tool arguments, API keys, or fetched page bodies).

import fs from 'node:fs'
import path from 'node:path'

const FILE_MODE = 0o600

function safeToken(value, maxLength = 200) {
  if (value == null) return null
  const text = String(value).trim()
  return text && text.length <= maxLength && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null
}

function normalizeProviderSignal(signal) {
  if (!signal || signal.provider !== 'deepseek') return null
  const status = signal.httpStatus == null ? null : Number(signal.httpStatus)
  const choices = signal.choiceCount == null ? null : Number(signal.choiceCount)
  return {
    provider: 'deepseek',
    finishReason: safeToken(signal.finishReason, 80),
    refusalPresent: typeof signal.refusalPresent === 'boolean' ? signal.refusalPresent : null,
    choiceCount: Number.isInteger(choices) && choices >= 0 ? choices : null,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    requestId: safeToken(signal.requestId),
  }
}

function normalizeFailure(failure) {
  if (!failure) return null
  return {
    code: safeToken(failure.code, 80) || 'UNKNOWN_FAILURE',
    retryable: !!failure.retryable,
    providerSignal: normalizeProviderSignal(failure.providerSignal),
  }
}

function repairPosition(label) {
  if (typeof label !== 'string' || !label.startsWith('repair:')) return null
  const match = label.match(/#(\d+)\/(\d+)$/)
  if (!match) return null
  const round = Number(match[1]), maxRounds = Number(match[2])
  return Number.isInteger(round) && Number.isInteger(maxRounds) && round > 0 && maxRounds >= round
    ? { round, maxRounds }
    : null
}

function safeWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
  fs.chmodSync(tmp, FILE_MODE)
  fs.renameSync(tmp, filePath)
}

export function makeRunTrace(outputDir, { now = () => new Date().toISOString() } = {}) {
  const root = path.resolve(outputDir)
  const eventsPath = path.join(root, 'events.jsonl')
  const statePath = path.join(root, 'run-state.json')
  fs.mkdirSync(root, { recursive: true })
  let sequence = 0
  const state = {
    schemaVersion: 1,
    status: 'running',
    stage: 'prepare',
    startedAt: now(),
    updatedAt: null,
    progress: {
      agentsStarted: 0, agentsCompleted: 0, agentsFailed: 0,
      toolsSucceeded: 0, toolsFailed: 0, filesPlanned: 0, partsPlanned: 0,
      repairRound: 0, repairMaxRounds: 0, repairToolsFailed: 0,
    },
    failure: null,
  }

  const persistState = () => {
    state.updatedAt = now()
    safeWriteJson(statePath, state)
  }
  const emit = (type, data = {}) => {
    try {
      const event = { sequence: ++sequence, at: now(), type, ...data }
      fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: FILE_MODE })
      fs.chmodSync(eventsPath, FILE_MODE)
      persistState()
      return true
    } catch {
      return false
    }
  }

  persistState()
  emit('run.started')

  return {
    eventsPath,
    statePath,
    heartbeat() { return emit('run.heartbeat', { stage: state.stage }) },
    stage(stage) {
      state.stage = String(stage || 'unknown')
      return emit('stage.changed', { stage: state.stage })
    },
    plan(plan) {
      state.progress.filesPlanned += 1
      state.progress.partsPlanned += (plan.parts || []).length
      return emit('refine.planned', {
        label: plan.label, driver: plan.driver, model: plan.model, contentLength: plan.contentLength,
        parts: (plan.parts || []).map((p) => ({ idx: p.idx, startLine: p.startLine, endLine: p.endLine, path: p.path })),
      })
    },
    tool(event) {
      if (event.ok) state.progress.toolsSucceeded += 1
      else state.progress.toolsFailed += 1
      if (!event.ok && repairPosition(event.label)) state.progress.repairToolsFailed += 1
      return emit('tool.completed', {
        label: event.label, tool: event.tool, ok: !!event.ok, code: event.code || null,
        path: event.path || null, bytes: event.bytes ?? null,
      })
    },
    agent(event) {
      const repair = repairPosition(event.label)
      if (repair) {
        state.progress.repairRound = repair.round
        state.progress.repairMaxRounds = repair.maxRounds
      }
      if (event.status === 'started') state.progress.agentsStarted += 1
      else if (event.status === 'completed') state.progress.agentsCompleted += 1
      else if (event.status === 'failed') state.progress.agentsFailed += 1
      return emit(`agent.${event.status}`, {
        label: event.label, phase: event.phase || null, model: event.model || null,
        code: event.code || null, retryable: event.retryable ?? null,
        providerSignal: normalizeProviderSignal(event.providerSignal),
      })
    },
    finish(execution) {
      state.status = execution.status
      state.stage = 'finished'
      state.failure = normalizeFailure(execution.failure)
      state.finishedAt = now()
      emit('run.finished', { status: state.status, failure: state.failure })
      return { eventsPath, statePath }
    },
  }
}
