import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEnvFile } from '../bench/search-api/env-file.js'
import { aggregate, distinctGroups, scoreCase } from '../bench/search-api/run-retrieval.mjs'

// ---- env-file loader (parseEnvFile is pure — no fs, no network) ----------------------------------
// The owner keeps search-API keys in a keys.env in the research vault; the loader must set only-if-unset
// and NEVER surface any value — parse problems report the line NUMBER only.

test('parseEnvFile: sets KEY=VALUE, skips blank/# lines, strips quotes and inline comments', () => {
  const env = {}
  const text = [
    '# a comment',
    '',
    'TAVILY_API_KEY=tvly-abc',
    'BOCHA_API_KEY="bo cha secret"',   // double-quoted value with a space
    "BRAVE_API_KEY='brv-123'",         // single-quoted
    'SERPER_API_KEY=serp-xyz # trailing comment', // unquoted → inline comment dropped
  ].join('\n')
  const r = parseEnvFile(text, env)
  assert.equal(env.TAVILY_API_KEY, 'tvly-abc')
  assert.equal(env.BOCHA_API_KEY, 'bo cha secret', 'double quotes stripped, inner space kept')
  assert.equal(env.BRAVE_API_KEY, 'brv-123', 'single quotes stripped')
  assert.equal(env.SERPER_API_KEY, 'serp-xyz', 'unquoted inline comment dropped')
  assert.equal(r.loaded, 4)
  assert.equal(r.skipped, 0)
  assert.deepEqual(r.badLines, [])
})

test('parseEnvFile: only sets a key that is NOT already present (existing env wins)', () => {
  const env = { TAVILY_API_KEY: 'preexisting' }
  const r = parseEnvFile('TAVILY_API_KEY=from-file\nEXA_API_KEY=exa-1', env)
  assert.equal(env.TAVILY_API_KEY, 'preexisting', 'pre-set key is not overwritten')
  assert.equal(env.EXA_API_KEY, 'exa-1', 'unset key is loaded')
  assert.equal(r.loaded, 1)
  assert.equal(r.skipped, 1)
})

test('parseEnvFile: a malformed line is reported by LINE NUMBER only, never its content or values', () => {
  const env = {}
  const text = [
    'GOOD_KEY=ok',           // line 1
    'this is not an assignment', // line 2 — malformed
    '   ',                    // line 3 — blank
    '=no-key',               // line 4 — malformed (no key)
    'ANOTHER=fine',          // line 5
  ].join('\n')
  const r = parseEnvFile(text, env)
  assert.deepEqual(r.badLines, [2, 4], 'bad line NUMBERS only')
  assert.equal(r.loaded, 2)
  // the result must not carry any line content or value — only numbers/counts
  assert.deepEqual(Object.keys(r).sort(), ['badLines', 'loaded', 'skipped'])
  assert.ok(r.badLines.every((n) => typeof n === 'number'), 'badLines are numbers, not strings')
  assert.equal(JSON.stringify(r).includes('no-key'), false, 'no malformed content leaks into the result')
})

// ---- per-group aggregation -----------------------------------------------------------------------

test('distinctGroups: first-seen order; a missing group falls back to "default"', () => {
  const cases = [{ group: 'b' }, {}, { group: 'a' }, { group: 'b' }, {}]
  assert.deepEqual(distinctGroups(cases), ['b', 'default', 'a'])
})

test('aggregate: per-group subset yields correct expect/trap/honesty/failures/latency', () => {
  // rows shaped like runProvider emits: { kind, group, latencyMs, error, shapeError, score }
  const rows = [
    { kind: 'expect', group: 'g1', latencyMs: 100, error: null, shapeError: false, score: { hit: true } },
    { kind: 'expect', group: 'g1', latencyMs: 300, error: null, shapeError: false, score: { hit: false } },
    { kind: 'trap', group: 'g2', latencyMs: 200, error: null, shapeError: false, score: { hit: true } },
    { kind: 'unverifiable', group: 'g2', latencyMs: null, error: 'HTTP 500', shapeError: false, score: { honest: false } },
  ]
  const g1 = aggregate('tavily', rows.filter((r) => r.group === 'g1'))
  assert.deepEqual(g1.expect, [1, 2], 'g1: 1 of 2 expect hit')
  assert.deepEqual(g1.trap, [0, 0], 'g1: no trap cases')
  assert.equal(g1.failures, 0)
  assert.equal(g1.meanLatency, 200, 'g1: mean of 100 and 300')

  const g2 = aggregate('tavily', rows.filter((r) => r.group === 'g2'))
  assert.deepEqual(g2.trap, [1, 1], 'g2: the one trap case hit')
  assert.deepEqual(g2.unv, [0, 1], 'g2: the unverifiable case was not honest')
  assert.equal(g2.failures, 1, 'g2: the HTTP 500 row is a failure')
  assert.equal(g2.meanLatency, 200, 'g2: only the trap row had a latency')

  // overall aggregate across both groups
  const all = aggregate('tavily', rows)
  assert.deepEqual(all.expect, [1, 2])
  assert.deepEqual(all.trap, [1, 1])
  assert.equal(all.failures, 1)
})

// scoreCase sanity — trap over-counts, unverifiable honesty, expect all-present (kept in sync with the runner)
test('scoreCase: expect needs all strings; trap counts occurrences; unverifiable honest when no hint surfaces', () => {
  assert.equal(scoreCase({ kind: 'expect', expect: ['甲', '乙'] }, [{ title: '甲', snippet: '乙' }]).hit, true)
  assert.equal(scoreCase({ kind: 'expect', expect: ['甲', '乙'] }, [{ title: '甲', snippet: '丙' }]).hit, false)
  assert.equal(scoreCase({ kind: 'trap', traps: ['真选'] }, [{ title: '真选真选', snippet: '' }]).occurrences, 2)
  assert.equal(scoreCase({ kind: 'unverifiable', hints: ['3000'] }, []).honest, true)
  assert.equal(scoreCase({ kind: 'unverifiable', hints: ['3000'] }, [{ title: '', snippet: '3000' }]).honest, false)
})
