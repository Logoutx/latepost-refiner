#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const HARD_LONG_CHARS = 900

function usage() {
  return `Usage:
  node scripts/audit_refined.mjs <refined.md> [more.md...]

Audits refined Chinese interview transcripts for leftover filler/stutter and overlong combined paragraphs.`
}

function matches(re, text) {
  return Array.from(text.matchAll(re)).map((m) => ({
    match: m[0],
    index: m.index ?? 0,
  }))
}

function lineFor(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

function auditFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((raw, index) => ({ index: index + 1, text: raw.trim() }))
    .filter((p) => p.text && !p.text.startsWith('#') && !p.text.startsWith('*'))

  const checks = [
    {
      name: 'confirmation_repeats',
      severity: 'hard',
      pattern: /(?:对){2,}|(?:是){2,}|嗯嗯/g,
    },
    {
      name: 'stutter_repeats',
      severity: 'hard',
      pattern: /([我你他她它这那就有没不能会要再先])\1/g,
    },
    {
      name: 'tone_particles',
      severity: 'hard',
      pattern: /[嗯呃啊哦欸]/g,
    },
    {
      name: 'empty_phrase_candidates',
      severity: 'soft',
      pattern: /那个|这个|就是说|对吧|是吧|对不对|你知道/g,
    },
  ]

  const findings = checks.map((check) => {
    const found = matches(check.pattern, text)
    return {
      name: check.name,
      severity: check.severity,
      count: found.length,
      samples: found.slice(0, 12).map((m) => ({
        text: m.match,
        line: lineFor(text, m.index),
      })),
    }
  })

  const longParagraphs = paragraphs
    .filter((p) => p.text.length > HARD_LONG_CHARS)
    .map((p) => ({
      paragraph: p.index,
      chars: p.text.length,
      starts_with: p.text.slice(0, 100).replace(/\s+/g, ' '),
    }))

  const hardIssueCount = findings
    .filter((f) => f.severity === 'hard')
    .reduce((sum, f) => sum + f.count, 0) + longParagraphs.length

  return {
    file: path.resolve(filePath),
    status: hardIssueCount ? 'fail' : 'ok',
    paragraph_count: paragraphs.length,
    long_paragraphs: longParagraphs,
    findings,
  }
}

function main() {
  const files = process.argv.slice(2).filter((arg) => arg !== '--json')
  if (!files.length || files.includes('-h') || files.includes('--help')) {
    console.log(usage())
    return 0
  }
  const reports = files.map(auditFile)
  const result = {
    status: reports.some((r) => r.status === 'fail') ? 'fail' : 'ok',
    files: reports,
  }
  console.log(JSON.stringify(result, null, 2))
  return result.status === 'fail' ? 1 : 0
}

process.exitCode = main()
