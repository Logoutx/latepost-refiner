#!/usr/bin/env node
// Deterministic quality audit for refined Chinese interview transcripts.
//
// Hard failures (status: fail) — must be fixed or explicitly surfaced:
//   - leftover pure filler particles 嗯 / 呃 (almost always noise)
//   - confirmation / stutter repeats: 对对对 / 是是是 / 嗯嗯 / 我我 / 就就 …
//   - dialogue paragraphs over ~900 characters (run-on; needs re-splitting)
//
// Soft candidates (do NOT fail the audit — inspect context before deleting):
//   - sentence-final modal particles 啊 / 哦 / 欸 (often legitimate tone)
//   - context-dependent 那个 / 这个 / 就是说 / 对吧 … (can be meaningful)
//
// Importable: auditText / auditFile / auditFiles. Also runs as a CLI.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARD_LONG_CHARS = 900

const CHECKS = [
  { name: 'confirmation_repeats', severity: 'hard', pattern: /(?:对){2,}|(?:是){2,}|嗯嗯/g },
  { name: 'stutter_repeats',      severity: 'hard', pattern: /([我你他她它这那就有没不能会要再先])\1/g },
  { name: 'filler_particles',     severity: 'hard', pattern: /[嗯呃]/g },                 // 几乎总是垫词
  { name: 'modal_particles',      severity: 'soft', pattern: /[啊哦欸]/g },               // 可能是句末语气词，看上下文
  { name: 'empty_phrase_candidates', severity: 'soft', pattern: /那个|这个|就是说|对吧|是吧|对不对|你知道/g },
]

function matches(re, text) {
  return Array.from(text.matchAll(re)).map((m) => ({ match: m[0], index: m.index ?? 0 }))
}
function lineFor(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

export function auditText(text, file = '<text>') {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((raw, i) => ({ index: i + 1, text: raw.trim() }))
    // skip headings, italic subtitles, editor bridges, table rows — not dialogue paragraphs
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

function usage() {
  return `用法:
  node scripts/audit_refined.mjs <精校稿.md> [更多.md...]

抽查精校稿。hard（算失败）：残留纯噪音口癖（嗯/呃、对对对/是是是、我我/就就 等）、超约 900 字的对话长段。
soft（不算失败、需看上下文）：句末语气词 啊/哦/欸，以及 那个/这个/就是说/对吧 等。`
}

function main() {
  const files = process.argv.slice(2).filter((a) => a !== '--json')
  if (!files.length || files.includes('-h') || files.includes('--help')) { console.log(usage()); return 0 }
  const result = auditFiles(files)
  console.log(JSON.stringify(result, null, 2))
  return result.status === 'fail' ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
