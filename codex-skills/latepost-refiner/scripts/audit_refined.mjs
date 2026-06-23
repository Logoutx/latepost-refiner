#!/usr/bin/env node
// Deterministic quality audit for refined Chinese interview transcripts.
//
// Two modes:
//   1. Output-only (auditText/auditFile/auditFiles): checks the refined file's
//      own cleanliness — leftover filler, run-on paragraphs. Cannot see the
//      source, so it CANNOT detect compression/summarization.
//   2. Source-aware (auditPair/auditPairs): compares refined vs source to catch
//      the two real failures — compression (refine became summary) and
//      under-refinement (filler barely removed).
//
// Hard residual noise (output-only, always a fail): 嗯/呃, 对对对/是是是, stutter
// repeats 我我/就就, paragraphs > ~900 chars.
// Soft (never fails): 啊/哦/欸 modal particles, 那个/这个/就是说 (context-dependent).
//
// Source-aware gates (mode: 'refine'):
//   - compression_risk: charRatio < 0.55  (PRIMARY gate; faithful ~0.83, summary ~0.21)
//   - under_refined:     source filler-heavy AND emptyReduction < 0.25
//   - ending_missing:    source's last sentence not found in the refined output
//   - residual_noise / long_paragraphs: from the output-only checks
//   speakerTurnRatio is reported as a CONFIRMING signal only (consolidated
//   alternations, so rule-4a same-speaker merging doesn't lower it) — it never
//   fails a high-charRatio output on its own.
//   mode 'summary' | 'timeline' | 'logic' skip the charRatio / under_refined /
//   ending gates (a summary is meant to be short).
//
// Importable: auditText / auditFile / auditFiles / auditPair / auditPairs. Also a CLI.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARD_LONG_CHARS = 900

export const REFINE_GATES = {
  CHAR_RATIO_MIN: 0.55,         // refined/source 汉字 below this → probable compression
  EMPTY_REDUCTION_MIN: 0.25,    // filler density must drop at least this much
  SOURCE_FILLER_DENSITY: 0.02,  // only apply the under-refine check when source is filler-heavy
}

const EMPTY_PHRASE = /那个|这个|就是说|对吧|是吧|对不对|你知道/g

const CHECKS = [
  { name: 'confirmation_repeats', severity: 'hard', pattern: /(?:对){2,}|(?:是){2,}|嗯嗯/g },
  { name: 'stutter_repeats',      severity: 'hard', pattern: /([我你他她它这那就有没不能会要再先])\1/g },
  { name: 'filler_particles',     severity: 'hard', pattern: /[嗯呃]/g },                 // 几乎总是垫词
  { name: 'modal_particles',      severity: 'soft', pattern: /[啊哦欸]/g },               // 可能是句末语气词，看上下文
  { name: 'empty_phrase_candidates', severity: 'soft', pattern: EMPTY_PHRASE },
]

function matches(re, text) {
  return Array.from(text.matchAll(re)).map((m) => ({ match: m[0], index: m.index ?? 0 }))
}
function lineFor(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}
function hanzi(text) {
  return (text.match(/[一-龥]/g) || []).length
}
function emptyCount(text) {
  return (text.match(EMPTY_PHRASE) || []).length
}

// Ordered speaker identifiers from either format: source "**发言人 1 …**" or
// refined "老夏：/记者：". Headings/quotes/tables are skipped.
function speakerSeq(text) {
  const ids = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const src = line.match(/^\*{0,2}\s*发言人\s*([0-9一二三四五六七八九十]+)/)
    if (src) { ids.push('S' + src[1]); continue }
    if (/^[#*>|]/.test(line)) continue
    const ref = line.match(/^([一-龥A-Za-z][^：:\s]{0,7})[：:]/)
    if (ref) { ids.push('R' + ref[1]) }
  }
  return ids
}
// Consolidated turns = speaker *alternations* (collapse consecutive same-speaker).
// Invariant to ASR fragmentation, so a faithful refine that merges split turns
// keeps the same count as its source.
function consolidatedTurns(text) {
  let turns = 0, prev = null
  for (const s of speakerSeq(text)) { if (s !== prev) { turns += 1; prev = s } }
  return turns
}
// Lenient ending check: is the source's last sentence reflected in the refined output?
function endingCovered(sourceText, refinedText) {
  const srcLines = sourceText.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !/^\*{0,2}\s*发言人/.test(s) && !/^[#*>|]/.test(s))
  const lastSrc = srcLines[srcLines.length - 1] || ''
  const tail = (lastSrc.match(/[一-龥]/g) || []).slice(-14).join('')
  if (tail.length < 4) return true // can't judge → lenient
  const refHan = (refinedText.match(/[一-龥]/g) || []).join('')
  for (let i = 0; i + 4 <= tail.length; i += 1) {
    if (refHan.includes(tail.slice(i, i + 4))) return true
  }
  return false
}

export function auditText(text, file = '<text>') {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((raw, i) => ({ index: i + 1, text: raw.trim() }))
    .filter((p) => p.text && !/^[#*>|]/.test(p.text))

  const findings = CHECKS.map((c) => {
    const found = matches(c.pattern, text)
    return {
      name: c.name,
      severity: c.severity,
      count: found.length,
      samples: found.slice(0, 12).map((m) => ({ text: m.match, line: lineFor(text, m.index) })),
    }
  })

  const long_paragraphs = paragraphs
    .filter((p) => p.text.length > HARD_LONG_CHARS)
    .map((p) => ({ paragraph: p.index, chars: p.text.length, starts_with: p.text.slice(0, 80).replace(/\s+/g, ' ') }))

  const hard_issues = findings.filter((f) => f.severity === 'hard').reduce((s, f) => s + f.count, 0) + long_paragraphs.length
  return { file, status: hard_issues ? 'fail' : 'ok', hard_issues, paragraph_count: paragraphs.length, long_paragraphs, findings }
}

export function auditFile(filePath) {
  return auditText(fs.readFileSync(filePath, 'utf8'), path.resolve(filePath))
}

export function auditFiles(paths) {
  const files = (paths || []).map(auditFile)
  return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
}

// Source-aware audit: compare refined output against its source transcript.
export function auditPair({ sourceText, refinedText, sourceFile = '<source>', refinedFile = '<refined>', mode = 'refine' }) {
  const out = auditText(refinedText, refinedFile) // output-only cleanliness (residual noise / long paras)

  const sChars = hanzi(sourceText)
  const rChars = hanzi(refinedText)
  const charRatio = sChars ? Number((rChars / sChars).toFixed(3)) : 1
  const sTurns = consolidatedTurns(sourceText)
  const rTurns = consolidatedTurns(refinedText)
  const speakerTurnRatio = sTurns ? Number((rTurns / sTurns).toFixed(3)) : 1
  const sEmptyDensity = sChars ? emptyCount(sourceText) / sChars : 0
  const rEmptyDensity = rChars ? emptyCount(refinedText) / rChars : 0
  const emptyReduction = sEmptyDensity ? Number((1 - rEmptyDensity / sEmptyDensity).toFixed(3)) : 0
  const ending = endingCovered(sourceText, refinedText)

  const metrics = {
    sourceChars: sChars, refinedChars: rChars, charRatio,
    sourceTurns: sTurns, refinedTurns: rTurns, speakerTurnRatio, // turnRatio is confirming-only, never an independent gate
    sourceEmptyDensity: Number(sEmptyDensity.toFixed(4)), refinedEmptyDensity: Number(rEmptyDensity.toFixed(4)), emptyReduction,
    endingCovered: ending,
  }

  const gates = {
    residual_noise: out.hard_issues > 0,
    long_paragraphs: (out.long_paragraphs || []).length > 0,
  }
  if (mode === 'refine') {
    gates.compression_risk = charRatio < REFINE_GATES.CHAR_RATIO_MIN
    gates.under_refined = sEmptyDensity > REFINE_GATES.SOURCE_FILLER_DENSITY && emptyReduction < REFINE_GATES.EMPTY_REDUCTION_MIN
    gates.ending_missing = !ending
  }
  const failed = Object.keys(gates).filter((k) => gates[k])
  return { file: out.file, mode, status: failed.length ? 'fail' : 'ok', failed, metrics, long_paragraphs: out.long_paragraphs, findings: out.findings }
}

export function auditPairs(pairs) {
  const files = (pairs || []).map((p) => auditPair({
    sourceText: p.sourceText != null ? p.sourceText : fs.readFileSync(p.sourcePath, 'utf8'),
    refinedText: p.refinedText != null ? p.refinedText : fs.readFileSync(p.refinedPath, 'utf8'),
    sourceFile: p.sourcePath || p.sourceFile,
    refinedFile: p.refinedPath || p.refinedFile,
    mode: p.mode || 'refine',
  }))
  return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
}

function usage() {
  return `用法:
  node scripts/audit_refined.mjs <精校稿.md> [更多.md...]          # 只查输出干净度
  node scripts/audit_refined.mjs --source <源稿.md> --refined <精校稿.md> [--mode refine|summary]
                                                                  # 对比源文：查压缩/欠精校

输出-only hard（算失败）：嗯/呃、对对对/是是是、我我/就就 等纯噪音；超约 900 字的对话长段。
对比源文 hard（mode=refine）：charRatio < 0.55（疑似压缩成摘要）、欠精校、结尾缺失。
soft（不算失败、需看上下文）：句末语气词 啊/哦/欸，以及 那个/这个/就是说 等。`
}

function getOpt(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) { console.log(usage()); return 0 }
  const source = getOpt(argv, '--source')
  const refined = getOpt(argv, '--refined')
  if (source && refined) {
    const result = auditPairs([{ sourcePath: source, refinedPath: refined, mode: getOpt(argv, '--mode') || 'refine' }])
    console.log(JSON.stringify(result, null, 2))
    return result.status === 'fail' ? 1 : 0
  }
  const files = argv.filter((a) => !a.startsWith('--'))
  const result = auditFiles(files)
  console.log(JSON.stringify(result, null, 2))
  return result.status === 'fail' ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
