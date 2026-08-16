#!/usr/bin/env node
// Lightweight identity-only entry point for catalog backfills. It uses the same DeepSeek engine,
// prompt, schema and sanitizer as normal runs, but does not refine or write editorial artifacts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFilePolicy, prepareFile, selectEngine } from './jobs.js'
import { extractTranscriptMetadata } from '../core/transcript-metadata.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!flag.startsWith('--') || argv[i + 1] == null) continue
    out[flag.slice(2)] = argv[i + 1]
  }
  return out
}

function readText(filePath) {
  return filePath ? fs.readFileSync(path.resolve(filePath), 'utf8').trim() : ''
}

function readCatalog(filePath) {
  if (!filePath) return { people: [], organizations: [] }
  const value = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('catalog 必须是 JSON 对象')
  return value
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file) throw new Error('缺少 --file')
  const source = path.resolve(args.file)
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`找不到文件 ${source}`)
  const topic = args.topic || path.basename(source, path.extname(source))
  const outputDir = path.resolve(args.out || fs.mkdtempSync(path.join(os.tmpdir(), 'latepost-metadata-')))
  fs.mkdirSync(outputDir, { recursive: true })
  const { entry } = await prepareFile(source, {
    topic,
    date: '',
    headingPolicy: 'none',
    outputDir,
    workDir: path.join(outputDir, '.converted'),
  })
  const filePolicy = buildFilePolicy({
    outputDir,
    skillDir: path.join(REPO_ROOT, 'claude-code-skill'),
    files: [entry],
    topic,
    scope: [],
  })
  const selected = selectEngine({
    concurrency: args.concurrency ? Number(args.concurrency) : 1,
    filePolicy,
    onLog: (message) => process.stderr.write(`${message}\n`),
  })
  const transcriptMetadata = await extractTranscriptMetadata(selected.engine, entry, {
    topic,
    background: readText(args['background-file']),
    catalog: readCatalog(args.catalog),
    model: 'deepseek-v4-flash',
  })
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    provider: selected.provider,
    transcriptMetadata,
    usage: selected.engine.usage(),
  }) + '\n')
}

main().catch((error) => {
  process.stderr.write(`metadata extraction failed: ${error && error.message ? error.message : String(error)}\n`)
  process.exit(1)
})
