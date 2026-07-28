// ===== 说话人链路开发记录（dev trace）=====
// 开发排查专用，默认关闭：只有命令行加 --dev-trace、或环境变量 REFINER_DEV_TRACE=1 时才会写文件；
// 关闭时这个模块一次文件系统调用都不做。
//
// 记录范围只有说话人的结构信息——标签文字、行号、条数、每个阶段的判断结果。不写入访谈正文、prompt、
// 模型响应正文、网页正文或 API key，与 universal/trace.js 是同一条隐私约定。侦察备注只落盘本流水线
// 自己生成的“分段侦察对……”冲突模板（内容只有标签和人名）；模型自由书写的备注可能引用访谈原话，
// 一律只记条数、不记内容。
//
// 输出写在 <输出目录>/.dev-trace/ 下（目录权限 0700、文件权限 0600）：
//   speaker-trace.jsonl  逐条事件，单轮内只追加；同目录重跑时上一轮轮转为 speaker-trace-prev.*
//   speaker-trace.md     人读的分阶段小结，finish() 时生成
// 这两个文件都不是交付物，也不会进 run.json 的产物清单。

import fs from 'node:fs'
import path from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const MAX_EXAMPLES = 5
const MAX_TOKEN = 40
const MAX_ROWS = 80
const MAX_NOTE = 80

const GENERIC_PREFIX = '(?:发言人|说话人|讲者|讲话人|Speaker)'
// 只认阿拉伯数字与全角数字：汉字数字（“说话人一”）在正文里太容易误报。
const GENERIC_HEAD_RE = new RegExp(`^\\s*\\*{0,2}\\s*(${GENERIC_PREFIX})\\s*([0-9０-９]+)`, 'iu')
const GENERIC_ONLY_RE = new RegExp(`^${GENERIC_PREFIX}$`, 'iu')
// 标签后面还能安全带出来的字符：数字、冒号、点、星号、连字符、空格。遇到汉字或字母就停，避免带出正文。
const SAFE_TAIL_RE = /^[0-9０-９\s:：.．*＊-]*/u
const TRAILING_DIGITS_RE = /^(.*?)\s*([0-9０-９]{1,4})$/u
const STRONG_KINDS = new Set(['generic', 'generic-inline', 'cite', 'timestamp'])

function token(value, max = MAX_TOKEN) {
  if (value == null) return ''
  return String(value)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
}

const posInt = (value) => (Number.isInteger(value) && value >= 0 ? value : null)
const count = (value) => (Array.isArray(value) ? value.length : (Number.isInteger(value) && value >= 0 ? value : 0))

// 把一行“看着像说话人标签”的文字压成一个可安全记录的标签片段：只保留前缀 + 编号 + 后面那段纯符号数字，
// 其余部分只记字符数（形如 …+37），保证正文一个字都不会落到记录里。
function genericHeadToken(rawLine) {
  const line = String(rawLine ?? '')
  const head = line.match(GENERIC_HEAD_RE)
  if (!head) return ''
  const tail = (line.slice(head[0].length).match(SAFE_TAIL_RE) || [''])[0]
  const rest = line.slice(head[0].length + tail.length).trim()
  const base = `${head[1]} ${head[2]}${tail.replace(/\s+$/u, '')}`
  return token(rest ? `${base}…+${rest.length}` : base)
}

// 截断时间戳的特征：标签末尾挂着一段单独的数字（“张三 00”“说话人 1 00”，源出 “张三 00:12”被冒号切开）。
// 正常的泛称“说话人 1”不算——它的头部正好就是前缀本身。
function digitTailLabel(label) {
  const clean = token(label)
  const match = clean.match(TRAILING_DIGITS_RE)
  if (!match) return ''
  const head = match[1].trim()
  if (!head || GENERIC_ONLY_RE.test(head)) return ''
  return clean
}

// 近似漏判扫描：只看结构，不看内容。给定 parseSpeakerDocument 的结果，回答 3 个问题——
// 有没有像标签却没被认成标签的行、有没有截断时间戳特征的标签、弱兜底标签是不是压过了强标签。
// speaker-trace 与 scripts/speaker-inspect.mjs 共用这一份实现。
export function scanSpeakerNearMiss(parsed = {}) {
  const lines = Array.isArray(parsed && parsed.lines) ? parsed.lines : []
  const labels = (Array.isArray(parsed && parsed.labels) ? parsed.labels : []).filter(Boolean)
  const labelled = new Set(labels.map((fact) => fact.line).filter(Number.isInteger))

  const missedExamples = []
  let missedCount = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (labelled.has(i + 1)) continue
    const labelToken = genericHeadToken(lines[i])
    if (!labelToken) continue
    missedCount += 1
    if (missedExamples.length < MAX_EXAMPLES) missedExamples.push({ line: i + 1, labelToken })
  }

  const digitExamples = []
  let digitCount = 0
  for (const fact of labels) {
    const labelToken = digitTailLabel(fact.label)
    if (!labelToken) continue
    digitCount += 1
    if (digitExamples.length < MAX_EXAMPLES) digitExamples.push({ line: posInt(fact.line), labelToken })
  }

  const inlineExamples = []
  let inline = 0
  let strong = 0
  for (const fact of labels) {
    if (STRONG_KINDS.has(fact.kind)) { strong += 1; continue }
    if (fact.kind !== 'inline') continue
    inline += 1
    if (inlineExamples.length < MAX_EXAMPLES) inlineExamples.push({ line: posInt(fact.line), labelToken: token(fact.label) })
  }
  const inlineDominates = inline > 0 && inline > strong

  const warnings = []
  if (missedCount) {
    warnings.push(`${missedCount} 行看着像说话人标签，却没有被认成标签（例：第 ${missedExamples.map((e) => e.line).join('、')} 行，${missedExamples.map((e) => `“${e.labelToken}”`).join('、')}）`)
  }
  if (digitCount) {
    warnings.push(`${digitCount} 个标签结尾挂着单独的数字，像被截断的时间戳（例：${digitExamples.map((e) => `第 ${e.line} 行“${e.labelToken}”`).join('、')}）`)
  }
  if (inlineDominates) {
    warnings.push(`弱兜底标签（行内“名字：”）${inline} 条，多过强标签 ${strong} 条——说明这份稿子的说话人是靠冒号猜出来的，容易把正文里的句子误当成标签`)
  }

  return {
    missedGenericLines: { count: missedCount, examples: missedExamples },
    digitTailLabels: { count: digitCount, examples: digitExamples },
    weakInlineLabels: { inline, strong, dominates: inlineDominates, examples: inlineExamples },
    warnings,
  }
}

function trackRows(parsed) {
  const labels = (Array.isArray(parsed && parsed.labels) ? parsed.labels : []).filter(Boolean)
  const kindByKey = new Map()
  for (const fact of labels) {
    const key = fact.matchKey || fact.key
    if (key && !kindByKey.has(key)) kindByKey.set(key, fact.kind)
  }
  return (Array.isArray(parsed && parsed.tracks) ? parsed.tracks : []).slice(0, MAX_ROWS).map((track) => ({
    sourceLabel: token(track && track.sourceLabel),
    key: token(track && track.key, 60),
    kind: token(kindByKey.get(track && track.key), 24) || null,
    generic: !!(track && track.generic),
    roleLike: !!(track && track.roleLike),
    firstLine: posInt(track && track.firstLine),
    labelLines: posInt(track && track.labelLines),
  }))
}

const speakerRows = (speakers) => (Array.isArray(speakers) ? speakers : []).slice(0, MAX_ROWS).map((s) => ({
  label: token(s && s.label),
  outputLabel: token(s && s.output_label),
  confidence: token(s && s.output_label_confidence, 12),
  role: token(s && s.role, 24),
}))

// audit 摘要按标量白名单过滤：只留数字、布尔和很短的字符串，样本/明细一律不进来。
function scalarSummary(value) {
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item
    else if (typeof item === 'boolean') out[key] = item
    else if (typeof item === 'string') { const text = token(item); if (text) out[key] = text }
  }
  return out
}

const mdCell = (value) => (value == null || value === '' ? '—' : String(value).replace(/\|/gu, '\\|'))

function mdTable(headers, rows) {
  if (!rows.length) return '（无）\n'
  const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) out.push(`| ${row.map(mdCell).join(' | ')} |`)
  return `${out.join('\n')}\n`
}

const yesNo = (value) => (value ? '是' : '否')

const NOOP = Object.freeze({
  enabled: false,
  eventsPath: null,
  summaryPath: null,
  parse() {},
  scout() {},
  mapping() {},
  rewrite() {},
  enforce() {},
  audit() {},
  finish() { return null },
})

export function makeSpeakerTrace(outputDir, { enabled = false, now = () => new Date().toISOString() } = {}) {
  if (!enabled) return NOOP

  let root
  let dir
  let eventsPath
  let summaryPath
  try {
    root = path.resolve(outputDir)
    dir = path.join(root, '.dev-trace')
    eventsPath = path.join(dir, 'speaker-trace.jsonl')
    summaryPath = path.join(dir, 'speaker-trace.md')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, DIR_MODE)
    // 同一输出目录重跑时，上一轮记录轮转为 *-prev 文件：当前 jsonl 永远只含本轮事件，
    // speaker-trace.md 与它一一对应，阅读器不会把两轮混成一轮。“只追加”指单轮之内。
    if (fs.existsSync(eventsPath)) fs.renameSync(eventsPath, path.join(dir, 'speaker-trace-prev.jsonl'))
    if (fs.existsSync(summaryPath)) fs.renameSync(summaryPath, path.join(dir, 'speaker-trace-prev.md'))
  } catch {
    return NOOP   // 目录建不出来（只读盘等）时安静降级：开发记录永远不能把正事搞挂
  }

  let sequence = 0
  const startedAt = now()
  const files = new Map()

  const emit = (type, data = {}) => {
    try {
      const event = { sequence: ++sequence, at: now(), type, ...data }
      fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: FILE_MODE })
      fs.chmodSync(eventsPath, FILE_MODE)
      return true
    } catch {
      return false
    }
  }

  const stateFor = (fileLabel) => {
    const key = token(fileLabel, 80) || '（未命名文件）'
    if (!files.has(key)) files.set(key, { label: key, parse: null, scout: null, mapping: null, rewrite: null, enforce: [], audit: [] })
    return files.get(key)
  }

  const renderSummary = () => {
    const out = []
    out.push('# 说话人链路记录（开发用）')
    out.push('')
    out.push(`- 开始时间：${startedAt}`)
    out.push(`- 结束时间：${now()}`)
    out.push(`- 逐条事件：${path.basename(eventsPath)}`)
    out.push('- 本文件只记录说话人标签的结构信息（标签文字、行号、条数、各阶段结论），不含访谈正文；默认关闭，只在加了 `--dev-trace` 时生成，不是交付物。')
    out.push('- 标签片段里出现的 `…+37` 表示后面还有 37 个字符没记录（那部分是正文，故意不写）。')
    out.push('')
    out.push('说话人一共要过 6 关：解析源文件 → 侦察认人 → 生成映射 → 改写精校输入 → 成稿标签兜底 → 审计核对。')
    out.push('排查时从上往下看，第一处数字对不上的那一关，就是问题发生的地方。')
    out.push('')

    const signals = []
    for (const state of files.values()) {
      out.push(`## 文件：${state.label}`)
      out.push('')

      out.push('### 第 1 关　解析源文件')
      out.push('')
      if (!state.parse) {
        out.push('（没有记录：这份文件没走到解析，或开发记录是在解析之后才打开的）')
        out.push('')
      } else {
        const p = state.parse
        out.push(`- 说话人模式：${p.speakerMode === 'tracked' ? 'tracked（源文件自带说话人标签）' : 'untracked（源文件没有可识别的说话人标签）'}`)
        out.push(`- 标签行数：${p.labelLines ?? '—'}　·　说话人轨道数：${p.trackCount ?? '—'}`)
        out.push('')
        out.push(mdTable(['源标签', '归并键', '识别方式', '是否泛称', '是否角色词', '首次出现行', '标签行数'],
          (p.tracks || []).map((t) => [t.sourceLabel, t.key, t.kind, yesNo(t.generic), yesNo(t.roleLike), t.firstLine, t.labelLines])))
        out.push('')
        const warnings = (p.nearMiss && p.nearMiss.warnings) || []
        out.push(`近似漏判扫描：${warnings.length ? '' : '没有发现异常'}`)
        for (const w of warnings) { out.push(`- ${w}`); signals.push(`${state.label} · 解析：${w}`) }
        out.push('')
      }

      out.push('### 第 2 关　侦察认人')
      out.push('')
      if (!state.scout) {
        out.push('（没有记录：这次没跑侦察，或侦察没返回）')
        out.push('')
      } else {
        const s = state.scout
        out.push(`- 侦察分块数：${s.chunkCount ?? '—'}`)
        out.push('')
        for (const chunk of s.chunks || []) {
          out.push(`第 ${chunk.idx} 块（${chunk.ok ? '有返回' : '没返回'}）：`)
          out.push('')
          out.push(mdTable(['源标签', '建议输出标签', '置信度', '角色'], (chunk.speakers || []).map((x) => [x.label, x.outputLabel, x.confidence, x.role])))
          out.push('')
        }
        out.push('合并后的结论：')
        out.push('')
        out.push(mdTable(['源标签', '建议输出标签', '置信度', '角色'], ((s.merged && s.merged.speakers) || []).map((x) => [x.label, x.outputLabel, x.confidence, x.role])))
        out.push('')
        const notes = (s.merged && s.merged.conflictNotes) || []
        if (notes.length) {
          out.push('侦察自己提到的冲突：')
          for (const note of notes) { out.push(`- ${note}`); signals.push(`${state.label} · 侦察：${note}`) }
          out.push('')
        }
      }

      out.push('### 第 3 关　生成映射')
      out.push('')
      if (!state.mapping) {
        out.push('（没有记录）')
        out.push('')
      } else {
        out.push(mdTable(['源标签', '输出标签', '依据', '角色', '标签行数'],
          (state.mapping.mappings || []).map((m) => [m.sourceLabel, m.outputLabel, m.basis, m.role, m.labelLines])))
        out.push('')
        const unresolved = state.mapping.unresolved || []
        out.push(`仍未确定身份：${unresolved.length ? unresolved.map((x) => `“${x}”`).join('、') : '无'}`)
        if (unresolved.length) signals.push(`${state.label} · 映射：${unresolved.length} 个说话人没认出身份（${unresolved.map((x) => `“${x}”`).join('、')}），保留源标签`)
        out.push('')
      }

      out.push('### 第 4 关　改写精校输入')
      out.push('')
      if (!state.rewrite) out.push('（没有记录）')
      else out.push(`- 改写标签行：${state.rewrite.changedLines ?? 0} 行　·　总标签行：${state.rewrite.labelLines ?? 0} 行`)
      out.push('')

      out.push('### 第 5 关　成稿标签兜底')
      out.push('')
      out.push(mdTable(['阶段', '是否合规', '改写行数', '未知标签数', '替换次数'],
        (state.enforce || []).map((e) => [e.phase, yesNo(e.valid), e.changedLines, e.unknownLabelCount, e.replacements])))
      out.push('')
      for (const e of state.enforce || []) {
        if (!(e.unknownLabels || []).length) continue
        out.push(`阶段 ${e.phase} 出现的未知标签：${e.unknownLabels.map((u) => `第 ${u.line} 行“${u.label}”`).join('、')}`)
        signals.push(`${state.label} · 兜底（${e.phase}）：${e.unknownLabelCount} 个标签不在本次映射里（${e.unknownLabels.slice(0, 3).map((u) => `第 ${u.line} 行“${u.label}”`).join('、')}）`)
      }
      out.push('')

      out.push('### 第 6 关　审计核对')
      out.push('')
      if (!(state.audit || []).length) {
        out.push('（没有记录：这次没跑到源比对审计）')
      } else {
        for (const a of state.audit) {
          const pairs = Object.entries(a.summary || {}).map(([k, v]) => `${k}=${v}`).join('　·　')
          out.push(`- ${a.phase || '审计'}：${pairs || '（无可记录的标量指标）'}`)
        }
      }
      out.push('')
    }

    out.push('## 疑似问题信号')
    out.push('')
    if (!signals.length) out.push('本次没有发现异常信号。')
    else for (const signal of signals) out.push(`- ${signal}`)
    out.push('')
    return out.join('\n')
  }

  emit('speaker_trace_started', { outputDir: root })

  return {
    enabled: true,
    eventsPath,
    summaryPath,

    parse(fileLabel, parsed) {
      try {
        const state = stateFor(fileLabel)
        const tracks = trackRows(parsed)
        const data = {
          fileLabel: state.label,
          speakerMode: token(parsed && parsed.speakerMode, 16) || null,
          labelLines: posInt(parsed && parsed.labelLines),
          trackCount: Array.isArray(parsed && parsed.tracks) ? parsed.tracks.length : null,
          needsResolution: !!(parsed && parsed.needsResolution),
          tracks,
          nearMiss: scanSpeakerNearMiss(parsed),
        }
        state.parse = data
        emit('speaker.parse', data)
      } catch { /* 开发记录不可影响主流程 */ }
    },

    scout(fileLabel, event = {}) {
      try {
        const state = stateFor(fileLabel)
        const merged = event.merged || {}
        const data = {
          fileLabel: state.label,
          chunkCount: posInt(event.chunkCount),
          chunks: (Array.isArray(event.chunks) ? event.chunks : []).slice(0, 40).map((chunk, i) => ({
            idx: posInt(chunk && chunk.idx) ?? i + 1,
            ok: !!(chunk && chunk.ok),
            speakers: speakerRows(chunk && chunk.speakers),
          })),
          merged: {
            speakers: speakerRows(merged.speakers),
            // 只落盘本流水线自己生成的冲突模板（内容只有标签和人名）。模型自由书写的备注可能
            // 逐字引用访谈内容，永远只计数。
            conflictNotes: (Array.isArray(merged.special_notes) ? merged.special_notes : [])
              .filter((note) => String(note || '').startsWith('分段侦察对“'))
              .slice(0, MAX_EXAMPLES)
              .map((note) => token(note, MAX_NOTE)),
            otherNoteCount: (Array.isArray(merged.special_notes) ? merged.special_notes : [])
              .filter((note) => !String(note || '').startsWith('分段侦察对“')).length,
          },
        }
        state.scout = data
        emit('speaker.scout', data)
      } catch { /* 同上 */ }
    },

    mapping(fileLabel, result = {}) {
      try {
        const state = stateFor(fileLabel)
        const data = {
          fileLabel: state.label,
          needsResolution: !!result.needsResolution,
          mappings: (Array.isArray(result.mappings) ? result.mappings : []).slice(0, MAX_ROWS).map((m) => ({
            sourceLabel: token(m && m.sourceLabel),
            outputLabel: token(m && m.outputLabel),
            basis: token(m && m.basis, 32),
            role: token(m && m.role, 24),
            labelLines: posInt(m && m.labelLines),
          })),
          unresolved: (Array.isArray(result.unresolved) ? result.unresolved : []).slice(0, MAX_ROWS).map((x) => token(x)),
        }
        state.mapping = data
        emit('speaker.mapping', data)
      } catch { /* 同上 */ }
    },

    rewrite(fileLabel, result = {}) {
      try {
        const state = stateFor(fileLabel)
        const data = {
          fileLabel: state.label,
          changedLines: posInt(result.changedLines) ?? 0,
          labelLines: posInt(result.labelLines) ?? 0,
        }
        state.rewrite = data
        emit('speaker.rewrite', data)
      } catch { /* 同上 */ }
    },

    enforce(fileLabel, phase, result = {}) {
      try {
        const state = stateFor(fileLabel)
        const unknown = (Array.isArray(result.unknownLabels) ? result.unknownLabels : []).slice(0, MAX_ROWS)
        const data = {
          fileLabel: state.label,
          phase: token(phase, 40) || 'unknown',
          valid: result.valid !== false,
          changedLines: posInt(result.changedLines) ?? 0,
          labelLines: posInt(result.labelLines) ?? 0,
          replacements: count(result.replacements),
          unknownLabelCount: count(result.unknownLabels),
          unknownLabels: unknown.map((u) => ({ line: posInt(u && u.line), label: token(u && u.label) })),
        }
        state.enforce.push(data)
        emit('speaker.enforce', data)
      } catch { /* 同上 */ }
    },

    audit(fileLabel, summary) {
      try {
        const state = stateFor(fileLabel)
        const data = {
          fileLabel: state.label,
          phase: token(summary && summary.phase, 40) || '审计',
          summary: scalarSummary(summary),
        }
        state.audit.push(data)
        emit('speaker.audit', data)
      } catch { /* 同上 */ }
    },

    finish() {
      try {
        emit('speaker_trace_finished', { fileCount: files.size })
        const tmp = `${summaryPath}.${process.pid}.tmp`
        fs.writeFileSync(tmp, renderSummary(), { encoding: 'utf8', mode: FILE_MODE })
        fs.chmodSync(tmp, FILE_MODE)
        fs.renameSync(tmp, summaryPath)
      } catch { /* 同上 */ }
      return { eventsPath, summaryPath }
    },
  }
}
