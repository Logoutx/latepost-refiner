// M10 cheap-first escalation — offline, mock engines, fictional data only.
//
// The cheap (primary) engine refines to a COMPRESSED summary → the deterministic audit fails
// (compression_risk + ending_missing). With --escalate configured, the file is re-refined FROM SOURCE
// on the premium engine and re-audited. These tests cover: (a) escalation replaces the file + records both
// audits + renders review.md + exit code reflects final state; (b) no --escalate → byte-equivalent, zero
// escalation calls even when audit fails; (c) premium ALSO fails → keep-best + loud「两档均未过审」marker;
// (d) escalation usage merged into totals; (e) CLI parseArgs/buildRunParams map the new flags.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runJob } from '../universal/jobs.js'
import { parseArgs, buildRunParams, computeExitCode } from '../universal/cli.js'

const fx = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/escalation/${name}`, import.meta.url)), 'utf8')
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-escalation-')) }

// Base usage shape every mock engine reports (matches engines/api.js + engines/openai.js).
const usageObj = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, agents: 0, failed: 0 })

// Cheap primary engine: multi-file branch. Its `pipeline` writes a COMPRESSED summary for each file, so the
// in-pipeline audit gate (jobs.js injects capabilities.runAudit) flags compression_risk + ending_missing.
function cheapEngine() {
  const usage = usageObj()
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, fx('cheap-compressed.md'))
      return { path: f.outPath, headings: ['## 摘要'], key_fixes: [], open_questions: [] }
    }),
    agent: async () => { usage.agents++; return null }, // scouts/verify/dedup → null; audit uses the injected capability
  }
}

// Premium engine factory. On a `refine:` agent call it WRITES the fixture (read via `reader`) to the file's
// outPath (the same contract the pipeline's refine agent has) and returns a REFINE_REPORT-shaped object.
// Everything else → null. `reader` defaults to the escalation-fixtures reader; pass `cov` for coverage fixtures.
function premiumEngine(refinedFixture, tag = 'premium', reader = fx) {
  const usage = usageObj()
  const calls = []
  const eng = {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async () => [],
    agent: async (_prompt, opts = {}) => {
      usage.agents++
      calls.push(opts.label || '')
      if (opts.label && opts.label.startsWith('refine:')) {
        // The escalation writes the file's outPath itself. Recover it from the prompt (it embeds `Write 到 <outPath>`).
        const m = String(_prompt).match(/Write 到 (\S+)/)
        if (m) { fs.mkdirSync(path.dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1], reader(refinedFixture)) }
        return { path: m ? m[1] : 'unused.md', headings: ['## 自我介绍'], key_fixes: [], open_questions: [] }
      }
      return null
    },
  }
  eng.__calls = calls
  eng.__tag = tag
  return eng
}

async function runEscalationJob({ escalate = { provider: 'anthropic' }, premium = premiumEngine('premium-good.md'), extra = {} } = {}) {
  const outputDir = tmpdir()
  const src64 = Buffer.from(fx('source.md')).toString('base64')
  const result = await runJob({
    __engine: cheapEngine(),
    __escalateEngine: premium,
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }], // 2 files → multi-file branch
    topic: '试跑', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    escalate,
    ...extra,
  })
  return { result, premium, outputDir }
}

// (a) The happy path: cheap fails, premium passes, file replaced, both audits recorded, review.md rendered.
test('escalation: cheap output fails audit → premium re-refine passes → file replaced + both audits recorded', async () => {
  const { result, premium } = await runEscalationJob()

  // The premium engine was actually invoked (one refine per failing file — 2 files here).
  const refineCalls = premium.__calls.filter((l) => l.startsWith('refine:'))
  assert.equal(refineCalls.length, 2, 'premium re-refined each failing file exactly once')

  // The escalation block is populated and both files passed on premium.
  assert.ok(result.escalation, 'result.escalation present')
  assert.equal(result.escalation.provider, 'anthropic')
  assert.equal(result.escalation.escalated, 2)
  assert.equal(result.escalation.passed, 2)
  assert.equal(result.escalation.bothFailed, 0)

  // Per-file records carry BOTH the cheap and premium audits.
  for (const f of result.escalation.files) {
    assert.ok(f.cheapAudit && f.cheapAudit.failed.includes('compression_risk'), 'cheap audit recorded (compression)')
    assert.ok(f.premiumAudit && f.premiumAudit.status === 'ok', 'premium audit recorded (passed)')
    assert.equal(f.kept, 'premium')
    assert.equal(f.bothFailed, false)
  }

  // The 成稿 ON DISK is the premium (faithful) output, not the cheap summary.
  for (const rr of result.refined) {
    const text = fs.readFileSync(rr.outPath || rr.path, 'utf8')
    assert.ok(text.includes('自我介绍') && text.includes('也谢谢你们'), 'premium faithful output on disk (ending covered)')
    assert.ok(!text.includes('## 摘要'), 'cheap summary replaced')
  }

  // Final-state refresh: the file passed on premium, so it is NO LONGER in auditFailed / incomplete, and its
  // inline audit is ok. The exit code is 0 (a clean run after escalation).
  assert.deepEqual(result.auditFailed, [], 'escalated-and-passed files cleared from auditFailed')
  assert.deepEqual(result.incomplete, [], 'ending_missing cleared after premium fixed the ending')
  assert.ok(result.refined.every((r) => r.audit && r.audit.status === 'ok'), 'each refined entry audits ok post-escalation')
  assert.equal(result.audit.status, 'ok', 'top-level audit status ok after escalation')
  assert.equal(computeExitCode(result), 0, 'exit code 0 — audit satisfied via escalation')

  // review.md renders the「升级重跑」section; run.json records the escalation block.
  const review = fs.readFileSync(result.reviewPath, 'utf8')
  assert.match(review, /升级重跑/, 'review.md has the 升级重跑 section')
  assert.match(review, /升级 anthropic 已过审/, 'review.md notes the premium pass')
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.ok(manifest.escalation, 'run.json has the escalation block')
  assert.equal(manifest.escalation.passed, 2)
  assert.ok(manifest.escalation.files[0].cheapAudit && manifest.escalation.files[0].premiumAudit, 'both audits in run.json')
})

// (b) OPT-IN guarantee: WITHOUT --escalate, behaviour is byte-equivalent and ZERO escalation calls happen
// even though the audit fails. The compressed cheap output stays on disk; the file lands in auditFailed-adjacent
// review sections exactly as before M10.
test('escalation: no --escalate → byte-equivalent behaviour, zero escalation calls even when audit fails', async () => {
  const outputDir = tmpdir()
  const src64 = Buffer.from(fx('source.md')).toString('base64')
  const premium = premiumEngine('premium-good.md') // provided but must never be touched (no escalate configured)
  const result = await runJob({
    __engine: cheapEngine(),
    __escalateEngine: premium, // present but inert without params.escalate
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }],
    topic: '试跑', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    // NO escalate key
  })
  assert.equal(premium.__calls.length, 0, 'premium engine never called without --escalate')
  assert.equal(result.escalation, null, 'no escalation block')
  // The audit still failed (compression) — the cheap summary is on disk and surfaced, unchanged from pre-M10.
  assert.ok(result.audit && result.audit.status === 'fail', 'audit still fails on the compressed cheap output')
  assert.ok(result.incomplete.length >= 1, 'ending_missing still reported (no escalation to fix it)')
  for (const rr of result.refined) {
    assert.ok(fs.readFileSync(rr.outPath || rr.path, 'utf8').includes('## 摘要'), 'cheap summary untouched on disk')
  }
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.equal(manifest.escalation, null, 'run.json escalation is null without the flag')
})

// (c) Both tiers fail: premium ALSO writes a compressed summary. keep-best (tie → premium) + a loud
// 「两档均未过审」marker in review.md + openQuestions; the file stays in auditFailed/incomplete (unresolved).
test('escalation: premium also fails → keep-best (tie→premium) + loud 两档均未过审 marker', async () => {
  const { result } = await runEscalationJob({ premium: premiumEngine('cheap-compressed.md', 'premium-bad') })

  assert.ok(result.escalation, 'escalation ran')
  assert.equal(result.escalation.passed, 0, 'nothing passed on premium')
  assert.equal(result.escalation.bothFailed, 2, 'both files failed both tiers')
  for (const f of result.escalation.files) {
    assert.equal(f.bothFailed, true)
    assert.equal(f.kept, 'premium', 'tie → premium kept')
    assert.ok(f.premiumAudit && f.premiumAudit.status === 'fail', 'premium audit recorded as fail')
  }
  // The still-failing file remains in the hard-fail / incomplete accounting (nothing was silently cleared).
  assert.ok((result.auditFailed || []).length === 0, 'compression is not a HARD content-gate → not in auditFailed')
  assert.ok(result.incomplete.length >= 1, 'ending_missing still unresolved after both tiers')
  assert.equal(result.audit.status, 'fail', 'top-level audit still fails')

  // Loud markers: review.md「升级重跑」 says 两档均未过审; an openQuestion surfaces it for the Step-5 batch-ask.
  const review = fs.readFileSync(result.reviewPath, 'utf8')
  assert.match(review, /两档均未过审/, 'review.md loudly marks the double failure')
  assert.ok((result.openQuestions || []).some((q) => /两档均未过审/.test(String(q))), 'openQuestions carries the loud line')
})

// (c2) keep-best RESTORE branch: cheap fails with FEWER gates than premium → cheap is kept and RESTORED to
// disk (premium overwrote it during the re-refine). Uses the coverage fixtures: cheap = coverage-refined-good
// (fails ending_missing only, 1 gate); premium re-refine = coverage-refined-gap (compression_risk +
// ending_missing + content_gap, 3 gates). Cheap strictly better → restore cheap; loud 两档均未过审 either way.
const cov = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/audit/${name}`, import.meta.url)), 'utf8')
function cheapCoverageEngine(fixture) {
  const usage = usageObj()
  return {
    phase() {}, log() {}, usage: () => ({ ...usage }),
    parallel: async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null))),
    pipeline: async (items) => items.map((f) => {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, cov(fixture))
      return { path: f.outPath, headings: ['## 公司概况'], key_fixes: [], open_questions: [] }
    }),
    agent: async () => { usage.agents++; return null },
  }
}
test('escalation: cheap fails with fewer gates than premium → keep-best restores the cheap 成稿', async () => {
  const outputDir = tmpdir()
  const src64 = Buffer.from(cov('coverage-source.md')).toString('base64')
  const premium = premiumEngine('coverage-refined-gap.md', 'premium-worse', cov) // premium re-refine is WORSE
  const result = await runJob({
    __engine: cheapCoverageEngine('coverage-refined-good.md'), // cheap fails ending_missing only
    __escalateEngine: premium,
    files: [{ name: '甲.md', base64: src64 }, { name: '乙.md', base64: src64 }],
    topic: '试跑', date: '2026-07', outputDir, scope: ['refine'], verifyDepth: 'none',
    anchors: false, // keep the restored cheap 成稿 byte-identical to the fixture (no anchor comments injected)
    escalate: { provider: 'anthropic' },
  })
  assert.equal(result.escalation.bothFailed, 2, 'both tiers failed the raw audit')
  for (const f of result.escalation.files) {
    assert.equal(f.kept, 'cheap', 'cheap kept (fewer failed gates)')
    assert.deepEqual(f.cheapAudit.failed, ['ending_missing'], 'cheap failed only ending_missing')
    assert.ok(f.premiumAudit.failed.includes('content_gap'), 'premium re-refine was worse (content_gap)')
  }
  // The cheap 成稿 was restored to disk (premium had overwritten it). With anchors off it byte-matches the fixture.
  for (const rr of result.refined) {
    assert.equal(fs.readFileSync(rr.outPath || rr.path, 'utf8'), cov('coverage-refined-good.md'), 'cheap 成稿 restored verbatim')
  }
  // No HARD content-gate remains (cheap had none), so the exit code is 0 even though both tiers "failed" the raw audit.
  assert.deepEqual(result.auditFailed, [], 'no hard content_gap survived → auditFailed empty')
  assert.equal(computeExitCode(result), 0, 'exit 0 — the surviving failure (ending_missing) is not a hard content-gate')
})

// (d) Usage accounting: the premium engine's usage is merged into the run totals, with a separate
// `escalation` sub-object holding the premium-only breakdown.
test('escalation: premium usage merged into totals with a separate escalation sub-object', async () => {
  // Give the premium engine non-zero usage by having its usage() report agents from its calls.
  const premium = premiumEngine('premium-good.md')
  // Wrap usage() so it reflects the agent calls it made (the factory already ++s usage.agents per call).
  const { result } = await runEscalationJob({ premium })
  const premUsage = premium.usage()
  assert.ok(premUsage.agents >= 2, 'premium engine tallied its refine calls')
  assert.ok(result.usage.escalation, 'result.usage.escalation sub-object present')
  assert.equal(result.usage.escalation.agents, premUsage.agents, 'escalation sub-object equals the premium usage')
  // Totals include the premium agents on top of the cheap engine's.
  assert.ok(result.usage.agents >= premUsage.agents, 'top-line agent total includes escalation agents')
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.ok(manifest.usage && manifest.usage.escalation, 'run.json usage carries the escalation breakdown')
})

// (e) CLI: parseArgs maps the new flags; buildRunParams assembles the escalate object.
test('escalation: CLI parseArgs + buildRunParams map --escalate / --escalate-models / --escalate-base-url', () => {
  const a = parseArgs([
    '--files', 'x.md',
    '--topic', '试跑',
    '--provider', 'deepseek',
    '--escalate', 'anthropic',
    '--escalate-models', 'refine=claude-opus-4-8',
    '--escalate-base-url', 'https://example.invalid/v1',
  ])
  assert.equal(a.escalate, 'anthropic')
  assert.equal(a.escalateModels, 'refine=claude-opus-4-8')
  assert.equal(a.escalateBaseURL, 'https://example.invalid/v1')

  const params = buildRunParams(a, { env: { HOME: '/tmp' } })
  assert.equal(params.provider, 'deepseek', 'cheap first-pass provider')
  assert.ok(params.escalate, 'escalate object built')
  assert.equal(params.escalate.provider, 'anthropic')
  assert.equal(params.escalate.baseURL, 'https://example.invalid/v1')
  assert.deepEqual(params.escalate.models, { refine: 'claude-opus-4-8' })

  // No --escalate → undefined (opt-in).
  const bare = buildRunParams(parseArgs(['--files', 'x.md', '--topic', 't']), { env: { HOME: '/tmp' } })
  assert.equal(bare.escalate, undefined, 'no escalate object without the flag')
})
