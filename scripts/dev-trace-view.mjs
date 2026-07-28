#!/usr/bin/env node
// 说话人开发记录阅读器：把 --dev-trace 写出的 speaker-trace.jsonl 渲染成分阶段的可读视图。
// 运行结束后 .dev-trace/speaker-trace.md 已经是完整小结；这个工具的价值在于——
//   1. 运行中途就能看（jsonl 是逐条追加的，小结要等 finish 才生成）；
//   2. --follow 跟着正在跑的任务实时打印新事件；
//   3. 不用记文件位置，指到运行输出目录即可。
//
//   node scripts/dev-trace-view.mjs <运行输出目录|.dev-trace 目录|speaker-trace.jsonl> [--follow]
//
// 只读，不写任何文件；打印的内容全部来自记录文件本身（标签、行号、条数，无访谈正文）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = '用法：node scripts/dev-trace-view.mjs <运行输出目录|.dev-trace 目录|speaker-trace.jsonl> [--follow]'
const POLL_MS = 1000

function resolveTracePath(target) {
  const p = path.resolve(target)
  if (!fs.existsSync(p)) return { jsonl: p.endsWith('.jsonl') ? p : path.join(p, '.dev-trace', 'speaker-trace.jsonl'), exists: false }
  if (fs.statSync(p).isFile()) return { jsonl: p, exists: true }
  for (const candidate of [path.join(p, 'speaker-trace.jsonl'), path.join(p, '.dev-trace', 'speaker-trace.jsonl')]) {
    if (fs.existsSync(candidate)) return { jsonl: candidate, exists: true }
  }
  return { jsonl: path.join(p, '.dev-trace', 'speaker-trace.jsonl'), exists: false }
}

function parseLines(text) {
  const events = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { events.push(JSON.parse(trimmed)) } catch { /* 半行或损坏行：跳过，不因此报错 */ }
  }
  return events
}

function pad(value, width) {
  const text = String(value == null || value === '' ? '—' : value)
  let cells = 0
  for (const ch of text) cells += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u.test(ch) ? 2 : 1
  return text + ' '.repeat(Math.max(1, width - cells))
}

const yesNo = (v) => (v ? '是' : '否')
const num = (v) => (v == null ? '—' : String(v))

// 单条事件 → 一行摘要（--follow 的增量输出用）
function eventLine(event) {
  const at = String(event.at || '').replace(/^.*T/, '').replace(/\..*$/, '')
  const f = event.fileLabel ? `〔${event.fileLabel}〕` : ''
  switch (event.type) {
    case 'speaker_trace_started': return `${at} 记录开始`
    case 'speaker.parse': return `${at} ${f}第 1 关 解析：${event.speakerMode}，标签行 ${num(event.labelLines)}，轨道 ${num(event.trackCount)}${(event.nearMiss && event.nearMiss.warnings || []).length ? `，⚠ 近失信号 ${event.nearMiss.warnings.length} 条` : ''}`
    case 'speaker.scout': return `${at} ${f}第 2 关 侦察：${num(event.chunkCount)} 段，合并出 ${((event.merged || {}).speakers || []).length} 位说话人${((event.merged || {}).conflictNotes || []).length ? '，⚠ 有姓名冲突' : ''}`
    case 'speaker.mapping': return `${at} ${f}第 3 关 映射：${(event.mappings || []).length} 条${(event.unresolved || []).length ? `，未定 ${(event.unresolved || []).length}` : ''}`
    case 'speaker.rewrite': return `${at} ${f}第 4 关 改写：改动 ${num(event.changedLines)}/${num(event.labelLines)} 行`
    case 'speaker.enforce': return `${at} ${f}第 5 关 出稿校验 ${event.phase}：${event.valid ? '通过' : '不通过'}，替换 ${num(event.replacements)}，未知标签 ${num(event.unknownLabelCount)}`
    case 'speaker.audit': return `${at} ${f}第 6 关 审计 ${event.phase}：${Object.entries(event.summary || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}`
    case 'speaker_trace_finished': return `${at} 记录结束（${num(event.fileCount)} 份文件），完整小结已生成`
    default: return `${at} ${event.type}`
  }
}

function collectSignals(events) {
  const signals = []
  for (const event of events) {
    if (event.type === 'speaker.parse') {
      for (const warning of (event.nearMiss && event.nearMiss.warnings) || []) signals.push(`〔${event.fileLabel}〕解析：${warning}`)
    }
    if (event.type === 'speaker.scout') {
      for (const note of (event.merged && event.merged.conflictNotes) || []) signals.push(`〔${event.fileLabel}〕侦察：${note}`)
    }
    if (event.type === 'speaker.mapping' && (event.unresolved || []).length) {
      signals.push(`〔${event.fileLabel}〕映射：仍未确定身份 ${event.unresolved.map((x) => `“${x}”`).join('、')}`)
    }
    if (event.type === 'speaker.enforce' && !event.valid) {
      const labels = (event.unknownLabels || []).map((u) => `第 ${u.line} 行“${u.label}”`).join('、')
      signals.push(`〔${event.fileLabel}〕出稿校验 ${event.phase} 不通过${labels ? `：${labels}` : ''}`)
    }
    if (event.type === 'speaker.audit') {
      const s = event.summary || {}
      if (s.assessed === false) signals.push(`〔${event.fileLabel}〕审计 ${event.phase}：attribution 未能评估`)
      if (Number(s.mismatches) > 0) signals.push(`〔${event.fileLabel}〕审计 ${event.phase}：归属错位 ${s.mismatches} 处`)
      if (s.attributionMismatchFailed === true) signals.push(`〔${event.fileLabel}〕审计 ${event.phase}：attribution_mismatch 硬性不通过`)
    }
  }
  return signals
}

function renderTrace(events) {
  const out = []
  const byFile = new Map()
  for (const event of events) {
    if (!event.fileLabel) continue
    if (!byFile.has(event.fileLabel)) byFile.set(event.fileLabel, [])
    byFile.get(event.fileLabel).push(event)
  }
  const finished = events.some((event) => event.type === 'speaker_trace_finished')
  out.push(`事件 ${events.length} 条 · 文件 ${byFile.size} 份 · ${finished ? '运行已结束' : '运行未结束（或中途退出）'}`)
  out.push('')

  for (const [label, fileEvents] of byFile) {
    out.push(`■ ${label}`)
    const parse = fileEvents.filter((e) => e.type === 'speaker.parse').at(-1)
    if (parse) {
      out.push(`  第 1 关 解析：${parse.speakerMode} · 标签行 ${num(parse.labelLines)} · 轨道 ${num(parse.trackCount)} · 需侦察定身份 ${yesNo(parse.needsResolution)}`)
      for (const track of parse.tracks || []) {
        out.push(`    ${pad(track.sourceLabel, 22)}${pad(track.kind, 16)}首现行 ${pad(track.firstLine, 8)}标签行 ${num(track.labelLines)}`)
      }
    } else out.push('  第 1 关 解析：（无记录）')

    const scout = fileEvents.filter((e) => e.type === 'speaker.scout').at(-1)
    if (scout) {
      out.push(`  第 2 关 侦察：分 ${num(scout.chunkCount)} 段（${(scout.chunks || []).map((c) => (c.ok ? `#${c.idx}✓` : `#${c.idx}✗`)).join(' ') || '—'}）`)
      for (const s of (scout.merged || {}).speakers || []) {
        out.push(`    ${pad(s.label, 22)}→ ${pad(s.outputLabel, 20)}置信 ${pad(s.confidence, 8)}角色 ${s.role || '—'}`)
      }
      for (const note of (scout.merged || {}).conflictNotes || []) out.push(`    ⚠ ${note}`)
      if ((scout.merged || {}).otherNoteCount) out.push(`    （模型另有 ${scout.merged.otherNoteCount} 条自由备注，为保护访谈内容未落盘）`)
    } else out.push('  第 2 关 侦察：（无记录）')

    const mapping = fileEvents.filter((e) => e.type === 'speaker.mapping').at(-1)
    if (mapping) {
      out.push(`  第 3 关 映射：${(mapping.mappings || []).length} 条`)
      for (const m of mapping.mappings || []) {
        out.push(`    ${pad(m.sourceLabel, 22)}→ ${pad(m.outputLabel, 20)}依据 ${pad(m.basis, 24)}标签行 ${num(m.labelLines)}`)
      }
      if ((mapping.unresolved || []).length) out.push(`    仍未确定身份：${mapping.unresolved.map((x) => `“${x}”`).join('、')}`)
    } else out.push('  第 3 关 映射：（无记录）')

    const rewrite = fileEvents.filter((e) => e.type === 'speaker.rewrite').at(-1)
    out.push(rewrite ? `  第 4 关 改写：改动 ${num(rewrite.changedLines)}/${num(rewrite.labelLines)} 行` : '  第 4 关 改写：（无记录）')

    const enforces = fileEvents.filter((e) => e.type === 'speaker.enforce')
    if (enforces.length) {
      out.push('  第 5 关 出稿校验：')
      for (const e of enforces) {
        out.push(`    ${pad(e.phase, 26)}${e.valid ? '通过 ' : '不通过'} · 替换 ${num(e.replacements)} · 未知标签 ${num(e.unknownLabelCount)}`)
        for (const u of e.unknownLabels || []) out.push(`      未知标签 第 ${u.line} 行：“${u.label}”`)
      }
    } else out.push('  第 5 关 出稿校验：（无记录）')

    const audits = fileEvents.filter((e) => e.type === 'speaker.audit')
    if (audits.length) {
      out.push('  第 6 关 审计：')
      for (const a of audits) {
        out.push(`    ${pad(a.phase, 26)}${Object.entries(a.summary || {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '—'}`)
      }
    } else out.push('  第 6 关 审计：（无记录）')
    out.push('')
  }

  const signals = collectSignals(events)
  out.push('疑似问题信号：')
  if (!signals.length) out.push('  没有发现异常信号。')
  for (const signal of signals) out.push(`  ⚠ ${signal}`)
  return out.join('\n')
}

function follow(jsonl) {
  let offset = 0
  let announced = false
  const tick = () => {
    let stat
    try { stat = fs.statSync(jsonl) } catch {
      if (!announced) { console.log(`等待记录文件出现：${jsonl}`); announced = true }
      return
    }
    if (stat.size < offset) offset = 0   // 文件被轮转成新一轮：从头读本轮
    if (stat.size <= offset) return
    const fd = fs.openSync(jsonl, 'r')
    const buf = Buffer.alloc(stat.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = stat.size
    for (const event of parseLines(buf.toString('utf8'))) {
      console.log(eventLine(event))
      if (event.type === 'speaker_trace_finished') {
        console.log('')
        console.log(renderTrace(parseLines(fs.readFileSync(jsonl, 'utf8'))))
        console.log(`完整小结：${path.join(path.dirname(jsonl), 'speaker-trace.md')}`)
        process.exit(0)
      }
    }
  }
  tick()
  setInterval(tick, POLL_MS)
}

function main(argv) {
  const wantFollow = argv.includes('--follow') || argv.includes('-f')
  const target = argv.filter((x) => x !== '--follow' && x !== '-f')[0]
  if (!target) { console.error(USAGE); process.exit(2) }
  const { jsonl, exists } = resolveTracePath(target)
  if (wantFollow) { follow(jsonl); return }
  if (!exists) {
    console.error(`找不到记录文件：${jsonl}`)
    console.error('确认该次运行开了 --dev-trace（或 REFINER_DEV_TRACE=1）。想等它出现可加 --follow。')
    process.exit(2)
  }
  console.log(renderTrace(parseLines(fs.readFileSync(jsonl, 'utf8'))))
  const summary = path.join(path.dirname(jsonl), 'speaker-trace.md')
  if (fs.existsSync(summary)) console.log(`\n完整小结：${summary}`)
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main(process.argv.slice(2))

export { renderTrace, resolveTracePath, parseLines, eventLine, collectSignals }
