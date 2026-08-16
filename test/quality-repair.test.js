import assert from 'node:assert/strict'
import test from 'node:test'
import { qualityRepairResult } from '../universal/jobs.js'

test('qualityRepairResult keeps attempts after a failed file is removed from refined deliverables', () => {
  const attempt = {
    file: '/tmp/out/Transcripts/A.md',
    round: 2,
    action: 'targeted_repair',
    outcome: 'candidate_rejected',
  }
  const result = qualityRepairResult({
    refined: [],
    qualityRepairAttempts: [attempt],
    auditFailed: [{ path: attempt.file, findings: ['speaker_structure'] }],
  })
  assert.equal(result.roundsUsed, 2)
  assert.equal(result.stopReason, 'max_rounds')
  assert.deepEqual(result.attempts, [attempt])
})
