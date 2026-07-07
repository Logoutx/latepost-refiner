// ===== M10 cheap-first escalation (universal-only) =====
// OPT-IN provider routing with a deterministic-gate escalation. The NORMAL --provider does the
// first (cheap) refine pass; the audit gates judge each 成稿; a file whose audit FAILS is
// RE-REFINED FROM THE ORIGINAL SOURCE on a premium engine, then re-audited. Quality is enforced by
// gates, not provider trust.
//
// Why universal-only (like M8 crossFileConflicts): escalation needs fs (read source, restore a losing
// cheap 成稿), the premium engine built via selectEngine, and the batch-level audit — none of which the
// CC-sandbox pipeline has. So this lives in universal/ and NOTHING here touches core/* → the CC bundle
// (workflow.js) is unaffected and build:cc stays byte-identical.
//
// Two hard principles:
//   (1) OPT-IN only: runJob does nothing unless params.escalate is set (byte-equivalent otherwise).
//   (2) Escalation re-refines FROM SOURCE (file.path), NEVER from the possibly-compressed cheap 成稿.

import fs from 'node:fs'
import path from 'node:path'
import { refinePrompt } from '../core/prompts.js'
import { REFINE_REPORT_SCHEMA, SINGLE_FILE_GLOSSARY } from '../core/spec.js'
import { auditPairs } from '../scripts/audit_refined.mjs'

// The two hard content gates the pipeline already treats as blocking. Reused here only to describe the
// per-file outcome (hard-fail count for the keep-best tie-break weights ALL failed gates equally — see
// hardFailCount — but this list lets callers label the blocking reason).
export const HARD_GATES = ['content_gap', 'quote_style']

// A file's audit is "failing" iff the deterministic audit reported status:'fail'. This is the RAW
// per-file audit (result.audit.files[i].status), which fails on compression_risk (charRatio),
// content_gap, ending_missing, quote_style, under_refined, residual_noise, long_paragraphs — exactly
// the gates the concept names. (NOT the narrow pipeline `auditFailed`, which keeps only the two hard
// content gates and would miss the flagship "cheap provider summarized" failure.)
export const auditIsFailing = (a) => !!a && a.status === 'fail'

// Keep-best weight: number of failed gates. Fewer failed gates = better output. On a tie the premium
// output is preferred (it is already on disk; and it is the stronger model). content_gap/quote_style
// are the hardest, but weighting every gate equally is the conservative, explainable rule.
const hardFailCount = (a) => ((a && a.failed) || []).length

// The rendered batch 校对表 to seed the escalation refine. Prefer this round's in-memory glossary (unless
// it is the single-file sentinel), else the persisted <outDir>/校对表.md, else '' (behaviour then matches
// a first run — the refine prompt still works, it just has no cross-file 写法 aid). Never throws.
export function escalationGlossaryText(result, glossaryPath) {
  const g = result && result.glossary
  if (g && g !== SINGLE_FILE_GLOSSARY) return g
  try { return glossaryPath && fs.existsSync(glossaryPath) ? fs.readFileSync(glossaryPath, 'utf8') : '' } catch { return '' }
}

// Re-refine ONE file from its ORIGINAL SOURCE on the given (premium) engine, then run the deterministic
// audit pair. Reuses the exact single-agent refine prompt (refinePrompt with chunk=undefined — the same
// path the one-pass branch and the non-chunked multi-file refine use), seeded with the batch glossary.
// No scout / verify / dedup — the batch glossary already exists. Writes file.outPath (overwriting the
// cheap output). Returns { report, audit } where report is REFINE_REPORT-shaped (null if the refine
// agent produced nothing) and audit is the auditPair per-file result (null when report is null).
export async function refineSingleFile(engine, file, glossaryText, A) {
  const M = { refine: (A && A.models && A.models.refine) || 'opus' }
  const report = await engine.agent(
    refinePrompt(file, glossaryText || '', {}, A),
    { label: `refine:${file.label}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA })
  if (!report) return { report: null, audit: null }
  // The refine agent Wrote file.outPath itself (same contract as the pipeline's refine). Audit it.
  let audit = null
  try {
    const res = auditPairs([{ sourcePath: file.path, refinedPath: file.outPath, mode: 'refine', glossaryText: glossaryText || null }])
    audit = res.files[0] || null
  } catch { audit = null }
  return { report, audit }
}

// Merge premium usage into the run totals + attach a separate `escalation` sub-object. Non-destructive:
// returns a NEW usage object. base is the primary engine's usage (already on result.usage).
export function mergeEscalationUsage(base, premiumUsage) {
  const total = { ...(base || {}) }
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'agents', 'failed']
  for (const k of keys) total[k] = (total[k] || 0) + ((premiumUsage && premiumUsage[k]) || 0)
  total.escalation = premiumUsage || null
  return total
}

// Run the whole escalation pass over a completed pipeline result. Pure orchestration over the injected
// premium engine + fs; the caller (jobs.js) owns engine construction and re-writes result fields.
//
// For each file whose RAW audit failed: capture the cheap 成稿 text, re-refine from source on premium,
// re-audit, then apply the outcome policy:
//   · premium refine failed (null)            → keep cheap, bothFailed (premium unavailable).
//   · premium audit passes                    → premium wins (already on disk). kept='premium'.
//   · premium audit also fails                → keep the one with fewer failed gates (tie → premium);
//                                               if cheap wins, RESTORE the cheap 成稿 to disk; bothFailed.
//
// Returns { records[], premiumUsage, escalated:int, passed:int, bothFailed:int } where each record is
//   { outPath, label, escalated:true, cheapAudit:{status,failed}, premiumAudit:{status,failed}|null,
//     kept:'premium'|'cheap', bothFailed:bool, reason:[gates] }.
// The caller uses records to (a) refresh result.audit.files / auditFailed / incomplete to the FINAL state,
// (b) render review.md「升级重跑」 and run.json escalation, (c) print the CLI summary.
export async function runEscalation({ auditFiles, A, fileEntries, escalateEngine, glossaryText, log }) {
  const say = typeof log === 'function' ? log : () => {}
  const byOut = new Map(fileEntries.map((f) => [f.outPath, f]))
  const auditByOut = new Map((auditFiles || []).map((a) => [a.file, a]))

  const failing = (auditFiles || []).filter(auditIsFailing)
  const records = []
  let passed = 0
  let bothFailed = 0

  for (const cheapAudit of failing) {
    const file = byOut.get(cheapAudit.file)
    if (!file) continue // an audited file with no matching entry (should not happen) — skip defensively
    const label = file.label || path.basename(file.outPath)
    const reason = (cheapAudit.failed || []).slice()

    // Capture the cheap 成稿 BEFORE the premium refine overwrites file.outPath, so we can restore it if
    // the cheap output turns out to be the better of two failing drafts.
    let cheapText = null
    try { cheapText = fs.readFileSync(file.outPath, 'utf8') } catch { cheapText = null }

    say(`升级重跑：${label} 首档未过审（${reason.join('/') || 'fail'}）——从源文件在升级 provider 重跑精校`)
    const { report, audit: premiumAudit } = await refineSingleFile(escalateEngine, file, glossaryText, A)

    if (!report) {
      // Premium refine failed entirely — the cheap 成稿 is still on disk (premium never wrote). Keep it.
      // The on-disk audit is unchanged (still the cheap one) — leave auditByOut as-is.
      say(`升级重跑：${label} 升级 provider 精校失败——保留首档成稿（仍未过审）`)
      records.push({ outPath: file.outPath, label, escalated: true, cheapAudit: brief(cheapAudit), premiumAudit: null, kept: 'cheap', bothFailed: true, reason })
      bothFailed += 1
      continue
    }

    if (auditIsFailing(premiumAudit)) {
      // Both drafts fail. Keep the one with fewer failed gates; tie → premium (already on disk).
      const keepPremium = hardFailCount(premiumAudit) <= hardFailCount(cheapAudit)
      if (keepPremium) {
        say(`⚠ 升级重跑：${label} 两档均未过审（首档 ${reason.join('/')}；升级 ${(premiumAudit.failed || []).join('/')}）——保留升级档（未过审项更少或持平）`)
        records.push({ outPath: file.outPath, label, escalated: true, cheapAudit: brief(cheapAudit), premiumAudit: brief(premiumAudit), kept: 'premium', bothFailed: true, reason })
        auditByOut.set(file.outPath, premiumAudit) // premium 成稿 is on disk → it is the final audit
      } else {
        // Cheap was better — restore it (premium overwrote the file). Final audit stays the cheap one.
        if (cheapText != null) { try { fs.writeFileSync(file.outPath, cheapText, 'utf8') } catch { /* best effort */ } }
        say(`⚠ 升级重跑：${label} 两档均未过审（首档 ${reason.join('/')}；升级 ${(premiumAudit.failed || []).join('/')}）——升级档更差，已回退到首档成稿`)
        records.push({ outPath: file.outPath, label, escalated: true, cheapAudit: brief(cheapAudit), premiumAudit: brief(premiumAudit), kept: 'cheap', bothFailed: true, reason })
      }
      bothFailed += 1
      continue
    }

    // Premium passed. The premium 成稿 is already on disk. Record both audits.
    say(`升级重跑：${label} 升级 provider 已过审——替换成稿`)
    records.push({ outPath: file.outPath, label, escalated: true, cheapAudit: brief(cheapAudit), premiumAudit: brief(premiumAudit), kept: 'premium', bothFailed: false, reason })
    passed += 1
    // Update the in-memory audit map so the caller's final-state refresh sees the passing premium audit.
    auditByOut.set(file.outPath, premiumAudit)
  }

  return {
    records,
    // The FINAL per-file audits (premium where it ran+passed, cheap otherwise) so the caller can refresh
    // result.audit.files / auditFailed / incomplete to the post-escalation truth.
    finalAuditFor: (outPath) => auditByOut.get(outPath),
    premiumUsage: (escalateEngine && typeof escalateEngine.usage === 'function') ? escalateEngine.usage() : null,
    escalated: records.length,
    passed,
    bothFailed,
  }
}

// A compact audit summary kept in the manifest / records (full audit stays in result.audit.files).
function brief(a) {
  if (!a) return null
  return { status: a.status, failed: (a.failed || []).slice(), charRatio: a.metrics ? a.metrics.charRatio : null, endingCovered: a.metrics ? a.metrics.endingCovered : null }
}
