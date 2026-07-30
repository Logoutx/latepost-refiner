#!/usr/bin/env node
// 说话人结构速查：不调模型、不写文件，只读一份源稿，把解析器眼里的说话人结构原样打印出来。
// 怀疑某份稿子的说话人标签被弄坏时，先跑这个。
//
//   node scripts/speaker-inspect.mjs <文件.md> [--json]
//
// 打印内容：说话人模式、标签行数、轨道数、逐轨道明细、映射结果，以及近似漏判扫描
// （scanSpeakerNearMiss，与 universal/speaker-trace.js 共用同一份实现）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSpeakerDocument, resolveSpeakerMapping } from './speaker-resolver.js'
import { scanSpeakerNearMiss } from '../universal/speaker-trace.js'

const USAGE = '用法：node scripts/speaker-inspect.mjs <文件.md> [--json]'

function inspect(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const parsed = parseSpeakerDocument(text)
  const resolved = resolveSpeakerMapping(text, [])
  const kindByKey = new Map()
  for (const fact of parsed.labels || []) {
    const key = fact.matchKey || fact.key
    if (key && !kindByKey.has(key)) kindByKey.set(key, fact.kind)
  }
  return {
    file: path.resolve(filePath),
    speakerMode: parsed.speakerMode,
    labelLines: parsed.labelLines,
    trackCount: (parsed.tracks || []).length,
    needsResolution: parsed.needsResolution,
    tracks: (parsed.tracks || []).map((track) => ({
      sourceLabel: track.sourceLabel,
      key: track.key,
      kind: kindByKey.get(track.key) || null,
      generic: !!track.generic,
      roleLike: !!track.roleLike,
      firstLine: track.firstLine,
      labelLines: track.labelLines,
    })),
    mappings: (resolved.mappings || []).map((m) => ({
      sourceLabel: m.sourceLabel, outputLabel: m.outputLabel, basis: m.basis, role: m.role, labelLines: m.labelLines,
    })),
    unresolved: resolved.unresolved || [],
    nearMiss: scanSpeakerNearMiss(parsed),
  }
}

function pad(value, width) {
  const text = String(value == null || value === '' ? '—' : value)
  let cells = 0
  for (const ch of text) cells += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u.test(ch) ? 2 : 1
  return text + ' '.repeat(Math.max(1, width - cells))
}

function printHuman(report) {
  console.log(`文件：${report.file}`)
  const modeLabel = report.speakerMode === 'tracked'
    ? 'tracked（已确认说话人轨道）'
    : report.speakerMode === 'ambiguous'
    ? 'ambiguous（疑似有说话人结构，需 Scout 证据或人工复核）'
    : 'untracked（没有说话人标签证据）'
  console.log(`说话人模式：${modeLabel}`)
  console.log(`标签行数：${report.labelLines}　·　说话人轨道数：${report.trackCount}　·　需要靠侦察定身份：${report.needsResolution ? '是' : '否'}`)
  console.log('')
  console.log('逐轨道：')
  console.log(`  ${pad('源标签', 20)}${pad('识别方式', 16)}${pad('泛称', 6)}${pad('角色词', 8)}${pad('首现行', 8)}${pad('标签行数', 10)}`)
  for (const track of report.tracks) {
    console.log(`  ${pad(track.sourceLabel, 20)}${pad(track.kind, 16)}${pad(track.generic ? '是' : '否', 6)}${pad(track.roleLike ? '是' : '否', 8)}${pad(track.firstLine, 8)}${pad(track.labelLines, 10)}`)
  }
  if (!report.tracks.length) console.log('  （没有识别到任何说话人轨道）')
  console.log('')
  console.log('映射（不带侦察结果，纯源文件推断）：')
  for (const m of report.mappings) console.log(`  ${pad(m.sourceLabel, 20)}→ ${pad(m.outputLabel, 20)}依据 ${m.basis}`)
  if (!report.mappings.length) console.log('  （无）')
  if (report.unresolved.length) console.log(`  仍未确定身份：${report.unresolved.map((x) => `“${x}”`).join('、')}`)
  console.log('')
  console.log('近似漏判扫描：')
  if (!report.nearMiss.warnings.length) console.log('  没有发现异常。')
  for (const warning of report.nearMiss.warnings) console.log(`  ⚠ ${warning}`)
}

function main(argv) {
  const args = argv.filter((x) => x !== '--json')
  const asJson = argv.includes('--json')
  const target = args[0]
  if (!target) { console.error(USAGE); process.exit(2) }
  const filePath = path.resolve(target)
  if (!fs.existsSync(filePath)) { console.error(`找不到文件：${filePath}`); process.exit(2) }
  const report = inspect(filePath)
  if (asJson) console.log(JSON.stringify(report, null, 2))
  else printHuman(report)
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main(process.argv.slice(2))

export { inspect }
