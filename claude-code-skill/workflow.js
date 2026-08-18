export const meta = {
  name: 'latepost-refiner',
  description: 'Scout → verify → glossary → refine → audit → summary/timeline for interview transcripts',
  whenToUse: 'latepost-refiner 技能的 Claude Code 快路径：多份访谈转录并行侦察、统一校对表、并行精校与交付物生成',
  phases: [
    { title: 'Scout', detail: '每份转录一个侦察代理（超大文件自动拆段并行、防单代理卡死），返回结构化清单（默认 haiku）' },
    { title: 'Verify', detail: '关键实体联网核实（默认 sonnet）' },
    { title: 'Refine', detail: '逐份精校（大文件拆块并行 + 拼接；侦察失败也照常精校，默认 opus；Workflow 拼接 fallback 为 haiku）' },
    { title: 'Audit', detail: '正文忠实性审计（实质缺口 / 压缩 / 说话人 / 引号 hard；Universal 最多候选修复两轮，CC 对内容缺口 / 引号定点修复一次，仍未过则暂停派生产物）' },
    { title: 'Logic', detail: '逐份逻辑顺序重排稿（按主线把问答重排成叙事顺序，默认 opus）' },
    { title: 'Deliver', detail: '访谈总结 / 时间线（默认 opus）' },
  ],
}

// args contract (assembled by the main agent after the Step 0 pre-flight):
// { topic, date, background, outputDir, skillDir,
//   scope: ['refine','logic','summary','timeline'] trimmed as needed ('logic' = logical-order rewrite, depends on refine output),
//   verifyDepth: 'key'|'deep'|'none', headingPolicy: 'none'|'regenerate'|'keep',
//   models?: {scout,verify,dedup,refine,repair,stitch,logic,summary,timeline},  (repair defaults to opus)
//   priorGlossaryText?: full text of an existing <outputDir>/校对表.md (per-company persistent glossary, P1) —
//     Step 0 reads it if present; the workflow parses it to seed scout and accumulates this batch into it.
//   fresh?: true to ignore any prior glossary and rebuild from scratch.
//   files: [{ path, label, lines, bytes?, chars?, title, subtitle, outPath, speakerHints?, notes? }] }
//   (chars = 正文字数 (汉字 + 每个英文词/数字各算 1); THE document-length metric — chunk routing keys on it, not lines.
//    lines/bytes are for Read pagination only (readPlan). If chars is absent it's estimated from bytes, then lines.)

// ===== Generated from core/* by build/build-cc.mjs — do not edit by hand; edit core/ and re-run build =====

// Deterministic bridge between full-text Scout and Refine.
//
// Scout decides who each source speaker track represents. This module never re-diarizes prose and never lets
// Refine invent a second mapping: it rewrites only recognized speaker-label lines in a disposable model-input
// copy. The untouched source remains the ground truth for the downstream source-aware audit.

// A timecode is metadata around a speaker turn, never proof that the line is (or is not) a speaker label.
// Keep the grammar bounded enough to reject prose, but accept the common precision/wrapper variants emitted by
// transcript tools. Speaker detection may still recover an unfamiliar decorator through exact Scout evidence;
// successful timestamp normalization is deliberately NOT a prerequisite for establishing a speaker track.
const COLON_TIMECODE = '\\d{1,3}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,3})?'
const PRIME_TIMECODE = "\\d{1,3}\\s*[′']\\s*\\d{1,2}(?:\\s*[″\"])?"
const TIMESTAMP = `(?:${COLON_TIMECODE}|${PRIME_TIMECODE})`
const GENERIC_PREFIX = '(?:发言人|说话人|讲者|讲话人|Speaker)'
const GENERIC_NUMBER = '[0-9０-９一二三四五六七八九十]+'
const GENERIC_LINE_RE = new RegExp(
  `^(\\s*)\\*{0,2}\\s*(${GENERIC_PREFIX})\\s*(${GENERIC_NUMBER})(?:\\s+(${TIMESTAMP}))?\\s*\\*{0,2}\\s*$`,
  'iu',
)
const GENERIC_INLINE_RE = new RegExp(
  `^(\\s*)\\*{0,2}\\s*(${GENERIC_PREFIX})\\s*(${GENERIC_NUMBER})\\s*\\*{0,2}\\s*[：:]\\s*(.*)$`,
  'iu',
)
const CITE_RE = new RegExp(`^(\\s*)<cite\\b([^>]*)>\\s*</cite>\\s+(${TIMESTAMP})\\s*$`, 'iu')
const CITE_ONLY_RE = /^(\s*)<cite\b([^>]*)>\s*<\/cite>\s*$/iu
const NAMED_TIMESTAMP_RE = new RegExp(`^(\\s*)\\*{0,2}\\s*(.{1,40}?)\\s+(${TIMESTAMP})\\s*\\*{0,2}\\s*$`, 'u')
const INLINE_RE = /^(\s*)([^：:\r\n]{1,40})[：:]\s*(.*)$/u
const LEADING_TIMESTAMP_RE = new RegExp(
  `^(\\s*)(?:\\[(${TIMESTAMP})\\]|\\((${TIMESTAMP})\\)|【(${TIMESTAMP})】|((?:T\\+)?${TIMESTAMP}))\\s+`,
  'iu',
)
const ROLE_TOKEN = '(?:记者|采访者|访谈者|提问者|主持人|受访者|嘉宾|回答者|主讲人|PR|公关|同事|协调)'
const ROLE_RE = new RegExp(`^${ROLE_TOKEN}(?:[／/][一-龥A-Za-z]{1,16})*(?:\\s*\\d+)?$`, 'iu')
const TITLE_WORD_RE = /(?:创始人|联合创始人|负责人|总裁|董事|经理|老师|先生|女士|博士|教授|CEO|CTO|COO|CFO|公司|团队|产品)/iu
const AI_SUMMARY_DISCLOSURE_RE = /(?:智能纪要|本(?:份)?纪要|本(?:份)?摘要)\s*(?:由|为)\s*AI\s*(?:生成|整理)|(?:由|使用)\s*AI\s*(?:生成|整理)(?:的)?(?:智能纪要|会议纪要|摘要)/iu

// Pandoc-style docx exports end lines with a Markdown hard break: a trailing backslash, as in
// `说话人 1 00:01\`. Label-only, end-anchored forms must tolerate it or the generic inline fallback
// splits the line at the colon inside the timestamp and mints a fake per-minute speaker.
const stripLineEndHardBreak = (value) => String(value || '').replace(/\s*\\\s*$/u, '')

function splitLeadingTimestamp(value) {
  const source = String(value || '')
  const match = source.match(LEADING_TIMESTAMP_RE)
  if (!match) return { matched: false, timestamp: '', rest: source }
  const timestamp = [match[2], match[3], match[4], match[5]].find(Boolean) || ''
  return {
    matched: true,
    timestamp: timestamp.replace(/^T\+/iu, ''),
    rest: `${match[1] || ''}${source.slice(match[0].length)}`,
  }
}

const normalizeLabel = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/^\*{1,2}|\*{1,2}$/g, '')
  .replace(/[：:]\s*$/u, '')
  .replace(/\s+/g, ' ')
  .trim()

function parseAttrs(raw) {
  const attrs = {}
  for (const match of String(raw || '').matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  return attrs
}

// Transcript headers carry date/time lines (`2026年7月2日 下午 3:37`) that would otherwise satisfy the
// name-plus-timestamp form. A date is never a speaker name — but real labels can contain date-adjacent
// characters (姓周的人名、选手2号), so only a date SHAPE at the label start, or a label that is nothing
// but a weekday/time-of-day word, is rejected.
const DATE_LIKE_RE = /^\d{2,4}\s*年|^\d{1,2}\s*月\s*\d{1,2}\s*[日号]|^(?:上午|下午|中午|凌晨|晚上|周[一二三四五六日天]|星期[一二三四五六日天])$/u

function plausibleLabel(value) {
  const label = normalizeLabel(value)
  if (!label || label.length > 32) return false
  // normalizeLabel runs NFKC first, so a source full-width comma becomes ASCII "," before this guard.
  if (/^[#*>|<]/u.test(label) || /[：:,，。；;！？!?]/u.test(label)) return false
  if (DATE_LIKE_RE.test(label)) return false
  return /[一-龥A-Za-z]/u.test(label)
}

function speakerKey(value) {
  const label = normalizeLabel(value).replace(/\s*[（(]\s*(?:uid-ref|uid)\s*=[^（）()]*[）)]\s*$/iu, '').trim()
  const generic = label.match(new RegExp(`^(${GENERIC_PREFIX})\\s*(${GENERIC_NUMBER})$`, 'iu'))
  if (generic) return `generic:${generic[2].normalize('NFKC')}`
  return label ? `label:${label}` : ''
}

function isGenericSpeakerLabel(value) {
  return speakerKey(value).startsWith('generic:')
}

function isRoleSpeakerLabel(value) {
  return ROLE_RE.test(normalizeLabel(value))
}

function strongLabel(rawLine) {
  const raw = String(rawLine || '')
  const leading = splitLeadingTimestamp(raw)
  const classificationRaw = leading.matched ? leading.rest : raw
  let match = classificationRaw.match(GENERIC_INLINE_RE)
  if (match) {
    const label = normalizeLabel(`${match[2]} ${match[3]}`)
    return {
      indent: match[1],
      key: speakerKey(label),
      label,
      kind: 'generic-inline',
      body: match[4] || '',
      timestamp: leading.timestamp || '',
      generic: true,
    }
  }
  // Only the label-only forms below match against the hard-break-stripped view. The body-capturing
  // forms above (and the inline fallback) keep the raw line, so a body's own trailing hard break
  // stays part of the body and survives rewriting untouched.
  const line = stripLineEndHardBreak(classificationRaw)
  match = line.match(GENERIC_LINE_RE)
  if (match) {
    const label = normalizeLabel(`${match[2]} ${match[3]}`)
    return {
      indent: match[1],
      key: speakerKey(label),
      label,
      kind: 'generic',
      body: '',
      timestamp: leading.timestamp || match[4] || '',
      generic: true,
    }
  }
  match = leading.matched ? line.match(CITE_ONLY_RE) : line.match(CITE_RE)
  if (match) {
    const attrs = parseAttrs(match[2])
    const label = normalizeLabel(attrs['user-name'])
    if (!plausibleLabel(label)) return null
    const uid = normalizeLabel(attrs['uid-ref'] || attrs.uid)
    return {
      indent: match[1],
      key: uid ? `feishu:${uid}` : speakerKey(label),
      matchKey: speakerKey(label),
      label,
      kind: 'cite',
      body: '',
      timestamp: leading.timestamp || match[3] || '',
      generic: false,
    }
  }
  // A bare name after a leading timecode (`00:03 张三`) is deliberately NOT promoted here. It is
  // indistinguishable from an agenda marker (`00:03 开场`) on one line, so it needs exact Scout evidence below.
  match = line.match(NAMED_TIMESTAMP_RE)
  if (match) {
    const label = normalizeLabel(match[2])
    if (!plausibleLabel(label)) return null
    return {
      indent: match[1],
      key: speakerKey(label),
      label,
      kind: 'timestamp',
      body: '',
      timestamp: leading.timestamp || match[3] || '',
      generic: false,
      hardBreak: line !== classificationRaw,
    }
  }
  return null
}

function inlineView(rawLine) {
  const raw = String(rawLine || '')
  const leading = splitLeadingTimestamp(raw)
  const view = leading.matched ? leading.rest : raw
  return { leading, match: view.match(INLINE_RE) }
}

function decoratedSpeakerCandidate(rawLine) {
  const raw = String(rawLine || '')
  const leading = splitLeadingTimestamp(raw)
  if (leading.matched) {
    const tail = stripLineEndHardBreak(leading.rest)
    const inline = tail.match(INLINE_RE)
    const label = normalizeLabel(inline ? inline[2] : tail)
    return plausibleLabel(label) || isGenericSpeakerLabel(label) ? { label } : null
  }

  // Do not try to understand every vendor's wrapper. Find a split where the left side is numeric decoration
  // and the right side is a plausible label-only token. Two or more such lines are ambiguity evidence, not
  // confirmed tracks: `⟦00:03⟧ 张三` and an agenda marker can look identical without Scout/full-text context.
  const normalized = stripLineEndHardBreak(raw).normalize('NFKC')
  const boundaries = [...normalized.matchAll(/\s+/gu)]
  for (const boundary of boundaries) {
    const at = boundary.index
    const prefix = normalized.slice(0, at)
    const tail = normalized.slice(at + boundary[0].length)
    const inline = tail.match(INLINE_RE)
    const label = normalizeLabel(inline ? inline[2] : tail)
    if (!decorativePrefix(prefix)) continue
    if (plausibleLabel(label) || isGenericSpeakerLabel(label)) return { label }
  }
  return null
}

function evidenceLine(value) {
  return stripLineEndHardBreak(String(value || ''))
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
}

function decorativePrefix(value) {
  const clean = String(value || '').replace(/\*{1,2}/gu, '').trim()
  if (!clean || clean.length > 48 || !/\d/u.test(clean)) return false
  // Unknown vendor timecodes may use punctuation or a literal T+, but semantic prose before a mentioned name
  // must never qualify as a decorator.
  if (/[一-龥]/u.test(clean) || /[A-SU-Z]/iu.test(clean)) return false
  return /[:：.,，′″'"\[\]()【】+\-–—>]/u.test(clean)
}

function knownLabelFact(rawLine, requestedLabel) {
  const raw = String(rawLine || '')
  const label = normalizeLabel(requestedLabel)
  if (!plausibleLabel(label) && !isGenericSpeakerLabel(label)) return null

  const leading = splitLeadingTimestamp(raw)
  const view = leading.matched ? leading.rest : raw
  const inline = view.match(INLINE_RE)
  if (inline && speakerKey(inline[2]) === speakerKey(label)) {
    return {
      indent: inline[1],
      key: speakerKey(label),
      label,
      kind: isGenericSpeakerLabel(label) ? 'generic-inline' : 'scout-evidence',
      body: inline[3] || '',
      timestamp: leading.timestamp || '',
      generic: isGenericSpeakerLabel(label),
      recoveredByScout: true,
    }
  }

  // For an unfamiliar leading decorator, locate the Scout-provided label without understanding the timestamp.
  // The prefix must be decoration-only and the suffix must be a label boundary, so prose such as
  // `他在 00:03 问张三：...` cannot become a speaker turn.
  const normalizedRaw = stripLineEndHardBreak(raw).normalize('NFKC')
  const normalizedRequested = label.normalize('NFKC')
  const at = normalizedRaw.indexOf(normalizedRequested)
  if (at < 0) return null
  const prefix = normalizedRaw.slice(0, at)
  if (prefix.trim() && !decorativePrefix(prefix)) return null
  const suffix = normalizedRaw.slice(at + normalizedRequested.length)
  const inlineSuffix = suffix.match(/^\s*[：:]\s*(.*)$/u)
  if (inlineSuffix) {
    return {
      indent: (raw.match(/^\s*/u) || [''])[0],
      key: speakerKey(label),
      label,
      kind: isGenericSpeakerLabel(label) ? 'generic-inline' : 'scout-evidence',
      body: inlineSuffix[1] || '',
      timestamp: leading.timestamp || prefix.trim(),
      generic: isGenericSpeakerLabel(label),
      recoveredByScout: true,
    }
  }
  if (/^\s*(?:\\\s*)?$/u.test(suffix)) {
    return {
      indent: (raw.match(/^\s*/u) || [''])[0],
      key: speakerKey(label),
      label,
      kind: 'scout-evidence',
      body: '',
      timestamp: leading.timestamp || prefix.trim(),
      generic: isGenericSpeakerLabel(label),
      recoveredByScout: true,
    }
  }
  return null
}

function scoutStructureRecord(record) {
  if (!record || !normalizeLabel(record.label) || !String(record.sample || '').trim()) return false
  const output = cleanOutputLabel(record.output_label)
  return Boolean(
    isGenericSpeakerLabel(record.label)
    || normalizeRole(record.role)
    || normalizeRole(output)
    || effectiveScoutPersonName(record),
  )
}

function scoutRecordKeys(record) {
  const keys = new Set()
  const label = normalizeLabel(record && record.label)
  const direct = speakerKey(label)
  if (direct) keys.add(direct)

  // Feishu Scout records are instructed to keep the source label verbatim, so `label` may be the
  // bare cite element while the deterministic parser represents that same track by user-name.
  // Treat these as two views of one already-parsed track; this is identity matching, not structure recovery.
  const cite = stripLineEndHardBreak(String(record && record.label || '')).match(CITE_ONLY_RE)
  if (cite) {
    const attrs = parseAttrs(cite[2])
    const nameKey = speakerKey(attrs['user-name'])
    if (nameKey) keys.add(nameKey)
  }
  return keys
}

function recoverScoutFacts(lines, facts, scoutSpeakers = []) {
  const recovered = []
  const evidenceMisses = []
  for (const record of scoutSpeakers || []) {
    if (!scoutStructureRecord(record)) continue
    const recordKeys = scoutRecordKeys(record)
    const knownKeys = new Set(facts.filter(Boolean).flatMap((fact) => [fact.key, fact.matchKey]).filter(Boolean))
    const alreadyParsed = [...recordKeys].some((key) => knownKeys.has(key))
    const samples = String(record.sample || '').split(/\r?\n/u).map(evidenceLine).filter(Boolean)
    const evidenceIndexes = []
    for (let i = 0; i < lines.length; i += 1) {
      if (samples.includes(evidenceLine(lines[i]))) evidenceIndexes.push(i)
    }
    const exactEvidence = evidenceIndexes.some((i) => knownLabelFact(lines[i], record.label))
    if (!exactEvidence && !alreadyParsed) {
      evidenceMisses.push(normalizeLabel(record.label))
      continue
    }
    for (let i = 0; i < lines.length; i += 1) {
      if (facts[i]) continue
      const fact = knownLabelFact(lines[i], record.label)
      if (!fact) continue
      facts[i] = fact
      recovered.push({ line: i + 1, label: fact.label })
    }
  }
  return { recovered, evidenceMisses }
}

function recoverKnownFacts(lines, facts, knownSpeakerLabels = []) {
  const recovered = []
  for (const requestedLabel of [...new Set((knownSpeakerLabels || []).map(normalizeLabel).filter(Boolean))]) {
    for (let i = 0; i < lines.length; i += 1) {
      if (facts[i]) continue
      const fact = knownLabelFact(lines[i], requestedLabel)
      if (!fact) continue
      facts[i] = fact
      recovered.push({ line: i + 1, label: fact.label })
    }
  }
  return recovered
}

function substantiveLine(value) {
  const line = String(value || '').trim()
  return Boolean(
    line
    && !/^<!--/u.test(line)
    && !/^(?:[#*>|`~_]|[-+]\s|\d+[.)、]\s)/u.test(line),
  )
}

function parseSpeakerLabels(sourceText, options = {}) {
  const text = String(sourceText || '')
  const lines = text.split(/\r?\n/)
  const facts = lines.map(strongLabel)
  // On a clean line, name+timestamp is distinctive evidence even once. In a Pandoc hard-break document
  // a wrapped body fragment ending in a time (`会议改到下午 3:30\`) reads identically. Markdown itself
  // separates the two: a hard break means the NEXT line continues the same paragraph, so a line whose
  // previous line ends with a hard break AND still carries substantive text can never start a speaker
  // turn — while a real label always opens its own paragraph. A line that is ONLY a backslash is a
  // paragraph separator in real Pandoc transcript output (production Job-58 shape), not a continuation.
  // Occurrence counting is wrong here: it silently absorbs a speaker who talks only once into the
  // previous turn. Demoted fragments are also barred from the inline fallback below — otherwise the
  // colon inside their timestamp re-mints exactly the truncated fake labels this fix removes.
  const demotedTimeFragments = new Set()
  for (let i = 0; i < facts.length; i += 1) {
    const fact = facts[i]
    if (!fact || fact.kind !== 'timestamp' || !fact.hardBreak) continue
    const prev = i > 0 ? stripLineEndHardBreak(lines[i - 1]) : ''
    const prevHadHardBreak = i > 0 && prev !== String(lines[i - 1] || '')
    if (prevHadHardBreak && prev.trim()) {
      facts[i] = null
      demotedTimeFragments.add(i)
    }
  }
  const strongNames = new Set(facts.filter(Boolean).flatMap((fact) => [fact.label, fact.matchKey]).filter(Boolean))
  const inlineCounts = new Map()
  let substantive = 0
  let inlineCandidates = 0
  let plainInlineCandidates = 0
  const leadingInlineCandidates = []
  const unresolvedDecoratedCandidates = []

  for (let i = 0; i < lines.length; i += 1) {
    if (facts[i] || !substantiveLine(lines[i])) continue
    substantive += 1
    if (demotedTimeFragments.has(i)) continue
    const { leading, match } = inlineView(lines[i])
    if (!match || !plausibleLabel(match[2])) {
      const decorated = decoratedSpeakerCandidate(lines[i])
      if (decorated) unresolvedDecoratedCandidates.push({ line: i + 1, label: decorated.label })
      continue
    }
    const label = normalizeLabel(match[2])
    inlineCandidates += 1
    if (leading.matched) leadingInlineCandidates.push({ line: i + 1, label })
    else plainInlineCandidates += 1
    inlineCounts.set(label, (inlineCounts.get(label) || 0) + 1)
  }

  // The all-lines-are-inline shortcut is safe only when the label starts the source line. Once a time/decorator
  // precedes a weak name, the same surface shape also describes agenda/prose lines and needs recurrence, a role,
  // an existing strong track, or exact Scout evidence.
  const pureInline = !facts.some(Boolean)
    && plainInlineCandidates >= 2
    && plainInlineCandidates === substantive
    && inlineCandidates === plainInlineCandidates
  for (let i = 0; i < lines.length; i += 1) {
    // The counting pass above defines the structural boundary: Markdown headings, blockquotes, tables and
    // emphasis/list rows are document structure, not dialogue turns. Re-apply it here before any recurrence,
    // role-name or pure-inline shortcut can promote an individual row.
    if (facts[i] || demotedTimeFragments.has(i) || !substantiveLine(lines[i])) continue
    const { leading, match } = inlineView(lines[i])
    if (!match) continue
    const label = normalizeLabel(match[2])
    if (!plausibleLabel(label)) continue
    const accepted = strongNames.has(label)
      || isRoleSpeakerLabel(label)
      || (!leading.matched && ((inlineCounts.get(label) || 0) >= 2 || pureInline))
    if (!accepted) continue
    facts[i] = {
      indent: match[1],
      key: speakerKey(label),
      label,
      kind: isGenericSpeakerLabel(label) ? 'generic-inline' : 'inline',
      body: match[3] || '',
      timestamp: leading.timestamp || '',
      generic: isGenericSpeakerLabel(label),
    }
  }

  // Once one occurrence has established a label, the label itself is structural evidence for the same
  // track under another timestamp wrapper. This avoids enumerating every vendor decorator while keeping
  // unknown labels fail-closed: knownLabelFact still accepts decoration-only prefixes and exact label
  // boundaries, never arbitrary prose.
  const parsedLabels = facts.filter(Boolean).map((fact) => fact.label)
  const knownRecovery = recoverKnownFacts(lines, facts, [
    ...parsedLabels,
    ...(options.knownSpeakerLabels || []),
  ])
  const scoutRecovery = recoverScoutFacts(lines, facts, options.scoutSpeakers || [])
  const tracks = new Map()
  const labels = []
  for (let i = 0; i < facts.length; i += 1) {
    const fact = facts[i]
    if (!fact) continue
    labels.push({ line: i + 1, ...fact })
    const key = fact.matchKey || fact.key
    let track = tracks.get(key)
    if (!track) {
      track = { key, sourceLabel: fact.label, generic: fact.generic, roleLike: isRoleSpeakerLabel(fact.label), firstLine: i + 1, labelLines: 0 }
      tracks.set(key, track)
    }
    track.labelLines += 1
  }

  const structureWarnings = []
  const unresolvedLeadingInline = leadingInlineCandidates.filter((candidate) => !facts[candidate.line - 1])
  const unresolvedDecorated = [
    ...unresolvedLeadingInline,
    ...unresolvedDecoratedCandidates.filter((candidate) => !facts[candidate.line - 1]),
  ]
  if (unresolvedDecorated.length >= 2) {
    structureWarnings.push({
      kind: 'unrecognized_speaker_structure',
      count: unresolvedDecorated.length,
      lines: unresolvedDecorated.slice(0, 8).map((item) => item.line),
      labels: [...new Set(unresolvedDecorated.map((item) => item.label))].slice(0, 8),
    })
  }
  const scoutSignals = [...new Set((options.scoutSpeakers || [])
    .filter(scoutStructureRecord)
    .map((record) => speakerKey(record.label))
    .filter(Boolean))]
  if (!tracks.size && scoutSignals.length >= 2) {
    structureWarnings.push({
      kind: 'scout_parser_disagreement',
      count: scoutSignals.length,
      lines: [],
      labels: (options.scoutSpeakers || []).filter(scoutStructureRecord).map((record) => normalizeLabel(record.label)).slice(0, 8),
    })
  } else if (tracks.size && scoutRecovery.evidenceMisses.length) {
    structureWarnings.push({
      kind: 'scout_evidence_unmatched',
      count: scoutRecovery.evidenceMisses.length,
      lines: [],
      labels: [...new Set(scoutRecovery.evidenceMisses)].slice(0, 8),
    })
  }

  return {
    lines,
    labels,
    tracks: [...tracks.values()],
    labelLines: labels.length,
    needsResolution: [...tracks.values()].some((track) => track.generic || track.roleLike),
    recoveredByScout: scoutRecovery.recovered,
    recoveredByKnownLabel: knownRecovery,
    structureWarnings,
  }
}

function unitBodyLine(raw) {
  const line = String(raw || '').trim()
  if (!line || /^<!--/u.test(line) || /^#{1,6}\s/u.test(line) || /^<title\b/iu.test(line)) return ''
  return line
}

function trackedUnits(parsed) {
  return parsed.labels.map((fact, index) => {
    const next = parsed.labels[index + 1]
    const endIndex = next ? next.line - 2 : parsed.lines.length - 1
    const body = []
    let endLine = fact.line
    if (String(fact.body || '').trim()) body.push(String(fact.body).trim())
    for (let i = fact.line; i <= endIndex; i += 1) {
      const line = unitBodyLine(parsed.lines[i])
      if (!line) continue
      body.push(line)
      endLine = i + 1
    }
    return {
      speaker: fact.label,
      speakerKey: fact.matchKey || fact.key,
      startLine: fact.line,
      endLine,
      text: body.join('\n'),
      ts: fact.timestamp || null,
    }
  })
}

function untrackedUnits(lines) {
  const units = []
  let cur = null
  const flush = () => {
    if (cur && cur.text.length) units.push({ speaker: null, speakerKey: '', ...cur, text: cur.text.join('\n') })
    cur = null
  }
  for (let i = 0; i < lines.length; i += 1) {
    const raw = String(lines[i] || '')
    const line = raw.trim()
    if (!line) { flush(); continue }
    if (/^<!--/u.test(line) || /^#{1,6}\s/u.test(line) || /^<title\b/iu.test(line)) { flush(); continue }
    if (/^>\s*(?:录音主题|录音时间|智能纪要由\s*AI\s*生成)/iu.test(line)) { flush(); continue }
    const listItem = /^\s*(?:[-*+]|\d+[.)、])\s+/u.test(raw)
    if (listItem && cur) flush()
    if (!cur) cur = { startLine: i + 1, endLine: i + 1, text: [] }
    cur.text.push(line)
    cur.endLine = i + 1
  }
  flush()
  return units
}

// One canonical structural parse for every downstream consumer. `tracked` means complete verified tracks,
// `ambiguous` means speaker-shaped structure is still unresolved, and `untracked` means no label evidence exists
// (it may still be a valid monologue).
function parseSpeakerDocument(sourceText, options = {}) {
  const parsed = parseSpeakerLabels(sourceText, options)
  const speakerMode = parsed.structureWarnings.length ? 'ambiguous' : parsed.tracks.length ? 'tracked' : 'untracked'
  return {
    ...parsed,
    speakerMode,
    units: speakerMode === 'tracked' ? trackedUnits(parsed) : untrackedUnits(parsed.lines),
  }
}

// Conservative provenance gate: only an explicit declaration near the document head qualifies. A filename,
// an “智能纪要” title by itself, a summary-like writing style, or zero speaker tracks is never enough.
function detectDeclaredAiSummary(sourceText) {
  const head = String(sourceText || '').split(/\r?\n/u).slice(0, 80)
  const index = head.findIndex((line) => AI_SUMMARY_DISCLOSURE_RE.test(line))
  return index >= 0
    ? { declared: true, kind: 'declared_ai_summary', line: index + 1, evidence: head[index].trim().slice(0, 200) }
    : { declared: false, kind: 'transcript', line: null, evidence: '' }
}

function normalizeRole(value) {
  const role = normalizeLabel(value).replace(/[（(].*$/u, '').trim()
  if (/记者|采访者|访谈者|提问者/iu.test(role)) return '记者'
  if (/受访者|嘉宾|回答者/iu.test(role)) return '受访者'
  if (/主持/iu.test(role)) return '主持人'
  if (/\bPR\b|公关/iu.test(role)) return 'PR'
  if (/同事/iu.test(role)) return '同事'
  if (/协调/iu.test(role)) return '协调'
  return ROLE_RE.test(role) ? role.replace(/\s*\d+$/u, '') : ''
}

function extractPersonName(value) {
  let head = normalizeLabel(value).replace(/^(?:姓名|名字)\s*[：:]\s*/u, '')
  head = head.split(/[，,；;（(\n]/u, 1)[0].trim()
  if (!head || TITLE_WORD_RE.test(head) || isRoleSpeakerLabel(head) || isGenericSpeakerLabel(head)) return ''
  if (/^[\p{Script=Han}·]{2,8}$/u.test(head)) return head
  if (/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/u.test(head)) return head
  return ''
}

function cleanOutputLabel(value) {
  const label = normalizeLabel(value)
  if (!label || label.length > 32 || isGenericSpeakerLabel(label)) return ''
  const name = extractPersonName(label)
  if (name) return name
  return normalizeRole(label)
}

function recordScore(record) {
  if (!record) return -1
  const output = cleanOutputLabel(record.output_label)
  const identity = extractPersonName(record.identity)
  const confident = record.output_label_confidence === 'high' && String(record.output_label_evidence || '').trim()
  return (confident && output && !isRoleSpeakerLabel(output) ? 20 : 0)
    + (confident && identity ? 10 : 0)
    + (output ? 4 : 0)
    + (normalizeRole(record.role) ? 2 : 0)
}

function scoutRecordsByKey(speakers) {
  const records = new Map()
  const conflictKeys = new Set()
  for (const record of speakers || []) {
    if (!record) continue
    const keys = [speakerKey(record.label)]
    const sampleHead = String(record.sample || '').split(/\r?\n/u, 1)[0]
    if (sampleHead) keys.push(speakerKey(stripLineEndHardBreak(sampleHead).replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/u, '')))
    for (const key of keys.filter(Boolean)) {
      if (record.name_conflict) conflictKeys.add(key)
      if (!records.has(key) || recordScore(record) > recordScore(records.get(key))) records.set(key, record)
    }
  }
  return { records, conflictKeys }
}

// The one interpretation of "which person does this Scout record name". chooseOutputLabel can turn a
// record into a person name through exactly two branches — a confident non-role output_label, else a
// confident identity — and conflict detection in mergeScoutChunks must use the same two branches, or an
// identity-only disagreement slips past the comparison and the resolver still names the track.
function effectiveScoutPersonName(record) {
  if (!record) return ''
  const confident = record.output_label_confidence === 'high' && String(record.output_label_evidence || '').trim()
  if (!confident) return ''
  const requested = cleanOutputLabel(record.output_label)
  if (requested && !isRoleSpeakerLabel(requested)) return requested
  return extractPersonName(record.identity)
}

function chooseOutputLabel(track, record) {
  const requested = cleanOutputLabel(record && record.output_label)
  const confidentIdentity = record && record.output_label_confidence === 'high' && String(record.output_label_evidence || '').trim()
  if (confidentIdentity && requested && !isRoleSpeakerLabel(requested)) return { outputLabel: requested, basis: 'scout_output_label' }
  if (!track.generic && !track.roleLike) return { outputLabel: track.sourceLabel, basis: 'source_name' }
  const identity = extractPersonName(record && record.identity)
  if (confidentIdentity && identity) return { outputLabel: identity, basis: 'scout_identity' }
  if (requested && isRoleSpeakerLabel(requested)) return { outputLabel: requested, basis: 'scout_output_label' }
  const role = normalizeRole(record && record.role)
  if (role) return { outputLabel: role, basis: 'scout_role' }
  return { outputLabel: track.sourceLabel, basis: 'unresolved' }
}

function resolveSpeakerMapping(sourceText, scoutSpeakers = []) {
  const parsed = parseSpeakerLabels(sourceText, { scoutSpeakers })
  const { records, conflictKeys } = scoutRecordsByKey(scoutSpeakers)
  const mappings = parsed.tracks.map((track) => {
    let record = records.get(track.key)
    // A track whose Scout chunks disagreed on the person keeps its conflict verdict: no record that
    // reaches this key — however it got here — may hand the track a person name again.
    if (record && conflictKeys.has(track.key)) {
      record = { ...record, output_label: '', output_label_confidence: 'low', output_label_evidence: '', identity: '' }
    }
    return { ...track, role: normalizeRole(record && record.role), ...chooseOutputLabel(track, record) }
  })

  // Two unidentified people with the same role must never collapse into one visible speaker. Keep the semantic
  // role, but number the distinct source tracks deterministically by first appearance.
  const roleGroups = new Map()
  for (const mapping of mappings) {
    if (!isRoleSpeakerLabel(mapping.outputLabel)) continue
    if (!roleGroups.has(mapping.outputLabel)) roleGroups.set(mapping.outputLabel, [])
    roleGroups.get(mapping.outputLabel).push(mapping)
  }
  for (const [role, group] of roleGroups) {
    if (group.length < 2) continue
    group.sort((a, b) => a.firstLine - b.firstLine)
    group.forEach((mapping, index) => {
      mapping.outputLabel = `${role} ${index + 1}`
      mapping.basis += '_disambiguated'
    })
  }

  return {
    parsed,
    mappings,
    unresolved: mappings.filter((mapping) => mapping.basis === 'unresolved').map((mapping) => mapping.sourceLabel),
    speakerMode: parsed.structureWarnings.length ? 'ambiguous' : parsed.tracks.length ? 'tracked' : 'untracked',
    structureWarnings: parsed.structureWarnings,
    recoveredByScout: parsed.recoveredByScout,
  }
}

function rewriteSpeakerLabels(sourceText, scoutSpeakers = [], options = {}) {
  const source = String(sourceText || '')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const { parsed, mappings, unresolved, speakerMode, structureWarnings, recoveredByScout } = resolveSpeakerMapping(source, scoutSpeakers)
  const byKey = new Map(mappings.map((mapping) => [mapping.key, mapping]))
  const out = [...parsed.lines]
  let changedLines = 0

  for (const fact of parsed.labels) {
    const mapping = byKey.get(fact.matchKey || fact.key)
    const outputLabel = mapping ? mapping.outputLabel : fact.label
    const timestamp = options.keepTimestamps && fact.timestamp ? ` ${fact.timestamp}` : ''
    const rewritten = `${fact.indent || ''}${outputLabel}${timestamp}：${fact.body || ''}`
    if (out[fact.line - 1] !== rewritten) changedLines += 1
    out[fact.line - 1] = rewritten
  }

  return {
    text: out.join(newline),
    mappings: mappings.map(({ key, sourceLabel, outputLabel, role, basis, firstLine, labelLines }) =>
      ({ key, sourceLabel, outputLabel, role, basis, firstLine, labelLines })),
    unresolved,
    changedLines,
    labelLines: parsed.labelLines,
    needsResolution: parsed.needsResolution,
    speakerMode,
    structureWarnings,
    recoveredByScout,
  }
}

// A generic prefix followed by a second number that runs straight into a colon or the line end
// (`说话人 1 00：…` / `说话人 1 00`) is the signature of a truncated timestamp, never legitimate prose.
// Requiring the colon/EOL keeps narrative lines like `发言人 2 15 分钟后回来` out of the trap. Enforcement
// fails closed on the signature even when it occurs too rarely for the inline accept-gate to parse it.
const TRUNCATED_GENERIC_RE = new RegExp(
  `^\\s*\\*{0,2}\\s*(?:${GENERIC_PREFIX})\\s*(?:${GENERIC_NUMBER})\\s+\\d{1,4}\\s*(?:[：:]|$)`,
  'iu',
)

function aliasKey(value) {
  const label = normalizeLabel(value)
  const role = normalizeRole(label)
  return role ? `role:${role}` : speakerKey(label)
}

function inlineableTurnBody(value) {
  const line = String(value || '')
  const trimmed = line.trim()
  if (!trimmed || line !== line.trimStart()) return false
  return !/^(?:#{1,6}\s|<!--|<title\b|```|~~~|>|[-*+]\s|\d+[.)、]\s|\|)/iu.test(trimmed)
}

function inlineCanonicalSpeakerBodies(lines, labels, canonicalLabelLines) {
  const out = [...lines]
  const removals = new Set()
  for (let i = 0; i < labels.length; i += 1) {
    const fact = labels[i]
    if (!canonicalLabelLines.has(fact.line) || String(fact.body || '').trim()) continue
    const nextLabelLine = labels[i + 1] ? labels[i + 1].line : out.length + 1
    let bodyIndex = fact.line
    while (bodyIndex < nextLabelLine - 1 && !String(out[bodyIndex] || '').trim()) bodyIndex += 1
    if (bodyIndex >= nextLabelLine - 1 || !inlineableTurnBody(out[bodyIndex])) continue
    out[fact.line - 1] = `${out[fact.line - 1]}${out[bodyIndex]}`
    for (let lineIndex = fact.line; lineIndex <= bodyIndex; lineIndex += 1) removals.add(lineIndex)
  }
  return out.filter((_line, index) => !removals.has(index))
}

function enforceCanonicalSpeakerLabels(refinedText, mappings = [], options = {}) {
  const source = String(refinedText || '')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const parsed = parseSpeakerLabels(source)
  const speakerMode = ['tracked', 'ambiguous', 'untracked'].includes(options.speakerMode)
    ? options.speakerMode
    : 'tracked'
  const aliases = new Map()
  const register = (alias, canonical) => {
    const key = aliasKey(alias)
    if (!key || !canonical) return
    if (!aliases.has(key)) aliases.set(key, canonical)
    else if (aliases.get(key) !== canonical) aliases.set(key, null)
  }
  for (const mapping of mappings || []) {
    if (!mapping || !mapping.outputLabel) continue
    register(mapping.sourceLabel, mapping.outputLabel)
    register(mapping.outputLabel, mapping.outputLabel)
    register(mapping.role, mapping.outputLabel)
  }

  const canonicalSet = new Set((mappings || []).map((mapping) => mapping && mapping.outputLabel).filter(Boolean))
  const out = [...parsed.lines]
  const replacements = []
  const unknownLabels = []
  const canonicalLabelLines = new Set()
  for (const fact of parsed.labels) {
    const canonical = aliases.get(aliasKey(fact.label))
    if (!canonical) {
      if (!canonicalSet.has(fact.label)) unknownLabels.push({ line: fact.line, label: fact.label })
      else canonicalLabelLines.add(fact.line)
      continue
    }
    canonicalLabelLines.add(fact.line)
    const rewritten = `${fact.indent || ''}${canonical}：${fact.body || ''}`
    if (out[fact.line - 1] === rewritten) continue
    replacements.push({ line: fact.line, from: fact.label, to: canonical })
    out[fact.line - 1] = rewritten
  }
  const factLines = new Set(parsed.labels.map((fact) => fact.line))
  for (let i = 0; i < parsed.lines.length; i += 1) {
    if (factLines.has(i + 1) || !TRUNCATED_GENERIC_RE.test(parsed.lines[i])) continue
    unknownLabels.push({ line: i + 1, label: normalizeLabel(parsed.lines[i].split(/[：:]/u, 1)[0]).slice(0, 40) })
  }
  return {
    text: inlineCanonicalSpeakerBodies(out, parsed.labels, canonicalLabelLines).join(newline),
    speakerMode,
    replacements,
    changedLines: replacements.length,
    unknownLabels,
    labelLines: parsed.labelLines,
    valid: unknownLabels.length === 0,
    violations: unknownLabels.map((item) => ({
      ...item,
      kind: speakerMode === 'untracked'
        ? 'invented_speaker_label'
        : speakerMode === 'ambiguous'
        ? 'unverified_speaker_label'
        : 'unknown_speaker_label',
    })),
  }
}



// Failures that mean substantive interview content is not yet a trustworthy source for derivatives.
const BODY_FIDELITY_GATES = Object.freeze([
  'content_gap', 'compression_risk', 'attribution_mismatch', 'seam_duplicate',
])

// Publication-invalid cleanup/typesetting failures. They do not imply lost or reassigned content, but a file
// carrying one of them is still not a final body. Keep them separate from BODY_FIDELITY_GATES so diagnostics can
// say whether the risk is factual or editorial; both groups receive at most two repair + re-audit rounds before blocking.
const OUTPUT_QUALITY_GATES = Object.freeze([
  'residual_noise', 'under_refined', 'long_paragraphs', 'quote_style',
])

// The ONE shared answer to “does this body block derivatives/direct publication?”. Pipeline repair, Codex-native
// gating, and run-level scorecards must consume this list instead of re-interpreting audit `status` independently.
const PUBLICATION_BLOCK_GATES = Object.freeze([
  ...BODY_FIDELITY_GATES,
  ...OUTPUT_QUALITY_GATES,
])

// Compare semantic section titles, not their typesetting. Model-authored logic provenance often changes Chinese
// curly quotes to ASCII quotes, folds spaces around Latin words, or swaps full-/half-width punctuation. None of
// those changes means a source section is missing. NFKC folds width variants; lower-case removes Latin case drift;
// every Unicode punctuation/space code point (including zero-width spaces) is ignored. Keep letters, numbers and
// non-punctuation symbols because they may carry meaning (for example C++); callers retain the original title for reporting.
function canonicalHeadingKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s\u200B-\u200D\uFEFF]+/gu, '')
}

// ---------- schemas ----------
// NOTE: no schema sets `required` — a StructuredOutput validation failure triggers an unbounded retry loop.
// (Observed in the wild: network degradation truncating output caused one `required` field to spin the verify agent
// 151 times / 20 minutes.) Missing fields are covered by JS-side defaults (|| [] / normalised to null);
// the worst-case for a missing field is falling back to “retain (phonetic)” — far safer than a retry loop.
const entitySchema = (extra) => ({
  type: 'object',
  properties: Object.assign({
    canonical: { type: 'string', description: '该实体最可信的写法' },
    variants: { type: 'array', items: { type: 'string' }, description: '文中出现的其它写法，含疑似同音误写' },
    hint: { type: 'string', description: '一句定位线索（身份/title/语境）' },
    suspect_asr: { type: 'boolean', description: 'canonical 疑为转录同音/听写误写、但拿不准正确写法时置 true——会强制联网核实这一条（哪怕只出现一处、无其它变体）' },
  }, extra || {}),
})

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    speakers: { type: 'array', items: { type: 'object', properties: {
      label: { type: 'string', description: '转录中的发言人标签原样' },
      role: { type: 'string', description: '受访者 / 记者 / PR陪同 / 同事 / 协调 等' },
      identity: { type: 'string', description: '对应到谁 + title（若文中可判断）' },
      output_label: { type: 'string', description: '精校稿最终应显示的纯标签：能判断真名则只写真名，否则写可区分角色；拿不准留空' },
      output_label_confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '真名归属置信度；只有全文内有直接证据才可 high' },
      output_label_evidence: { type: 'string', description: '支持 output_label 的一处原文证据；写真名时必须说明为何这是本人而非被提到/被喊话的人' },
      sample: { type: 'string', description: '一整行原文标签样例，必须逐字照抄该行（含行首时间码/括号、标签、冒号与同行正文），供确定性代码回查；不得省略或改写' },
    } } },
    people: { type: 'array', items: entitySchema({ public_figure: { type: 'boolean', description: '公众人物，可公开核实' } }) },
    brands: { type: 'array', items: entitySchema({ category: { type: 'string', description: '自家/竞品/供应商/平台/产品/机构' } }) },
    terms: { type: 'array', items: entitySchema({ domain: { type: 'string', description: '行业/工艺/公司内部 等' } }) },
    errors: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', description: '同音字错/英文听写错/（音）标记/夹行时间戳/乱码/Word残讯' },
      examples: { type: 'array', items: { type: 'string' } },
    } } },
    themes: { type: 'array', items: { type: 'string' } },
    has_existing_headings: { type: 'boolean', description: '源文件是否已带小标题行' },
    ending_anchor: { type: 'object', properties: {
      line: { type: 'number', description: '文件总行数' },
      text: { type: 'string', description: '原文最后一句话原样' },
    } },
    special_notes: { type: 'array', items: { type: 'string' }, description: '该份特别提醒：拒答语境要保留、离场后闲聊、称呼混乱重灾区等' },
  },
}

const SPEAKER_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'number', description: '候选在精校稿中的 1-based 行号；必须原样返回输入候选行号' },
          label: { type: 'string', description: '候选标签；必须原样返回输入候选标签' },
          verdict: {
            type: 'string',
            enum: ['invented_speaker', 'not_speaker', 'source_supported_alias', 'uncertain'],
            description: 'invented_speaker=确为对话发言轮且源稿/映射均不支持；not_speaker=标题、说明、元信息等非发言轮；source_supported_alias=源稿支持但映射遗漏；uncertain=证据不足',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: {
            type: 'string',
            enum: ['dialogue_turn_without_source', 'document_metadata', 'heading_or_caption', 'list_quote_or_table', 'source_label_or_alias', 'insufficient_context'],
            description: '只返回最贴近直接文本证据的一类原因，不写自由文本',
          },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'array', items: { type: 'object', properties: {
      query: { type: 'string', description: '清单中的候选写法' },
      canonical: { type: 'string', description: '核实后的正确写法' },
      identity: { type: 'string', description: '身份/title' },
      source: { type: 'string', description: '依据来源一句话' },
      // Chinese-name spelling is a separate key from identity. An English/Pinyin author page may prove that
      // Lin Chuan is the person being discussed, but it cannot prove whether the Chinese name is 林川 or 林传.
      // The verifier must both set this flag and repeat the exact canonical Han spelling in `source`; the render
      // side checks both before it lets a person-name conclusion enter the glossary/body.
      name_script_exact: { type: 'boolean', description: '人名 canonical 为中文汉字时，仅当所列来源页面直接出现该完整汉字写法才置 true；仅有英文名/拼音/罗马字必须为 false' },
      // OPTIONAL (all existing consumers survive its absence): the agent attests BOTH keys held for a decisive
      // conclusion on a phonetically-suspect / contested entity — a 高级别来源（官方域名/大媒体/百科）AND 语境吻合.
      // Only two_key===true may retire a 〔同指两解〕 row (see confidenceMark); a coattail/SEO/分销站 never sets it.
      two_key: { type: 'boolean', description: '对存疑/两解实体下决定性结论时，高级别来源与语境吻合两项同时成立才置 true；搭便车/SEO 站永不可置 true' },
    } } },
    unresolved: { type: 'array', items: { type: 'object', properties: {
      query: { type: 'string' },
      note: { type: 'string' },
    } } },
    // Contested (两把钥匙未满足): a referent substitution the two-key rule blocked — keep the spoken/literal form,
    // record BOTH hypotheses + each side's evidence tier. Separate from resolved/unresolved so existing consumers
    // are untouched; the pipeline lands these as 〔同指两解〕 rows and one 收尾待问 line each.
    contested: { type: 'array', items: { type: 'object', properties: {
      query: { type: 'string', description: '清单中的候选写法（口播/字面原形），维持不改' },
      literal: { type: 'string', description: '假设 A：字面/口播形若真为独立实体，它是什么（可与 query 相同）' },
      literal_tier: { type: 'string', description: 'A 命中的最强证据级别：官方/权威媒体/百科 ＞ 目录站/SEO 博客 ＞ 自我推销贴' },
      correction: { type: 'string', description: '假设 B：更可能的正确写法/所指' },
      correction_tier: { type: 'string', description: 'B 命中的最强证据级别（同上分级）' },
      note: { type: 'string', description: '一句说明为何两解未决（如：字面命中仅为 X 的分销站，属搭便车反转）' },
    } } },
  },
}

const REFINE_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '成稿输出路径' },
    headings: { type: 'array', items: { type: 'string' }, description: '你分的 ## 小标题' },
    key_fixes: { type: 'array', items: { type: 'string' }, description: '关键修正' },
    open_questions: { type: 'array', items: { type: 'string' }, description: '仍存疑、需问委托方的点' },
  },
}


const DEDUP_SCHEMA = {
  type: 'object',
  properties: {
    suspects: { type: 'array', items: { type: 'object', properties: {
      members: { type: 'array', items: { type: 'string' }, description: '疑似指同一对象的两个或多个写法（取各自 canonical）' },
      kind: { type: 'string', description: 'person / brand / term' },
      why: { type: 'string', description: '为何疑似同指（同音/形近/同一身份线索等），一句话' },
      preferred: { type: 'string', description: '仅当 kind 为 term/brand 且你有把握时：给出该组的正确/标准写法（members 之一）；人名身份合并或拿不准就留空，交人工定夺' },
    } } },
  },
}

const LOGIC_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '逻辑顺序稿输出路径' },
    mainline: { type: 'string', description: '主线脉络导读：一段话讲清这次访谈的主线与重排逻辑' },
    threads: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string', description: '该叙事线索的小标题（自描述、不编号）' },
      logic: { type: 'string', description: '该线索内部排序逻辑：时间 / 因果 / 问题-解法 等' },
      source_sections: { type: 'array', items: { type: 'string' }, description: '该线索取自精校稿的哪些小标题——**原样照抄精校稿里的 ## 小标题**，供完整性核对' },
    } } },
    open_questions: { type: 'array', items: { type: 'string' }, description: '重排中发现、需问委托方的点' },
  },
}

const LOGIC_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '逻辑重排方案 JSON 输出路径' },
    mainline: { type: 'string', description: '主线脉络：为什么这样重排' },
    no_reorder_needed: { type: 'boolean', description: '精校稿已天然按叙事顺序组织时置 true，并说明无需另出逻辑稿' },
    reason: { type: 'string', description: '无需重排或重排策略的理由' },
    threads: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string', description: '该叙事线索的小标题（自描述、不编号）' },
      logic: { type: 'string', description: '该线索内部排序逻辑：时间 / 因果 / 问题-解法 等' },
      source_sections: { type: 'array', items: { type: 'string' }, description: '该线索取自精校稿的哪些 ## 小标题，原样照抄' },
      source_order: { type: 'array', items: { type: 'number' }, description: '这些 source_sections 在精校稿中的 1-based 顺序号' },
    } } },
    open_questions: { type: 'array', items: { type: 'string' }, description: '重排前发现、需问委托方的点' },
  },
}


// ---------- proofreading rules (kept in sync with SKILL.md Step 2) ----------
// Content editing and serialization are deliberately separate facts. Legacy Markdown agents still own their
// wrapper/label syntax; turn-ir-v2 agents edit only block bodies and relations, while the host owns H1, subtitle,
// and canonical speaker labels. Do not derive one mode from the other with regex/string filtering.
const EDITORIAL_RULES = `精校内容规范（务必全部遵守）：
1. 保持对话体、不要改写成叙述文章；保留每轮发言的归属和顺序，不把不同说话人的内容混在一起，也不把转述改造成新的直接引语。
2. 删口癖、口语赘词与口语重复，合并语义重复句；以“读着顺、信息不丢”为准——不改语气风格与原意，不替发言人加观点，拿不准就保留，宁可漏删一处也别删出歧义。注意：“宁可漏删”只适用于可能改义的词，不适用于纯噪音；纯噪音（语气音、确认复读、卡顿）必须删干净。开场寒暄**只有在纯问候、无任何实质内容时**才折叠成一句括号说明；**夹在寒暄里的产品评论、事实陈述、观点原话必须逐句保留**（例：调试录音设备时对某支麦克风的吐槽、闲聊里带出的一个数字或判断，都属于必须保留的实质内容，不得随寒暄一起折叠）。
   · **径删（纯垫词，无任何语义）**：语气与卡顿音（嗯、呃、啊、哦、欸）；确认复读（对对对、是是是、嗯嗯）；纯卡顿的“那个…这个…就是说…”；句首口头禅式的“然后/其实/就是”；空洞的反问尾巴（对吧、是吧、对不对、你知道——确在向对方求证的留）。
   · **看义删（有义则留，纯垫才删）**：“一个/一种/一些”作量词废垫删、表“一/同一/特指某个”留——“为了让它有一个统一口感”→“为了有统一口感”（删），“跟咖啡豆拼配是一个道理”照留（＝同一个道理，有义），“摆在一个角落、同一个时间、给他一个机会”留；“其实”句首口头禅删、表转折（本以为…其实…、但其实）留；“然后”空接续删、表真实先后或因果留；“就是”卡顿垫词删、表“正是/只是/即”留；“的话”纯提顿删（“做手工的话”→“做手工”）、真条件（“需要的话”）留。
   · **基本别动（多为实义，硬删反而改义）**：“我觉得/我感觉”标记的是发言人立场，删了会把看法读成事实，仅紧邻重复时合并；“一点/一下”表程度或轻微动作，“对…来说/来讲”“包括”“比如”是框定与举例——一般照留。
   纯粹确认写法的来回**折叠成结果**：口头拼字（“吴，哪个杰？”“捷报的捷——提手旁那个”“哦，口天的吴”）在书面稿里没有残值，在名字首次出现处直接写澄清后的写法（“吴捷”），整段问字对话删去——但必须用**澄清后**的字（捷，非先听到的杰）；夹有信息量内容（名字来历/玩笑）的只删机械确认、内容照留；没澄清出结果的保留（音）。
3. 理顺破碎口语、修语序与冗余助词；有信息量/有个性的金句照留，不要抹平。
4. 按主题加 ## 小标题：准确概括、不篡改原意、不加原文没有的结论；一律不编号；一份通常 6–20 个。
4a. 段落边界：不要因为连续同一发言人就把多段源转录合成一个巨长段。原则上保留源文件的问答/发言轮次；只有同一发言人的相邻源段明显是同一句话被 ASR 切开、且合并后不超过约 500 字时才合并。长独白拆成多个可读段落（每段通常 200-600 字）；单个对话段超过约 900 字视为需要重切。
5. 严格按校对表统一人名/品牌/术语；删姓名后/夹行时间戳与英文听写乱码（能判断词义就替换，判断不了就顺掉）；拿不准的名字保留（音），绝不臆造。**凡校对表中标 ⚠ 或注明「保留（音）／未能核实／疑为转录误写」的名字：正文每处都写作「名字（音，存疑）」或「名字（音）」，不得裸写**（这些是尚未核实的写法，裸写会被误当成已确认）。
6. 保留全部事实细节（数字/金额/时间/产品/工艺/渠道/观点）——精校不是摘要。
7. 发言人规范：采访方追问归对应记者名；被访方旁白/补充按校对表标注；拒答/「以招股书为准」等语境务必原样保留，勿替受访者补数字。
8. 中文引号一律用全角 “”（内层 ‘’）——禁用 ASCII 直引号 "/'、禁用「」/『』；其余中文标点（，。；：？！）也用全角。转写常把引号输成直引号，逐一改成全角弯引号。**书面化的引语、专名与术语首次出现、带反讽或口头禅性质的短语，主动用全角弯引号 “” 标出**（如 他说这是 “行业惯例”、所谓 “现厂制”）。代码/英文专名/路径里的 ASCII 引号不动。
9. 数字用阿拉伯数字：把汉字数字改成阿拉伯数字（十六个部门→16 个部门，六七十 B 大模型→60-70B 大模型，三四百人→300-400 人，约数范围用连字符）。例外——很短的口语化小数目保留汉字：两个人、三五个、一两次、七八年、一两句话 等约定俗成口语不转；成语/固定词不动（三心二意、五花八门、一五一十）。带量词的确切数目（16 个、3 轮、5 家）一律用阿拉伯数字。
10. 中文与英文/数字之间加一个半角空格（盘古之白）：汉字与拉丁字母、阿拉伯数字相邻处插一个空格（用 GPT-4 做、16 个部门、覆盖 80% 用户、A 轮融资、2021 年底）。不加空格：①数字与紧跟的单位/符号之间（60-70B、80%、$50、5G、A4）；②与全角标点相邻处；③英文/数字内部与 ASCII 标点之间。已正确成对的空格不要再叠加。
11. **一次写对，别回头微改**：术语/人名/品牌按“写法统一”指令与校对表在初次落笔时就写对；**严禁写完后再回头做大量“改一两个字”的细小 Edit**（每次 Edit 都要把整份转录+校对表重新过一遍，十几个小改 = 成倍拖慢）。确需更正就把多处合并成尽量少的几次 Edit，别逐字逐处单独改。
12. **绝不无声跳过任何实质内容段**。若确有无法恢复的缺口（原文转录缺失、彻底无法辨认），就在原位置用**一句人话的括号说明**交代，例：（此处约 200 字因转录缺失未能恢复，见源 L120-L150）——**禁止输出工具告警式、系统报错式的文案**。此为最后手段——正常情况下整份成稿应没有任何缺口说明；口水寒暄按规范 2 折叠成一句括号说明不算缺口、不要标。宁可如实标注缺口，不可无声省略。`

const LEGACY_MARKDOWN_RULES = `传统 Markdown 输出规范（仅适用于模型直接拥有最终 Markdown 格式的路径）：
1. 发言人标签一律「名字：」纯文本形态，不加粗、不加时间戳、不加其它样式——写成 李明： 而不是 **李明：** 或 李明 12:03：，全篇同一形态；长独白分段时按需重复发言人标签。
2. 文件抬头由模型写入：首行 H1 标题，第二行斜体说明行。
3. 长文件分多次接力写：先 Write 抬头和开头，再用 Edit 以已写入的最后一句为锚点追加，务必覆盖到源文件结尾；每次写尽量大的完整主题块，不要逐行追加。`

const TURN_IR_V2_RULES = `Turn IR v2 序列化规范（宿主是最终格式的唯一所有者）：
- 第一条非空行必须逐字为 \`<!-- LRB_TURN_CONTRACT v2 -->\`。
- 只使用成对的 \`LRB_OUTPUT_BLOCK sources=... disposition=keep|merge|split|fold_noise\` 标记承载正文；\`LRB_SOURCE_REFS\` 是宿主只读元数据，可原样保留。
- 全部来源 ID 必须按原顺序完整记账（这里的 ID 即 source turn ID）：keep 一对一；merge 只合并相邻同轨来源；split 把同一来源连续映射到至少两个 block；fold_noise 只折叠相邻纯口癖或纯寒暄来源。不得把事实或观点搬到不相干来源，不同说话人的实质发言不得合并。
- output block 外只能出现 \`## \` 小标题，且小标题归属于它后面的 block；block 正文内不得出现 Markdown 标题。
- 不要输出 H1、说明行、前言、结语或分隔线；不要输出或猜测 speaker_track_id，也不要输出说话人标签。标题、说明行和 canonical 说话人标签只由宿主根据结构化事实确定性渲染。`

// Backward-compatible name for direct-Markdown paths. Contracted paths must explicitly select
// EDITORIAL_RULES + TURN_IR_V2_RULES and never interpolate RULES.
const RULES = `${EDITORIAL_RULES}\n\n${LEGACY_MARKDOWN_RULES}`

// Chinese typesetting rules (same source as EDITORIAL_RULES items 8/9/10): injected into every sub-agent that generates Chinese.
// Proofreading agents already get them via RULES; summaries/timelines inject this compact version separately
// (timelines are the densest for numbers/years/amounts, so rules ② and ③ matter most there).
const TYPESET = `中文排版三规范（务必遵守）：
①引号一律用全角 “”（内层 ‘’），禁用 ASCII 直引号 "/' 与「」『』（代码/英文/路径除外）；其余中文标点也用全角。
②数字用阿拉伯数字（十六→16、六七十 B→60-70B、三四百→300-400，约数范围用连字符）；很短的口语小数目（两个人/三五个/一两次）与成语（三心二意/五花八门）保留汉字。
③盘古空格：中文与英文/阿拉伯数字相邻处加一个半角空格（用 GPT-4 做、16 个、覆盖 80%、A 轮、2021 年）；数字与紧跟的单位/符号间（60-70B、80%、$50）、与全角标点相邻处不加。`

// Single-file one-pass branch does not build a standalone glossary — use a sentinel constant rather than scattered
// string literals so that timelinePrompt can branch into the “no glossary” fallback path.
const SINGLE_FILE_GLOSSARY = '（单文件一遍过，未建独立校对表；校对决定见成稿与精校报告）'

// ---------- per-phase reasoning-effort DEFAULTS (M12 caps) ----------
// The M12 --effort knob only sets effort when the user passes it; otherwise a sub-agent INHERITS the session's
// reasoning effort. A maximum-effort session therefore made EVERY phase (mechanical ones included) burn maximal
// thinking — one real run took 117 min where the same work at normal effort took 15-25 min. These per-phase
// defaults CAP that: they are applied whenever the user has NOT overridden a phase (see effortFor below), so a
// run can never inherit an extreme session effort.
//
// This is a CAP on the CEILING, not a cut: it must never lower any judgment phase below its proven-good baseline
// (the API edition's implicit 'high'), only stop a maxed session from inflating a phase past 'high'.
//   · ALL judgment phases (verify / dedup / refine / logic / summary / timeline) are capped at 'high' — strong
//     reasoning, but never the 'xhigh'/'max' that caused the 2-hour run. verify (web entity-checking, exactly
//     what catches mis-heard names) and dedup (semantic same-referent judgment) are NOT mechanical: their
//     slow-run cost was a network stall, not thinking time, so dropping them below 'high' would be an unproven
//     quality risk. refine is likewise NOT lowered below 'high' — the document-level proof that 'medium' keeps
//     faithfulness isn't in yet, so 'medium' stays a user opt-in (--effort refine=medium, protocol in
//     eval/effort-experiment.md).
//   · Only the genuinely mechanical haiku phases (scout / stitch) go 'low' — and those are effort no-ops anyway.
// A user --effort <cat>=<level> override (A.effort[category]) always WINS over these defaults.
//
// Effort only affects the opus/sonnet/fable tiers — the haiku-tier entries here (scout / stitch) are harmless
// no-ops via the api.js EFFORT_ALLOWED guard, kept in the map for completeness so a future model-tier change
// stays covered. NOTE: the pipeline does NOT pass effort at the haiku (scout/stitch) call sites today — only the
// opus/sonnet sites read this map (see effortFor use in pipeline.js) — because the CC-edition bootstrap forwards
// opts.effort RAW (no per-model guard), and haiku 400-errors on effort. These two entries are documentation +
// future-proofing; if scout/stitch ever move to a smart tier, wire their call sites AND add a haiku guard to
// build/bootstrap-cc.js at the same time.
const DEFAULT_EFFORT = {
  scout: 'low', verify: 'high', dedup: 'high', refine: 'high',
  stitch: 'low', logic: 'high', summary: 'high', timeline: 'high',
}
// Resolve the effective effort for a phase: the user's per-category override wins, else the built-in cap.
// `??` (not `||`) so only null/undefined fall through to the default — a deliberately-set value is honoured as-is.
const effortFor = (A, category) => (A && A.effort && A.effort[category]) ?? DEFAULT_EFFORT[category]

// ---------- machine-readable confidence markers (校对表条目置信标记) ----------
// A 校对表 entry line was previously *prose only*: “已核实” / ⚠ told a human, but a machine couldn't tell an
// already-confirmed spelling from one still awaiting review, so an erroneous entry could only be undone by
// editing the text and hoping the next run re-checked it. These four line-tail tokens make the state MACHINE-
// readable. They use full-width lenticular brackets 〔…〕 which never appear in renderGlossary's own output, so
// an old 校对表 (no markers) round-trips completely unchanged — parseGlossary just reports confidence:'unknown'.
//   〔核实·YYYY-MM〕 — verified: applied a网络核实 conclusion backed by a CONCRETE source (date optional → 〔核实〕)
//   〔用户钦定〕     — user: a locked cluster from applyCanonicalOverrides (has structural veto, see below)
//   〔待复核〕       — recheck: EITHER a human撤销/flagged this entry, OR (M3 provenance guard) this round's
//                     verify resolved it but named no concrete source (isConcreteSource(source) failed) — the
//                     resolution is still applied to the entry body, just not trusted permanently. Either way
//                     parse decodes it the same (confidence:'recheck') and excludeVerified re-verifies it.
// Downstream contract:
//   · excludeVerified skips only verified/user (both are settled); recheck must be re-verified next round;
//     unknown keeps today's behaviour verbatim (full backward compatibility — the hard requirement).
const CONFIDENCE_VERIFIED = '核实'
const CONFIDENCE_USER = '用户钦定'
const CONFIDENCE_RECHECK = '待复核'
// 〔同指两解〕 — contested: verify could NOT satisfy the two-key rule (a high-tier source AND context-fit) for a
// referent substitution, so the spoken/literal written form is KEPT and BOTH hypotheses are recorded on the row.
// This is the coattail-inversion guard: an SEO site named after the misheard string does not license overwriting
// the entity's identity. A contested row is re-adjudicated next batch (excludeVerified treats it like recheck) and
// only a later two_key verdict (a resolved hit with two_key===true, the agent attesting high-tier source AND
// context-fit) that ACTUALLY applies (not blocked by the name-guard) may upgrade it to 〔核实〕. Bare concreteness
// never does — that was the coattail hole (an SEO domain reads "concrete" yet proves nothing about identity).
const CONFIDENCE_CONTESTED = '同指两解'
// Trailing-token matcher: 〔用户钦定〕 / 〔待复核〕 / 〔核实〕 / 〔核实·2025-07〕 / 〔同指两解〕 at the very end of an entry line.
// SF-1: the marker must be preceded by a whitespace char or a ｜ separator (captured group 1) — the render side
// always emits exactly one leading space before it (see confidenceMark), so a *legitimate* hint that happens to
// END with the literal string 〔核实〕 (no separating space, e.g. 正文…核实〔核实〕) is NOT mistaken for metadata
// and stays in the body. Anchored to $ so it can only ever consume a real trailing marker.
// Residual edge (documented, not handled): a hint deliberately ending with a SPACE + a literal 〔核实〕 token
// (“… 〔核实〕”) is indistinguishable from a real marker and will be stripped — an extreme collision we accept.
const CONFIDENCE_RE = new RegExp(`(^|[\\s｜])〔(${CONFIDENCE_USER}|${CONFIDENCE_RECHECK}|${CONFIDENCE_VERIFIED}|${CONFIDENCE_CONTESTED})(?:·([0-9]{4}-[0-9]{2}))?〕\\s*$`)

// ---------- provenance guard (M3): 核实 requires a CONCRETE source ----------
// The gap this closes: excludeVerified treats confidence:'verified' as PERMANENTLY settled — such an entry is
// skipped from re-verification in every future batch (see excludeVerified below). If the verify agent hallucinates
// a canonical and writes a vague/self-referential source (“网络搜索”、“公开资料” — the search ACTION, not a citation
// of what was found), that wrong name would otherwise be locked in forever, silently propagating to every batch.
// The guard: 〔核实〕 may only be earned when `source` names actual evidence (a URL/domain, or a specific
// publication/page). Anything else — including the verify prompt's own disciplined-sounding hedges — falls back
// to 〔待复核〕 (machine-assigned, not just hand-written): the resolution is still APPLIED this run
// (applyVerifiedEntry / the name-guard are untouched — only the PERMANENT-TRUST marker is withheld), and
// excludeVerified already force-re-verifies any confidence:'recheck' entry next batch (see below) — so a
// no-evidence hit gets one more chance to be checked properly instead of being trusted forever on the first guess.
// Blocklist: generic hedges a model reaches for when it has NO real citation — the search action itself
// (网络搜索/联网搜索/搜索结果/web search), a vague wave at "public info" with nothing specific named
// (公开资料/公开信息), or an admission it has nothing (常识/据记忆/模型知识/未提供/无来源/common knowledge).
// Matched case/width-insensitively as a SUBSTRING, so “搜索确认” and “经网络搜索确认” both fail alike.
const CONCRETE_SOURCE_BLOCKLIST = [
  '网络搜索', '联网搜索', '公开资料', '公开信息', '常识', '据记忆', '模型知识', '未提供', '无来源', '搜索结果',
  'web search', 'common knowledge',
]
// URL/domain fragment: scheme, www., or a bare domain with a common TLD (letters/digits/hyphen label + TLD),
// anywhere in the string (“36kr.com 2025-03 报道” must match on the bare-domain branch, no scheme/www needed).
const URL_FRAGMENT_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|cn|org|net|gov|edu|io|co)\b/i
function isConcreteSource(s) {
  if (!s || typeof s !== 'string') return false
  // Width-insensitive: fold full-width ASCII (Ａ-Ｚ／ａ-ｚ／０-９) down to half-width before every other check,
  // so a blocklist term or URL fragment typed in full-width CJK input method still matches.
  const norm = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim()
  if (!norm) return false
  const low = norm.toLowerCase()
  if (CONCRETE_SOURCE_BLOCKLIST.some((b) => low.includes(b.toLowerCase()))) return false
  if (URL_FRAGMENT_RE.test(norm)) return true
  // No URL: fall back to a length heuristic — a real citation names a specific publication/page/document,
  // which reads longer than a bare hedge (“搜索确认” is 4 chars; “公司官网 about 页” / “36 氪 2021 年报道” both
  // clear 6). Short-circuits false positives from generic short phrases that dodge the blocklist by wording.
  return norm.length >= 6
}
// Render side: pick the marker for an entry e0, returned WITH its leading separator space (or '' when none), so
// every call site is guaranteed the SF-1 space without duplicating the rule. Priority (BLOCKER — confidence must
// round-trip across batches):
//   1. locked (in-memory 用户钦定 cluster) OR a prior entry parsed back as confidence:'user' → 〔用户钦定〕
//   1b. a contested row (fresh or carried): retire to 〔核实〕 ONLY if the hit has two_key===true AND applied (not
//      in `rejected`); otherwise stay 〔同指两解〕. Bare concreteness never retires a contested row.
//   2. a NON-contested row re-verified THIS round (a writing is in resolvedMap) with a CONCRETE source
//      (isConcreteSource) AND actually applied (not name-guard-rejected) → 〔核实·<thisDate>〕 (date omitted when
//      absent); re-verified but source NOT concrete, OR the rename was rejected → 〔待复核〕 instead
//      (machine-assigned provenance guard — see above; a rejected rename is also kept out of the entry body by
//      applyVerifiedEntry, so body and marker never contradict)
//   3. a prior entry parsed back as confidence:'verified' but NOT re-checked this round → its ORIGINAL marker
//      preserved verbatim, original date段 and all (this is what was silently lost before)
//   4. a prior entry parsed back as confidence:'recheck' but NOT re-verified this round → 〔待复核〕 preserved, so
//      next round's excludeVerified still force-re-verifies it (Finding 4: this marker was silently dropped before)
//   5. unknown with no fresh verification → no marker
// contestedMap (optional 4th arg): query→contested item from THIS round's verify. A fresh contested verdict, or a
// prior entry parsed back as confidence:'contested', renders 〔同指两解〕. A contested row may ONLY be retired when
// the fresh resolved hit carries two_key===true (the verify agent attests high-tier source AND context-fit) AND the
// rename was actually APPLIED (not blocked by the name-guard). Bare concreteness — even a real-looking domain — can
// NEVER retire a contested row (the coattail failure). A two_key self-confirmation (canonical === a spoken form) is
// a legitimate retirement toward the literal.
// rejected (optional 5th arg): the Set applyVerifiedEntry populated THIS render pass with the hits it refused
// (contested referent-substitution guard OR the张冠李戴 person name-guard). confidenceMark re-derives the SAME hit
// object from the same names, so `rejected.has(hit)` tells it whether the rename actually landed. This closes the
// contradiction "row body says 未采用/张冠李戴 while marker says 〔核实〕": a rejected hit never yields 〔核实〕 — a
// contested row stays contested, a non-contested row falls to 〔待复核〕. Omitting the arg (direct callers/tests)
// means "nothing was rejected", preserving prior behaviour for hits that were applied.
function confidenceMark(e0, resolvedMap, date, contestedMap, rejected) {
  if (!e0) return ''
  if (e0.locked || e0.confidence === 'user') return ` 〔${CONFIDENCE_USER}〕`
  const names = [e0.canonical, ...(e0.variants || [])]
  const hit = resolvedMap && names.map((n) => resolvedMap.get(n)).find(Boolean)
  const hitRejected = !!(hit && rejected && rejected.has(hit))
  const applied = !!hit && !hitRejected   // the rename actually landed in the entry body this pass
  const verifiedMark = () => (date ? ` 〔${CONFIDENCE_VERIFIED}·${date}〕` : ` 〔${CONFIDENCE_VERIFIED}〕`)
  // Contested row (fresh this round OR carried forward): retire ONLY on a two_key, actually-applied verdict.
  const freshContested = contestedMap && names.map((n) => contestedMap.get(n)).find(Boolean)
  if (freshContested || e0.confidence === 'contested') {
    if (hit && hit.two_key === true && applied) return verifiedMark()   // sanctioned two-key upgrade / self-confirm
    return ` 〔${CONFIDENCE_CONTESTED}〕`                                  // no two_key, or rename rejected → stay contested
  }
  // Non-contested row: a concrete-source hit that actually landed earns 〔核实〕 — a rejected (张冠李戴) hit does not.
  if (hit && isConcreteSource(hit.source) && applied) return verifiedMark()
  if (hit) return ` 〔${CONFIDENCE_RECHECK}〕`   // resolved this round, but not concrete-and-applied — applied?不永久信任
  if (e0.confidence === 'verified') return e0.confidenceDate ? ` 〔${CONFIDENCE_VERIFIED}·${e0.confidenceDate}〕` : ` 〔${CONFIDENCE_VERIFIED}〕`
  // Finding 4: a prior 〔待复核〕 entry with no fresh verification hit this round must RE-EMIT its marker — dropping it
  // (the old behavior) lost the flag excludeVerified relies on to force-re-verify the entry next batch.
  if (e0.confidence === 'recheck') return ` 〔${CONFIDENCE_RECHECK}〕`
  return ''
}
// Parse side: strip a trailing confidence marker off an entry-line RHS, returning the cleaned string plus the
// decoded confidence ('verified'|'user'|'recheck'|'unknown') and, for a verified marker, its original date段
// (confidenceDate, '' when absent) so confidenceMark can re-emit it unchanged next round. Stripping BEFORE the
// ` ｜ ` split keeps variants/hint byte-identical to the pre-marker parse for every old 校对表. The separator
// captured by group 1 is dropped along with the marker (slice stops at its index), so no dangling ` ｜`/space.
function stripConfidence(rhs) {
  const s = String(rhs == null ? '' : rhs)
  const m = s.match(CONFIDENCE_RE)
  if (!m) return { rhs: s, confidence: 'unknown', confidenceDate: '' }
  const conf = m[2] === CONFIDENCE_USER ? 'user'
    : m[2] === CONFIDENCE_RECHECK ? 'recheck'
    : m[2] === CONFIDENCE_CONTESTED ? 'contested'
    : 'verified'
  return { rhs: s.slice(0, m.index).replace(/\s+$/, ''), confidence: conf, confidenceDate: m[3] || '' }
}


// ---------- pure JS merge (no model cost) ----------
// Generic titles / honorifics are “weak keys”: sharing one alone is insufficient to identify the same person.
// In a transcript “王总” may simultaneously refer to the interviewee (politely addressed as 王总) and the
// chairman; “李总 / 老师 / 董事长” follow the same pattern. Chaining clusters on any shared string means a
// single ambiguous honorific would collapse multiple distinct people into one blob.
// Rule: only merge when a “strong name” (real name / product name / term — not a generic title) is shared;
// never merge on weak keys alone. Under-merging is safer than over-merging:
// under-merging leaves two entries and the proofreader resolves them from the source text;
// over-merging writes two different people as one, corrupting the final transcript.
function isWeakKey(s) {
  return /^[一-龥]{1,2}总$/.test(s)            // e.g. 王总, 李总, 欧阳总 (one/two-char surname + 总)
    || /(老师|总监|经理|主管)$/.test(s)
    || /^(董事长|老板|老板娘|总经理|总裁|创始人|CEO|CFO|CTO|COO|PR|嘉宾|记者|主持人|同事|领导)$/.test(s)
}
// The scout sometimes stuffs an identity description into canonical (e.g. “王总（示例公司董事长）”),
// which defeats the `^X总$` pattern in `isWeakKey`. Strip parenthetical annotations before testing
// whether a string is a weak title, exposing the bare honorific.
// Used only in the name guard — does not touch the merge keys inside `clusterEntities`.
const stripDesc = (s) => (s || '').replace(/[（(][^）)]*[）)]/g, '').trim()
// Garbled-scout detection: when the network corrupts the generation stream mid-flight, the scout returns
// structurally valid JSON whose content is gibberish (a long run of rare CJK characters that the schema
// cannot reject), which would pollute the glossary. The signal: legitimate entity names and speaker labels
// are short, and long names are always interrupted by punctuation (e.g. “某集团（…）”); garbled output
// is a run of a dozen or more CJK characters with no punctuation at all.
// Empirically, the longest clean run is ≤ 6; corrupted output reached 41 — threshold set at 16,
// leaving a wide margin on both sides with virtually no false positives.
function longestHanziRun(s) {
  let max = 0, cur = 0
  for (const ch of (s || '')) {
    if (ch >= '一' && ch <= '鿿') { cur++; if (cur > max) max = cur } else cur = 0
  }
  return max
}
function scoutLooksGarbled(f) {
  if (!f) return false
  if (!(f.speakers || []).length) return true   // every interview has at least one speaker; empty = corrupted
  const names = []
  for (const e of [...(f.people || []), ...(f.brands || []), ...(f.terms || [])]) {
    names.push(e.canonical || ''); for (const v of e.variants || []) names.push(v)
  }
  for (const sp of f.speakers || []) names.push(sp.label || '')
  return names.some((n) => longestHanziRun(n) >= 16)
}

// ---------- glossary note (hint) accumulation policy ----------
// A row's note field (the text after ｜) is human-review signal: when the same entity recurs across chunks or
// across cumulative batches, a fresh conflicting note MUST NOT silently overwrite the prior one or be dropped.
// The note is also embedded in refine prompts and is re-parsed + re-merged on every cumulative run, so an
// unbounded append would grow without limit and bloat prompts. Policy: union of DISTINCT clauses (separator
// '；', which stays inside a single ｜-field and never re-splits a row); clauses carrying ⚠ (review flags, and
// the truncation mark itself) are always kept; plain notes are capped at MAX_HINT_NOTES and any overflow is
// flagged with an explicit truncation marker rather than dropped silently. First-N (not last-N) is kept on
// purpose: the leading clause carries the verified-identity tag (applyVerifiedEntry prepends it) and is what the
// condensed refine glossary surfaces via trimHint, so the head is the most valuable note. mergeHints is
// idempotent — mergeHints(x, x) === x, and once a row is truncated the marker stays put on every later merge.
const HINT_SEP = '；'
const MAX_HINT_NOTES = 3
const HINT_TRUNC_MARK = '⚠ 说明较多、已保留前若干条，其余从略——请查阅往次校对表并人工整理'
const HEADERLESS_MARK = '⚠ 原校对表此行缺少分类标题、已按术语暂存——请人工归类'
const hintClauses = (h) => (h == null ? [] : String(h).split(HINT_SEP).map((s) => s.trim()).filter(Boolean))
function mergeHints(a, b) {
  const seen = new Set(); const notes = []; const warns = []; let truncated = false
  for (const p of [...hintClauses(a), ...hintClauses(b)]) {
    if (p === HINT_TRUNC_MARK) { truncated = true; continue }   // recomputed below — never store two markers
    if (seen.has(p)) continue
    seen.add(p)
    if (p.includes('⚠')) warns.push(p); else notes.push(p)
  }
  let kept = notes
  if (notes.length > MAX_HINT_NOTES) { kept = notes.slice(0, MAX_HINT_NOTES); truncated = true }
  return [...kept, ...warns, ...(truncated ? [HINT_TRUNC_MARK] : [])].join(HINT_SEP)
}

// ---------- internal-directory suspicion (飞书 ASR 同事名偏置) ----------
// 飞书/Lark ASR 会把听不清的人名优先写成上传方租户内的同事名（热词表来自企业通讯录）。因此转录里一个与内部
// 通讯录完全同名的人名反而【更可疑】：真实说话对象可能是外部同音他人，被 ASR「吸附」成了同事。通讯录在这里
// 只作【存疑名单】，绝不是白名单或改名依据——命中者置 suspect_asr=true（强制联网核实，哪怕 verify=key），
// 改不改仍由既有的两把钥匙规则裁决。匹配全部在代码里完成：通讯录内容不进任何 prompt、输出或日志，
// 只有转录里本来就出现的名字会被标记。名单文件由宿主本地读取（--internal-directory），不入库。
// hint 措辞刻意只描述 ASR 的失误模式，不断言「此人在我方通讯录里」——hint 会进核实/精校 prompt 与校对表，
// 措辞越少确认名单成员身份越好（残余信号见 README 该节说明）。
const INTERNAL_DIRECTORY_HINT = '⚠ 疑为飞书 ASR 同事名偏置产物（ASR 常把听不清的名字写成文件上传方的同事名），此写法可能是同音他人——须凭上下文与联网证据核实正身，勿仅因像真名而采信'
// 匹配归一化：NFKC 折叠全角/半角，去掉全部空白，拉丁字母不分大小写——「张　三」「ZHANG san」都能对上。
const normalizeDirName = (n) => String(n || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const CJK_RE = /[㐀-鿿]/
function parseInternalDirectory(text) {
  const names = new Set()
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 分号/顿号是【姓名列表】分隔（一行多个名字：「蔡梅梅; 杜静; 龚格」）；tab/逗号/竖线是【列】分隔
    // （姓名后跟部门等列，只取首列）。空格不算任何分隔，否则英文全名（Mary Jane）会被腰斩。
    for (const item of line.split(/[;；、]+/)) {
      let name = item.split(/[\t,，|]+/)[0].trim()
      // 中文条目内若用空格隔开部门或英文别名（「沈其安 市场部」「申远 neil」），姓名取首个空格前的字段；英文条目保留整段。
      if (CJK_RE.test(name)) name = name.split(/\s+/)[0]
      if (name && normalizeDirName(name).length >= 2) names.add(name)
    }
  }
  return Array.from(names)
}
// merged: mergeFindings 输出（people/brands/terms）。就地标记 people 中命中通讯录的条目并返回命中条目数组
// （{canonical, writings}：writings 供 forceReopen 撬开核实缓存，canonical 供日志）。locked（用户钦定）条目跳过
// ——decree 是明确的人工指令，终局（README 记载此例外）。hint 追加走 mergeHints（幂等，⚠ 子句永不被截断），
// 累积批次里 parse→render 往返也不会重复膨胀。只查 people：品牌/术语不受同事名偏置影响。
function applyInternalDirectorySuspicion(merged, dirNames) {
  const dir = new Set((dirNames || []).map((n) => normalizeDirName(stripDesc(String(n)))).filter(Boolean))
  if (!dir.size) return []
  const matched = []
  for (const e of (merged && merged.people) || []) {
    if (!e || e.locked) continue
    const forms = [e.canonical, ...(e.variants || [])].map((n) => stripDesc(String(n || ''))).filter(Boolean)
    if (!forms.some((n) => dir.has(normalizeDirName(n)))) continue
    e.suspect_asr = true
    e.hint = mergeHints(e.hint, INTERNAL_DIRECTORY_HINT)
    matched.push({ canonical: e.canonical, writings: forms })
  }
  return matched
}
// 侦察漏网补扫：通讯录名字若在源文本里出现、却没进侦察的 people 清单（侦察分块失败/漏抽/只当成说话人标签），
// 逐字扫描把它找回来。中文名用子串匹配（≥2 字全名撞进别的词的概率低，误报的代价只是多一次核实）；
// 拉丁名要求词边界、不分大小写。excludeForms 传已在 people 里的全部写法，避免重复注入。纯函数，宿主读文件。
function scanTextForDirectoryNames(text, dirNames, excludeForms) {
  const t = String(text || '')
  if (!t) return []
  const tNorm = t.normalize('NFKC').toLowerCase()
  const seen = new Set((excludeForms || []).map((n) => normalizeDirName(stripDesc(String(n)))))
  const out = []
  for (const name of dirNames || []) {
    const key = normalizeDirName(name)
    if (!key || seen.has(key)) continue
    let hit
    if (CJK_RE.test(name)) hit = t.includes(name) || tNorm.includes(key)
    else hit = new RegExp(`(?<![A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i').test(t)
    if (hit) { seen.add(key); out.push(name) }
  }
  return out
}

function clusterEntities(entries) {
  const clusters = []
  for (const e of entries) {
    const names = [e.canonical].concat(e.variants || []).map((s) => (s || '').trim()).filter(Boolean)
    if (!names.length) continue
    const strong = names.filter((n) => !isWeakKey(n))
    let home = null
    for (const c of clusters) {
      if (strong.some((n) => c.strong.has(n))) { home = c; break }
    }
    if (!home) { home = { names: new Set(), strong: new Set(), entries: [] }; clusters.push(home) }
    names.forEach((n) => home.names.add(n))
    strong.forEach((n) => home.strong.add(n))
    home.entries.push(e)
  }
  return clusters.map((c) => {
    const counts = {}
    // vote using trimmed canonicals, skipping empty/whitespace-only values —
    // otherwise an empty canonical could be elected as cluster representative and render as an empty **bold** span
    for (const e of c.entries) { const k = (e.canonical || '').trim(); if (k) counts[k] = (counts[k] || 0) + 1 }
    // fallback: if every canonical in the cluster is empty, use the first non-empty strong name (or any name)
    const canonical = Object.keys(counts).sort((x, y) => counts[y] - counts[x] || y.length - x.length)[0]
      || Array.from(c.names)[0] || ''
    const variants = Array.from(c.names).filter((n) => n !== canonical)
    // Fold every entry's note through the bounded-union policy. Was a silent `.slice(0, 2)`, which truncated a
    // 3rd+ distinct note without a trace; mergeHints dedups, always keeps ⚠ flags, caps plain notes, and marks
    // overflow explicitly so a many-note conflict surfaces for human review instead of vanishing.
    const hint = c.entries.map((e) => e.hint).filter(Boolean).reduce((acc, h) => mergeHints(acc, h), '')
    const files = Array.from(new Set(c.entries.map((e) => e.file)))
    return {
      canonical,
      variants,
      hint,
      files,
      public_figure: c.entries.some((e) => e.public_figure),
      suspect_asr: c.entries.some((e) => e.suspect_asr),   // any scout flagged it a likely ASR mishear → force verify
      category: c.entries.map((e) => e.category || e.domain).find(Boolean) || '',
      crossFile: files.length > 1,
    }
  })
}

function mergeFindings(findings, files) {
  const tag = (arr, file) => (arr || []).map((e) => Object.assign({ file }, e))
  let people = []
  let brands = []
  let terms = []
  const speakersByFile = []
  const errors = []
  const notes = []
  findings.forEach((fd, i) => {
    if (!fd) return
    const label = files[i].label
    people = people.concat(tag(fd.people, label))
    brands = brands.concat(tag(fd.brands, label))
    terms = terms.concat(tag(fd.terms, label))
    speakersByFile.push({ label, speakers: fd.speakers || [] })
    for (const er of fd.errors || []) { if (er) errors.push({ file: label, kind: er.kind || '其他', examples: er.examples || [] }) }
    for (const n of fd.special_notes || []) notes.push(`[${label}] ${n}`)
  })
  return {
    people: clusterEntities(people),
    brands: clusterEntities(brands),
    terms: clusterEntities(terms),
    speakersByFile,
    errors,
    notes,
  }
}

// Verification list chunking (no worthy entities dropped): stuffing too many items into a single verify agent
// causes it to look up each one serially over the network, slowing the whole round
// (observed: 30 items in one batch ≈ 30 serial lookups ~10 min; in earlier runs 90+ items caused repeated
// timeout retries, ~35 min). The root cause is single-agent overload — chunking and parallelising,
// with ≤ VERIFY_CHUNK per chunk, serial within a chunk and concurrent across chunks, avoids overload
// without dropping any worthy entry.
// Small chunk size (12): verification is network-round-trip-intensive; smaller chunks maximise parallelism,
// amortising lookup latency (~30 items → 3 concurrent chunks, verify phase drops from ~10 min to ~3–4 min).
// Larger chunks save no tokens but serialise longer. The cost is a few extra Sonnet agents (cheap and parallel),
// subject to ≤ concurrency limit min(16, cpu_count-2) to avoid queuing.
// key (default): only send “worthy” entities — public figures / cross-file corroboration / variant confusion (≥ 2 variants);
// low-priority internal terms with w=0 are excluded (the proofreader normalises them from the source; logged).
// deep: send everything. Both modes sort by weight before chunking; MAX_CHUNKS×CHUNK=144 is a runaway guard,
// large enough to cover the ~95 items observed in practice for deep mode.
const VERIFY_CHUNK = 12
const MAX_CHUNKS = 12
const entityWorth = (e) => (e.public_figure ? 4 : 0) + (e.crossFile ? 2 : 0) + ((e.variants || []).length >= 2 ? 1 : 0)
function verifyChunks(merged, depth) {
  const row = (e) => `- ${e.canonical} ← ${e.variants.join(' / ') || '（无变体）'} ｜ ${e.hint || ''}${e.public_figure ? ' ｜ 公众人物' : ''}${e.suspect_asr ? ' ｜ ⚠侦察疑为转录误写、请优先核实正确写法' : ''}`
  const tagged = []
  for (const [sec, list] of [['人名', merged.people], ['品牌/公司/产品', merged.brands], ['术语', merged.terms]]) {
    for (const e of list) tagged.push({ sec, e, w: entityWorth(e) })
  }
  // key mode normally sends only worth>0, but a consistently mis-heard name has no variants and may not be a
  // public figure → worth 0 → it would be skipped exactly when it's a silent ASR error. So always include
  // scout-flagged suspects regardless of worth (this is what closes the consistently-mis-heard-name gap).
  const eligible = (depth === 'deep' ? tagged.slice() : tagged.filter((t) => t.w > 0 || t.e.suspect_asr)).sort((a, b) => b.w - a.w)
  const excluded = tagged.length - eligible.length
  let pool = eligible
  let overflow = 0
  if (eligible.length > VERIFY_CHUNK * MAX_CHUNKS) { pool = eligible.slice(0, VERIFY_CHUNK * MAX_CHUNKS); overflow = eligible.length - pool.length }
  const chunks = []
  for (let i = 0; i < pool.length; i += VERIFY_CHUNK) {
    const slice = pool.slice(i, i + VERIFY_CHUNK)
    const lines = []
    for (const s of ['人名', '品牌/公司/产品', '术语']) {
      const rows = slice.filter((t) => t.sec === s)
      if (rows.length) lines.push(`【${s}】`, ...rows.map((t) => row(t.e)))
    }
    chunks.push(lines.join('\n'))
  }
  return { chunks, eligible: pool.length, excluded, overflow }
}

// Input to the dedup agent: the full entity list (including w=0 low-salience entries — homophones and
// co-referents most often hide here), with category and source file, for semantic co-reference checking.
function dedupListText(merged) {
  const lines = []
  for (const [kind, list] of [['person', merged.people], ['brand', merged.brands], ['term', merged.terms]]) {
    for (const e of list) lines.push(`- [${kind}] ${e.canonical} ← ${e.variants.join(' / ') || '（无变体）'} ｜ ${e.hint || ''} ｜ 出处：${(e.files || []).join('、')}`)
  }
  return lines.join('\n')
}


// ---------- chunked refine for large transcripts ----------
// A single refine agent on a long transcript is both the wall-clock long pole AND prone to
// over-compression (one agent squeezes the whole file into a single output budget → it summarizes,
// the claude.ai-style failure). Splitting a large file into K contiguous line-range chunks refined by
// K parallel agents fixes both: ~K× faster on the refine phase, and each agent has a bounded span so
// nothing gets compressed. Safe because refine is LOCAL — each turn is cleaned against the shared
// glossary, with no whole-file dependency (unlike summary/timeline/logic, which must see everything).
//
// The script can't read the transcript (the Workflow sandbox has no fs; raw text never enters the
// orchestration layer), so the split is computed from line metadata only, and chunk OWNERSHIP is a
// deterministic shared rule the agents follow: a speaker turn belongs to whichever chunk's line span
// contains the turn's opening label line — no overlap, no gap. Parts are written to
// <outPath>.part{idx} and merged by a cheap stitch agent (the script can't concat files either).
// Refine chunking has TWO independent drivers, unified in splitForRefine:
//  1. SPEED (opt-in, A.chunkMode === 'speed'): a coarse batch-speed lever for a strong model. The per-chunk
//     overhead (each chunk agent re-thinks + re-ingests RULES) is an intrinsic ~1.5× token premium, so the user
//     opts in per run (SKILL.md Step 0 asks speed-vs-cost). CONSERVATIVE — only large files, at most 2 chunks —
//     a balanced ~35% refine speedup for ~1.5× tokens.
//  2. BUDGET (automatic, faithfulness): a weaker-but-cheaper model silently compresses a long transcript into a
//     summary past its faithful length. When the model actually assigned to refine declares a per-model budget
//     (engines/providers.js refineCharBudget; passed in as `budget`), any file over it is auto-split BELOW that
//     length so retention stays healthy. No flag; keyed on the resolved model, so Anthropic (no budget) is
//     unchanged. Chunks are as LARGE as safely possible (target = budget), never fine-diced — an old experiment
//     showed 4K-字 chunks fragment sub-headings; big chunks avoid that. Count is UNCAPPED (split as many times as
//     the file needs), because each chunk still stays ≈ budget-sized.
// When both apply, the chunk count is the LARGER of the two. A.chunkMode === 'off' disables ALL chunking
// (including auto) — the escape hatch. Unset budget + non-speed mode ⇒ one agent, exactly as before.
// Document length is measured in 正文字数 (content chars: 汉字 + each English word/number run = 1),
// NEVER in lines — line count is a poor proxy (timestamp lines, short ASR turns inflate it; one transcript
// ran 13.9 字/line). Chunking decisions key on this metric.
// See [[feedback-size-metric]]. Read-tool pagination stays line-addressed (readPlan) because Read is
// line-based — that's a mechanic, not a size judgment.
function contentLength(text) {
  const t = String(text || '')
  return (t.match(/[一-龥]/g) || []).length + (t.match(/[A-Za-z0-9]+/g) || []).length
}
// Effective 字数 for routing: prefer the precomputed f.chars (from pre-flight); else estimate from
// bytes (CJK UTF-8 ≈ 3 B/char, mixed ≈ 2.6) or, last resort, lines (~14 正文字/line).
function refineSize(f) {
  if (f && typeof f.chars === 'number') return f.chars
  if (f && f.bytes) return Math.round(f.bytes / 2.6)
  return Math.round(((f && f.lines) || 0) * 14)
}
// Subscription runtimes retain a speaker-gated short-file fast path; Universal supplies host capabilities and
// always takes the full staged path. Callers must never bypass Scout while speaker resolution is still needed.
const ONE_PASS_CHARS = 4000

// ---------- single-shot refine (M11a) ----------
// Single-shot mode builds ONE request per file: the prompt INLINES the full source text and the response text
// IS the refined document (no Read/Write/Edit tool loop, no structured_output). It's the byte-for-byte editorial
// contract of a normal refine, just delivered in one turn — cheaper/faster for archival bulk, and the natural
// unit for the Anthropic Batch API (one request = one file). Its known historical failure is silent compression
// (one agent squeezing a whole file into one output budget → it summarizes — the claude.ai-style failure), so
// the deterministic source-aware audit gates run UNCHANGED afterward as the safety net.
// SIZE GATE: refuse files over SINGLE_SHOT_MAX_CHARS. A refined transcript is ≈ the source 字数 (near-lossless,
// light compression), and Chinese output runs ≈ 1.6-2.0 tokens/字, so the response for a 45K-字 file needs
// ~72-90K output tokens — right at the opus/fable 96K ceiling (maxTokensFor). Bigger files can't fit their
// output under the cap → truncation-prone → route them to agentic mode (multi-write, no per-response cap).
const SINGLE_SHOT_MAX_CHARS = 45000
// max_tokens formula: ceil(sourceChars × TOK_PER_CHAR) + FLOOR_SLACK, clamped to [MIN, opus/fable ceiling].
// TOK_PER_CHAR = 2.2 covers ~2.0 tok/字 of near-lossless refined output plus adaptive-thinking headroom (thinking
// counts toward max_tokens); FLOOR_SLACK guarantees room for 抬头/小标题 on a tiny file; the 96000 cap is the
// opus/fable output ceiling (maxTokensFor), and is exactly why the size gate sits at 45000 (45000×2.2+2048 ≈
// 101K clamps to 96K — a file that big would have its tail silently cut). Pure + exported so tests pin the curve.
const SINGLE_SHOT_TOK_PER_CHAR = 2.2
const SINGLE_SHOT_TOK_FLOOR = 2048
const SINGLE_SHOT_TOK_MIN = 8000
const SINGLE_SHOT_TOK_CEILING = 96000
function singleShotMaxTokens(sourceChars) {
  const n = Math.max(0, Math.round(Number(sourceChars) || 0))
  const want = Math.ceil(n * SINGLE_SHOT_TOK_PER_CHAR) + SINGLE_SHOT_TOK_FLOOR
  return Math.min(SINGLE_SHOT_TOK_CEILING, Math.max(SINGLE_SHOT_TOK_MIN, want))
}

const REFINE_CHUNK_CHARS = 12000     // speed mode: only files over this many 正文字数 chunk
const TARGET_CHUNK_CHARS = 9000      // aim for ~this many 正文字数 per chunk
const MAX_SPEED_REFINE_CHUNKS = 2    // conservative cap for SPEED mode only — a coarse batch lever, not a limit on provider-budget chunks
const singleChunk = (f) => {
  const lines = (f && f.lines) || 0
  return [{ idx: 1, count: 1, startLine: 1, endLine: lines, isFirst: true, isLast: true, label: f && f.label }]
}
// Even-line division into K chunks. The agent ownership rule (refinePrompt / scoutPrompt chunk branch) keeps
// each speaker turn whole, so a turn is never split across chunks even though the line boundary is approximate.
function evenLineChunks(f, K) {
  const lines = (f && f.lines) || 0
  const label = f && f.label
  const per = Math.ceil(lines / K)
  const chunks = []
  for (let i = 0; i < K; i += 1) {
    const startLine = i * per + 1
    if (startLine > lines) break // rounding can leave the final slice empty; drop it
    chunks.push({ idx: chunks.length + 1, count: 0, startLine, endLine: Math.min(lines, (i + 1) * per), isFirst: i === 0, isLast: false, label })
  }
  const last = chunks[chunks.length - 1]
  last.endLine = lines // absorb any rounding remainder into the final chunk
  last.isLast = true
  for (const c of chunks) c.count = chunks.length // count reflects ACTUAL chunks (a slice may have been dropped)
  return chunks
}
// ---------- turn-boundary quality: never orphan a question from its answer ----------
// A speaker turn opens with a label line (「名字：」/「记者：」/「张三：」 — same shape as the audit's ATTR_LABEL_RE),
// so a "turn boundary" is the line before the next label line. parseTurns walks the raw source once and returns one
// entry per turn: its 1-based opening line and whether the turn's VISIBLE text ends with a question mark. Used by the
// preflight (universal jobs.prepareFile) to attach f.turns so the orchestrator can snap chunk boundaries to real
// turns AND avoid ending a chunk on a question (see turnAwareChunks). Editions with no fs (the CC Workflow sandbox)
// simply don't populate f.turns → splitForRefine falls back to evenLineChunks, byte-identical to before.
// A turn "ends with a question" if — after stripping trailing whitespace, closing quotes/brackets, and any trailing
// HTML-comment provenance marker (<!-- 源 L… -->) — the last visible glyph is ？ or ?. This is what lets us keep a
// question glued to the answer that follows it. Pure + exported so the rule is unit-testable in isolation.
function endsWithQuestion(text) {
  let t = String(text == null ? '' : text)
  let prev
  do {
    prev = t
    t = t.replace(/<!--[\s\S]*?-->\s*$/, '')            // trailing 溯源 HTML comment marker
    t = t.replace(/[\s"'’”`」』）)】〕》\]}]+$/, '')      // trailing whitespace / closing quotes / brackets
  } while (t !== prev)
  return /[？?]$/.test(t)
}
function parseTurns(content) {
  return parseSpeakerDocument(content).units.map((unit) => ({
    startLine: unit.startLine,
    q: endsWithQuestion(unit.text),
  }))
}
// Split a file into K chunks whose boundaries land on real turn edges, then move any boundary that would END a chunk
// on a question to a nearby non-question turn boundary. Only reached when f.turns is present and has ≥ K turns;
// otherwise splitForRefine keeps the line-based evenLineChunks divider (unchanged). Returns the same chunk shape
// {idx,count,startLine,endLine,isFirst,isLast,label}, contiguous over [1, lines].
function turnAwareChunks(f, K) {
  const lines = (f && f.lines) || 0
  const label = f && f.label
  const turns = f.turns
  const n = turns.length
  // Boundary AFTER turn j (j in [0, n-2]) ends a chunk at the line just before turn j+1's label line.
  const endLineOf = (j) => (j >= n - 1 ? lines : Math.min(lines, turns[j + 1].startLine - 1))
  const cuts = []   // cuts[i] = index of the LAST turn of chunk i (i = 0 .. K-2 internal boundaries)
  for (let i = 1; i < K; i += 1) {
    // Nominal: the turn boundary NEAREST the even split line (earlier turn wins ties → slightly smaller chunk).
    const target = Math.round((i * lines) / K)
    let best = 0, bestD = Infinity
    for (let j = 0; j <= n - 2; j += 1) { const d = Math.abs(endLineOf(j) - target); if (d < bestD) { bestD = d; best = j } }
    cuts.push(best)
  }
  // One left→right pass: clamp each boundary to a strictly-increasing, room-preserving range, then apply the
  // question rule. lo keeps this chunk non-empty (past the previous boundary); hi reserves one turn for every later
  // chunk. Prefer the nearest EARLIER non-question boundary (smaller chunk); if none in range, fall FORWARD; if the
  // whole range is questions (pathological all-questions text), keep the nominal boundary rather than merge chunks.
  for (let i = 0; i < cuts.length; i += 1) {
    const lo = (i === 0) ? 0 : cuts[i - 1] + 1
    const hi = (n - 2) - (cuts.length - 1 - i)
    let j = Math.max(lo, Math.min(cuts[i], hi))
    if (turns[j].q) {
      let found = -1
      for (let k = j - 1; k >= lo; k -= 1) if (!turns[k].q) { found = k; break }
      if (found < 0) for (let k = j + 1; k <= hi; k += 1) if (!turns[k].q) { found = k; break }
      if (found >= 0) j = found
    }
    cuts[i] = j
  }
  const chunks = []
  let prevEnd = 0
  for (let i = 0; i < K; i += 1) {
    const startLine = (i === 0) ? 1 : prevEnd + 1
    const endLine = (i === K - 1) ? lines : endLineOf(cuts[i])
    chunks.push({ idx: i + 1, count: K, startLine, endLine, isFirst: i === 0, isLast: i === K - 1, label })
    prevEnd = endLine
  }
  return chunks
}
// Route K (>1) chunks through the turn-aware divider when the preflight supplied usable turns, else the line divider.
const dividedChunks = (f, K) => ((f && Array.isArray(f.turns) && f.turns.length >= K && f.turns.length >= 2)
  ? turnAwareChunks(f, K)
  : evenLineChunks(f, K))
// N-way balanced split at speaker-turn boundaries. `mode` is 'speed' | 'off' | undefined (cost); `budget` is the
// resolved model's faithful-refine 字数 cap (undefined = none); `chunkSize` is the explicit --chunk-size experiment
// knob (正文字数/块, undefined = none). Returns 1 chunk (singleChunk) unless a driver fires. Drivers feed the SAME
// divider (turn-aware when f.turns is present, else line-based), so whole turns stay intact and sizes are balanced.
// Precedence: 'off' forces one agent; else an explicit chunkSize OVERRIDES both budget and speed (K = ceil(字数/N));
// else K = max(speed count, budget count).
function splitForRefine(f, mode, budget, chunkSize) {
  const lines = (f && f.lines) || 0
  const size = refineSize(f)                 // 字数, not lines
  if (mode === 'off' || lines <= 1) return singleChunk(f)   // escape hatch, or unsplittable → one agent
  let K
  if (typeof chunkSize === 'number' && chunkSize > 0) {
    // Explicit experiment knob: exactly ceil(字数/N) balanced chunks, ignoring the provider budget and speed cap.
    K = Math.max(1, Math.ceil(size / chunkSize))
  } else {
    // Speed: opt-in coarse lever — only large files, capped at MAX_SPEED_REFINE_CHUNKS.
    const speedK = (mode === 'speed' && size > REFINE_CHUNK_CHARS)
      ? Math.min(MAX_SPEED_REFINE_CHUNKS, Math.max(2, Math.ceil(size / TARGET_CHUNK_CHARS)))
      : 1
    // Budget: automatic faithfulness cap — target chunk ≈ budget, count UNCAPPED (chunks stay large, never diced).
    const budgetK = (typeof budget === 'number' && budget > 0 && size > budget)
      ? Math.max(2, Math.ceil(size / budget))
      : 1
    K = Math.max(speedK, budgetK)
  }
  return K <= 1 ? singleChunk(f) : dividedChunks(f, K)   // no driver fired → cost mode (default) → one agent
}

// Scout chunking is a RESILIENCE measure, not a speed lever: a single scout agent over an oversized merged
// file (a ~50K-字 merge was observed to stall) chokes the same way refine does. So the scout ALWAYS chunks
// past SCOUT_CHUNK_CHARS — no chunkMode gate (unlike refine, which is opt-in because Opus fan-out is costly;
// scout is haiku, so K cheap agents beat one stalled one). Each chunk scouts its own line span; mergeScoutChunks
// unions the per-chunk findings back into one per-file finding, leaving the rest of the pipeline unchanged.
const SCOUT_CHUNK_CHARS = 40000         // a normal 2h interview (~20–40K 字) stays one agent; only oversized merges chunk
const TARGET_SCOUT_CHUNK_CHARS = 20000  // aim ~this many 字/段 — comfortably inside one haiku scout's budget
const MAX_SCOUT_CHUNKS = 6              // runaway guard (6×20K ≈ 120K 字 covers very large merges)
function splitForScout(f) {
  const lines = (f && f.lines) || 0
  const size = refineSize(f)
  if (size <= SCOUT_CHUNK_CHARS || lines <= 1) return singleChunk(f)   // normal file → one scout agent (path unchanged)
  const K = Math.min(MAX_SCOUT_CHUNKS, Math.max(2, Math.ceil(size / TARGET_SCOUT_CHUNK_CHARS)))
  return evenLineChunks(f, K)
}

// Merge K per-chunk scout findings of ONE file back into a single SCOUT_SCHEMA-shaped finding. Lists are
// unioned (people/brands/terms left to the downstream cross-file clusterEntities to dedup, exactly as
// same-referent entries from different files are); ending_anchor is taken from the chunk that actually saw
// the file's end (largest line) and DROPPED if the best anchor falls well short of the file — that means the
// last chunk's scout didn't return, so refine/check should read the real tail themselves (they handle a
// missing anchor). Returns null only if EVERY chunk failed; a partial set still yields a usable glossary.
function mergeScoutChunks(parts, f) {
  const got = (parts || []).filter(Boolean)
  if (!got.length) return null
  const speakers = []; const speakerIndex = new Map()
  const speakerKey = (value) => {
    const label = String(value || '').normalize('NFKC').trim()
    const generic = label.match(/^(?:发言人|说话人|讲者|讲话人|Speaker)\s*([0-9一二三四五六七八九十]+)$/iu)
    return generic ? `generic:${generic[1]}` : label
  }
  const ROLE_OUTPUT_RE = /^(?:记者|采访者|访谈者|提问者|主持人|受访者|嘉宾|回答者|主讲人|PR|公关|同事|协调)$/iu
  const speakerScore = (speaker) => {
    const output = String((speaker && speaker.output_label) || '').trim()
    const identity = String((speaker && speaker.identity) || '').trim()
    const role = String((speaker && speaker.role) || '').trim()
    const confident = speaker && speaker.output_label_confidence === 'high' && String(speaker.output_label_evidence || '').trim()
    return (confident && output && !ROLE_OUTPUT_RE.test(output) ? 20 : 0) + (confident && identity ? 10 : 0) + (output ? 4 : 0) + (role ? 2 : 0)
  }
  // A high-confidence person name for a track: only these can conflict. Role outputs (记者/受访者…)
  // never name a person, so they keep competing on score alone. effectiveScoutPersonName is the same
  // interpretation the resolver uses to pick the final name (output_label first, identity second), so a
  // disagreement on EITHER naming path is caught. Comparison strips inner whitespace so “张三” and
  // “张 三” read as the same person, not a contradiction.
  const confidentName = (speaker) => String(effectiveScoutPersonName(speaker) || '').replace(/\s+/gu, '')
  const conflicted = new Set()
  const conflictNotes = []
  for (const p of got) for (const s of p.speakers || []) {
    const k = speakerKey(s && s.label)
    if (!k) continue
    if (!speakerIndex.has(k)) {
      speakerIndex.set(k, speakers.length)
      speakers.push(s)
      continue
    }
    const i = speakerIndex.get(k)
    if (conflicted.has(k)) {
      // The name stays dropped, but a later chunk may still contribute the role the demoted record
      // lacks — roles are the safe fallback display, so backfilling one cannot re-name the track.
      const role = String((s && s.role) || '').trim()
      if (role && !String(speakers[i].role || '').trim()) speakers[i] = { ...speakers[i], role }
      continue
    }
    const kept = speakers[i]
    const keptName = confidentName(kept)
    const newName = confidentName(s)
    // Two chunks naming the same source track as different people is a disagreement, not a ranking
    // problem: silently keeping either name risks publishing the wrong person. Drop the automatic
    // name, keep the numbered source label, and surface the conflict for a human.
    if (keptName && newName && keptName !== newName) {
      const base = speakerScore(s) > speakerScore(kept) ? { ...s, label: kept.label } : kept
      // name_conflict travels with the record so the resolver can refuse person names for this track
      // even when a stray alias record (person-name label + sample pointing here) outscores it.
      speakers[i] = { ...base, output_label: '', output_label_confidence: 'low', output_label_evidence: '', identity: '', name_conflict: true }
      conflicted.add(k)
      conflictNotes.push(`分段侦察对“${kept.label}”给出相互矛盾的高置信姓名（“${keptName}”与“${newName}”），已放弃自动命名，保留原始标签待人工确认。`)
      continue
    }
    if (speakerScore(s) > speakerScore(kept)) speakers[i] = { ...s, label: kept.label }
  }
  const cat = (key) => got.flatMap((p) => p[key] || [])
  const errByKind = {}
  for (const p of got) for (const er of p.errors || []) {
    if (!er) continue
    const k = er.kind || '其他'
    if (!errByKind[k]) errByKind[k] = { kind: k, examples: [] }
    for (const ex of er.examples || []) if (!errByKind[k].examples.includes(ex)) errByKind[k].examples.push(ex)
  }
  const uniq = (key) => { const out = []; const seen = new Set(); for (const p of got) for (const v of p[key] || []) { const s = String(v).trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s) } } return out }
  let ending = null
  for (const p of got) { const a = p.ending_anchor; if (a && typeof a.line === 'number' && (!ending || a.line >= ending.line)) ending = a }
  const total = (f && f.lines) || 0
  if (ending && total && ending.line < total * 0.9) ending = null   // last chunk missing → unknown ending; let refine/check read the tail
  return {
    speakers,
    people: cat('people'),
    brands: cat('brands'),
    terms: cat('terms'),
    errors: Object.values(errByKind),
    themes: uniq('themes'),
    has_existing_headings: got.some((p) => p.has_existing_headings),
    ending_anchor: ending || {},
    special_notes: [...uniq('special_notes'), ...conflictNotes],
  }
}
const partPath = (outPath, idx) => `${outPath}.part${idx}`

// Deterministic part-merge used by the Concat file tool (engines/fileops.js) and by tests:
// join chunk part-files in order into one transcript. Pure string op (no fs) so it's portable and
// testable. Each part's trailing whitespace is trimmed and parts are separated by exactly one blank
// line. Besides an exact-duplicate `##` heading, remove only a HIGH-CONFIDENCE duplicated prose block at
// the seam: same speaker (when labelled), >=60 normalized chars, and either containment at near-equal length
// or >=0.92 bigram Dice similarity. Short/common replies are deliberately never deduplicated.
function seamNorm(text) {
  return String(text || '')
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*[一-龥A-Za-z0-9·]{1,16}[：:]\s*/, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function seamSpeaker(text) {
  const parsed = parseSpeakerDocument(text)
  return parsed.speakerMode === 'tracked' && parsed.labels.length ? parsed.labels[0].label : null
}

function bigramDice(a, b) {
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i + 1 < s.length; i += 1) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ga = grams(a), gb = grams(b)
  let overlap = 0
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0)
  const total = Array.from(ga.values()).reduce((s, n) => s + n, 0) + Array.from(gb.values()).reduce((s, n) => s + n, 0)
  return total ? (2 * overlap) / total : 0
}

function h2Key(line) {
  const m = String(line || '').match(/^\s*##\s+(.+?)\s*$/)
  if (!m) return null
  return m[1].normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function proseRanges(lines, start, end) {
  const out = []
  let i = start
  while (i < end) {
    while (i < end && (!lines[i].trim() || /^\s*<!--/.test(lines[i]))) i += 1
    if (i >= end || /^\s*#{1,6}\s+/.test(lines[i])) { i += 1; continue }
    const from = i
    while (i < end && lines[i].trim() && !/^\s*#{1,6}\s+/.test(lines[i])) i += 1
    if (i > from) out.push({ start: from, end: i, text: lines.slice(from, i).join('\n') })
  }
  return out
}

// A chunked model sometimes reopens the same topic with typography-only differences
// (`2026 年 agent` / `2026年agent`) or repeats the exact heading. When two consecutive H2 sections
// normalize to the same key, keep one heading and all substantive content. If the boundary also replays the
// exact same speaker paragraph, remove only that repeated copy. Different-speaker or paraphrased prose stays.
function collapseAdjacentDuplicateHeadings(text) {
  const source = String(text || '')
  const trailingNewline = /\n$/.test(source)
  const lines = source.split(/\r?\n/)
  const headings = []
  for (let i = 0; i < lines.length; i += 1) {
    const key = h2Key(lines[i])
    if (key) headings.push({ index: i, key })
  }
  const remove = new Set()
  let removedHeadings = 0
  let removedBlocks = 0
  for (let i = 1; i < headings.length; i += 1) {
    const prev = headings[i - 1]
    const curr = headings[i]
    if (!curr.key || curr.key !== prev.key) continue
    remove.add(curr.index)
    removedHeadings += 1

    const before = proseRanges(lines, prev.index + 1, curr.index)
    const nextHeading = headings[i + 1] ? headings[i + 1].index : lines.length
    const after = proseRanges(lines, curr.index + 1, nextHeading)
    const left = before.at(-1), right = after[0]
    if (!left || !right) continue
    const a = seamNorm(left.text), b = seamNorm(right.text)
    const sa = seamSpeaker(left.text), sb = seamSpeaker(right.text)
    if (a.length >= 20 && a === b && (!sa || !sb || sa === sb)) {
      for (let n = right.start; n < right.end; n += 1) remove.add(n)
      removedBlocks += 1
    }
  }
  if (!remove.size) return { text: source, removedHeadings: 0, removedBlocks: 0 }
  const result = lines.filter((_, i) => !remove.has(i)).join('\n').replace(/\n{3,}/g, '\n\n')
  return { text: result.replace(/\s+$/, '') + (trailingNewline ? '\n' : ''), removedHeadings, removedBlocks }
}

function isDuplicateSeamBlock(left, right) {
  const a = seamNorm(left), b = seamNorm(right)
  if (Math.min(a.length, b.length) < 60) return false
  const sa = seamSpeaker(left), sb = seamSpeaker(right)
  if (sa && sb && sa !== sb) return false
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length)
  if (ratio < 0.82) return false
  if (a.includes(b) || b.includes(a)) return true
  return bigramDice(a, b) >= 0.88
}

function findDuplicateSeamPrefix(left, right, max = 4) {
  const leftBlocks = String(left || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).filter((x) => !/^#{1,6}\s/.test(x))
  const rightBlocks = String(right || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)
  const rightProse = rightBlocks.map((x, i) => /^#{1,6}\s/.test(x) ? -1 : i).filter((i) => i >= 0)
  if (!leftBlocks.length || !rightProse.length) return null

  // A repeated seam can span several turns: part N ends with A→B→C while part N+1 starts by restating
  // A→B→C. Comparing only C with A misses the whole duplicate (the UGround replay failure). Search a small,
  // bounded suffix/prefix window and remove the highest-confidence matching prefix as one unit. Heading blocks
  // are preserved; only prose blocks at the beginning of the new part are eligible for deletion.
  let best = null
  for (let lc = 1; lc <= Math.min(max, leftBlocks.length); lc += 1) {
    const leftSeq = leftBlocks.slice(-lc).join('\n\n')
    for (let rc = 1; rc <= Math.min(max, rightProse.length); rc += 1) {
      const indices = rightProse.slice(0, rc)
      const rightSeq = indices.map((i) => rightBlocks[i]).join('\n\n')
      if (!isDuplicateSeamBlock(leftSeq, rightSeq)) continue
      const a = seamNorm(leftSeq), b = seamNorm(rightSeq)
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length)
      // Prefer the tightest semantic fit, not simply the longest match. Otherwise an exact six-block replay
      // followed by one NEW short question can look like a seven-block containment match and the new question
      // gets deleted. Length fit + containment/Dice makes the exact replay win while retaining paraphrase support.
      const quality = ratio + ((a.includes(b) || b.includes(a)) ? 1 : bigramDice(a, b))
      const score = Math.min(a.length, b.length)
      if (!best || quality > best.quality || (quality === best.quality && score > best.score)) best = { quality, score, indices }
    }
  }
  return best ? { ...best, rightBlocks } : null
}

function stripDuplicateSeamPrefix(left, right, max = 4) {
  const match = findDuplicateSeamPrefix(left, right, max)
  if (!match) return { text: right, removedBlocks: 0 }
  const rightBlocks = match.rightBlocks.slice()
  const removedBlocks = match.indices.length
  for (const i of match.indices.slice().sort((a, b) => b - a)) rightBlocks.splice(i, 1)
  return { text: rightBlocks.join('\n\n'), removedBlocks }
}

// Merge plus a post-merge seam audit. The normal four-block pass preserves the historical conservative cleanup.
// If an unusually long replay remains, one deterministic eight-block repair is allowed, then a wider final scan
// records (but does not hide) any still-duplicated seam. The caller can block derivatives on `seamDuplicates`
// while still delivering the body for review.
function stitchPartsWithReport(texts) {
  const parts = (texts || []).map((t) => String(t == null ? '' : t).replace(/\s+$/, '')).filter((t) => t.length)
  if (!parts.length) return { text: '', seamRepairs: [], seamDuplicates: [] }
  let out = parts[0]
  const seamRepairs = []
  const seamDuplicates = []
  for (let i = 1; i < parts.length; i += 1) {
    let next = parts[i]
    const prevLast = out.slice(out.lastIndexOf('\n') + 1).trim()
    const nextFirst = (next.split('\n')[0] || '').trim()
    if (prevLast.startsWith('## ') && prevLast === nextFirst) {
      next = next.split('\n').slice(1).join('\n').replace(/^\s+/, '')
    }
    // A model may repeat one turn OR a short sequence of turns from the previous chunk at the new chunk's
    // opening even though source ownership is disjoint. The helper is bounded to the seam and at most four
    // prose blocks, so later legitimate repetition remains untouched.
    const normal = stripDuplicateSeamPrefix(out, next, 4)
    next = normal.text
    let removedBlocks = normal.removedBlocks
    const longReplay = findDuplicateSeamPrefix(out, next, 8)
    if (longReplay) {
      const repaired = stripDuplicateSeamPrefix(out, next, 8)
      next = repaired.text
      removedBlocks += repaired.removedBlocks
    }
    if (removedBlocks) seamRepairs.push({ seam: i, removedBlocks })
    const residual = findDuplicateSeamPrefix(out, next, 12)
    if (residual) seamDuplicates.push({ seam: i, repeatedBlocks: residual.indices.length })
    out = `${out}\n\n${next}`
  }
  const headingRepair = collapseAdjacentDuplicateHeadings(`${out.replace(/\s+$/, '')}\n`)
  return {
    text: headingRepair.text,
    seamRepairs,
    seamDuplicates,
    headingRepairs: headingRepair.removedHeadings,
    headingReplayBlocksRemoved: headingRepair.removedBlocks,
  }
}

function stitchParts(texts) {
  return stitchPartsWithReport(texts).text
}

// Fallback for the pre-flight grep: if the scout finds that a source file already has headings but
// headingPolicy is still 'none' (the pre-flight check didn't catch it), the user must be asked at wrap-up.
function findHeadingConflicts(findings, files, policy) {
  if ((policy || 'none') !== 'none') return []
  return files.filter((f, i) => findings[i] && findings[i].has_existing_headings).map((f) => f.label)
}

// Apply a verified conclusion into an entry — shared by the full render (renderGlossary) and the
// condensed refine render (renderRefineGlossary). resolvedMap: query→{canonical,identity}; applied/rejected:
// sets tracking which conclusions landed vs. were blocked by the name guard (for the full render's footnote).
// Name guard: if an entry already has a real (strong) name and the verifier returns a DIFFERENT strong name
// not present in the entry, it's likely a misattribution (observed: verify hallucinated 李明→王志远, rewriting
// the interviewee as the chairman) — don't rewrite; append a ⚠ note. Weak titles (王总 / 董事长) resolving to a
// real name still apply (that's the point of verification). ownStrong spans ALL names, not just canonical
// (clustering may elect a weak title as canonical with the real name in variants).
function applyVerifiedEntry(e, isPerson, resolvedMap, applied, rejected) {
  // Locked (user-decreed) cluster: the decree is final — short-circuit before the name guard can even look at
  // a verify hit, so a stray verify conclusion whose query happens to collide with one of the decree's variants
  // can never rewrite the钦定 canonical. (A locked cluster is normally excluded from verify entirely; this is
  // belt-and-braces for the case where a prior-glossary verify row matches a freshly-decreed writing.)
  // confidence:'user' is the SAME decree parsed back from a prior 校对表 (which carries 〔用户钦定〕 but no live
  // `locked` flag) — a user钦定 keeps its cross-batch veto, so it short-circuits the guard identically (BLOCKER).
  if (e && (e.locked || e.confidence === 'user')) return e
  const hit = resolvedMap.get(e.canonical) || (e.variants || []).map((v) => resolvedMap.get(v)).find(Boolean)
  if (!hit) return e
  const names = [e.canonical, ...(e.variants || [])]
  // Chinese orthography is its own evidence key. A Romanized author name can establish identity/context but
  // cannot choose among homophonic Han spellings. Fail closed unless the verifier explicitly attested that the
  // cited page shows the exact Chinese canonical AND preserved that spelling in the source note, making the
  // evidence contract machine-checkable instead of trusting a bare `two_key:true`.
  const hitCanonical = stripDesc(hit.canonical)
  const needsExactHanScript = isPerson && /^\p{Script=Han}{2,8}$/u.test(hitCanonical)
  const hasExactHanScript = hit.name_script_exact === true && String(hit.source || '').includes(hitCanonical)
  if (needsExactHanScript && !hasExactHanScript) {
    rejected.add(hit)
    const reason = hit.name_script_exact === true
      ? `⚠ 联网来源说明未原样包含中文名“${hitCanonical}”，无法证明具体汉字——未采用，待补中文原文来源`
      : `⚠ 联网仅确认身份/英文名，未直接证明中文名“${hitCanonical}”的汉字写法——未采用，待补中文原文来源`
    return Object.assign({}, e, { hint: [e.hint, reason].filter(Boolean).join('；') })
  }
  // Contested entry: a referent substitution (a DIFFERENT written form) is FORBIDDEN unless the fresh verdict
  // carries two_key===true — the verify agent attesting BOTH a high-tier source AND context-fit. Bare
  // concreteness, even a real-looking domain, never licenses it (the coattail failure: verify "confirms" the
  // misheard string off an SEO/分销 site named after it). Refuse → keep the spoken form, stay contested; the hit is
  // recorded in `rejected` so confidenceMark also withholds 〔核实〕. A two_key hit (or a self-confirmation whose
  // canonical equals a spoken form) falls through and applies.
  if (e.confidence === 'contested' && hit.canonical
      && !names.map(stripDesc).includes(stripDesc(hit.canonical)) && hit.two_key !== true) {
    rejected.add(hit)
    return e
  }
  const ownStrong = names.map(stripDesc).filter((n) => n && !isWeakKey(n))
  // Authority order is explicit:
  //   user decree (returned above) > carried verified canonical > fresh two-key verification > Scout/ASR guess.
  // The old guard treated a fresh Scout spelling as if it were already human/externally verified. That made the
  // exact failure it was meant to fix permanent: Scout flags 林川 as suspect_asr, Verify finds 林传, then the
  // "strong name" guard keeps 林川. A current suspect-ASR cluster may therefore be corrected only by a concrete
  // two-key result; a carried 〔核实〕 name remains protected and contested rows still use the stricter branch above.
  // Fresh first-run strong spellings are still only Scout hypotheses. A decisive Verify result already attests
  // both source authority and context fit via two_key, so it may correct them even when Scout forgot to set
  // suspect_asr (the real replay found the right public names but retained five ASR spellings for exactly this
  // reason). Carried verified and contested rows remain protected by the branches above / this exclusion.
  const freshTwoKeyCorrection = e.confidence !== 'verified' && e.confidence !== 'contested'
    && hit.two_key === true && isConcreteSource(hit.source)
  if (isPerson && hit.canonical && ownStrong.length
      && !ownStrong.includes(stripDesc(hit.canonical)) && !isWeakKey(stripDesc(hit.canonical))
      && !freshTwoKeyCorrection) {
    rejected.add(hit)
    const hint = [e.hint, `⚠ 联网核实给出“${hit.canonical}”，与本条强名不符，疑似张冠李戴——未采用，待人工确认`].filter(Boolean).join('；')
    return Object.assign({}, e, { hint })
  }
  applied.add(hit)
  const variants = Array.from(new Set(names.filter((n) => n && n !== hit.canonical)))
  // Idempotent: don't re-prepend the identity tag if it's already in the hint (a persisted glossary
  // is parsed + re-rendered every batch, so a naive prepend would bloat the hint each run).
  const idTag = hit.identity ? `${hit.identity}（已核实）` : ''
  const hint = (idTag && e.hint && e.hint.includes(idTag)) ? e.hint : [idTag, e.hint].filter(Boolean).join('；')
  return Object.assign({}, e, { canonical: hit.canonical, variants, hint })
}

// ---------- contested identity (〔同指两解〕) ----------
// One plain-text hint clause carrying BOTH hypotheses, so the state survives render→parse→render with no separate
// persisted section (the entity row IS the source of truth). No '；' or ' ｜ ' inside — those are field/clause
// separators mergeHints/parseEntityLine split on; using 「」（），· keeps it a single indivisible clause.
const CONTESTED_TAG = '同指两解·'
function contestedClause(c) {
  const lit = (c && c.literal) || '口播原形'
  const lt = (c && c.literal_tier) || '级别未标'
  const cor = (c && c.correction) || '待定'
  const ct = (c && c.correction_tier) || '级别未标'
  return `${CONTESTED_TAG}字面「${lit}」（${lt}），更可能「${cor}」（${ct}）`
}
const CONTESTED_HINT_RE = /同指两解·字面「(.*?)」（(.*?)），更可能「(.*?)」（(.*?)）/
// Build query→item lookup from a verify result's contested list (fresh this round).
function contestedMapOf(verified) {
  const m = new Map()
  for (const c of (verified && verified.contested) || []) if (c && c.query) m.set(c.query, c)
  return m
}
// Merge the both-hypotheses clause into an entry's hint when it is freshly contested this round. Idempotent: a
// prior contested entry already carries the clause (round-tripped in its hint), so it is left byte-identical.
function applyContestedEntry(e, contestedMap) {
  if (!e || !contestedMap || !contestedMap.size) return e
  if (String(e.hint || '').includes(CONTESTED_TAG)) return e   // already annotated (prior carry-forward or re-apply)
  const names = [e.canonical, ...(e.variants || [])]
  const cont = names.map((n) => contestedMap.get(n)).find(Boolean)
  if (!cont) return e
  return Object.assign({}, e, { hint: mergeHints(e.hint, contestedClause(cont)) })
}
// Resolve the contested hypotheses for an entry, from THIS round's verify (fresh) or from a prior row's hint clause
// (carried forward). Returns null when the entry is not contested. Single accessor used by both the refine-glossary
// no-substitution section and the 收尾待问 line, so fresh and prior contested surface identically.
function contestedInfoFor(e0, contestedMap) {
  const names = [e0.canonical, ...(e0.variants || [])]
  const fresh = contestedMap ? names.map((n) => contestedMap.get(n)).find(Boolean) : null
  if (fresh) return { spoken: e0.canonical, literal: fresh.literal || e0.canonical, literalTier: fresh.literal_tier || '级别未标', correction: fresh.correction || '待定', correctionTier: fresh.correction_tier || '级别未标' }
  if (e0.confidence === 'contested') {
    const m = String(e0.hint || '').match(CONTESTED_HINT_RE)
    if (m) return { spoken: e0.canonical, literal: m[1], literalTier: m[2], correction: m[3], correctionTier: m[4] }
    return { spoken: e0.canonical, literal: e0.canonical, literalTier: '级别未标', correction: '待定', correctionTier: '级别未标' }
  }
  return null
}
// Every contested entity (fresh or carried), in glossary order — drives the refine no-substitution list + wrap-up.
function contestedEntities(merged, contestedMap) {
  const out = []
  for (const list of [merged.people, merged.brands, merged.terms]) {
    for (const e of list || []) { const info = contestedInfoFor(e, contestedMap); if (info) out.push(info) }
  }
  return out
}
// 收尾待问 lines: one per contested entity, both hypotheses + evidence tiers, spelled out for a human to settle.
function contestedQuestions(merged, verified) {
  const cm = contestedMapOf(verified)
  return contestedEntities(merged, cm).map((c) =>
    `〔${CONFIDENCE_CONTESTED}〕${c.spoken}：A=${c.literal}（${c.literalTier}）；B=${c.correction}（${c.correctionTier}）——正文已保留口播形并标注，请定夺`)
}

// Keep a hint short for the condensed refine glossary: the first clause (truncated) plus any ⚠ warnings
// (the refiner must see ⚠ to skip those rows). Drops the long identity/source prose the refiner doesn't need.
function trimHint(h) {
  if (!h) return ''
  const parts = String(h).split('；')
  const warn = parts.filter((p) => p.includes('⚠'))
  const head = (parts.find((p) => !p.includes('⚠')) || '').trim().slice(0, 36)
  return [head, ...warn].filter(Boolean).join('；')
}

// Condensed glossary for the chunk-refine agents: only the spelling-unification info a refiner needs —
// entity tables (canonical ← variants, verified spellings applied, ⚠ marks), 写法统一 directives,
// 疑似同指 flags, 确认不同指, and compact speaker labels. Drops the archival prose (采访背景, 联网核实结论
// sources, 转写错误 examples, 各份特别提醒, 跨访谈发言人登记) that bloats the full 校对表. Sent to EACH of the
// K chunk agents, so trimming it is the main lever on chunked-refine token cost; the full 校对表 is still
// persisted and used by the single-agent refine path. Verified canonicals are applied exactly as in the
// full render (same applyVerifiedEntry), so 写法 stay identical.
function renderRefineGlossary(merged, verified, dedup, a) {
  const resolvedMap = new Map()
  for (const r of (verified && verified.resolved) || []) resolvedMap.set(r.query, r)
  const contestedMap = contestedMapOf(verified)
  const applied = new Set(), rejected = new Set()
  const sec = [`# ${a.topic} 写法对照（精校用·摘自校对表）`]
  const spk = []
  for (const s of merged.speakersByFile || []) for (const sp of s.speakers || []) { if (sp && sp.label) spk.push(`${sp.label} → ${sp.role || '?'}${sp.identity ? `（${sp.identity}）` : ''}`) }
  const uspk = Array.from(new Set(spk))
  if (uspk.length) { sec.push('', '## 发言人'); for (const x of uspk) sec.push(`- ${x}`) }
  const block = (title, list, isPerson) => {
    const rows = []
    for (const e0 of list) {
      const e = applyContestedEntry(applyVerifiedEntry(e0, isPerson, resolvedMap, applied, rejected), contestedMap)
      const hint = trimHint(e.hint)
      rows.push(`- **${e.canonical}** ← ${e.variants.join(' / ') || '—'}${hint ? ` ｜ ${hint}` : ''}${confidenceMark(e0, resolvedMap, a.date, contestedMap, rejected)}`)
    }
    if (rows.length) { sec.push('', `## ${title}`); sec.push(...rows) }
  }
  block('人名', merged.people, true)
  block('品牌 / 公司 / 产品', merged.brands)
  block('术语 / 专名', merged.terms)
  // Contested rows get an explicit no-substitution directive for the refiner: keep the spoken written form,
  // annotate the first occurrence per file, and NEVER write the candidate name into the prose.
  const contested = contestedEntities(merged, contestedMap)
  if (contested.length) {
    sec.push('', '## 同指两解（口播形存疑·务必保留原形、勿替换）', '> 下列写法核实未决：正文一律保留口播原形；每份文件首次出现处标注（音，存疑：或为 <候选>）；**绝不可把候选名替换进正文**。')
    for (const c of contested) sec.push(`- ${c.spoken} ｜ 保留原形，首次出现标注（音，存疑：或为 ${c.correction}）——绝不写成 ${c.correction}`)
  }
  const { directives, flags } = splitSuspects(dedup)
  if (directives.length) { sec.push('', '## 写法统一（初次落笔即写对，勿事后回改）'); for (const s of directives) sec.push(`- ${(s.members || []).filter((x) => x !== s.preferred).join(' / ')} → **${s.preferred}**`) }
  if (flags.length) { sec.push('', '## 疑似同指（勿自动合并）'); for (const s of flags) sec.push(`- ${(s.members || []).join(' ／ ')}（${s.kind}）`) }
  if (a.doNotMerge && a.doNotMerge.length) { sec.push('', '## 确认不同指（勿合并）'); for (const p of a.doNotMerge) sec.push(`- ${(p || []).join(' ／ ')}`) }
  return sec.join('\n')
}

function renderGlossary(merged, verified, dedup, a) {
  // Apply verified results back into the body entries first: if query matches an entry's canonical or
  // any variant, replace canonical with the verified spelling (folding the original into variants)
  // and merge the identity into hint — the archived glossary body is authoritative; no footnote corrections.
  const resolvedMap = new Map()
  for (const r of (verified && verified.resolved) || []) resolvedMap.set(r.query, r)
  const contestedMap = contestedMapOf(verified)
  const applied = new Set()   // verified conclusions actually applied into the table body
  const rejected = new Set()  // verified conclusions blocked by the person-name guard
  const applyVerified = (e, isPerson) => applyContestedEntry(applyVerifiedEntry(e, isPerson, resolvedMap, applied, rejected), contestedMap)
  const sec = []
  sec.push(`# ${a.topic} 统一校对表（采访时间 ${a.date}）`, '', '## 采访背景', a.background, '')
  sec.push('## 发言人统一标注')
  const trustedSpeakerNames = new Set()
  const trustSpeaker = (name) => {
    const n = stripDesc(String(name || '').trim())
    if (n && /[\u4e00-\u9fff]/.test(n)) trustedSpeakerNames.add(n)
  }
  for (const f of a.files || []) {
    for (const m of String(f.speakerHints || '').matchAll(/(?:^|[；;，,])\s*([^=＝:：；;,，]+)\s*[=＝:：]/g)) trustSpeaker(m[1])
  }
  for (const s of merged.speakersByFile) {
    sec.push(`**${s.label}**`)
    for (const sp of s.speakers) {
      if (sp && sp.label) {
        trustSpeaker(sp.label)
        sec.push(`- ${sp.label} → ${sp.role || '?'}${sp.identity ? `（${sp.identity}）` : ''}`)
      }
    }
  }
  // Cross-interview speaker registry (P3): a derived view unifying speakers that recur across ≥2 files
  // (chiefly the interviewer), so refine labels them consistently and the human sees who recurs.
  const reg = buildSpeakerRegistry(merged.speakersByFile)
  if (reg.length) { sec.push('', '## 发言人登记（跨访谈）'); for (const r of reg) sec.push(`- ${r.label}（${r.role}）${r.identity ? ` ｜ ${r.identity}` : ''} ｜ 出现：${r.files.join('、')}`) }
  const block = (title, list, isPerson) => {
    sec.push('', `## ${title}（写法 → 统一）`)
    for (const e0 of list) {
      const e = applyVerified(e0, isPerson)
      // A locked (用户钦定) cluster is settled — it never carries the ⚠ suspect-ASR flag even if a consumed
      // cluster was scout-flagged; it renders clean with 〔用户钦定〕 (via confidenceMark) instead.
      const forms = [e0.canonical, ...(e0.variants || [])]
      const speakerTrusted = forms.some((n) => trustedSpeakerNames.has(stripDesc(n)))
      // A contested entity already carries 〔同指两解〕 + both hypotheses — the suspect-ASR ⚠ line would be
      // redundant (and, since suspect_asr is not re-parsed, would break the render→parse→render round-trip).
      const isContested = e0.confidence === 'contested' || forms.some((n) => contestedMap.has(n))
      const susp = !speakerTrusted && !e0.locked && !isContested && e0.suspect_asr && !forms.some((n) => resolvedMap.has(n))
        ? ' ｜ ⚠ 侦察疑为转录误写、未能核实——请人工确认正确写法' : ''
      sec.push(`- **${e.canonical}** ← ${e.variants.join(' / ') || '—'}${e.hint ? ` ｜ ${e.hint}` : ''}${e.crossFile ? ' ｜ 多份互证' : ''}${susp}${confidenceMark(e0, resolvedMap, a.date, contestedMap, rejected)}`)
    }
  }
  block('人名', merged.people, true)
  block('品牌 / 公司 / 产品', merged.brands)
  block('术语 / 专名', merged.terms)
  sec.push('', '## 需特别处理的转写错误')
  for (const er of merged.errors) sec.push(`- [${er.file}] ${er.kind}：${er.examples.slice(0, 6).join('；')}`)
  if (merged.notes.length) sec.push('', '## 各份特别提醒', ...merged.notes.map((n) => '- ' + n))
  // M9a re-open notes: a DERIVED, ephemeral section (like 发言人登记 / it has no parseGlossary grammar, so it is
  // never read back and cannot fossilize into the persistent body). Lists the prior 〔核实〕 entries this batch
  // sent back to verify because the scout surfaced a new contradicting strong writing.
  if (a.reopenNotes && a.reopenNotes.length) { sec.push('', '## 本轮重新入队复核（往批核实遇新写法证据）'); for (const nt of a.reopenNotes) sec.push(`- ${nt}`) }
  if (verified && ((verified.resolved || []).length || (verified.unresolved || []).length)) {
    sec.push('', '## 联网核实结论（已采纳的已应用到上表正文；标 ⚠ 的与正文强名冲突、未采纳，待人工确认）')
    for (const r of verified.resolved || []) {
      // Rejection takes priority: flag ⚠ if any entry triggered the name guard for this result
      // (even if another entry legitimately accepted the same result, a spurious warning is far less harmful
      // than silently replacing one person with another). The wording “与部分条目强名不符” covers the case
      // where the result was accepted elsewhere.
      const bad = rejected.has(r)
      sec.push(`- ${bad ? '⚠ ' : ''}${r.query} → **${r.canonical}**${r.identity ? `（${r.identity}）` : ''}${bad ? ' ｜ 与部分条目强名不符、疑似张冠李戴，请人工确认' : ''} ｜ 依据：${r.source}`)
    }
    for (const u of verified.unresolved || []) {
      const trusted = trustedSpeakerNames.has(stripDesc(u.query))
      sec.push(trusted
        ? `- ${u.query}：公开核实不足；按发言人信息使用${u.note ? ` ｜ ${u.note}` : ''}`
        : `- ${u.query}：未能核实，保留（音）${u.note ? ` ｜ ${u.note}` : ''}`)
    }
  }
  const { directives, flags } = splitSuspects(dedup)
  if (directives.length) {
    sec.push('', '## 写法统一（精校请初次落笔即套用，勿事后逐字回改）', '> dedup 已判定为同一术语/品牌的不同写法，下列以右侧为准——精校时直接写对，不要先写错再回头改。')
    for (const s of directives) sec.push(`- ${(s.members || []).filter((x) => x !== s.preferred).join(' / ')} → 统一写 **${s.preferred}**（${s.why}）`)
  }
  if (flags.length) {
    sec.push('', '## 疑似同指（待人工确认，未自动合并）', '> 写法不同但疑似指同一对象——脚本不会自动并（尤其人名），请人工/精校据原文定夺；不是同指就忽略。')
    for (const s of flags) sec.push(`- ${(s.members || []).join(' ／ ')}（${s.kind}）：${s.why}`)
  }
  // Human-confirmed distinct referents (P4): carried forward so dedup won't re-flag them next batch.
  if (a.doNotMerge && a.doNotMerge.length) {
    sec.push('', '## 确认不同指（勿合并）', '> 人工确认：以下各组写法相近但确为不同对象，dedup 勿再标记为疑似同指。')
    for (const pair of a.doNotMerge) sec.push(`- ${(pair || []).join(' ／ ')}`)
  }
  // P2c follow-up: verbatim-preserved lines re-emitted under their ORIGINAL section titles, at the end. A block
  // whose title repeats a section rendered above simply reads as a continuation — parseGlossary reads every
  // matching block (all()), so these lines round-trip stably (unparseable then, unparseable-but-kept now).
  for (const p of merged.preserved || []) {
    if (!p || !p.title || !(p.lines || []).length) continue
    sec.push('', `## ${p.title}`, ...p.lines)
  }
  return sec.join('\n')
}

// Scout-flagged ASR suspects that verify did not resolve — surfaced into openQuestions so a likely
// mis-transcribed name is never shipped silently (the failure mode where scout suspected it, verify
// either skipped it or couldn't confirm, and the ASR spelling went straight into the 成稿).
function suspectUnverified(merged, verified) {
  const resolved = new Set()
  for (const r of (verified && verified.resolved) || []) if (r && r.query) resolved.add(r.query)
  const out = []
  for (const list of [merged.people, merged.brands, merged.terms]) {
    for (const e of list || []) {
      if (e.suspect_asr && ![e.canonical, ...(e.variants || [])].some((n) => resolved.has(n))) {
        out.push(`疑似转录误写、未核实：「${e.canonical}」${e.hint ? `（${e.hint}）` : ''}——请人工确认正确写法`)
      }
    }
  }
  return out
}

// Defensive filter: drop the model's occasional placeholder/self-negating entries
// (observed in the wild: groups with members < 2, or why = “撤回 / 不适用” noise).
function cleanSuspects(suspects) {
  return (suspects || [])
    // require ≥ 2 DISTINCT members: a self-duplicate group (e.g. 优鲜纯/优鲜纯, from a scout listing one
    // term under both brand and term) is noise — and as a directive it would render an empty-left
    // “ → 统一写 **X**” line. A real same-referent group always has ≥ 2 distinct spellings.
    .filter((s) => s && new Set((s.members || []).map((m) => stripDesc(m))).size >= 2 && !/撤回|不适用|不适合|不属于|仅供参考/.test(s.why || ''))
    .map((s) => Object.assign({}, s, { kind: s.kind || '未标类', why: s.why || '' }))
}

// Split dedup results into two paths: term/brand entries with a valid `preferred` → actionable
// “unify spelling” directives applied automatically; everything else (person identity merges / uncertain cases)
// → flags requiring manual confirmation.
function splitSuspects(dedup) {
  const directives = [], flags = []
  // The main flow already calls cleanSuspects before this; the second pass here is defensive
  // (direct calls and degraded inputs must not throw).
  for (const s of cleanSuspects((dedup && dedup.suspects) || [])) {
    const m = s.members || []
    if ((s.kind === 'term' || s.kind === 'brand') && s.preferred && m.includes(s.preferred) && m.length >= 2) directives.push(s)
    else flags.push(s)
  }
  return { directives, flags }
}

// Circuit-breaker output: items left unverified because the verify agent was tripped by a network failure.
// These are not “not found” — they were never looked up. Worth re-verifying once the network recovers.
// Surfaced separately so the wrap-up step can offer the user a “re-verify” option
// (see SKILL.md for the handling flow).
function pickNetworkUnverified(verified) {
  return ((verified && verified.unresolved) || []).filter((u) => u && /网络故障|网络错误|连接|超时|断路|熔断|中断|检索失败|检索报错|timed? ?out|network|connection/i.test(u.note || ''))
}

// Only pending flags go into openQuestions (spelling-unification directives have already been applied automatically
// and do not need to be surfaced to the user).
function dedupQuestions(dedup) {
  return splitSuspects(dedup).flags.map((s) => `疑似同指（${s.kind}）：${(s.members || []).join(' ／ ')} 是否指同一对象？（${s.why}）——脚本未自动合并，请确认`)
}

// ---------- persistent per-company glossary (P1) ----------
// parseGlossary is the inverse of renderGlossary: it reads a previously-written 校对表.md back
// into the same structures mergeFindings/renderGlossary use, so a company's glossary becomes
// cumulative memory rather than per-batch output. The render format is regular and stable;
// any line that doesn't match a known grammar is preserved in `extra` so user free-text is
// never lost. 补核结论 (re-verify addendum) rows are folded into `verified.resolved`.
function parseEntityLine(l) {
  // Tolerant of minor whitespace variance around `-` and `←` (a hand-edited `**X**←变体` row used to fail this
  // match and silently vanish — the P2c-follow-up entity-row loss). The render side still emits ` ← ` exactly.
  const m = l.match(/^-\s+\*\*(.+?)\*\*\s*←\s*(.*)$/)
  if (!m) return null
  // Peel the machine-readable confidence marker off the tail FIRST, so an unmarked (legacy) line yields exactly
  // the same variants/hint as before — the only difference is the added confidence field (defaults to 'unknown').
  const { rhs, confidence, confidenceDate } = stripConfidence(m[2] || '')
  const parts = rhs.split(' ｜ ')
  const varsRaw = (parts.shift() || '—').trim()
  const variants = varsRaw === '—' ? [] : varsRaw.split(' / ').map((x) => x.trim()).filter(Boolean)
  let hint = '', crossFile = false
  for (const p of parts) { if (p.trim() === '多份互证') crossFile = true; else if (p.trim()) hint = hint ? `${hint} ｜ ${p.trim()}` : p.trim() }
  // confidenceDate is carried so a prior 〔核实·YYYY-MM〕 re-renders with its ORIGINAL date next round (BLOCKER).
  return { canonical: m[1], variants, hint, crossFile, confidence, confidenceDate }
}
function parseResolvedLine(body, out) {
  let s = body, rejected = false
  if (s.startsWith('⚠ ')) { rejected = true; s = s.slice(2) }
  const rm = s.match(/^(.+?) → \*\*(.+?)\*\*(?:（(.+?)）)?(?:\s*｜\s*(?!依据：).*?)?\s*｜\s*依据：(.*)$/)
  if (rm) { out.push({ query: rm[1], canonical: rm[2], identity: rm[3] || '', source: rm[4], rejected }); return true }
  return false
}
// Section titles parseGlossary / renderGlossary know how to emit or read. Any OTHER `##` block (and the
// preamble) is treated as foreign: its entity-looking rows are rescued into 术语 rather than dropped (see below).
const KNOWN_SECTION = [/^采访背景/, /^发言人统一标注/, /^发言人登记/, /^人名（写法/, /^品牌.*（写法/, /^术语.*（写法/, /^需特别处理的转写错误/, /^各份特别提醒/, /^本轮重新入队复核/, /^联网核实结论/, /^补核结论/, /^写法统一/, /^疑似同指/, /^确认不同指/]
function parseGlossary(md) {
  const g = { topic: '', date: '', background: '', speakersByFile: [], people: [], brands: [], terms: [], errors: [], notes: [], verified: { resolved: [], unresolved: [] }, dedupSuspects: [], doNotMerge: [], extra: [], preserved: [] }
  if (!md || !md.trim()) return g
  // P2c follow-up — verbatim preservation: any content line no section grammar recognizes is kept as
  // { title, lines } and re-emitted by renderGlossary under the SAME section title, so a formatting-variant row
  // or a hand-written section is never silently dropped from the cumulative glossary. Dedup by exact line keeps
  // repeated round-trips stable (a preserved line re-parses into preserved again, once).
  const keep = (title, line) => {
    if (!line || !line.trim()) return
    let b = g.preserved.find((p) => p.title === title)
    if (!b) { b = { title, lines: [] }; g.preserved.push(b) }
    if (!b.lines.includes(line)) b.lines.push(line)
  }
  const lines = md.split('\n')
  const mh = (lines.find((l) => /统一校对表/.test(l)) || '').match(/^#\s*(.+?)\s*统一校对表（采访时间\s*(.+?)）/)
  if (mh) { g.topic = mh[1]; g.date = mh[2] }
  const sections = []
  let cur = { title: '__preamble__', body: [] }
  for (const l of lines) { const m = l.match(/^##\s+(.*)$/); if (m) { sections.push(cur); cur = { title: m[1], body: [] } } else cur.body.push(l) }
  sections.push(cur)
  const all = (re) => sections.filter((s) => re.test(s.title))
  const get = (re) => all(re)[0]
  // Non-entity sections read EVERY matching block (all()), same as the entity sections since the P2c fix — a
  // concatenated / hand-merged 校对表 repeating `## 写法统一` etc. used to keep only the first block.
  g.background = all(/^采访背景/).map((s) => s.body.join('\n').trim()).filter(Boolean).join('\n\n')
  for (const spk of all(/^发言人统一标注/)) {
    let grp = null
    for (const l of spk.body) {
      const mb = l.match(/^\*\*(.+?)\*\*\s*$/)
      if (mb) { grp = { label: mb[1], speakers: [] }; g.speakersByFile.push(grp); continue }
      const ms = l.match(/^- (.+?) → (.+?)(?:（(.+)）)?$/)
      if (ms && grp) { grp.speakers.push({ label: ms[1], role: ms[2], identity: ms[3] || '' }); continue }
      if (!l.startsWith('> ')) keep(spk.title, l)
    }
  }
  // Parse entity rows from EVERY matching section, not just the first. A concatenated or hand-merged 校对表 can
  // repeat the same `## 术语…` header; `sections.find` silently dropped every later block (reproduced data-loss).
  const parseEntities = (secs) => { const out = []; for (const sec of secs || []) for (const l of sec.body) { if (!l.startsWith('- ')) continue; const e = parseEntityLine(l); if (e) out.push(e); else { g.extra.push(l); keep(sec.title, l) } } return out }
  g.people = parseEntities(all(/^人名（写法/))
  g.brands = parseEntities(all(/^品牌.*（写法/))
  g.terms = parseEntities(all(/^术语.*（写法/))
  // Rescue entity-looking rows stranded OUTSIDE any recognized entity section — the preamble, or a chunk whose
  // category header was lost/mangled. Silently ignoring them is the reproduced loss; instead fold them into 术语
  // (the neutral catch-all) with an explicit marker so the human can re-file. Well-formed renderGlossary output
  // has no such rows (all its sections are recognized), so this is a no-op on a clean render→parse round-trip.
  for (const s of sections) {
    if (s.title !== '__preamble__' && KNOWN_SECTION.some((re) => re.test(s.title))) continue
    for (const l of s.body) {
      const e = l.startsWith('- ') ? parseEntityLine(l) : null
      if (e) { g.terms.push({ ...e, hint: mergeHints(e.hint, HEADERLESS_MARK) }); continue }
      // Preamble: the H1 title line is re-generated by renderGlossary; everything else is user text — keep it.
      if (s.title === '__preamble__') { if (!/统一校对表/.test(l)) keep('（校对表开头的自由文本）', l); continue }
      // A foreign (unrecognized) section: rows that aren't rescuable entity lines are user content — keep whole.
      keep(s.title, l)
    }
  }
  for (const errs of all(/^需特别处理的转写错误/)) {
    for (const l of errs.body) {
      const m = l.match(/^- \[(.+?)\]\s*(.+?)：(.*)$/)
      if (m) g.errors.push({ file: m[1], kind: m[2], examples: m[3] ? m[3].split('；') : [] })
      else if (!l.startsWith('> ')) keep(errs.title, l)
    }
  }
  for (const nt of all(/^各份特别提醒/)) {
    for (const l of nt.body) {
      const m = l.match(/^- (.+)$/)
      if (m) g.notes.push(m[1])
      else if (!l.startsWith('> ')) keep(nt.title, l)
    }
  }
  for (const vsec of [...all(/^联网核实结论/), ...all(/^补核结论/)]) {
    for (const l of vsec.body) {
      if (!l.startsWith('- ')) { if (!l.startsWith('> ')) keep(vsec.title, l); continue }
      const body = l.slice(2)
      const un = body.match(/^(.+?)：未能核实，保留（音）(?:\s*｜\s*(.*))?$/)
      if (un) { g.verified.unresolved.push({ query: un[1], note: un[2] || '' }); continue }
      const pk = body.match(/^(.+?)：公开核实不足；按发言人信息使用(?:\s*｜\s*(.*))?$/)
      if (pk) { g.verified.unresolved.push({ query: pk[1], note: pk[2] || '' }); continue }
      if (!parseResolvedLine(body, g.verified.resolved)) { g.extra.push(l); keep(vsec.title, l) }
    }
  }
  for (const dr of all(/^写法统一/)) {
    for (const l of dr.body) {
      // The （why） tail is OPTIONAL on parse (render always emits it): a hand-trimmed directive row without a
      // reason used to fail this match and vanish — the P2c-follow-up 写法统一 section loss.
      const m = l.match(/^- (.+?) → 统一写 \*\*(.+?)\*\*(?:（(.*)）)?\s*$/)
      if (m) { const members = m[1].split(' / ').map((x) => x.trim()).filter(Boolean); if (!members.includes(m[2])) members.push(m[2]); g.dedupSuspects.push({ members, kind: 'term', preferred: m[2], why: m[3] || '同一对象的不同写法（沿用往次校对表）' }) }
      else if (!l.startsWith('> ')) keep(dr.title, l)
    }
  }
  for (const fl of all(/^疑似同指/)) {
    for (const l of fl.body) {
      const m = l.match(/^- (.+?)（(.+?)）：(.*)$/)
      if (m) g.dedupSuspects.push({ members: m[1].split(' ／ ').map((x) => x.trim()).filter(Boolean), kind: m[2], why: m[3] })
      else if (!l.startsWith('> ')) keep(fl.title, l)
    }
  }
  for (const dn of all(/^确认不同指/)) {
    for (const l of dn.body) {
      const m = l.match(/^- (.+)$/)
      if (m) { const grp = m[1].split(' ／ ').map((x) => x.trim()).filter(Boolean); if (grp.length >= 2) g.doNotMerge.push(grp); else keep(dn.title, l) }
      else if (!l.startsWith('> ')) keep(dn.title, l)
    }
  }
  // 发言人登记（跨访谈）is a derived view of speakersByFile — re-generated by renderGlossary, so we don't
  // parse it back (its lines are simply never visited, never landing in `extra`).
  return g
}

// Cumulative merge of this batch's fresh clusters into the prior glossary.
// Prior canonical wins (the user has had a chance to edit it); fresh variants/hints are folded in;
// an entry that shares no STRONG name with any prior entry is added as new; unmatched prior entries
// are carried forward unchanged. Under-merge (two entries) is preferred over over-merge, same as clusterEntities.
function strongSet(e) { return new Set([e.canonical, ...(e.variants || [])].map(stripDesc).filter((n) => n && !isWeakKey(n))) }
function mergeEntityLists(priorList, freshList) {
  const out = (priorList || []).map((e) => Object.assign({}, e, { variants: [...(e.variants || [])] }))
  for (const fe of freshList || []) {
    const fs = strongSet(fe)
    let home = null
    if (fs.size) home = out.find((pe) => { const ps = strongSet(pe); for (const n of fs) if (ps.has(n)) return true; return false })
    if (home) {
      const names = new Set([home.canonical, ...(home.variants || []), fe.canonical, ...(fe.variants || [])].filter(Boolean))
      names.delete(home.canonical)
      home.variants = Array.from(names)
      home.crossFile = true
      if (fe.hint) home.hint = mergeHints(home.hint, fe.hint)   // was: keep prior, drop the fresh note (silent loss)
      home.public_figure = home.public_figure || fe.public_figure
      if (!home.category && fe.category) home.category = fe.category
    } else out.push(Object.assign({}, fe, { variants: [...(fe.variants || [])] }))
  }
  return out
}
function mergeIntoPrior(prior, fresh) {
  if (!prior) return fresh
  const seen = new Set(); const speakers = []
  for (const grp of [...(prior.speakersByFile || []), ...(fresh.speakersByFile || [])]) { if (grp && grp.label && !seen.has(grp.label)) { seen.add(grp.label); speakers.push(grp) } }
  return {
    people: mergeEntityLists(prior.people, fresh.people),
    brands: mergeEntityLists(prior.brands, fresh.brands),
    terms: mergeEntityLists(prior.terms, fresh.terms),
    speakersByFile: speakers,
    errors: [...(prior.errors || []), ...(fresh.errors || [])],
    notes: Array.from(new Set([...(prior.notes || []), ...(fresh.notes || [])])),
    preserved: mergePreserved(prior.preserved, fresh.preserved),
  }
}
// P2c follow-up: verbatim-preserved lines (see parseGlossary's `keep`) accumulate append-only across batches,
// deduped by exact line within a section title, so nothing hand-written is ever dropped and nothing multiplies.
function mergePreserved(a, b) {
  const out = []
  for (const p of [...(a || []), ...(b || [])]) {
    if (!p || !p.title || !(p.lines || []).length) continue
    let home = out.find((x) => x.title === p.title)
    if (!home) { home = { title: p.title, lines: [] }; out.push(home) }
    for (const l of p.lines) if (!home.lines.includes(l)) home.lines.push(l)
  }
  return out
}
// Carry prior verify conclusions forward; fresh overrides prior for the same query; a resolved query
// is removed from unresolved.
function mergeVerified(priorV, freshV) {
  const r = new Map(), u = new Map(), c = new Map()
  for (const v of [priorV, freshV]) { if (!v) continue; for (const x of v.resolved || []) if (x && x.query) r.set(x.query, x); for (const x of v.unresolved || []) if (x && x.query) u.set(x.query, x); for (const x of v.contested || []) if (x && x.query) c.set(x.query, x) }
  // A query that got a DECISIVE (resolved) verdict this round is no longer contested/unresolved — the sanctioned
  // upgrade path (fresh always follows prior in the loop, so a fresh resolved overrides a prior contested for the
  // same query). A still-contested query is likewise removed from unresolved.
  for (const q of r.keys()) { u.delete(q); c.delete(q) }
  for (const q of c.keys()) u.delete(q)
  return { resolved: Array.from(r.values()), unresolved: Array.from(u.values()), contested: Array.from(c.values()) }
}
// Carry prior dedup suspects forward, de-duped by member-set + kind signature.
function mergeDedup(priorSuspects, freshSuspects) {
  const m = new Map()
  for (const s of [...(priorSuspects || []), ...(freshSuspects || [])]) { if (s && (s.members || []).length >= 2) m.set((s.members || []).map((x) => stripDesc(x)).sort().join('|') + '#' + (s.kind || ''), s) }
  return Array.from(m.values())
}

// P2 — verify-cache exclusion: drop entities already SETTLED by the prior glossary from THIS batch's verify
// list (they stay in the cumulative glossary via mergeIntoPrior + carried-forward verified — they just aren't
// re-checked). The real cost/latency win of the persistent glossary.
//
// Confidence-aware (Wave 2): an entry is "settled" and skipped when EITHER it is covered by a prior verify
// conclusion (query/canonical match — unchanged behaviour, the historical meaning of this function) OR the prior
// glossary entry itself is marked confidence ∈ {verified, user} (a网络核实 or 用户钦定 conclusion baked into the
// entry line). A prior entry marked 'recheck' (a human wrote 〔待复核〕) is FORCE re-verified: its writings are
// removed from the skip set even if a stale verify row still covered them. 'unknown' prior entries contribute
// nothing on their own (they only skip via the verify-conclusion path, exactly as before — full back-compat).
//
// M9 firebreak — `forceReopen` (optional): a set/array of prior-entry writings that this batch has decided to
// RE-adjudicate even though they parse as settled (verified/user). Two callers feed it (see core/pipeline.js):
// M9a contradiction re-open (a fresh scout cluster carries a NEW strong variant a prior-verified entry lacks) and
// M9b age-rotation (the N oldest verified entries, cycled back in). It is applied EXACTLY like the recheck path —
// each writing is deleted from `done` — so a re-opened entry that ALSO recurs as a fresh cluster this batch drops
// back into the verify candidate pool. (An entity not mentioned this batch has no fresh cluster to un-filter, so
// re-opening it is a harmless no-op — you can only re-check what is on the table.) Default empty → behaviour is
// byte-for-byte the pre-M9 function (full back-compat; dedupCoverage's call passes nothing and is unchanged).
function excludeVerified(merged, prior, forceReopen) {
  if (!prior) return merged
  const done = new Set()
  for (const r of (prior.verified && prior.verified.resolved) || []) { if (r && r.query) done.add(stripDesc(r.query)); if (r && r.canonical) done.add(stripDesc(r.canonical)) }
  const priorEntries = [...(prior.people || []), ...(prior.brands || []), ...(prior.terms || [])]
  const writingsOf = (e) => [e.canonical, ...(e.variants || [])].map(stripDesc).filter(Boolean)
  // Entries the prior glossary marks as settled (verified/user) seed the skip set directly.
  for (const e of priorEntries) { if (e.confidence === 'verified' || e.confidence === 'user') for (const n of writingsOf(e)) done.add(n) }
  // recheck AND contested override everything: force this batch to re-verify those writings. A contested row is
  // still unsettled (only a decisive verdict can retire it), so it must never be skipped as if already confirmed.
  for (const e of priorEntries) { if (e.confidence === 'recheck' || e.confidence === 'contested') for (const n of writingsOf(e)) done.delete(n) }
  // M9 force-reopen: same treatment as recheck, applied AFTER the settled-seed pass so it always wins.
  for (const n of forceReopen || []) { const k = stripDesc(n); if (k) done.delete(k) }
  if (!done.size) return merged
  const covered = (e) => [e.canonical, ...(e.variants || [])].some((n) => done.has(stripDesc(n)))
  const filt = (list) => (list || []).filter((e) => !covered(e))
  return Object.assign({}, merged, { people: filt(merged.people), brands: filt(merged.brands), terms: filt(merged.terms) })
}

// ---------- M9 glossary firebreak (anti-fossilization) ----------
// The gap: excludeVerified treats confidence:'verified' as PERMANENTLY settled — such an entry is skipped from
// re-verification in every future batch. The M3 provenance guard (confidenceMark) stops NEW evidence-free entries
// from earning 〔核实〕, but an OLD/legacy 〔核实〕 (or one that was right once and is contradicted now) never gets
// re-checked. M9a and M9b are the two firebreaks that let a settled entry back into the verify queue. Both return
// a plain array of prior-entry WRITINGS to hand to excludeVerified's `forceReopen`; M9a additionally returns the
// human-facing notes that surface the re-open (glossary render + openQuestions).

// M9a — contradiction re-open. glossaryConflicts (below) already detects, AFTER verify runs, that this batch's
// verify disagreed with the prior canonical — but by then the prior entry was already EXCLUDED from verify, so the
// disagreement is only reported, never re-adjudicated. M9a moves the trigger EARLIER: before exclusion, using only
// the SCOUT clusters (no model call), detect that a prior *verified* entry has acquired a NEW strong variant
// (real-name-like, not a weak honorific) that its canonical+variants do not already contain. That is fresh
// evidence the settled spelling may be wrong, so the entry is force-reopened (re-verified this batch) and a note
// is carried out. Only 'verified' entries are eligible — a 'user' decree is a human ruling that a new ASR variant
// must NOT silently override (excludeVerified/applyVerifiedEntry keep locking it); 'recheck' is already re-queued.
// Match prior↔fresh by a shared STRONG name (same rule as mergeEntityLists.strongSet), then require the fresh
// cluster to contribute a strong name the prior entry lacks.
function contradictionReopen(prior, fresh) {
  const empty = { writings: [], notes: [] }
  if (!prior || !fresh) return empty
  const strongOf = (e) => [e.canonical, ...(e.variants || [])].map(stripDesc).filter((n) => n && !isWeakKey(n))
  const allNamesOf = (e) => new Set([e.canonical, ...(e.variants || [])].map(stripDesc).filter(Boolean))
  const freshEntries = [...(fresh.people || []), ...(fresh.brands || []), ...(fresh.terms || [])]
  const freshStrong = freshEntries.map((e) => ({ e, strong: strongOf(e) }))
  const priorVerified = [...(prior.people || []), ...(prior.brands || []), ...(prior.terms || [])].filter((e) => e && e.confidence === 'verified')
  const writings = []
  const notes = []
  const seen = new Set()
  for (const pe of priorVerified) {
    const pStrong = new Set(strongOf(pe))
    if (!pStrong.size) continue
    const pNames = allNamesOf(pe)
    // A fresh cluster that shares ≥1 strong name with this prior entry AND carries a strong name the prior entry
    // does not already list → a contradicting new writing. (stripDesc-compared throughout so an annotated writing
    // like 沈其安（示例公司）still matches the bare form.)
    let newVariant = null
    for (const { strong } of freshStrong) {
      if (!strong.some((n) => pStrong.has(n))) continue          // not the same entity
      const extra = strong.find((n) => !pNames.has(n))            // a strong name the prior entry lacks
      if (extra) { newVariant = extra; break }
    }
    if (!newVariant) continue
    for (const n of pNames) if (!seen.has(n)) { seen.add(n); writings.push(n) }
    notes.push(`“${pe.canonical}”往批核实结论遇到新写法证据“${newVariant}”，已重新入队核实`)
  }
  return { writings, notes }
}

// M9b — rotating spot re-verify. excludeVerified drops ALL verified entries forever; this cycles the N=2 OLDEST
// verified entries (by their 〔核实·YYYY-MM〕 date — the marker format parseGlossary decodes into confidenceDate)
// back into the verify candidate pool each batch, so a stale canonical is eventually re-examined even absent any
// contradiction signal. Undated legacy 〔核实〕 markers (confidenceDate '') count as OLDEST (they sort first). Only
// 'verified' entries rotate: 'user' is a human decree (never auto-rechecked), 'recheck' is already re-queued.
// Returns { writings, count, oldest } where oldest is the earliest date string ('' → undated) for the log line.
// A re-confirmed entry gets a refreshed date automatically (confidenceMark tier 2 re-stamps 〔核实·<thisDate>〕);
// a changed answer flows through glossaryConflicts. Rotation is a no-op for an entry not mentioned this batch.
const ROTATE_REVERIFY = 2
function rotateReverify(prior, n = ROTATE_REVERIFY) {
  const empty = { writings: [], count: 0, oldest: null }
  if (!prior || n <= 0) return empty
  const verified = [...(prior.people || []), ...(prior.brands || []), ...(prior.terms || [])].filter((e) => e && e.confidence === 'verified')
  if (!verified.length) return empty
  // Sort oldest-first: undated ('') sorts before any real YYYY-MM (string compare, '' < '2020-01'); a plain
  // lexical compare on YYYY-MM is a correct chronological order. Ties keep input (glossary) order via index.
  const sorted = verified
    .map((e, i) => ({ e, i, d: e.confidenceDate || '' }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i))
  const pick = sorted.slice(0, n)
  const writingsOf = (e) => [e.canonical, ...(e.variants || [])].map(stripDesc).filter(Boolean)
  const writings = []
  const seen = new Set()
  for (const { e } of pick) for (const w of writingsOf(e)) if (!seen.has(w)) { seen.add(w); writings.push(w) }
  return { writings, count: pick.length, oldest: pick.length ? (pick[0].d || '') : null }
}

// P3 — cross-interview speaker registry: unify speakers recurring across ≥ 2 files (chiefly the interviewer)
// into one entry with the files they appear in. A derived view of speakersByFile (re-generated each render).
function buildSpeakerRegistry(speakersByFile) {
  const map = new Map()
  for (const g of speakersByFile || []) {
    for (const sp of g.speakers || []) {
      if (!sp || !sp.label) continue
      let e = map.get(sp.label)
      if (!e) { e = { label: sp.label, role: sp.role || '?', identity: sp.identity || '', files: [] }; map.set(sp.label, e) }
      if (!e.identity && sp.identity) e.identity = sp.identity
      if (g.label && !e.files.includes(g.label)) e.files.push(g.label)
    }
  }
  return Array.from(map.values()).filter((e) => e.files.length >= 2)
}

// P4 — conflict surfacing: when this batch's verify resolves a name the prior glossary already records
// under a DIFFERENT strong canonical, surface it as an open question rather than silently keeping or
// overwriting either. (mergeIntoPrior keeps the prior canonical; this just flags the disagreement.)
function glossaryConflicts(prior, verified) {
  if (!prior || !verified) return []
  const priorEntries = [...(prior.people || []), ...(prior.brands || []), ...(prior.terms || [])]
  const out = []
  for (const r of verified.resolved || []) {
    if (!r || !r.query || !r.canonical) continue
    const pe = priorEntries.find((e) => [e.canonical, ...(e.variants || [])].map(stripDesc).includes(stripDesc(r.query)))
    if (pe && stripDesc(pe.canonical) !== stripDesc(r.canonical) && !(pe.variants || []).map(stripDesc).includes(stripDesc(r.canonical)) && !isWeakKey(stripDesc(pe.canonical)))
      out.push(`核实冲突：本轮核实「${r.query}」→「${r.canonical}」，但往次校对表记为「${pe.canonical}」——请确认以哪个为准（未自动改写）`)
  }
  return out
}

// P4b — cross-batch weak-name ambiguity flag: mergeIntoPrior deliberately does NOT merge weak-only
// honorific entries (王总 / 李总), because two interviews' "王总" may be different people — auto-merging
// would be the over-merge bug. But silently accumulating two identical "王总" rows across batches isn't
// surfaced by dedup (which only sees the current batch). So when this batch has a weak-only entity whose
// canonical exactly matches a prior weak-only entry, flag it as an open question (with both hints) for the
// human to disambiguate / supply a real name — never auto-merged.
const isStrongName = (e) => [e.canonical, ...(e.variants || [])].map(stripDesc).some((n) => n && !isWeakKey(n))
function weakDupFlags(prior, fresh) {
  if (!prior) return []
  const priorWeak = [...(prior.people || []), ...(prior.brands || []), ...(prior.terms || [])].filter((e) => e.canonical && isWeakKey(stripDesc(e.canonical)) && !isStrongName(e))
  const out = []
  for (const fe of [...(fresh.people || []), ...(fresh.brands || []), ...(fresh.terms || [])]) {
    if (!fe.canonical || !isWeakKey(stripDesc(fe.canonical)) || isStrongName(fe)) continue
    const pe = priorWeak.find((e) => stripDesc(e.canonical) === stripDesc(fe.canonical))
    if (pe) out.push(`称呼歧义：「${stripDesc(fe.canonical)}」往次校对表与本轮各有一条（往次：${pe.hint || '无说明'}；本轮：${fe.hint || '无说明'}）——可能同一人、也可能不同人；弱称呼脚本不自动合并，请确认是否同指并尽量补真名。`)
  }
  return out
}

// ---------- user-decreed canonical overrides (钦定正名的结构化否决权) ----------
// The forensic finding: a user's Step-0 decree (“口语 X/Y 一律写作 Z”) had no *structural* veto — it lived in
// prose and the merge/verify/name-guard machinery could quietly ignore or overrule it. applyCanonicalOverrides
// gives that decree teeth by rewriting the merged clusters BEFORE verify/render:
//   · Any cluster whose canonical or a variant matches an override's canonical/variants (any writing) is forced
//     to override.canonical; every other writing folds into variants (deduped). The cluster is marked locked.
//   · If an override matches SEVERAL clusters, they COLLAPSE into one — the decree overrides the weak-key
//     no-merge guard (isWeakKey / clusterEntities never merge on a bare 王总), because the user has *explicitly*
//     said these are the same; an explicit human merge is not the over-merge bug that guard defends against.
//   · An override that matches NOTHING still yields a locked cluster (canonical + its variants), so the refine
//     glossary is GUARANTEED to carry the decreed spelling even if the scout never surfaced it.
//
// A `locked` cluster's contract (consumed by the next task; stated here so the wiring is unambiguous):
//   · skip网络 verify (the user already decided — nothing to look up)
//   · skip the person name-guard in applyVerifiedEntry (a verifier disagreement must NOT override a decree)
//   · render without ⚠ (it is settled, not suspect) — it carries 〔用户钦定〕 via confidenceMark instead
//   · excludeVerified treats it as already-verified (never re-checked, never dropped)
// lockReason defaults to '用户钦定'; a supplied override.note is kept verbatim (e.g. “创始人本人确认”).
//
// Pure: never mutates the input clusters or overrides; returns a fresh array. Output order is stable — each
// surviving/locked cluster keeps the position of its first contributing input cluster; overrides that matched
// nothing append their fresh locked cluster at the end, in override order.
function applyCanonicalOverrides(clusters, overrides) {
  const src = Array.isArray(clusters) ? clusters : []
  const ovs = Array.isArray(overrides) ? overrides : []
  // Normalise each override to a canonical + a match-set of all its writings (canonical ∪ variants),
  // compared via stripDesc so an annotated writing (王总（示例公司董事长）) still matches the bare form.
  const specs = ovs
    .map((o) => {
      const canonical = ((o && o.canonical) || '').trim()
      if (!canonical) return null
      const writings = [canonical, ...((o && o.variants) || [])].map((s) => (s || '').trim()).filter(Boolean)
      const match = new Set(writings.map(stripDesc).filter(Boolean))
      return { canonical, writings, match, note: (o && o.note) || '' }
    })
    .filter(Boolean)
  const withConflicts = (arr, conflicts) => { Object.defineProperty(arr, 'conflicts', { value: conflicts, enumerable: false }); return arr }
  if (!specs.length) return withConflicts(src.map((c) => Object.assign({}, c, { variants: [...(c.variants || [])] })), [])

  const clusterWritings = (c) => [c.canonical, ...(c.variants || [])].map((s) => (s || '').trim()).filter(Boolean)
  const hits = (c, spec) => clusterWritings(c).map(stripDesc).some((n) => spec.match.has(n))

  // SF-2 — spec grouping via union-find, so a cluster hit by MULTIPLE decrees collapses those decrees into ONE
  // locked cluster instead of the (buggy) first-spec-consumes + second-spec-phantom path. Two specs are unioned
  // when EITHER (a) they name the same canonical (intentional dedup — pre-existing behaviour) OR (b) they both
  // hit the same source cluster (the overlap case — a conflict). The group's canonical is its first spec by
  // original decree order; every other spec's writings fold into variants.
  const parent = specs.map((_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb) }
  // (a) same-canonical specs merge (keeps “two decrees naming the same canonical collapse” working).
  const byCanon = new Map()
  specs.forEach((s, i) => { if (byCanon.has(s.canonical)) union(byCanon.get(s.canonical), i); else byCanon.set(s.canonical, i) })
  // Which specs hit each cluster; (b) union all specs that co-hit one cluster (the overlap → conflict case).
  const clusterHitSpecs = src.map((c) => specs.map((s, i) => (hits(c, s) ? i : -1)).filter((i) => i >= 0))
  clusterHitSpecs.forEach((hitList) => { for (let k = 1; k < hitList.length; k += 1) union(hitList[0], hitList[k]) })

  // One bucket per union-group root. writings/hints/files accumulate across the group's specs and consumed clusters.
  const buckets = new Map()   // root → { canonical, note, writings:Set, firstIdx, files, public_figure, suspect_asr, category, hints:Set, matched, canonicals:Set }
  const rootBucket = (root) => {
    let b = buckets.get(root)
    if (!b) { b = { canonical: specs[root].canonical, note: '', writings: new Set(), firstIdx: Infinity, files: new Set(), public_figure: false, suspect_asr: false, category: '', hints: new Set(), matched: false, canonicals: new Set() }; buckets.set(root, b) }
    return b
  }
  // Seed every group from its member specs (so a no-match override still emits its locked cluster). The group
  // canonical is the LOWEST spec index (root) — i.e. the first decree in the group by original order.
  specs.forEach((s, i) => {
    const b = rootBucket(find(i))
    b.canonicals.add(s.canonical)
    if (!b.note && s.note) b.note = s.note
    for (const w of s.writings) b.writings.add(w)
  })

  const consumed = new Array(src.length).fill(false)
  src.forEach((c, i) => {
    const hitList = clusterHitSpecs[i]
    if (!hitList.length) return
    consumed[i] = true
    const b = rootBucket(find(hitList[0]))
    b.matched = true
    if (i < b.firstIdx) b.firstIdx = i
    for (const w of clusterWritings(c)) b.writings.add(w)
    for (const f of c.files || []) b.files.add(f)
    b.public_figure = b.public_figure || !!c.public_figure
    b.suspect_asr = b.suspect_asr || !!c.suspect_asr
    if (!b.category && c.category) b.category = c.category
    if (c.hint) for (const h of String(c.hint).split('；')) if (h.trim()) b.hints.add(h.trim())
  })

  const lockedCluster = (b) => {
    const files = Array.from(b.files)
    return {
      canonical: b.canonical,
      variants: Array.from(new Set(Array.from(b.writings).filter((n) => n && n !== b.canonical))),
      hint: Array.from(b.hints).join('；'),
      files,
      public_figure: b.public_figure,
      suspect_asr: b.suspect_asr,
      category: b.category,
      crossFile: files.length > 1,
      locked: true,
      lockReason: b.note || '用户钦定',
    }
  }

  // Conflicts: a group that ended up merging ≥2 DISTINCT decreed canonicals AND actually consumed a cluster —
  // i.e. one cluster was claimed by competing decrees. (A pure same-canonical merge is intentional, not a conflict.)
  const conflicts = []
  for (const b of buckets.values()) {
    if (b.matched && b.canonicals.size > 1) conflicts.push({ canonicals: Array.from(b.canonicals), resolvedTo: b.canonical })
  }

  const out = []
  // Emit locked clusters that consumed at least one input cluster at the position of their first contributor,
  // interleaved with the untouched pass-through clusters, so overall order stays stable.
  const emittedAt = new Map()   // firstIdx → bucket (for matched buckets)
  for (const b of buckets.values()) if (b.matched) emittedAt.set(b.firstIdx, b)
  src.forEach((c, i) => {
    if (emittedAt.has(i)) out.push(lockedCluster(emittedAt.get(i)))
    if (!consumed[i]) out.push(Object.assign({}, c, { variants: [...(c.variants || [])] }))
  })
  // No-match groups: emit their locked clusters at the end, in group-root (first-decree) order.
  for (const root of Array.from(buckets.keys()).sort((a, b) => a - b)) { const b = buckets.get(root); if (!b.matched) out.push(lockedCluster(b)) }
  return withConflicts(out, conflicts)
}

// Apply user-decreed canonical overrides to a whole merged bundle (people/brands/terms cluster arrays),
// routing each override to the ONE category it declares (`category: 'person' | 'brand' | 'term'`, default
// 'person' — the motivating case is a spoken人名/公司写法混杂). Routing matters because applyCanonicalOverrides
// emits a locked cluster even for an override that matched nothing; applying the whole override set to all three
// lists would fabricate that decree in every category. Overrides with no (or an unknown) category fall into
// 'person'. Pure — returns a fresh bundle; the untouched fields (speakersByFile/errors/notes) pass through.
function applyOverridesToMerged(merged, overrides) {
  if (!merged) return merged
  const ovs = Array.isArray(overrides) ? overrides.filter((o) => o && o.canonical) : []
  if (!ovs.length) return merged
  const catOf = (o) => (o.category === 'brand' ? 'brand' : o.category === 'term' ? 'term' : 'person')
  const bucket = { person: [], brand: [], term: [] }
  for (const o of ovs) bucket[catOf(o)].push(o)
  const lists = { person: merged.people || [], brand: merged.brands || [], term: merged.terms || [] }
  const people = applyCanonicalOverrides(lists.person, bucket.person)
  const brands = applyCanonicalOverrides(lists.brand, bucket.brand)
  const terms = applyCanonicalOverrides(lists.term, bucket.term)

  // SF-2: collect the per-category conflict records (a cluster claimed by ≥2 competing decrees) so the pipeline
  // can surface them into openQuestions.
  const overrideConflicts = [...(people.conflicts || []), ...(brands.conflicts || []), ...(terms.conflicts || [])]

  // Risk (c): an override that hit NOTHING in its declared category, but whose writing DOES appear in a cluster of
  // ANOTHER category, is likely a mis-declared category. We still honour the declaration (a locked cluster is
  // emitted in the declared category, as designed), but flag it so the pipeline can ask the user to confirm.
  const clusterWritings = (c) => [c.canonical, ...(c.variants || [])].map((s) => stripDesc((s || '').trim())).filter(Boolean)
  const listHits = (list, o) => {
    const match = new Set([o.canonical, ...((o.variants) || [])].map((s) => stripDesc((s || '').trim())).filter(Boolean))
    return (list || []).some((c) => clusterWritings(c).some((n) => match.has(n)))
  }
  const label = { person: '人名', brand: '品牌', term: '术语' }
  const categoryWarnings = []
  for (const o of ovs) {
    const declared = catOf(o)
    if (listHits(lists[declared], o)) continue                 // matched in-category → fine
    const foundIn = ['person', 'brand', 'term'].find((k) => k !== declared && listHits(lists[k], o))
    if (foundIn) categoryWarnings.push({ canonical: o.canonical, declared: label[declared], foundIn: label[foundIn] })
  }
  return Object.assign({}, merged, { people, brands, terms, overrideConflicts, categoryWarnings })
}

// Verify-target filter: a locked (用户钦定) cluster is settled — the user already decided the spelling, so it
// must never be sent to网络 verify (nothing to look up, and a verifier disagreement must not get a vote). Drop
// locked clusters from a merged bundle before building the verify chunk list. Pure; the locked clusters still
// live in the full `merged` used for render/accumulate — only the verify view drops them.
function dropLocked(merged) {
  if (!merged) return merged
  const filt = (list) => (list || []).filter((e) => !(e && e.locked))
  return Object.assign({}, merged, { people: filt(merged.people), brands: filt(merged.brands), terms: filt(merged.terms) })
}

// ---------- filesystem-safe filename (文件名清洗) ----------
// Join point for timeline / summary / logic output filenames: an entity/topic string flows straight into a
// path, so a stray “/” would fabricate a directory and “:” / “?” / control chars break on some filesystems,
// and an over-long name can exceed the 255-byte per-component limit. safeName scrubs the reserved set (both
// ASCII and the full-width variants ASR/中文输入 commonly emit), collapses runs of whitespace to one space, trims
// leading/trailing whitespace and dots, then caps the result FIRST by code-point count (`max`, word boundaries
// not preserved) and THEN by UTF-8 byte budget (`maxBytes`) — a plain cut on each. CJK is preserved.
// SF-3: the byte cap closes a real overflow — 80 astral (4-byte) chars pass the 80-char cap yet are 320 bytes,
// blowing the 255-byte filesystem limit. Truncation drops WHOLE code points (never splits a surrogate pair /
// multibyte char), so the output is always valid UTF-8. maxBytes defaults to 255 (the actual ext4/APFS/NTFS
// per-component limit) rather than a looser ~200 so an 80-CJK-char title — 240 bytes, the common case — is left
// intact (CJK 常规路径不变). The 2-arg signature stays backward-compatible: `max` is still a CHARACTER count.
// An empty result falls back to 'untitled' so the caller never builds a path ending in a bare separator.
function safeName(s, max = 80, maxBytes = 255) {
  let out = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|]/g, ' ')   // ASCII reserved path chars
    .replace(/[：？＊]/g, ' ')         // full-width colon / question / asterisk (common in ASR/中文输入)
    .replace(/[\r\n\t\f\v]+/g, ' ')   // newlines & other control whitespace → space
    .replace(/\s+/g, ' ')             // collapse whitespace runs to a single space
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')  // strip leading/trailing dots and whitespace
  let cps = Array.from(out)                      // iterate by code point so a cut never splits a multibyte char
  if (max > 0 && cps.length > max) cps = cps.slice(0, max)
  if (maxBytes > 0) {
    // Drop trailing code points until the UTF-8 encoding fits the byte budget.
    // Pure-JS byte counting: the Workflow sandbox has no Node Buffer global.
    const utf8Len = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4 } return n }
    while (cps.length && utf8Len(cps.join('')) > maxBytes) cps.pop()
  }
  out = cps.join('').replace(/[.\s]+$/g, '')     // truncation may re-expose a trailing dot/space
  return out || 'untitled'
}



// Detect a phonetic-suspicion signal in a verify chunk's entity table, to decide whether the hypothesis-driven
// heavy protocol is warranted (kept OFF for clean chunks so the prompt stays lean). Signals:
//  · scout/glossary suspicion notes (同音/疑似/转写/存疑) or a ⚠ / （音） mark verifyChunks already stamps;
//  · a spaced or hyphenated Latin token of shape letter + Word (e.g. "K Frame" / "K-Frame") — a classic ASR split.
// Deliberately NOT a signal: a bare all-caps run (AI/CEO/GPU/API/SDK). Those appear in the hint text of nearly
// every real chunk, so treating them as suspect tripped the heavy protocol almost always — an all-caps token is
// suspect ONLY when it also carries one of the explicit flags the notes branch above already catches.
// The letter+Word separator class spans ASCII space/hyphen AND the Unicode hyphen/dash variants and wide spaces
// an ASR/typesetter may emit (U+2010‑U+2014, U+2212 minus, U+00A0 NBSP, U+3000 full-width space) — otherwise a
// "K‑Frame" spelled with a non-ASCII hyphen would slip past.
const LETTER_WORD_SEP = '[ \\u00A0\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212\\u3000-]'
const LETTER_WORD_RE = new RegExp(`(^|[^A-Za-z])[A-Za-z]${LETTER_WORD_SEP}[A-Z][a-z]+`)
function looksPhoneticallySuspect(table) {
  const t = String(table || '')
  if (/同音|疑似|转写|存疑|⚠|（音）|\(音\)/.test(t)) return true
  if (LETTER_WORD_RE.test(t)) return true   // "K Frame" / "K-Frame" / "K‑Frame" (Unicode dash/space)
  return false
}

// The hypothesis-driven verification protocol, emitted only for chunks that carry a phonetic-suspicion signal.
// Verbatim concepts: candidate-first search, tiered evidence, coattail inversion, context-fit, and the two-key rule.
const VERIFY_SUSPECT_PROTOCOL = `
【疑似口误·假设优先核实法（本清单含疑似转录/同音写法，务必逐条执行）】
1. 检索前先写候选：结合上方采访背景与线索、你自己的知识，先为存疑写法写下 1-3 个候选正确所指，再动手查。
2. 字面写法与每个候选都要检索（别只搜字面原形）。
3. 证据分级取信：官方域名／权威媒体／百科 ＞ 目录站与 SEO 博客 ＞ 自我推销/软文贴。结论里注明命中来源属于哪一级。
4. 搭便车反转规则：一个以该字面写法命名、但自身身份寄生于另一产品的站点（“Powered by X”“转售/代理 X”“X 分销/订阅站”），**不能**作为“该字面写法是独立实体”的证据——它恰恰是修正假设 X 成立的证据。
5. 上下文吻合校验：把胜出的身份放回转录里对该实体的说法（其提及线索已在清单的“线索”里）核对；与转录内说法矛盾的身份，一律不得判为已核实。
6. 中文人名汉字证据：身份相符、英文名或拼音相符，**不能证明中文名具体用哪个同音字**。若 canonical 是中文人名，至少 1 个所列来源页面必须直接显示该完整汉字写法；source 中原样写出页面所见中文名，且仅此时置 name_script_exact:true。只有 Lin Chuan / Chen Tao 一类英文、拼音或论文作者罗马字时，name_script_exact 必须为 false，不能据此“核实”林川/林传、陈涛/陈焘中的任何一个。
7. 两把钥匙规则：当结论是**与口播形不同的名字**（指代替换）时，必须同时满足【高级别来源】与【上下文吻合】两项，才可写进 resolved；中文人名还必须满足上一条【汉字原文证据】。只满足其一或都不满足，就写进 **contested**——保留口播原形，在 contested 里同时记下字面假设（literal + literal_tier）与修正假设（correction + correction_tier），绝不擅自替换。
8. two_key 标记：对本清单里疑似口误/两解的实体下**决定性结论**、写进 resolved 时，仅当【高级别来源（官方域名／大媒体／百科）】与【上下文吻合】两项**同时成立**，才置 two_key:true；中文人名若 name_script_exact 不为 true，two_key 也绝不能为 true。搭便车／SEO／分销／软文站永远不能支撑 two_key（哪怕它的域名恰好等于该写法）。缺 two_key 的结论按存疑对待——不足以让该实体退出「两解」状态。`

// ---------- prompt builders ----------
// Computed read plan: pagination is specified explicitly rather than left to the model
// (Haiku tends to take 8–9 small 100–200-line bites; Opus reads large chunks —
// the same instruction “page through the file” is interpreted differently per tier).
// Since f.lines is known at script time, we emit an exact Read checklist; the model
// just executes it, so read behavior is decoupled from model tier.
// Page size is constrained by the Read tool's ~25K-token limit:
// dense Chinese interviews run ~30–40 tok/line → 600 lines/page is safe.
const READ_PAGE = 600          // line cap: dense Chinese ~600 lines ≈ 18–22K tok, with headroom
const READ_BYTES_PER_PAGE = 45000  // density guard: ~45 KB/page ≈ 18K tok (Chinese UTF-8 ≈ 2.5 B/tok); only used to lower page size to prevent silent truncation at the token limit — never raised (an oversized page that gets cut silently loses content, not worth saving one round-trip)
function readPlan(f) {
  const n = f.lines || 0
  if (!n) return `用 Read 分页读完整份文件（每页 ${READ_PAGE} 行，一直读到最后一行）。`
  let page = READ_PAGE
  if (f.bytes) page = Math.min(READ_PAGE, Math.max(150, Math.floor(n * READ_BYTES_PER_PAGE / f.bytes)))
  if (n <= page) return `读取计划：一次 Read(offset=0, limit=${page}) 即可读完全文（共 ${n} 行）。`
  const steps = []
  for (let o = 0; o < n; o += page) steps.push(`Read(offset=${o}, limit=${page})`)
  return `读取计划（共 ${n} 行，照此执行，不要用更小的分页）：\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
}

// Read plan for one chunk's source span [startLine, endLine], with ~30 lines of lead-in/lead-out so
// the agent can see the full speaker turns straddling its boundaries (it only EMITS the turns it owns,
// per the ownership rule in refinePrompt's chunk branch). Same density-aware page sizing as readPlan.
const CHUNK_MARGIN = 30
function readPlanRange(f, startLine, endLine) {
  const lines = f.lines || 0
  const from = Math.max(1, (startLine || 1) - CHUNK_MARGIN)               // 1-indexed first line to read
  const to = lines ? Math.min(lines, (endLine || lines) + CHUNK_MARGIN) : (endLine || 0) + CHUNK_MARGIN // 1-indexed last line
  let page = READ_PAGE
  if (f.bytes && lines) page = Math.min(READ_PAGE, Math.max(150, Math.floor(lines * READ_BYTES_PER_PAGE / f.bytes)))
  const steps = []
  for (let o = from - 1; o < to; o += page) steps.push(`Read(offset=${o}, limit=${Math.min(page, to - o)})`) // o is a 0-based offset
  return steps
}

function headingNote(policy) {
  if (policy === 'keep') return '【小标题处理】源文件已带小标题：按用户要求**保留原有小标题**，只做必要的错字修正，不重新分段。'
  if (policy === 'regenerate') return '【小标题处理】源文件已带（记者/速记的）小标题：按用户要求**全部去掉**，根据内容理解重新生成小标题。'
  return ''
}

// Known-entities seed from a persistent per-company glossary (P1): when prior interviews for this
// company have already been processed, tell the scout the established 写法 so it reuses them instead
// of re-deriving (and risking a divergent spelling), and focuses its budget on genuinely new entities.
function knownNote(a) {
  const p = a.prior
  if (!p) return ''
  const top = (list, n) => (list || []).slice(0, n).map((e) => e.canonical + (e.variants && e.variants.length ? `（亦作 ${e.variants.slice(0, 3).join('、')}）` : '')).filter(Boolean).join('；')
  const ppl = top(p.people, 40), br = top(p.brands, 40), tm = top(p.terms, 40)
  const spk = Array.from(new Set((p.speakersByFile || []).flatMap((g) => g.speakers || []).map((s) => s.label + (s.identity ? `=${s.identity}` : '')).filter(Boolean))).slice(0, 30).join('；')
  if (!ppl && !br && !tm && !spk) return ''
  return `【已知实体（本公司往次访谈已确认，请沿用这些写法、不要另起新写法；重点是发现新实体与新变体，并把本份里这些已知实体出现的新变体写进 variants）】
${ppl ? `人名：${ppl}\n` : ''}${br ? `品牌/公司/产品：${br}\n` : ''}${tm ? `术语：${tm}\n` : ''}${spk ? `已知发言人：${spk}` : ''}`
}

function scoutPrompt(f, a, chunk) {
  const isChunk = !!(chunk && chunk.count > 1)
  const where = isChunk
    ? `本份文件：${f.path}——这是它的**第 ${chunk.idx}/${chunk.count} 段**（源文件第 ${chunk.startLine}–${chunk.endLine} 行，全文约 ${f.lines} 行）。这是大文件的分段侦察，各段结果会自动合并；只管**本段**，不必顾及别段。`
    : `本份文件：${f.path}（约 ${f.lines} 行）`
  const readBlock = isChunk
    ? `任务：用 Read **只读本段** [${chunk.startLine}, ${chunk.endLine}] 行（已含前后约 ${CHUNK_MARGIN} 行衔接），**不精校、不联网、不大段摘录原文**；只抽取**本段内**出现的实体与发言人。
读取计划（照此执行，不要用更小的分页）：
${readPlanRange(f, chunk.startLine, chunk.endLine).map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : `任务：用 Read 把这份转录**整份读完**（绝不能只读开头），**不精校、不联网、不大段摘录原文**。
${readPlan(f)}`
  const endingBullet = isChunk
    ? (chunk.isLast
        ? `- ending_anchor：本段含全文结尾——line=文件总行数（约 ${f.lines}）；text=全文最后一句话**原样照抄**。`
        : `- ending_anchor：本段不是全文结尾——line=本段最后一行行号（约 ${chunk.endLine}）、text 留空或填该行原文即可（合并时以含结尾的那段为准）。`)
    : `- ending_anchor：line=文件总行数；text=原文最后一句话**原样照抄**。`
  return `你是访谈转录「侦察」子代理。

采访背景：${a.background}

${where}
${f.speakerHints ? `已知发言人线索：${f.speakerHints}` : ''}
${f.notes ? `额外提醒：${f.notes}` : ''}
${knownNote(a)}

${readBlock}
读完后按 schema 返回结构化侦察结果：
- speakers：为源转录的**每一条发言轨道**填写 label（源标签原样）、role、identity、output_label、output_label_confidence、output_label_evidence 和一处 sample。sample 必须是该轨道一整行**逐字照抄**的原文标签样例，保留行首时间码/括号、标签、冒号及同行正文，不能省略或改写；代码只会用能在原稿逐字回查的 sample 恢复陌生格式。output_label 是精校稿最终可见的纯标签：能从全文判断具体是谁时，**只写真名**（如「刘益枫」，不要带公司/title）；真名不确定时才写可区分角色（如「记者」「受访者」「PR」）；连角色也拿不准则留空，绝不猜人名。相同源标签在全文只能对应同一个 output_label。
  · 具体姓名只有在**本人自我介绍、speakerHints 明示、或另一条清楚分轨的发言直接称呼此人**等直接证据成立时，才可标 output_label_confidence=high，并把依据原句写进 output_label_evidence。只是在该轨道正文里提到某个名字、转述某人观点、或混轨段里出现“赵磊，你们组……”一类喊话，不能证明该轨道本人就是赵磊；这种情况 confidence 只能 medium/low，output_label 应退回角色。
- 特别留意**口头拼字澄清段**（“哪个杰？”“捷报的捷”“口天吴”）——这是人名/术语正确写法的**最强内部证据**：把澄清后的写法记为 canonical，hint 注明「本人口述拼字确认」。
- people / brands / terms：反复出现的实体；canonical 填你判断的最可信写法，variants 列文中全部其它写法（含疑似同音误写），hint 一句定位线索；公众人物标 public_figure=true。
  · **知名实体用你已知的正确写法做 canonical**：若这是你认得的知名公司/产品/机构/公众人物，canonical 一律填**你所知的规范写法**，哪怕转录通篇是另一种听写——把转录里的写法放进 variants。例：转录一直写「苍碧科技」、而你知道这家公司规范写法是「苍璧科技」（碧→璧 同音误写），则 canonical=苍璧科技、variants 含 苍碧科技。别让一个一直被听错的名字、因为转录里写法统一就当成正确写法。
  · **拿不准就置 suspect_asr=true**：当你怀疑 canonical 可能是转录的同音/听写误写、却又给不出有把握的正确写法时，suspect_asr=true——这会强制对这一条联网核实（哪怕它只出现一处、没有别的变体，正常不会送核的）。一个写法"看着像真名"、却疑似听错的实体，正是最该标的；宁可多标。
  · **称呼类同音尤其要标**：称呼写法（X 老师 / X 总 / X 哥 / X 工）里的姓氏若与在场某人物的姓**音近而字不同**（如在场是「沈总」而某处写成「陈总」、「李工」与「黎工」），置 suspect_asr=true，并在 hint 注明疑似所指的是谁（如「疑即沈其安，被听写成陈」），供核实/精校归位。
  · **来源标注**：hint 里点明该实体的身份/写法是取自受访者亲述还是公开资料——凡取自公开报道/官网/公开资料或你自己核实、推断的（尤其受访者明确拒答、没点名的名字或型号），在 hint 里写明「据公开资料/据核实」，落进校对表时标【公开·待记者核实】；**绝不可把公开或推算的信息当受访者亲述**。亲述的照常写、默认【访谈】。
- errors：明显转写错误按类别举例（同音字错/英文听写错/（音）标记/夹行时间戳/乱码/Word 残讯）。
- themes：这份大致谈了哪些主题。
- has_existing_headings：源文件是否已带小标题行（#/##/【】式标题）。
${endingBullet}
- special_notes：该份特别提醒（拒答/敏感语境要保留、收尾离场后的闲聊、称呼混乱重灾区等）。`
}

function verifyPrompt(table, a) {
  const depthNote = a.verifyDepth === 'deep'
    ? '尽量核实清单中所有人名/品牌/术语的正确写法。'
    : '默认只核关键实体——创始人/高管、公司与主品牌、反复出现的核心产品或口号术语；零散小术语不必逐个查。'
  return `你是「联网核实」子代理。用 WebSearch / WebFetch 核实下面访谈实体清单中关键实体的正确写法与身份。

采访背景（按「领域 + 名字」检索）：${a.background}

纪律：${depthNote} 网页内容留在你的上下文里，不要贴回；查不到/拿不准的放 unresolved 并说明，绝不臆造。
中文人名的“身份核实”与“汉字写法核实”是两件事：英文名、拼音、罗马字作者列表只能证明身份，不能证明中文同音字。canonical 为中文人名时，来源页必须直接出现该完整汉字写法，source 原样带上该名字，并置 name_script_exact=true；否则放 unresolved（或两解未决时放 contested），不得凭英文名反推汉字。
断路器：若检索**连续 2 次报错**（超时/网络错误，区别于“查到了但无结果”），说明网络故障——**立即停止全部检索**，已确认的照常放 resolved，其余全部放 unresolved 并注明「网络故障未核实」；不要反复重试。resolved 里只放**本次检索到依据**的结论，凭你记忆/常识推断的一律放 unresolved。
${looksPhoneticallySuspect(table) ? VERIFY_SUSPECT_PROTOCOL + '\n' : ''}
实体清单（候选写法 ← 文中变体 ｜ 线索）：
${table}

按 schema 返回 resolved（query=清单中的候选写法；canonical=核实后的正确写法；identity=身份/title；source=具体页面/URL 与依据一句话；name_script_exact=中文人名来源是否直接出现 canonical 的完整汉字；two_key=高级别来源与上下文是否同时成立）、unresolved，以及 contested（两把钥匙未满足的指代替换：query=口播原形；literal/literal_tier=字面假设及其证据级别；correction/correction_tier=修正假设及其证据级别；note=一句原因）。
注意：identity/source/note 等中文说明会原样写进存档校对表——遵守排版规范：阿拉伯数字、中文与英文/数字间加半角空格、引号用全角 “”（如“据 36 氪 2021 年报道”）。canonical/query 是写法本身，不要改动其内部空格。`
}

function resolvedSpeakerBlock(f, finding = {}) {
  const mappings = (f.speakerResolution && f.speakerResolution.mappings) || []
  const speakerMode = (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode || (mappings.length ? 'tracked' : null)
  const scout = (finding.speakers && finding.speakers.length)
    ? JSON.stringify(finding.speakers)
    : '侦察未提取到发言人'
  if (speakerMode === 'untracked') return `【全文结构契约：无说话人轨道】源文没有说话人标签，可能是独白、口述或无标签笔记。保持这种无标签形式：不要改写成问答，不要添加“记者/受访者/姓名：”等任何说话人标签，也不要把转述改造成新的直接引语。本条覆盖通用规范 1、4a、7 中关于对话体和标签的要求。`
  if (speakerMode === 'ambiguous') return `【全文结构契约：疑似说话人格式未确认】源文出现了疑似发言轨道，但确定性代码与侦察证据未能建立可靠映射。逐字保留源稿中已有的标签、时间码和轮次边界；不要把它改成独白，也不得猜姓名、创造标签、合并轨道或把转述改成直接引语。本稿会进入人工复核，不要自行“修好”结构。`
  if (!mappings.length) return `【全文发言人统一结果】未取得身份映射。只能保留源稿已有标签；不得据语境猜姓名、创造新标签或合并轨道。`
  const rows = mappings.map((mapping) => `${mapping.sourceLabel} → ${mapping.outputLabel}`).join('；')
  return `【全文发言人统一结果】${rows}
你读取的源文件是依据上述结果生成的输入副本，标签行已经一次性替换完毕；这些**替换后的姓名/角色**是全篇唯一标签。照抄这些标签，不要改回原来的“发言人 N/说话人 N”，也不要在各分块里另起一套名字。
【Scout 识别依据】${scout}`
}

// One serialization contract for every turn-ir-v2 editing pass. Initial Refine and quality repair both
// interpolate this exact block; neither may import the legacy direct-Markdown wrapper rules.
function turnIrV2PromptBlock() {
  return `【不可变数据契约】
${TURN_IR_V2_RULES}
- 分段不等于改来源：长 turn 可以用多个 split block；同说话人 ASR 碎轮可以用一个 merge block。来源关系服务于回溯，不要求成稿机械一对一。`
}

function refinePrompt(f, glossary, finding, a, chunk) {
  // Scout results may be missing fields (schema is not strict, to avoid validation-retry loops) — if the anchor is absent, let the refine agent Read the source file's tail itself
  const anchor = finding.ending_anchor || {}
  const notes = (finding.special_notes || []).map((s) => '- ' + s).join('\n')
  const sourcePath = f.refinePath || f.path
  const speakers = resolvedSpeakerBlock(f, finding)

  if (f.refineContract) {
    const contractPath = (chunk && chunk.inputPath) || sourcePath
    const outPath = chunk && chunk.count > 1 ? partPath(f.outPath, chunk.idx) : f.outPath
    const turnCount = (chunk && Array.isArray(chunk.turnIds))
      ? chunk.turnIds.length
      : ((f.refineContract.records || []).length)
    const chunkNote = chunk && chunk.count > 1
      ? `这是第 ${chunk.idx}/${chunk.count} 块；输入文件已经只保留本块拥有的 ${turnCount} 个 source turn，不要再按原稿行号自行切边界。`
      : `这是整份文件，共 ${turnCount} 个 source turn。`
    return `你是访谈转录「精校」子代理。宿主程序已经把原稿转换成不可变的 source turn 账本；你把它们映射成可变的 output block，文档结构与说话人标签由宿主程序最终渲染。

【统一校对表】（「联网核实结论」与「写法统一」优先；标 ⚠ 的条目未采纳、勿套用）：
${glossary}

【结构化输入】${contractPath}
【输出】Write 到 ${outPath}
${chunkNote}
先完整 Read 结构化输入；它已经是宿主生成的默认 \`keep\` output-block 草稿。直接在这份 envelope 上精校，只有确实发生合并、拆分或折叠时才修改来源关系。

${turnIrV2PromptBlock()}

${notes ? `【该份特别提醒】\n${notes}\n` : ''}${headingNote(a.headingPolicy)}

${EDITORIAL_RULES}

完成后按 schema 返回 path（=${outPath}）、headings（你添加的 ## 小标题）、key_fixes、open_questions。`
  }

  // Chunked branch: this agent refines ONLY its line span and writes a part file; a stitch agent merges
  // the parts afterwards. Ownership rule keeps the K parallel agents from overlapping or leaving a gap.
  if (chunk && chunk.count > 1) {
    const outPart = partPath(f.outPath, chunk.idx)
    const steps = readPlanRange(f, chunk.startLine, chunk.endLine)
    const headBlock = chunk.isFirst
      ? `【抬头】你是第 1 块：第一行写 \`# ${f.title}\`，第二行写 \`${f.subtitle}\`，然后从第一个 \`##\` 小标题开始正文。`
      : `【抬头】你是第 ${chunk.idx} 块（非首块）：**不要写 H1 标题、不要写说明行**，直接从一个 \`##\` 小标题开始正文。`
    const speakerMode = (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode
    const trackless = speakerMode === 'untracked' || speakerMode === 'ambiguous'
    const boundaryRules = trackless
      ? `- 本文没有可作为分块依据的已确认说话人轨道；以段落或列表内容块为边界。一个内容块归属于其首行行号落入的分块，整块归一处、绝不拆开。
- 你的起点：从行号 ≥ ${chunk.startLine} 的第一个完整内容块开始。${chunk.isFirst ? '你是第 1 块，从文件开头正常处理。' : `若第 ${chunk.startLine} 行位于上一内容块中间，跳过该块，从下一个完整块开始。`}
- 你的终点：凡首行行号 ≤ ${chunk.endLine} 的内容块都归你；${chunk.isLast ? '你是最后一块，精校到文件末尾。' : `最后一个内容块即使越过第 ${chunk.endLine} 行也要处理完整，但不要开始首行号 > ${chunk.endLine} 的下一块。`}`
      : `- “一轮发言”以发言人标签行开头（如「发言人 N」「记者：」「张三：」）。一轮发言归属于**其开头标签所在行号**落在哪一块的范围，就由哪一块精校，整轮归一块、绝不拆到两块。
- 你的起点：从行号 ≥ ${chunk.startLine} 的**第一个发言人标签**开始精校。${chunk.isFirst ? '（你是第 1 块，从第 1 行正常开始，不跳过任何内容。）' : `若第 ${chunk.startLine} 行正处在某轮发言中间（该轮标签行在 ${chunk.startLine} 之前），那一轮属于上一块——**跳过、不要精校它**（往前多读几行确认标签位置即可；若那轮特别长、邻接内容里没看到它的标签，就再往前读到看见为止）。`}
- 你的终点：凡标签行号 ≤ ${chunk.endLine} 的发言轮都归你；${chunk.isLast ? '你是最后一块，精校到文件末尾。' : `若你负责的最后一轮发言正文越过第 ${chunk.endLine} 行，**继续往下读、把这一轮精校完整**；但**不要开始**任何标签行号 > ${chunk.endLine} 的发言轮（那是下一块的）。`}`
    const tailNote = chunk.isLast
      ? `【收尾】你这一块覆盖到源文件结尾（约第 ${f.lines} 行${anchor.text ? `，最后一句「${anchor.text}」` : ''}）——必须精校到最后，正文绝不能中途断掉（结尾客套可折成一句说明）。`
      : `【收尾】你不是最后一块，正常精校到你负责的最后一${trackless ? '内容块' : '轮发言'}即可，**不要补任何结束语 / 总结 / 收束注**——后面还有别的块接着写。`
    return `你是访谈转录「精校」子代理（分块并行：本份共 ${chunk.count} 块，你负责第 ${chunk.idx} 块）。

【写法对照表（精校用）】（表中已是核实后的统一写法，照此统一人名/品牌/术语——**标 ⚠ 的人名条目未采纳、勿套用**；「写法统一」一节的术语/品牌请**初次落笔就写对**，不要先写错再回头逐字改）：
${glossary}

【源文件】${sourcePath}（全文约 ${f.lines} 行）。你只负责其中**第 ${chunk.startLine}–${chunk.endLine} 行**这一段。
读取计划（首尾各多读约 ${CHUNK_MARGIN} 行邻接内容，好看清边界处的整轮发言；只精校属于你的那些发言轮）：
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

【分块边界规则——务必严格，确保各块不重不漏】
${boundaryRules}

【输出】Write 到 ${outPart}
${headBlock}
${speakers}
${notes ? `【该份特别提醒】\n${notes}` : ''}
${headingNote(a.headingPolicy)}

${RULES}

${tailNote}

完成后按 schema 返回 path（=${outPart}）、headings（你这一块分的 ## 小标题）、key_fixes、open_questions。`
  }

  const anchorNote = anchor.text
    ? `【收尾锚点】源文件共 ${anchor.line || f.lines} 行，最后一句：「${anchor.text}」。成稿必须覆盖到此处（收尾客套可折成一句说明；正文绝不能中途断掉）。`
    : `【收尾锚点】源文件共约 ${f.lines} 行——先用 Read 看源文件最后约 30 行确认结尾内容，成稿必须覆盖到源文件结尾（收尾客套可折成一句说明；正文绝不能中途断掉）。`
  return `你是访谈转录「精校」子代理。

【统一校对表】（「联网核实结论」与「写法统一」两节优先级最高，与前文冲突时以它们为准——但其中**标 ⚠ 的条目未被采纳、勿套用**；「写法统一」里的术语/品牌请**初次落笔就写对**，不要先写错再回头逐字改）：
${glossary}

【源文件】${sourcePath}（约 ${f.lines} 行）。${readPlan(f)}
【输出】Write 到 ${f.outPath}
【抬头】第一行 \`# ${f.title}\`；第二行 \`${f.subtitle}\`
${speakers}
${notes ? `【该份特别提醒】\n${notes}` : ''}
${headingNote(a.headingPolicy)}

${RULES}

${anchorNote}

完成后按 schema 返回 path、headings、key_fixes、open_questions。`
}

// Merge the K chunk part-files into the final transcript in the Workflow sandbox. Universal injects a
// deterministic fs stitch capability; this prompt is only the no-fs fallback and still requires pure
// concatenation, never retyping the content. The source-aware audit backstops a bad merge.
function stitchPrompt(f, chunks) {
  const parts = chunks.map((c) => partPath(f.outPath, c.idx))
  const list = parts.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
  return `你是「分块拼接」子代理。把一份访谈精校稿的 ${chunks.length} 个分块按顺序合并成一份最终成稿——**纯机械拼接、逐字照搬，绝不改写、增删、重述或重新打字录入内容**。

【分块文件（务必按此顺序拼接）】
${list}

【目标成稿】${f.outPath}

【怎么做——用一次拼接动作，别自己逐字重敲内容】
- 若你有 \`Concat\` 文件工具：直接调用 \`Concat(file_path="${f.outPath}", sources=[按上面顺序排列的各分块路径])\`，一步到位。
- 否则若你能跑 shell：用 \`cat "分块1" "分块2" … > "${f.outPath}"\`（**每个路径都用双引号包起来**——路径含空格/中文，不加引号会出错；务必按上面的顺序）。
- 两者都没有时（最后手段）：Read 第 1 块→Write 到目标成稿；再**逐块** Read→用 Edit 以目标当前结尾为锚点追加（一次只追加一块、绝不整文件重写），直到接完。
第 1 块已带 \`# ${f.title}\` 抬头、其余块直接是 \`##\` 正文，顺序接上即可；分块之间留一个空行。不要加任何前言、结语、编者注或分隔线。

拼好后用一句话回复：已合并 ${chunks.length} 块到 ${f.outPath}。`
}


function dedupPrompt(listText, a) {
  return `你是「疑似同指」核查子代理。下面是从多份访谈里抽出、已按“共享强名”聚类后的实体清单。聚类是纯字符串匹配，**抓不到写法完全不同、却其实指同一对象**的情况——例如同音异写的人名（王勇 / 汪勇）、口号的不同转写（现场制 / 现厂制）、同一产品的不同叫法。

采访背景（判断时参考）：${a.background}

任务：通读清单，**只挑出你怀疑其实是同一对象、但被聚成了不同条目**的组。判断依据：同音/形近、身份线索（hint）一致、同一文件里的角色重叠等。
纪律（重要）：
- 你只**标记**，**绝不**断言合并——拿不准也列出来，由人工/精校最终定夺；宁可多报，不可漏报。
- 真正不同的对象（如董事长 王志远 与其弟 王志明；不同竞品）**不要**列。
- **suspects 里只放你真心建议人工确认的组**；不要放“此组不适用/撤回/仅供参考”之类的占位或自我否定项——拿不准要不要放，就别放。
- 每组 members 至少 2 个写法；给出 kind（person/brand/term）、why（一句话理由）。没有可疑项就返回空 suspects=[]。
- **preferred（关键）**：当 kind 是 **term/brand**（术语/口号/品牌/产品名）且你有把握时，给出该组的**正确标准写法**（必须是 members 里的某一个，如「优鲜醇 / 优鲜纯」给 preferred=「优鲜纯」）——这会作为“写法统一”指令直接交给精校套用，省去它来回改字。**人名（person）一律留空 preferred**（合并人名身份须人工确认，绝不自动并）；术语但你拿不准标准写法的也留空。

${(a.doNotMerge && a.doNotMerge.length) ? `已人工确认为**不同对象**、**勿再标记为疑似同指**：${a.doNotMerge.map((p) => (p || []).join('／')).join('；')}\n` : ''}实体清单（canonical ← 变体 ｜ 线索 ｜ 类别/出处）：
${listText}

按 schema 返回 suspects。注意：why（理由）会原样写进存档校对表——遵守排版规范：阿拉伯数字、中文与英文/数字间加半角空格、引号用全角 “”。members/preferred 是写法本身，不要改动其内部空格。`
}

function speakerCandidatePrompt(f, candidates = []) {
  const resolution = f.speakerResolution || {}
  const mappings = (resolution.mappings || [])
    .filter((item) => item && item.sourceLabel && item.outputLabel)
    .map((item) => `- ${item.sourceLabel} → ${item.outputLabel}${item.role ? `（${item.role}）` : ''}`)
  const rows = candidates.map((item) => `- 第 ${item.line} 行：${item.label}`).join('\n')
  return `你是“说话人候选裁决”代理。程序只依据“短前缀 + 冒号”的表面形状找到了候选；候选不是事实，不能因为标签不在映射中就直接判错。

【只读文件】
- 原始转录：${f.path}
- 精校成稿：${f.outPath}

【本轮已由源稿确认的说话人映射】
${mappings.length ? mappings.join('\n') : '- 无已确认映射'}

【待裁决候选】
${rows}

逐项 Read 精校稿候选行前后文；只有需要确认来源标签或别名时才 Read 原始转录。禁止 Write / Edit / Concat，禁止改稿、猜姓名或重做说话人映射。

verdict 必须按以下边界：
- invented_speaker：同时满足“该行确实开启一轮对话发言”与“原始转录及既有映射都没有这个说话人/别名的直接证据”。
- not_speaker：标题、副标题、斜体说明、主题/日期等文档元信息、列表项、引用、表格、章节名或其它非发言轮结构。
- source_supported_alias：该行确实是发言轮，且原始转录直接支持同一标签或别名，但既有映射遗漏。
- uncertain：上下文或来源证据不足，不能满足以上任一结论。

confidence=high 只允许用于直接文本证据充分的结论；仅凭名称像人名、位置像对话或“映射中没有”都不够。按 schema 返回 decisions；每个输入候选恰好返回一项，line 和 label 原样照抄。`
}

function singlePassPrompt(f, a, overrideNote) {
  const speakerMode = (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode
  const structureInstruction = speakerMode === 'untracked'
    ? '本文没有说话人标签；按独白/无标签文本精校，保持无标签形式，不得改成问答或新增说话人。'
    : speakerMode === 'ambiguous'
    ? '本文疑似有未确认的说话人格式；保留原有标签、时间码与结构，不得猜人名、合并轨道或补造问答。'
    : '边读边记发言人对应，统一全文标签。'
  return `你是访谈转录「精校」子代理（单文件一遍过）。

采访背景：${a.background}

【源文件】${f.path}（约 ${f.lines} 行）。先把全文**整份读完**。${readPlan(f)}
${structureInstruction}同时记下人名/品牌/术语的各种写法、明显转写错误（同音/英文/时间戳/乱码），在心里建一张迷你校对表（不必落盘）；拿不准的名字保留（音），绝不臆造。然后按规范精校全文：
【输出】Write 到 ${f.outPath}
【抬头】第一行 \`# ${f.title}\`；第二行 \`${f.subtitle}\`
${resolvedSpeakerBlock(f)}
${f.speakerHints ? `【发言人线索】${f.speakerHints}` : ''}
${f.notes ? `【额外提醒】${f.notes}` : ''}
${headingNote(a.headingPolicy)}
若读全文时发现源文件其实已带（记者/速记的）小标题、而上方又没有【小标题处理】交代——按默认规范精校，但把这一情况写进 open_questions 提醒委托方决定保留还是重做。
${overrideNote ? `\n${overrideNote}\n` : ''}
${RULES}

完成后按 schema 返回 path、headings、key_fixes、open_questions。`
}

// M11a single-shot refine: same editorial contract as singlePassPrompt, but the FULL source text is inlined
// into the prompt and the model returns the refined document AS ITS RESPONSE TEXT (no Read, no Write, no tools).
// `sourceText` is the whole file content (the caller size-gates it against SINGLE_SHOT_MAX_CHARS before calling).
// `glossaryBlock` is optional — the multi-file / batch path passes the rendered 校对表 so 写法 stay unified; a bare
// single-shot run passes '' and the model builds its own mini-glossary as in singlePassPrompt. The response is
// written to f.outPath verbatim by JS, so it MUST be pure document text: first line the H1, no preamble/epilogue,
// no code fence, no report — the deterministic source-aware audit then gates it exactly as any other 成稿.
function singleShotPrompt(f, a, sourceText, glossaryBlock, overrideNote, finding = {}) {
  const speakerMode = (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode
  const trackless = speakerMode === 'untracked' || speakerMode === 'ambiguous'
  const glossary = (glossaryBlock && glossaryBlock.trim())
    ? `【统一校对表】（“联网核实结论”与“写法统一”优先级最高；标 ⚠ 的条目未采纳、勿套用；术语/品牌请初次落笔即写对）：\n${glossaryBlock}\n`
    : `边读边在心里建一张迷你校对表（${trackless ? '文本结构' : '发言人对应'}、人名/品牌/术语各写法、明显转写错误）；拿不准的名字保留（音），绝不臆造。`
  return `你是访谈转录「精校」子代理（单请求一次成稿）。

采访背景：${a.background}

${glossary}
下面 <源转录> 标签之间是需要精校的**完整**转录原文（${f.refinePath || f.path}）。按规范精校全文。
${resolvedSpeakerBlock(f, finding)}
${f.speakerHints ? `【发言人线索】${f.speakerHints}` : ''}
${f.notes ? `【额外提醒】${f.notes}` : ''}
${headingNote(a.headingPolicy)}
若源文件其实已带（记者/速记的）小标题、而上方又没有【小标题处理】交代——按默认规范精校（正文末尾可留一行 \`<!-- 注：源文件原带小标题，已按默认规范重排 -->\` 提醒委托方）。
${overrideNote ? `\n${overrideNote}\n` : ''}
${RULES}

【输出格式（务必严格）】直接输出精校后的**成稿正文本身**，不要任何前言、说明、代码围栏或结尾总结：
- 第一行必须是 \`# ${f.title}\`
- 第二行必须是 \`${f.subtitle}\`
- 随后是带 \`##\` 小标题的精校正文，必须覆盖到源文件结尾（收尾客套可折成一句括号说明；正文绝不能中途断掉）。
- 你回复的全部文本会被原样写入成稿文件，所以**除了成稿内容之外不要输出任何其它字符**。

<源转录>
${sourceText}
</源转录>`
}

function summaryDeliverableName(topic) {
  const raw = String(topic || '').trim()
  const base = raw.endsWith('访谈') ? raw.slice(0, -2) : raw
  return `${safeName(base || raw || '访谈', 40)}访谈总结.md`
}

// The 时间线 output filename — kept in lockstep with timelinePrompt's write target so a host can locate the
// produced file on disk (e.g. to run the derivative-attribution audit against it).
function timelineDeliverableName(topic) {
  return `${safeName(topic, 40)}时间线.md`
}

function summaryPrompt(a, refined, sectionMapPath) {
  const list = refined.map((r) => '- ' + (r.outPath || r.path)).join('\n')
  const mapNote = sectionMapPath
    ? `\n先 Read 结构索引 ${sectionMapPath}，用它定位每份成稿的小标题、行号、主题标签和关键实体；需要引用原文时再按索引只读相关成稿小节，避免反复通读全文。`
    : ''
  const summaryTitle = String(a.topic || '').trim().endsWith('访谈') ? `${a.topic}总结` : `${a.topic}访谈总结`
  const hasTrackless = (a.files || []).some((file) => {
    const mode = (file.speakerResolution && file.speakerResolution.speakerMode) || file.speakerMode
    return mode === 'untracked' || mode === 'ambiguous'
  })
  return `你是「访谈总结」子代理。基于以下精校成稿（先逐一 Read），产出《${summaryTitle}》：
${list}${mapNote}

结构模板：先 Read ${a.skillDir}/references/deliverables.md 的「访谈总结」部分。
三部分：分类要点（### 按主题小节，每条带具体事实或数字；**每个数字/金额/数量/规格都要紧跟自己的来源标注**：【访谈】=访谈亲口所述、必须确实出自成稿原文；【公开·待记者核实】=取自公开资料、须记者复核——**一条里若同时有访谈事实和公开补充，必须拆成两个事实子句并各自标注，禁止用行末一个标签统管整条**；绝不可把公开资料或你推算/换算的数字标成【访谈】，拿不准就标待核）；金句 Quotes（${hasTrackless ? '有可靠说话人标签的成稿按发言人归类；无标签或结构待复核的稿件按来源文件/章节归类，绝不补造发言人；' : '按发言人归类，'}忠实引用、只去口癖不改意）；行业与公司/人物洞察（分行业与该公司/人物两块，点出看点与风险，体现判断而非复述）。**所有标题一律不编号**（洞察等列表项也用 - 项目符号，不要 1./一、编号）。
**源头可溯**：每条金句末尾标〔出处：成稿文件标题 · 所在小标题〕；分类要点凡引用具体数字/事实也尽量带〔出处：标题 · 小标题〕——成稿里每段都在某个 ## 小标题下，照抄那个小标题原文，便于读者一键核对。

${TYPESET}

写到 ${a.outputDir}/${summaryDeliverableName(a.topic)}（输出根目录，不是 Transcripts/；文件名已清洗，勿再改动）。抬头 H1 + 第二行斜体说明（受访者与采访方、采访时间 ${a.date}）。末尾注一行配套文档（Transcripts/ 下各精校全文）。
你的最终回复即返回值：输出路径 + 各部分小节标题清单。`
}

function timelinePrompt(a, glossary, refined, sectionMapPath) {
  const list = refined.map((r) => '- ' + (r.outPath || r.path)).join('\n')
  const mapNote = sectionMapPath
    ? `先 Read 结构索引 ${sectionMapPath}，优先用其中的时间/阶段/实体线索列候选事件；需要核对上下文时再按索引只读相关成稿小节。`
    : ''
  const hasGlossary = glossary && glossary.trim() && glossary !== SINGLE_FILE_GLOSSARY
  const glossaryBlock = hasGlossary
    ? `附关键人物对照表（结合下方校对表的真名核实结论；查不到的标“真名未公开”）。\n\n统一校对表（含核实结论）：\n${glossary}`
    : `附关键人物对照表——本次无独立校对表，关键人物真名请你直接用 WebSearch 现查、查不到标“真名未公开”，绝不臆造。`
  return `你是「时间线」子代理。把 ${a.topic} 访谈口述与公开资料对照，产出《${a.topic}时间线》。

步骤：先 Read ${a.skillDir}/references/deliverables.md 的「时间线」部分作为结构模板；${mapNote ? `${mapNote} ` : ''}再逐一 Read 本次精校成稿（只读下面这些——目录里可能还有往次旧稿，不要读）：
${list}
抽出所有带时间/阶段的事实（成立、产品、融资、人事、渠道、出海…）；然后用 WebSearch / WebFetch 按“公司名 + 融资/成立/创始人”等核实年份、轮次、金额、关键人物（网页留在你的上下文里）。访谈与公开资料冲突时两边都列、注明分歧，不强行二选一。**每一个事实子句、尤其每一个数字/金额/数量/规格都必须紧跟自己的来源标注**，三选一：【访谈】=访谈亲口所述；【公开·待记者核实】=取自公开资料、须记者复核；【公开+访谈·待记者核实】=同一事实本身由两者互证（公开部分仍待核）。**一条里若同时有访谈事实和公开补充，必须拆成两个事实子句并各自标注；禁止用行末一个标签统管整条。**红线：标【访谈】的数字必须确实出自本次成稿原文——绝不可把公开资料、行业常识或你自己推算/换算的数字标成【访谈】；来源拿不准就标【公开·待记者核实】，宁可标待核也不可冒充访谈。**源头可溯**：凡含【访谈】的事件，在该事实子句末尾标〔出处：成稿标题 · 小标题〕指明取自哪份成稿哪段，便于核对。${glossaryBlock}

${TYPESET}

写到 ${a.outputDir}/${timelineDeliverableName(a.topic)}（文件名已清洗，勿再改动）。标题一律不编号。你的最终回复即返回值：输出路径 + 时间线小节清单。`
}

// Logic-reordered draft: reads the **refined transcript** (not the raw source — names/terms already unified), reordering Q&A from recording order into narrative order.
// Order-preserving reconstruction (lossless): Q&A blocks are copied verbatim, positions only are swapped; [Editor] bridging notes added only where a move breaks a reference.
function logicPlanPrompt(f, a, sectionMapPath) {
  const outName = safeName(f.title)
  const mapNote = sectionMapPath
    ? `\n【结构索引】先 Read ${sectionMapPath}，这里列出了精校稿所有 \`##\` 小标题、行号范围、主题标签和关键实体。`
    : ''
  return `你是「逻辑顺序重排」规划子代理。你只制定重排方案，不写最终稿。

【输入·精校稿】${f.outPath}（已精校，人名/术语已统一）。${readPlan(f)}（这是读精校稿——它和源文件行数可能不同，读到没有更多内容即止。**只读这一份，不读源转录、不联网。**）${mapNote}
【结构模板】先 Read ${a.skillDir}/references/deliverables.md 的「逻辑顺序稿」部分。
【输出方案】Write JSON 到 ${a.outputDir}/_codex-native/logic-plans/${outName}.json

做法：
1. 列出精校稿里全部 \`##\` 小标题，给它们按原出现顺序编号 1, 2, 3...
2. 判断这份精校稿是否已经天然按叙事顺序组织。如果确实已经很顺，置 \`no_reorder_needed=true\`，并在 reason 里说明；不要为了完成任务硬造“假重排”。
3. 若需要重排，理出 3–7 条叙事线索。每条线索必须给出：
   - title：自描述小标题，不编号；
   - logic：内部排序逻辑（时间 / 因果 / 问题→判断→证据→分歧→结论 / 产品起因→经过→结果）；
   - source_sections：取自哪些精校稿 \`##\` 小标题，必须原样照抄；
   - source_order：这些小标题在精校稿中的原 1-based 顺序号。
4. 方案必须能看出**实质重排**：不能只把一节前置、其余照旧；不能只是合并相邻标题；不能把全稿原顺序换成更大的原顺序分组。
5. 每个精校稿实质 \`##\` 小标题都要被某条线索覆盖一次。拿不准归属的单列到最接近的主线，并在 logic 里说明。

${TYPESET}

完成后按 schema 返回：path、mainline、no_reorder_needed、reason、threads（title、logic、source_sections、source_order）、open_questions。`
}

function logicWritePrompt(f, a, missing, planPath) {
  const outName = safeName(f.title)
  const missNote = (missing && missing.length)
    ? `\n【上轮遗漏——本轮必须完整纳入】上一遍重排漏掉了以下精校稿小标题对应的问答内容，请本轮务必把它们各自归入合适的主线、整段照原文补齐（不得再遗漏）：${missing.map((h) => `「${h}」`).join('、')}。`
    : ''
  const planNote = planPath
    ? `\n【已审重排方案】先 Read ${planPath}。最终稿必须严格按这个 JSON 里的 threads 顺序、source_sections 和 logic 执行；如果方案里 no_reorder_needed=true，就不要写假重排稿，改为返回 open_questions 说明无需另出逻辑稿。`
    : ''
  const speakerMode = (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode
  const trackless = speakerMode === 'untracked' || speakerMode === 'ambiguous'
  const logicOut = f.logicOutPath || a.outputDir + '/逻辑顺序/' + outName + '.md'
  return `你是「逻辑顺序重排」子代理。把一份**已精校**的访谈稿从“录音顺序”重排成“叙事顺序”——让散落在访谈各处、其实属于同一条线的${trackless ? '内容块' : '问答'}聚到一起，读起来是一个完整的故事。**这是重排，不是改写、更不是摘要**：${trackless ? '段落/内容块' : '问答块'}整段照搬精校稿原文，一字不改、一处不漏，只调换位置。${missNote}

【输入·精校稿】${f.outPath}（已精校，人名/术语已统一）。${readPlan(f)}（这是读精校稿——它和源文件行数可能不同，读到没有更多内容即止。**只读这一份，不读源转录、不联网。**）${planNote}
【结构模板】先 Read ${a.skillDir}/references/deliverables.md 的「逻辑顺序稿」部分。
【输出】Write 到 ${logicOut}
【抬头】第一行 \`# ${f.title} · 逻辑顺序稿\`；第二行斜体：\`*基于精校稿重排为叙事顺序，内容照搬未改，仅调顺序 + 少量 [编者] 衔接；原顺序见同名精校稿*\`

做法：
1. 通读精校稿，**理出这次访谈的主线**：3–7 条叙事线索（如 创业缘起 / 战略转折 / 某产品始末 / 组织 / 行业判断），各给一个自描述 \`##\` 小标题（**一律不编号**）。**源头可溯**：每条线索 \`##\` 小标题下、正文之前，加一行斜体 \`〔取自精校稿：<小标题1>、<小标题2>…〕\`，列出本线索取自精校稿的哪些 \`##\` 小标题（原样照抄精校稿小标题文字，与返回的 source_sections 一致），便于读者回溯原稿对应段落。
2. 每条线索选一个**内部顺序逻辑**：讲历史按时间，讲决策按 问题→洞察→决定→结果，讲产品/事件按 起因→经过→结果。
3. 把精校稿里属于该线索的${trackless ? '内容块' : '问答'}**整段照原文搬过来**，按上面的逻辑排好——${trackless ? '保持原有无标签或待复核结构，不得改成问答、补造发言人或猜测标签，' : '保留 `发言人：` 标签及其在精校稿里的原样式（精校稿是 `张三：` 就写 `张三：`，别改成 `**张三：**` 加粗或其它样式）、'}保留全部事实细节与原话措辞，**只换位置，不改一字**。
4. **指代修复（克制）**：仅当某段被移走后、开头的“他 / 那个 / 上面说的 / 然后”等指代或承接断了，才加一句 \`> [编者] …\` 衔接（如“此段原在访谈后段，承前文同属早期创业”），或把孤立的“他”补成名字。**绝不**改写原话、绝不补受访者没说的、绝不替他下结论。
5. **不丢不重**：精校稿里每一段实质问答都要在重排稿里出现且**只出现一次**（纯客套/重复可省，与精校稿口径一致）。一段问答若横跨两条线索，放进主线索一次，必要时另一处用一句 \`> [编者]\` 指路。
6. 开头加一节 \`## 主线脉络（导读）\`：一段话讲清这次访谈的主线与你的重排逻辑。

${TYPESET}

完成后按 schema 返回：path、mainline（导读那段）、threads（每条线索的 title、logic、以及它取自精校稿的哪些小标题 source_sections——**source_sections 必须原样照抄精校稿里的 \`##\` 小标题文字**，供完整性核对）、open_questions。`
}



const DEFAULT_STAGE_MODELS = Object.freeze({
  scout: 'haiku', verify: 'sonnet', dedup: 'sonnet', refine: 'opus', repair: 'opus',
  stitch: 'haiku', logic: 'opus', summary: 'opus', timeline: 'opus',
})

const QUALITY_REPAIR_MAX_ROUNDS = 2

// One shared publication contract: body-fidelity and output-quality groups stay separate for diagnostics, while
// their union drives repair, derivative withholding, exit status, and scorecards. Unknown findings stay review-tier.

function recordTurnContractFailure(A, f, error, phase) {
  if (!Array.isArray(A.turnContractFailures)) A.turnContractFailures = []
  const failure = {
    code: (error && error.code) || 'TURN_CONTRACT_INVALID',
    retryable: false,
    message: (error && error.message) || 'turn contract 校验失败',
    phase,
    label: (f && f.label) || null,
    path: (f && f.outPath) || null,
  }
  A.turnContractFailures.push(failure)
  return failure
}

function retryableAgentFailure(engine, label) {
  if (!engine || typeof engine.failures !== 'function') return false
  const failures = engine.failures()
  if (!Array.isArray(failures)) return false
  const failure = failures.findLast
    ? failures.findLast((entry) => entry && entry.label === label)
    : failures.slice().reverse().find((entry) => entry && entry.label === label)
  return !!(failure && failure.retryable === true)
}

// Refine one file. Cost mode (default), or a small file → one agent. Speed mode + a large file (> REFINE_CHUNK_CHARS
// 字) → parallel chunk agents writing <outPath>.part{idx}, merged deterministically. Speed mode has its own
// small cap; provider-budget and explicit-size chunking are intentionally uncapped.
// when the host injects fs capability, or by a cheap stitch agent in the Workflow sandbox. Returns a
// REFINE_REPORT-shaped object (path = f.outPath) or null if it
// could not produce an output. A failed chunk is surfaced via open_questions (and caught downstream by the
// source-aware audit) rather than silently dropped.
// M11a single-shot refine for ONE file: read the source text, size-gate it, send ONE non-tool request whose
// response IS the refined document, write it via a capability. Requires fs-side capabilities (readFile +
// writeFile) AND an engine.complete (the non-tool primitive) — the CC sandbox has neither, so this returns
// { degrade:true } and refineFile falls back to the agentic path (logged once). A file over SINGLE_SHOT_MAX_CHARS
// is REFUSED with a clear error routed into open_questions (never silently truncated). The full source-aware
// audit runs downstream unchanged — the safety net for single-shot's silent-compression failure mode.
async function refineFileSingleShot(engine, f, glossary, finding, A, M) {
  const cap = (A && A.capabilities) || {}
  const capturing = typeof A.captureSingleShot === 'function'
  // readFile is needed either way (to inline the source). The SEND path additionally needs engine.complete +
  // writeFile; the CAPTURE path (batch submit) needs neither — it hands the built payload to captureSingleShot.
  // Missing what THIS path needs → degrade to agentic (CC sandbox has no fs/complete). Ordered so a submit-time
  // mock engine without complete() still captures.
  if (typeof cap.readFile !== 'function') return { degrade: true }
  if (!capturing && (typeof engine.complete !== 'function' || typeof cap.writeFile !== 'function')) return { degrade: true }
  let sourceText
  try { sourceText = await cap.readFile(f.refinePath || f.path) } catch (e) {
    engine.log(`单请求精校：${f.label} 读源失败（${(e && e.message) || e}）——回退代理式`)
    return { degrade: true }
  }
  const chars = contentLength(sourceText)
  if (chars > SINGLE_SHOT_MAX_CHARS) {
    engine.log(`单请求精校：${f.label} 约 ${chars} 字，超过单请求上限 ${SINGLE_SHOT_MAX_CHARS} 字——拒绝；现已无 --refine-mode 参数，agentic 是默认且唯一的路径，DeepSeek 引擎会在其中按发言轮自动分段处理超长文件`)
    return {
      path: f.outPath, headings: [], key_fixes: [],
      open_questions: [`「${f.label}」约 ${chars} 字，超过 single-shot 上限 ${SINGLE_SHOT_MAX_CHARS} 字（响应封顶会截断长文）——本份未精校；现已无 --refine-mode 参数，agentic 是默认且唯一的路径，重新精校该份即可（DeepSeek 引擎会自动分段处理超长文件）`],
      refused: true,
    }
  }
  const glossaryBlock = (glossary && glossary !== SINGLE_FILE_GLOSSARY) ? glossary : ''
  const overrideNote = (A.singleShotOverrideNote && A.singleShotOverrideNote[f.label]) || ''
  const maxTokens = singleShotMaxTokens(chars)
  const prompt = singleShotPrompt(f, A, sourceText, glossaryBlock, overrideNote, finding)
  const model = M.refine, effort = effortFor(A, 'refine')   // M12-defaults: user override wins, else cap at 'high'
  // M11b batch-submit seam: when A.captureSingleShot is set, hand the built payload to it INSTEAD of sending —
  // the batch script reuses the whole scout→verify→glossary→single-shot-prompt pipeline to assemble batch
  // requests, then submits them itself. The rep is marked captured:true so the audit gate skips it (no 成稿 on
  // disk yet — the refined files are written on `resume`).
  if (typeof A.captureSingleShot === 'function') {
    A.captureSingleShot(f, { prompt, maxTokens, model, effort })
    return { path: f.outPath, headings: [], key_fixes: [], open_questions: [], singleShot: true, captured: true }
  }
  const text = await engine.complete(prompt, { label: `refine:${f.label}`, model, effort, maxTokens })
  if (text == null || !String(text).trim()) { engine.log(`单请求精校：${f.label} 返回空——记为失败`); return null }
  try { await cap.writeFile(f.outPath, String(text)) } catch (e) {
    engine.log(`单请求精校：${f.label} 写成稿失败（${(e && e.message) || e}）`)
    return null
  }
  return { path: f.outPath, headings: [], key_fixes: [], open_questions: [], singleShot: true }
}

async function refineFile(engine, f, glossary, refineGlossary, finding, A, M) {
  // M11a: single-shot mode builds ONE request per file (source inlined, response = 成稿). Falls back to agentic
  // when the runtime can't support it (no fs / no complete primitive — e.g. the CC sandbox).
  // A structured turn contract needs a host-side parse + deterministic render after the model write, so the
  // legacy response-as-final-Markdown single-shot path is intentionally bypassed for contracted files.
  if (A.refineMode === 'single-shot' && !f.refineContract) {
    const r = await refineFileSingleShot(engine, f, glossary, finding, A, M)
    if (!r || !r.degrade) return r
    engine.log(`单请求精校不可用（运行时无 fs / complete 能力）：${f.label} 回退代理式精校`)
  } else if (A.refineMode === 'single-shot' && f.refineContract) {
    engine.log(`单请求精校不承载 turn contract：${f.label} 改走结构化代理式精校`)
  }
  // M12: per-category reasoning effort (smart tier). effortFor = user override ?? per-phase default cap. Passed
  // straight to agent opts; the API engine emits output_config.effort only for allowed models, the CC Workflow
  // agent forwards opts.effort.
  const refineEffort = effortFor(A, 'refine')
  // Provider-aware auto-chunk: if the engine that will run refine declares a faithful-length budget for the model
  // actually assigned to refine (respects the internal stage-model map and the category-router's smart engine), split any file over
  // it — a weaker-but-cheaper model silently compresses long transcripts. Anthropic / the CC sandbox expose no
  // refineBudget → rb null → budget undefined → splitForRefine behaves byte-identically to before. See
  // engines/providers.js for the per-model budgets and the retention evidence behind them.
  const rb = (typeof engine.refineBudget === 'function') ? engine.refineBudget(M.refine) : null
  const budget = rb ? rb.budget : undefined
  // A.chunkSize (--chunk-size) is the explicit experiment knob; when set it OVERRIDES both the provider budget and
  // speed-mode's count (splitForRefine handles the precedence). `off` still suppresses all chunking upstream.
  let chunks = splitForRefine(f, A.chunkMode, budget, A.chunkSize)
  const cap = (A && A.capabilities) || {}
  const contractValidator = (chunk, outputPath) => (
    f.refineContract && typeof cap.validateRefineContractOutput === 'function'
      ? () => cap.validateRefineContractOutput(f, chunk, outputPath)
      : undefined
  )
  if (f.refineContract && typeof cap.prepareRefineChunks === 'function') {
    try {
      chunks = await cap.prepareRefineChunks(f, chunks)
    } catch (e) {
      recordTurnContractFailure(A, f, e, 'prepare_chunks')
      engine.log(`精校 turn contract 分块准备失败：${f.label}（${(e && e.message) || e}）`)
      return null
    }
  }
  // autoChunk trace: record when a non-opt-in driver forced the split — the model budget (faithfulness) OR the
  // explicit --chunk-size knob. Speed mode alone is an opt-in batch lever and is NOT traced. `off` suppresses
  // chunking upstream, so it can never reach here. When --chunk-size drove it, the record gains requestedChunkSize
  // (and still carries model/budget when a budgeted provider is in play). Rides on the returned report → run.json +
  // review.md via artifacts.js.
  const drivenByChunkSize = chunks.length > 1 && typeof A.chunkSize === 'number' && A.chunkSize > 0 && refineSize(f) > A.chunkSize
  const drivenByBudget = chunks.length > 1 && rb && refineSize(f) > rb.budget
  const autoChunk = (drivenByChunkSize || drivenByBudget)
    ? {
      label: f.label,
      ...(rb ? { model: rb.model, budget: rb.budget } : {}),
      contentLength: refineSize(f),
      parts: chunks.length,
      ...(drivenByChunkSize ? { requestedChunkSize: A.chunkSize } : {}),
    }
    : null
  const plan = {
    label: f.label,
    outPath: f.outPath,
    model: (rb && rb.model) || M.refine,
    contentLength: refineSize(f),
    driver: chunks.length <= 1 ? 'single' : (drivenByChunkSize ? 'chunk_size' : (drivenByBudget ? 'provider_budget' : 'speed')),
    parts: chunks.map((c) => ({ idx: c.idx, startLine: c.startLine, endLine: c.endLine, path: chunks.length > 1 ? partPath(f.outPath, c.idx) : f.outPath })),
    ...(rb ? { budget: rb.budget } : {}),
    ...(drivenByChunkSize ? { requestedChunkSize: A.chunkSize } : {}),
    ...(autoChunk ? { autoChunk } : {}),
  }
  if (!Array.isArray(A.plannedChunks)) A.plannedChunks = []
  const previousPlan = A.plannedChunks.findIndex((x) => x && x.label === plan.label)
  if (previousPlan >= 0) A.plannedChunks[previousPlan] = plan
  else A.plannedChunks.push(plan)
  if (typeof A.onChunkPlan === 'function') A.onChunkPlan(plan)
  if (chunks.length <= 1) {
    // Single agent → full glossary (no token multiplication on one agent).
    const prompt = refinePrompt(f, glossary, finding, A, chunks[0])
    const opts = {
      label: `refine:${f.label}`, phase: 'Refine', model: M.refine, effort: refineEffort,
      schema: REFINE_REPORT_SCHEMA, outputPath: f.outPath,
      validateOutput: contractValidator(chunks[0], f.outPath),
    }
    let rep = await engine.agent(prompt, opts)
    if (!rep && retryableAgentFailure(engine, opts.label)) {
      engine.log(`精校单元：${f.label} 遇到可重试 provider 故障——只重跑该单元一次`)
      rep = await engine.agent(prompt, { ...opts, label: `refine-retry:${f.label}` })
    }
    if (!rep || !f.refineContract) return rep
    if (typeof cap.finalizeRefineContract !== 'function') {
      recordTurnContractFailure(A, f, { code: 'TURN_CONTRACT_CAPABILITY_MISSING', message: '宿主缺少 turn contract 收口能力' }, 'finalize')
      engine.log(`精校 turn contract 缺少宿主收口能力：${f.label}`)
      return null
    }
    try {
      const finalized = await cap.finalizeRefineContract(f, chunks)
      engine.log(`精校 turn contract：${f.label} 已校验 ${finalized.turnCount} 个 source turn，并从 ${finalized.outputBlockCount} 个 output block 确定性渲染`)
      return {
        ...rep,
        path: f.outPath,
        headings: finalized.headings || [],
        turnContract: finalized.contract,
      }
    } catch (e) {
      recordTurnContractFailure(A, f, e, 'finalize')
      engine.log(`精校 turn contract 校验失败：${f.label}（${(e && e.code) || 'TURN_CONTRACT_INVALID'}：${(e && e.message) || e}）`)
      return null
    }
  }
  const chunkReason = drivenByChunkSize ? `（显式分块大小 ${A.chunkSize} 字/块）`
    : (drivenByBudget ? `（自动：约 ${refineSize(f)} 字 超过 ${rb.model} 忠实处理长度 ${rb.budget} 字）` : '')
  engine.log(`精校分块：${f.label}（${f.lines} 行）拆 ${chunks.length} 块并行精校，再拼接${chunkReason}`)
  // Chunk agents get the CONDENSED glossary — it's sent to all K of them, so trimming it is the main
  // lever on chunked-refine token cost; 写法 stay identical (verified canonicals applied the same way).
  const partReps = await engine.parallel(chunks.map((c) => async () => {
    const prompt = refinePrompt(f, refineGlossary, finding, A, c)
    const opts = {
      label: `refine:${f.label}#${c.idx}/${chunks.length}`, phase: 'Refine', model: M.refine, effort: refineEffort,
      schema: REFINE_REPORT_SCHEMA, outputPath: partPath(f.outPath, c.idx),
      validateOutput: contractValidator(c, partPath(f.outPath, c.idx)),
    }
    let rep = await engine.agent(prompt, opts)
    if (!rep && retryableAgentFailure(engine, opts.label)) {
      engine.log(`精校单元：${f.label}#${c.idx}/${chunks.length} 遇到可重试 provider 故障——只重跑该单元一次`)
      rep = await engine.agent(prompt, { ...opts, label: `refine-retry:${f.label}#${c.idx}/${chunks.length}` })
    }
    return rep
  }))
  const stillMissing = chunks.filter((c, i) => !partReps[i])
  if (stillMissing.length) {
    engine.log(`精校分块：${f.label} 处理后仍缺 ${stillMissing.map((c) => `${c.idx}（源第 ${c.startLine}-${c.endLine} 行）`).join('、')}——拒绝拼接残缺正文`)
    return null
  }
  const good = partReps.filter(Boolean)
  let stitchReport = null
  if (f.refineContract && typeof cap.finalizeRefineContract === 'function') {
    try {
      stitchReport = await cap.finalizeRefineContract(f, chunks)
      engine.log(`精校 turn contract：${f.label} 已按 ${stitchReport.turnCount} 个 source turn / ${stitchReport.outputBlockCount} 个 output block 校验并合并 ${chunks.length} 块`)
    } catch (e) {
      recordTurnContractFailure(A, f, e, 'merge')
      engine.log(`精校 turn contract 合并失败：${f.label}（${(e && e.code) || 'TURN_CONTRACT_INVALID'}：${(e && e.message) || e}）`)
      return null
    }
  } else if (typeof cap.stitch === 'function') {
    try {
      const stitched = await cap.stitch(f, chunks)
      if (stitched == null) { engine.log(`精校分块：${f.label} 确定性拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
      stitchReport = stitched
      engine.log(`精校分块：${f.label} 已确定性拼接 ${chunks.length} 块`)
    } catch (e) {
      engine.log(`精校分块：${f.label} 确定性拼接失败：${(e && e.message) || e}`)
      return null
    }
  } else {
    const stitched = await engine.agent(stitchPrompt(f, chunks), { label: `stitch:${f.label}`, phase: 'Refine', model: M.stitch, outputPath: f.outPath })
    if (stitched == null) { engine.log(`精校分块：${f.label} 拼接失败——各分块已写入 <成稿>.partN，可手动合并`); return null }
  }
  return {
    path: f.outPath,
    headings: (stitchReport && stitchReport.headings) || good.flatMap((r) => r.headings || []),
    key_fixes: good.flatMap((r) => r.key_fixes || []),
    open_questions: good.flatMap((r) => r.open_questions || []),
    chunked: chunks.length,
    ...((stitchReport && stitchReport.contract) ? { turnContract: stitchReport.contract } : {}),
    ...((stitchReport && stitchReport.seamRepairs && stitchReport.seamRepairs.length) ? { seamRepairs: stitchReport.seamRepairs } : {}),
    ...((stitchReport && stitchReport.seamDuplicates && stitchReport.seamDuplicates.length) ? { seamDuplicates: stitchReport.seamDuplicates } : {}),
    ...(autoChunk ? { autoChunk } : {}),   // present only when the model budget forced the split (traceability)
  }
}

// Scout one file. A normal interview → one agent (unchanged). An oversized merged file (> SCOUT_CHUNK_CHARS
// 字) → splitForScout parallel chunk agents, merged by mergeScoutChunks — a RESILIENCE measure so a single
// scout can't stall on a huge file (the failure mode that motivated this). Returns one SCOUT_SCHEMA-shaped
// finding, or null if every chunk failed (handled downstream exactly like any other null scout → scoutFailed,
// refine still runs from source). A partial chunk set still yields a usable per-file finding.
async function scoutFile(engine, f, A, M, labelPrefix = 'scout') {
  const chunks = splitForScout(f)
  if (chunks.length === 1) {
    const finding = await engine.agent(scoutPrompt(f, A), { label: `${labelPrefix}:${f.label}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })
    emitSpeakerScout(A, f, 1, [finding], finding)
    return finding
  }
  engine.log(`侦察分块：大文件 ${f.label}（约 ${refineSize(f)} 字）拆 ${chunks.length} 段并行侦察，防单代理卡死`)
  const parts = await engine.parallel(chunks.map((c) => () =>
    engine.agent(scoutPrompt(f, A, c), { label: `${labelPrefix}:${f.label}#${c.idx}/${c.count}`, phase: 'Scout', model: M.scout, schema: SCOUT_SCHEMA })))
  const merged = mergeScoutChunks(parts, f)
  emitSpeakerScout(A, f, chunks.length, parts, merged)
  return merged
}

// Host-side observability hook for the OFF-BY-DEFAULT speaker dev trace (universal/speaker-trace.js). Only
// speaker labels/roles travel — never transcript text. A missing or throwing callback can never break Scout.
function emitSpeakerScout(A, f, chunkCount, parts, merged) {
  if (!A || typeof A.onSpeakerEvent !== 'function') return
  const pick = (fd) => ((fd && fd.speakers) || []).map((s) => ({ label: s && s.label, output_label: s && s.output_label, output_label_confidence: s && s.output_label_confidence, role: s && s.role }))
  try {
    A.onSpeakerEvent({
      type: 'scout_chunks', fileLabel: (f && f.label) || null, chunkCount,
      chunks: (parts || []).map((fd, i) => ({ idx: i + 1, ok: !!fd, speakers: pick(fd) })),
      merged: { speakers: pick(merged), special_notes: (merged && merged.special_notes) || [] },
    })
  } catch { /* 开发记录不可影响流水线 */ }
}

// Resolve the prior-glossary TEXT (P1 persistent 校对表) from the args. Priority: inline priorGlossaryText >
// priorGlossaryPath. A path is read via capabilities.readFile (hosts with fs — Universal) or, in the CC sandbox
// (no fs in the workflow script), by dispatching a cheap haiku agent to Read the file and return its full text
// verbatim. Returns '' when nothing is available or the read fails (behaviour then identical to a first run).
async function readPriorGlossaryText(A, engine, capabilities) {
  if (A.priorGlossaryText) return A.priorGlossaryText
  const p = A.priorGlossaryPath
  if (!p) return ''
  if (capabilities && typeof capabilities.readFile === 'function') {
    try { return (await capabilities.readFile(p)) || '' } catch { return '' }
  }
  // CC sandbox: no fs here — a subagent has Read. Ask it for the raw file, nothing else.
  const txt = await engine.agent(
    `用 Read 读取文件 ${p} 的全部内容，把原文一字不改地原样返回（不要解释、不要加任何前后缀、不要总结）。若文件不存在或读不到，只回复空字符串。`,
    { label: 'prior-glossary:read', phase: 'Scout', model: 'haiku' })
  return (typeof txt === 'string' ? txt : '') || ''
}

// Parse the audit JSON a fallback agent returned. The agent is told to echo audit_refined.mjs's stdout
// verbatim, but a model may wrap it in prose / a ```json fence — peel the outermost {...} and JSON.parse.
// Returns the parsed object or null (caller retries once, then degrades to auditUnavailable).
function parseAuditJson(raw) {
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  const s = String(raw)
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

// SF-5 — shape guard shared by BOTH audit paths (capability.runAudit and the agent-fallback JSON): the capability
// returns a per-file result ({ status, failed[], gaps[], … }), but the fallback path can return either that OR the
// full auditPairs bundle ({ status, files:[…] }). Normalise to ONE per-file result. When given a bundle, pick the
// file matching f.outPath (by its `file` field) — falling back to files[0] — so a multi-file bundle can't hand back
// the wrong file. Returns null for null/empty. `f` may be omitted (then files[0] is used).
function normalizeAuditResult(raw, f) {
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw.files)) {
    const want = f && f.outPath
    const match = want ? raw.files.find((x) => x && (x.file === want || x.refinedFile === want)) : null
    return match || raw.files[0] || null
  }
  return raw
}

const SPEAKER_VERDICTS = new Set(['invented_speaker', 'not_speaker', 'source_supported_alias', 'uncertain'])
const SPEAKER_CONFIDENCE = new Set(['high', 'medium', 'low'])
const SPEAKER_REASONS = new Set(['dialogue_turn_without_source', 'document_metadata', 'heading_or_caption', 'list_quote_or_table', 'source_label_or_alias', 'insufficient_context'])

function outputSpeakerCandidates(report) {
  const out = []
  const seen = new Set()
  for (const item of [...((report && report.unknownLabels) || []), ...((report && report.violations) || [])]) {
    const line = Number(item && item.line)
    const label = typeof (item && item.label) === 'string' ? item.label.trim().slice(0, 80) : ''
    if (!Number.isInteger(line) || line <= 0 || !label) continue
    const key = `${line}\u0000${label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ line, label })
  }
  return out
}

function normalizeSpeakerCandidateDecisions(raw, candidates) {
  const rows = Array.isArray(raw && raw.decisions) ? raw.decisions : []
  return candidates.map((candidate) => {
    const row = rows.find((item) => (
      Number(item && item.line) === candidate.line
      && String((item && item.label) || '').trim() === candidate.label
    ))
    const verdict = SPEAKER_VERDICTS.has(row && row.verdict) ? row.verdict : 'uncertain'
    const confidence = SPEAKER_CONFIDENCE.has(row && row.confidence) ? row.confidence : 'low'
    const reason = SPEAKER_REASONS.has(row && row.reason) ? row.reason : 'insufficient_context'
    const outcome = verdict === 'invented_speaker' && confidence === 'high'
      ? 'block'
      : verdict === 'not_speaker' && confidence === 'high'
        ? 'dismiss'
        : 'review'
    return { ...candidate, verdict, confidence, reason, outcome }
  })
}

async function adjudicateOutputSpeakerCandidates(engine, f, report, M = DEFAULT_STAGE_MODELS) {
  const candidates = outputSpeakerCandidates(report)
  if (!candidates.length) return null
  let raw = null
  try {
    raw = await engine.agent(speakerCandidatePrompt(f, candidates), {
      label: `speaker-adjudicate:${f.label}`,
      phase: 'Audit',
      // Reuse the existing high-quality repair route instead of adding a new independently configurable stage.
      // This is a rare publication decision, not a bulk extraction pass.
      model: M.repair,
      schema: SPEAKER_CANDIDATE_SCHEMA,
      // A classifier must never inherit the normal job-wide write allowlist. It may inspect only this source/output
      // pair and submit structured data; model/tool failure is review-tier, not permission to mutate the draft.
      filePolicy: {
        readRoots: [],
        writeRoots: [],
        readPaths: [f.path, f.outPath].filter(Boolean),
        writePaths: [],
        writePartBases: [],
      },
    })
  } catch {
    // Fail open only to the explicit review tier. The final contract below still blocks deterministic
    // unavailability and a high-confidence invented speaker; classifier failure never masquerades as clearance.
  }
  const decisions = normalizeSpeakerCandidateDecisions(raw, candidates)
  const status = decisions.some((item) => item.outcome === 'block')
    ? 'blocked'
    : decisions.some((item) => item.outcome === 'review')
      ? (raw ? 'review_needed' : 'unavailable')
      : 'cleared'
  return { label: f.label, path: f.outPath, status, model: M.repair, decisions }
}

function reuseSpeakerCandidateAdjudication(previous, f, report) {
  const candidates = outputSpeakerCandidates(report)
  const prior = Array.isArray(previous && previous.decisions) ? previous.decisions : []
  if (!candidates.length || !prior.length) return null
  const decisions = []
  for (const candidate of candidates) {
    const match = prior.find((item) => item.label === candidate.label)
    if (!match) return null
    decisions.push({ ...match, ...candidate })
  }
  const status = decisions.some((item) => item.outcome === 'block')
    ? 'blocked'
    : decisions.some((item) => item.outcome === 'review')
      ? (previous.status === 'unavailable' ? 'unavailable' : 'review_needed')
      : 'cleared'
  return { ...previous, label: f.label, path: f.outPath, status, decisions }
}

function unavailableSpeakerCandidateAdjudication(f, report, M = DEFAULT_STAGE_MODELS) {
  const candidates = outputSpeakerCandidates(report)
  if (!candidates.length) return null
  return {
    label: f.label,
    path: f.outPath,
    status: 'unavailable',
    model: M.repair,
    decisions: normalizeSpeakerCandidateDecisions(null, candidates),
  }
}

function speakerAuditLabels(adjudication) {
  const decisions = Array.isArray(adjudication && adjudication.decisions) ? adjudication.decisions : []
  return {
    speakerDismissedLabels: [...new Set(decisions.filter((item) => item.outcome === 'dismiss').map((item) => item.label).filter(Boolean))],
    speakerReviewLabels: [...new Set(decisions.filter((item) => item.outcome === 'review').map((item) => item.label).filter(Boolean))],
  }
}

// Per-file quality gate (Wave 2): the source-aware audit is now IN the pipeline, not a report jobs.js runs
// afterwards. With fs (Universal) the host injects capabilities.runAudit (direct auditPairs call); in the CC
// sandbox there is no fs, so a stitch/haiku subagent runs `node <skillDir>/audit_refined.mjs` and echoes the
// JSON. Any PUBLICATION_BLOCK_GATES finding → optionally auto-repair at most twice through a host-provided
// transactional repair capability, re-audit after each round, and if still hard mark the file auditFailed + drop a visible
// 缺口 marker (--annotate). Then run source anchors (capability or the same agent with --anchors). Never throws:
// an unavailable audit degrades to { status:'unavailable', auditUnavailable:true }.
async function runAuditStep(A, engine, f, capabilities, glossaryText, options = {}) {
  const src = f.path, out = f.outPath
  const skillDir = A.skillDir || '.'
  const cap = capabilities || {}
  const directAudit = typeof cap.runAudit === 'function'

  // Risk (a): the audit's ghost_name / missing_yin checks need THIS round's rendered 校对表. On a first run it is
  // only in memory (persistGlossary writes it to disk AFTER the pipeline returns), so reading <out>/校对表.md would
  // miss it. Prefer the in-memory glossaryText everywhere; only fall back to the on-disk path when we have none.
  const memGlossary = glossaryText && glossaryText !== SINGLE_FILE_GLOSSARY ? glossaryText : null
  const glossaryPath = A.outputDir ? `${A.outputDir}/校对表.md` : null

  // 1) obtain an audit file-result ({ status, failed[], gaps[], findings[], modelMarkers[] })
  async function audit(auditContext = {}) {
    const speakerContext = speakerAuditLabels(f.speakerCandidateAdjudication)
    if (typeof cap.runAudit === 'function') {
      // Pass the in-memory glossary so the capability doesn't have to read a not-yet-persisted file (risk a).
      // Fail-loud (P7): a thrown direct audit is retried ONCE (parity with the CC agent path's one retry); still
      // throwing → null, which the caller turns into a LOUD run failure instead of a quiet "audit unavailable".
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return normalizeAuditResult(await cap.runAudit(f, { glossaryText: memGlossary, ...speakerContext, ...auditContext }), f) }
        catch { if (attempt >= 1) return null }
      }
      return null
    }
    // CC sandbox: no fs here, so hand the in-memory glossary to the agent to stage in a scratch file, then pass it
    // to the CLI via --glossary. Without a memory glossary, fall back to the on-disk path (harmless if it exists).
    const scratch = A.scratchDir ? `${A.scratchDir}/audit-glossary-${f.label}.md` : `${(A.outputDir || '.')}/.audit-glossary-${f.label}.md`
    let glossaryArg = glossaryPath ? ` --glossary ${JSON.stringify(glossaryPath)}` : ''
    let stagePreamble = ''
    if (memGlossary) {
      glossaryArg = ` --glossary ${JSON.stringify(scratch)}`
      stagePreamble = `先用 Write 把下面这段“校对表全文”一字不改写到临时文件 ${JSON.stringify(scratch)}，再运行审计命令。\n<校对表全文>\n${memGlossary}\n</校对表全文>\n\n`
    }
    const dismissedArg = speakerContext.speakerDismissedLabels.length
      ? ` --speaker-dismissed-labels ${JSON.stringify(JSON.stringify(speakerContext.speakerDismissedLabels))}`
      : ''
    const reviewArg = speakerContext.speakerReviewLabels.length
      ? ` --speaker-review-labels ${JSON.stringify(JSON.stringify(speakerContext.speakerReviewLabels))}`
      : ''
    const cmd = `node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)}${glossaryArg}${dismissedArg}${reviewArg}`
    const prompt = `${stagePreamble}用 Bash 运行下面这条命令，把它打印到 stdout 的 JSON 原样交回——不要改写任何字符，尤其不要把弯引号改成直引号（使用结构化返回；字段一律照抄）：\n${cmd}`
    // Free-text echo is NOT trusted here: a relay model can silently normalize curly quotes inside JSON string
    // values into ASCII quotes, breaking the escaping (hit live 2026-08-16 on a heading containing “…”). The
    // schema forces a validated tool-call return, so malformed JSON is rejected at the harness layer and retried
    // there — parseAuditJson stays only as the belt for exotic hosts that ignore schemas.
    const openObject = { type: 'object', additionalProperties: true }
    const AUDIT_ECHO_SCHEMA = {
      type: 'object',
      additionalProperties: true,
      properties: {
        status: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              file: { type: 'string' },
              status: { type: 'string' },
              failed: { type: 'array', items: { type: 'string' } },
              gaps: { type: 'array', items: openObject },
              findings: { type: 'array', items: openObject },
              metrics: openObject,
              sections: { type: 'array', items: openObject },
              modelMarkers: { type: 'array', items: openObject },
              numericConflicts: { type: 'array', items: openObject },
            },
          },
        },
      },
    }
    let raw = await engine.agent(prompt, { label: `audit:${f.label}`, phase: 'Audit', model: 'haiku', schema: AUDIT_ECHO_SCHEMA })
    let parsed = parseAuditJson(raw)
    if (!parsed) { // one retry
      raw = await engine.agent(prompt, { label: `audit-retry:${f.label}`, phase: 'Audit', model: 'haiku', schema: AUDIT_ECHO_SCHEMA })
      parsed = parseAuditJson(raw)
    }
    return normalizeAuditResult(parsed, f)
  }

  const first = await audit({ phase: options.phase || 'pre_audit' })
  // Fail-loud (P7): the audit could not run after one retry. Previously this "degraded to record-only, non-blocking"
  // and the run reported success with an "audit unavailable" note — a quality gate that can be skipped silently.
  // Now the per-file result still carries auditUnavailable (the 成稿 is kept, not destroyed), but the orchestration
  // collects it into a top-level auditUnavailable list that marks the whole run FAILED (unaudited ≠ passed).
  if (!first) { engine.log(`⚠ 审计无法运行（重试后仍失败）：${f.label}——该成稿未经审计，本次运行判定为失败（deliverables unaudited/invalid，请人工跑 audit_refined.mjs 核验）`); return { status: 'unavailable', auditUnavailable: true, failedFindings: [], hardFindings: [], softFindings: [], repaired: false, repairAttempts: [], anchorsAdded: 0, directAudit } }

  const hardOf = (r) => (r.failed || []).filter((k) => PUBLICATION_BLOCK_GATES.includes(k))
  const softOf = (r) => (r.failed || []).filter((k) => !PUBLICATION_BLOCK_GATES.includes(k))
  const issueCounts = (r, hard) => {
    const counts = {}
    for (const finding of (r.findings || [])) {
      if (!finding || finding.severity !== 'hard') continue
      const count = Number(finding.count)
      if (finding.name && Number.isFinite(count) && count > 0) counts[finding.name] = count
    }
    const hardGaps = (r.gaps || []).filter((g) => g && g.severity === 'hard').length
    if (hardGaps) counts.content_gap = Math.max(counts.content_gap || 0, hardGaps)
    const longParagraphs = Array.isArray(r.long_paragraphs) ? r.long_paragraphs.length : 0
    if (longParagraphs) counts.long_paragraphs = Math.max(counts.long_paragraphs || 0, longParagraphs)
    for (const name of hard) if (!counts[name]) counts[name] = 1
    return counts
  }
  let cur = first
  let hard = hardOf(cur)
  let repaired = false
  const repairAttempts = []

  // Claude Code Workflow sandbox: there is no host fs transaction capability, but its Read/Edit agent can
  // still repair the two historically safe, precisely located classes once. Preserve that subscription-runtime
  // ability without changing Universal/DeepSeek's candidate-and-promote loop below.
  const sandboxRepairFindings = hard.filter((name) => name === 'content_gap' || name === 'quote_style')
  const sandboxRepairModel = (A.models && A.models.refine) || DEFAULT_STAGE_MODELS.refine
  if (options.allowRepair !== false && sandboxRepairFindings.length
      && typeof cap.repair !== 'function' && typeof cap.runAudit !== 'function') {
    engine.log(`审计 hard：${f.label} → ${sandboxRepairFindings.join('、')}——尝试 CC 定点修复一次`)
    const gaps = (cur.gaps || []).filter((g) => g.severity === 'hard')
    const gapLines = gaps.map((g) => `源第 ${g.startLine}-${g.endLine} 行（约 ${g.chars} 字）`).join('；') || '（见审计 gaps）'
    const parts = []
    if (sandboxRepairFindings.includes('content_gap')) parts.push(`· 内容缺口：把源文件这些行区间的实质内容按精校规范补进成稿的对应位置：${gapLines}。`)
    if (sandboxRepairFindings.includes('quote_style')) parts.push('· 直引号：把正文里紧贴中文的 ASCII 直引号（以及任何「」『』）改成全角弯引号 “”（内层 ‘’）。')
    await engine.agent(
      `用 Read 打开成稿 ${out}（必要时也 Read 源文件 ${src} 对照），只修下面点名的位置、用 Edit 直接改 ${out}，**不得改动其它任何内容、不得重写全文**：\n${parts.join('\n')}\n改完用一句话回复即可。`,
      { label: `repair:${f.label}`, phase: 'Audit', model: sandboxRepairModel })
    const again = await audit({ phase: 'post_sandbox_repair', round: 1 })
    if (again) {
      cur = again
      hard = hardOf(cur)
      repaired = hard.length === 0
      repairAttempts.push({
        file: out, round: 1, mode: 'in_place_sandbox', action: 'sandbox_spot_repair', model: sandboxRepairModel,
        failedBefore: sandboxRepairFindings, failedAfter: hard.slice(),
        outcome: hard.length ? 'audit_failed' : 'passed',
      })
      engine.log(`审计复检：${f.label} → ${hard.length ? `hard 仍在：${hard.join('、')}` : '已通过'}`)
    } else {
      repairAttempts.push({
        file: out, round: 1, mode: 'in_place_sandbox', action: 'sandbox_spot_repair', model: sandboxRepairModel,
        failedBefore: sandboxRepairFindings, failedAfter: hard.slice(), outcome: 'audit_unavailable',
      })
    }
  }

  // Runtimes with fs keep the team candidate-and-promote transaction exactly as the primary repair path.
  const repairAvailable = options.allowRepair !== false && typeof cap.repair === 'function'

  if (hard.length && repairAvailable) engine.log(`审计 hard：${f.label} → ${hard.join('、')}——最多候选修复 ${QUALITY_REPAIR_MAX_ROUNDS} 轮，每轮后复检`)
  for (let round = 1; hard.length && repairAvailable && round <= QUALITY_REPAIR_MAX_ROUNDS; round += 1) {
    const failedBefore = hard.slice()
    const hardIssueCountsBefore = issueCounts(cur, failedBefore)
    const gaps = (cur.gaps || []).filter((g) => g.severity === 'hard')
    let repairMeta = {}
    let repairError = null
    try { repairMeta = (await cap.repair(f, { gaps, hard: failedBefore, audit: cur, round, maxRounds: QUALITY_REPAIR_MAX_ROUNDS, glossaryText: memGlossary })) || {} }
    catch (error) { repairError = (error && error.code) || 'REPAIR_AGENT_FAILED' }

    const again = await audit({ phase: `post_repair_round_${round}`, round })
    if (!again) {
      repairAttempts.push({
        file: out, round, action: repairMeta.action || null, model: repairMeta.model || null,
        failedBefore, hardIssueCountsBefore, toolSummary: repairMeta.toolSummary || { succeeded: {}, failed: [] },
        bytesBefore: repairMeta.bytesBefore ?? null, bytesAfter: repairMeta.bytesAfter ?? null,
        changed: repairMeta.changed === true, agentCompleted: repairMeta.agentCompleted ?? null,
        candidatePromoted: repairMeta.candidatePromoted ?? null,
        candidateSpeakerValid: repairMeta.candidateSpeakerValid ?? null,
        candidateRejectedReason: repairMeta.candidateRejectedReason || null,
        candidateHardFindings: repairMeta.candidateHardFindings || [],
        failedAfter: failedBefore, hardIssueCountsAfter: hardIssueCountsBefore,
        outcome: 'audit_unavailable', errorCode: repairError,
      })
      engine.log(`审计复检：${f.label} 第 ${round}/${QUALITY_REPAIR_MAX_ROUNDS} 轮后无法运行——停止自动修复，保留原 hard 结论`)
      break
    }

    cur = again
    hard = hardOf(cur)
    const hardIssueCountsAfter = issueCounts(cur, hard)
    const toolFailures = ((repairMeta.toolSummary || {}).failed || []).reduce((sum, x) => sum + (Number(x.count) || 0), 0)
    const changed = repairMeta.changed === true
    const improved = hard.length < failedBefore.length || hard.some((name) => !failedBefore.includes(name)) || failedBefore.some((name) => !hard.includes(name))
    if (changed || improved || (!hard.length && repairMeta.changed == null)) repaired = true
    let outcome
    if (repairError || repairMeta.agentCompleted === false) outcome = 'agent_failed'
    else if (repairMeta.candidatePromoted === false && repairMeta.candidateRejectedReason) outcome = 'candidate_rejected'
    else if (!changed && repairMeta.changed != null) outcome = 'no_change'
    else if (!hard.length) outcome = toolFailures ? 'passed_with_tool_errors' : 'passed'
    else outcome = toolFailures ? 'audit_failed_with_tool_errors' : 'audit_failed'
    repairAttempts.push({
      file: out, round, action: repairMeta.action || null, model: repairMeta.model || null,
      failedBefore, hardIssueCountsBefore, toolSummary: repairMeta.toolSummary || { succeeded: {}, failed: [] },
      bytesBefore: repairMeta.bytesBefore ?? null, bytesAfter: repairMeta.bytesAfter ?? null,
      changed, agentCompleted: repairMeta.agentCompleted ?? null,
      candidatePromoted: repairMeta.candidatePromoted ?? null,
      candidateSpeakerValid: repairMeta.candidateSpeakerValid ?? null,
      candidateRejectedReason: repairMeta.candidateRejectedReason || null,
      candidateHardFindings: repairMeta.candidateHardFindings || [],
      failedAfter: hard.slice(), hardIssueCountsAfter, outcome,
      errorCode: repairError || repairMeta.errorCode || null,
    })
    engine.log(`审计复检：${f.label} 第 ${round}/${QUALITY_REPAIR_MAX_ROUNDS} 轮 → ${hard.length ? `hard 仍在：${hard.join('、')}` : '已通过'}${toolFailures ? `；本轮工具失败 ${toolFailures} 次（已保留记录）` : ''}`)
  }

  const auditFailed = hard.length ? hard.slice() : []
// Still hard after at most two repairs → annotate any concrete source gaps so the document shows the defect.
  // Risk (b): fall back to the agent whenever the annotate CAPABILITY specifically is missing — not only in the
  // all-agent CC path. A host that injects runAudit but not annotate still gets the marker via the agent.
  if (auditFailed.length && (cur.gaps || []).some((g) => g.severity === 'hard')) {
    if (typeof cap.annotate === 'function') { try { await cap.annotate(f, (cur.gaps || []).filter((g) => g.severity === 'hard')) } catch { /* best effort */ } }
    else {
      await engine.agent(
        `用 Bash 运行：node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)} --annotate\n只回复一句话确认即可。`,
        { label: `annotate:${f.label}`, phase: 'Audit', model: 'haiku' })
    }
  }

  // 2) source anchors (provenance) — after any gap annotation, so anchors coexist with just-inserted markers.
  // Risk (b): same per-capability fallback — a missing annotateAnchors capability falls back to the agent even when
  // runAudit IS a capability (previously this whole step was skipped in that mixed configuration).
  let anchorsAdded = 0
  if (typeof cap.annotateAnchors === 'function') {
    try { const a = await cap.annotateAnchors(f); anchorsAdded = (a && a.updated && a.updated.length) || 0 } catch { anchorsAdded = 0 }
  } else {
    await engine.agent(
      `用 Bash 运行：node ${JSON.stringify(skillDir + '/audit_refined.mjs')} --source ${JSON.stringify(src)} --refined ${JSON.stringify(out)} --anchors\n只回复一句话确认即可。`,
      { label: `anchors:${f.label}`, phase: 'Audit', model: 'haiku' })
  }

  return { status: auditFailed.length ? 'fail' : 'ok', auditFailed, failedFindings: (cur.failed || []).filter(Boolean), hardFindings: hard, softFindings: softOf(cur), repaired, repairAttempts, anchorsAdded, directAudit }
}

const DEDUP_SKIP_UNKNOWN_RATIO = 0.10
const entityCount = (merged) => ((merged && merged.people) || []).length + ((merged && merged.brands) || []).length + ((merged && merged.terms) || []).length
function dedupCoverage(prior, merged) {
  const target = dropLocked(merged)
  const total = entityCount(target)
  if (!prior || !total) return { total, unknown: total, covered: 0, unknownRatio: total ? 1 : 0, skip: false }
  const unknown = entityCount(excludeVerified(target, prior))
  const unknownRatio = unknown / total
  return { total, unknown, covered: total - unknown, unknownRatio, skip: unknownRatio <= DEDUP_SKIP_UNKNOWN_RATIO }
}

async function runPipeline(A, engine) {
const M = Object.assign(
  {}, DEFAULT_STAGE_MODELS,
  A.models || {}
)
const scope = A.scope || ['refine']
const capabilities = A.capabilities || null
const EMPTY_RETURN = (error) => ({ error, glossary: '', refined: [], failed: [], incomplete: [], unchecked: [], headingConflicts: [], scoutSuspect: [], scoutFailed: [], suspectedDuplicates: [], networkUnverified: [], logic: [], openQuestions: [], summary: null, timeline: null, transcriptMetadata: null, speakerIdentityFinalizations: [], auditFailed: [], auditUnavailable: [], qualityRepairAttempts: [] })
if (!Array.isArray(A.files) || A.files.length === 0) {
  return EMPTY_RETURN('args.files 为空——需在 Step 0 预检后组装 files 再派发')
}
// summary / timeline / logical-order rewrite all take this session's refined output as input; a scope with a
  // deliverable but no refine would silently produce nothing — so fail early and diagnosably.
if ((scope.includes('summary') || scope.includes('timeline') || scope.includes('logic')) && !scope.includes('refine')) {
  return EMPTY_RETURN('summary/时间线/逻辑顺序稿依赖本会话 refine 产物，scope 须同时含 refine（本工作流不支持只对历史成稿单独出交付物）')
}

// Persistent per-company glossary (P1): if Step 0 found an existing 校对表.md and passed its text (or a
// priorGlossaryPath the host/agent reads), parse it into prior memory to seed scout + accumulate into. A.fresh
// forces a from-scratch rebuild. Attached to A so scoutPrompt can read it. Absent/empty → null → behaviour
// identical to a first run. priorGlossaryText wins over priorGlossaryPath (§4 resolution order).
const priorText = A.fresh ? '' : await readPriorGlossaryText(A, engine, capabilities)
const prior = priorText ? parseGlossary(priorText) : null
A.prior = prior
A.doNotMerge = (prior && prior.doNotMerge) || []   // P4: human-confirmed distinct referents, carried forward to dedup + render
let conflicts = []                                  // P4: this batch's verify conclusions that disagree with the prior glossary
let weakDups = []                                   // P4b: cross-batch weak-honorific (张总/李总) ambiguities to disambiguate
let reopenNotes = []                                // M9a: prior 〔核实〕 entries this batch re-queued for verify on new contradicting evidence
if (prior) engine.log(`沿用往次校对表：已知 ${prior.people.length} 人名 / ${prior.brands.length} 品牌 / ${prior.terms.length} 术语、${(prior.verified.resolved || []).length} 条核实结论——本轮在其上累积`)

let glossary = ''
let netUnverified = []
let asrSuspects = []   // scout-flagged ASR suspects verify couldn't resolve → folded into openQuestions
let contestedAsks = []   // 〔同指两解〕 contested identities (spoken form kept in text) → one 收尾待问 line each
let refined = []
let failed = []
let headingConflicts = []
let scoutSuspect = []
let scoutFailed = []   // files whose scout returned nothing (stalled) — refined anyway (glossary degraded), surfaced for re-scout
let dedup = null
let auditFailed = []    // per-file publication-gate findings still failing after at most two targeted repair rounds
let incomplete = []     // Legacy return-contract field; source-aware hard failures live in auditFailed.
let unchecked = []      // Refined files lacking a direct audit capability, or whose audit errored.
let auditUnavailable = []  // P7 fail-loud: files whose audit could NOT run after one retry — the run is marked failed (unaudited, not passed).
let derivativesSkipped = [] // requested derivatives withheld because their source body was not final/audited
let overrideQuestions = []   // SF-2 + risk(c): decree conflicts (one cluster claimed by ≥2 decrees) and cross-category mis-declared-category warnings → openQuestions
let refinedPairs = []   // [{ f, rep }]: successfully refined files and their reports (including headings); used by the logic-reorder phase to read f.title/outPath and verify section-heading coverage
let speakerResolutions = []  // one deterministic Scout mapping per file; Refine reads its materialized input copy
let speakerOutputNormalizations = [] // same mapping re-applied to model output aliases; no identity inference
let speakerStructuralFailures = [] // output violated the source's tracked/untracked speaker contract; never deliver that draft
let speakerStructureWarnings = [] // parser/Scout disagreement or unresolved label shape; visible review, never silent untracked
let speakerCandidateAdjudications = [] // LLM verdicts for residual output candidates; only high-confidence invention blocks
let speakerIdentityFinalizations = [] // post-refine track registry decisions + deterministic render ledger
let transcriptMetadata = null // single-file catalog metadata produced by the same final identity pass
let qualityRepairAttempts = [] // append-only across all files, including drafts later removed by the final contract

// Claude Code / Codex subscription runtimes keep the original cheap one-pass path for a lone short file.
// Universal supplies host capabilities (including the Turn IR contract), so it always takes the full
// Scout/Resolve/Refine path. Generic-label inputs also stay on that full path so deterministic speaker
// resolution and canonical-label enforcement remain active.
const useShortFileFastPath = !capabilities
  && A.files.length === 1
  && refineSize(A.files[0]) < ONE_PASS_CHARS
  && !A.captureSingleShot
  && A.files[0].needsSpeakerResolution === false
if (useShortFileFastPath) {
  // Legacy single-short-file path: one-pass refine, skipping Scout/Verify.
  // (M11b: a batch-submit capture pass forces the else-branch so even a tiny lone file is captured as a
  // single-shot batch request via refineFileSingleShot, not sent through the one-pass Write-tool agent.)
  // Length judged by 正文字数, not lines. NOTE (M11a): refineMode:'single-shot' does NOT change this branch —
  // one-pass is already the cheapest possible refine (one agent, no scout/verify), so a tiny single file always
  // takes it. Single-shot's one-request-per-file contract governs the standard refineFile path (multi-file /
  // larger single files); see refineFileSingleShot.
  const f = A.files[0]
  engine.phase('Refine')
  engine.log(`▶ 精校 Refine：单份短文件（约 ${refineSize(f)} 字）一遍过，不建独立校对表`)
  // §1 on the one-pass path too: this branch skips scout/merge entirely, so canonicalOverrides has no cluster
  // list to veto — without this, a user decree was silently dropped (never reached singlePassPrompt, never
  // reached audit). Route every override through applyOverridesToMerged against an EMPTY bundle: every decree
  // then hits the documented "matched nothing → still emit a locked cluster" path, so it's guaranteed to
  // surface here exactly as it would on the multi-file path. Category routing (person/brand/term) is preserved.
  const lockedClusters = (A.canonicalOverrides && A.canonicalOverrides.length)
    ? applyOverridesToMerged({ people: [], brands: [], terms: [] }, A.canonicalOverrides)
    : null
  const lockedAll = lockedClusters ? [...lockedClusters.people, ...lockedClusters.brands, ...lockedClusters.terms] : []
  let overrideNote = ''
  let onePassGlossaryText = null
  if (lockedAll.length) {
    engine.log(`用户钦定正名（一遍过分支）：${lockedAll.length} 条已注入 prompt + 最小校对表`)
    // Prompt injection: same voice as the rest of singlePassPrompt (中文、弯引号、盘古空格).
    const decreeLines = lockedAll.map((e) => {
      const variants = (e.variants || []).join(' / ') || '（无变体）'
      return `- ${variants} 一律写作 **${e.canonical}**`
    })
    overrideNote = `【用户钦定正名（必须执行）】以下写法无论源文件里出现哪种口语/变体，精校时一律统一写作钦定正字：\n${decreeLines.join('\n')}`
    // Minimal glossaryText for the audit gate: hand-rolled `- **正字** ← 变体1 / 变体2` rows in the exact
    // grammar audit_refined.mjs's parseGlossaryLite recognises (canonical entity line under a 人名/品牌 header),
    // so ghost_name / missing_yin can catch a decreed variant surviving into the 成稿 on this path too.
    onePassGlossaryText = ['## 人名 / 品牌（用户钦定）', ...lockedAll.map((e) =>
      `- **${e.canonical}** ← ${(e.variants || []).join(' / ') || '—'} ｜ 用户钦定`)].join('\n')
  }
  const onePassPlan = {
    label: f.label, outPath: f.outPath, model: M.refine, contentLength: refineSize(f), driver: 'single',
    parts: [{ idx: 1, startLine: 1, endLine: f.lines, path: f.outPath }],
  }
  if (!Array.isArray(A.plannedChunks)) A.plannedChunks = []
  A.plannedChunks.push(onePassPlan)
  if (typeof A.onChunkPlan === 'function') A.onChunkPlan(onePassPlan)
  const rep = await engine.agent(singlePassPrompt(f, A, overrideNote), { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, effort: effortFor(A, 'refine'), schema: REFINE_REPORT_SCHEMA, outputPath: f.outPath })
  if (rep) {
    refined = [Object.assign({}, rep, { outPath: f.outPath, complete: null, checkNote: '审计待跑' })]
    refinedPairs = [{ f, rep, anchor: null, onePassGlossaryText }]
  } else {
    failed = [f.label]
  }
  glossary = SINGLE_FILE_GLOSSARY
} else {
  engine.phase('Scout')
  engine.log(`▶ 1/${scope.includes('logic') ? 5 : 4} 侦察 Scout：${A.files.length} 份并行抽取实体（人名 / 品牌 / 术语 / 发言人）`)
  let findings = await engine.parallel(A.files.map((f) => () => scoutFile(engine, f, A, M)))
  // Garbled-scout self-healing: if a scout result looks garbled, retry it once (a haiku call is cheap); if still garbled, flag it in scoutSuspect and warn at delivery that the glossary entry for that file is unreliable.
  // The refined transcript is unaffected — refine reads the source file directly and does not blindly trust the scout output — but the archived glossary entry for that file will be dirty.
  const retryIdx = A.files.map((f, i) => (findings[i] && scoutLooksGarbled(findings[i])) ? i : -1).filter((i) => i >= 0)
  if (retryIdx.length) {
    engine.log(`侦察疑似损坏（疑网络中途毁坏生成流）：${retryIdx.map((i) => A.files[i].label).join('、')}——各重试一次`)
    const retries = await engine.parallel(retryIdx.map((i) => () => scoutFile(engine, A.files[i], A, M, 'scout-retry')))
    retryIdx.forEach((i, k) => { if (retries[k] && !scoutLooksGarbled(retries[k])) findings[i] = retries[k] })
  }
  scoutSuspect = A.files.filter((f, i) => findings[i] && scoutLooksGarbled(findings[i])).map((f) => f.label)
  engine.log(`侦察完成 ${findings.filter(Boolean).length}/${A.files.length} 份${scoutSuspect.length ? `（${scoutSuspect.join('、')} 重试后仍疑损坏，校对表该份不可靠）` : ''}`)
  // Still-garbled scout results are dropped entirely from the merge: this prevents polluting the glossary body and avoids wasting verify/dedup web-lookup calls on garbage input.
  // Refine for that file still runs normally (it reads the source file directly, not the scout output); scoutSuspect still prompts the user to re-run scout for that file.
  // If every scout is garbled, cleanFindings is all-null → merged lists are all empty → doVerify is naturally false and dedupList is empty, so the whole verify/dedup block short-circuits safely.
  const cleanFindings = findings.map((fd) => (fd && scoutLooksGarbled(fd)) ? null : fd)
  // §1 user-decreed canonical overrides get their structural veto here — BEFORE verify/render — so a decree
  // (“口语 X/Y 一律写作 Z”) forces the canonical, collapses homophone clusters the weak-key guard won't merge,
  // and is GUARANTEED to appear even if the scout never surfaced it. Locked clusters skip verify (dropLocked
  // below), skip the name-guard (applyVerifiedEntry short-circuits), and render as 〔用户钦定〕 (no ⚠).
  const mergedThisBatch = applyOverridesToMerged(mergeFindings(cleanFindings, A.files), A.canonicalOverrides)
  const lockedCount = [...(mergedThisBatch.people || []), ...(mergedThisBatch.brands || []), ...(mergedThisBatch.terms || [])].filter((e) => e && e.locked).length
  if (lockedCount) engine.log(`用户钦定正名：${lockedCount} 条已锁定（强制 canonical、跳联网核实、渲染带〔用户钦定〕）`)
  // 飞书 ASR 同事名偏置：与内部通讯录同名的人名标 suspect_asr（强制联网核实）。放在 overrides 之后——
  // locked（用户钦定）条目不受名单影响（decree 是明确人工指令）。名单只在代码里比对，内容不进任何 prompt
  // （hint 只描述失误模式，不断言名单成员身份，见 spec.js 该节注释）。
  let dirReopenWritings = []
  if (Array.isArray(A.internalDirectory) && A.internalDirectory.length) {
    if (A.verifyDepth === 'none') engine.log('⚠ 已传内部通讯录但 verify=none：命中名单的人名只能标记存疑、写进 openQuestions，无法联网核实——建议至少用 --verify key')
    // 侦察漏网补扫：名单名字出现在源文本、却没进侦察 people 清单时，代码级逐字扫描把它找回来注入
    // （侦察分块失败/漏抽/只当成说话人标签都会漏）。宿主没有 readFile 能力（CC sandbox）时跳过——侦察结果仍然覆盖。
    const cap = A.capabilities || {}
    if (typeof cap.readFile === 'function') {
      const existingForms = mergedThisBatch.people.flatMap((e) => [e.canonical, ...(e.variants || [])])
      for (const f of A.files) {
        let text = null
        try { text = await cap.readFile(f.refinePath || f.path) } catch { /* 单文件读失败不致命——该文件只失去补扫 */ }
        if (!text) continue
        for (const name of scanTextForDirectoryNames(text, A.internalDirectory, existingForms)) {
          existingForms.push(name)
          mergedThisBatch.people.push({ canonical: name, variants: [], hint: '', files: [f.label], public_figure: false, suspect_asr: false, category: '', crossFile: false })
        }
      }
    }
    const dirMatched = applyInternalDirectorySuspicion(mergedThisBatch, A.internalDirectory)
    if (dirMatched.length) {
      engine.log(`内部通讯录同名预警：${dirMatched.map((m) => m.canonical).join('、')}——已标⚠强制联网核实（飞书 ASR 常把听不清的名字写成上传方同事名）`)
      // 撬开核实缓存：往批已〔核实〕的条目会被 excludeVerified 跳过，但名单命中者必须每批重核——
      // 上一批核实时可能还没传名单，且这类名字被 ASR 吸附的先验概率高，宁可多核。
      dirReopenWritings = dirMatched.flatMap((m) => m.writings)
    }
  }
  // SF-2: a single cluster claimed by ≥2 competing decrees was merged into one locked cluster (canonical = first
  // decree) — surface the disagreement. Risk(c): a decree that hit nothing in its declared category but whose
  // writing appears in another category's cluster — likely a mis-declared category. Both go into openQuestions.
  for (const c of mergedThisBatch.overrideConflicts || []) overrideQuestions.push(`钦定正名冲突：同一对象被多条 decree 命名为「${c.canonicals.join('」「')}」——已按首条统一为「${c.resolvedTo}」，请确认是否正确。`)
  for (const w of mergedThisBatch.categoryWarnings || []) overrideQuestions.push(`钦定正名类别疑误标：「${w.canonical}」声明为${w.declared}，但其写法在${w.foundIn}里出现——已按声明的${w.declared}锁定，请确认类别。`)
  if (overrideQuestions.length) engine.log(`用户钦定正名：${overrideQuestions.length} 条冲突/类别疑问——并入 openQuestions 待确认`)
  headingConflicts = findHeadingConflicts(cleanFindings, A.files, A.headingPolicy)
  if (headingConflicts.length) engine.log(`注意：${headingConflicts.join('、')} 源文件已带小标题但 headingPolicy=none——收尾时需问用户保留还是重做`)

  engine.phase('Verify')
  engine.log(`▶ 2/${scope.includes('logic') ? 5 : 4} 核实 Verify：精校前核实关键实体 + 语义同指排查`)
  // verify (web-lookup fact-checking, chunked and parallelised) and dedup (semantic co-reference check across all entities) are independent of each other — run both concurrently in the same parallel
  let verified = null
  // terms count too (verifyChunks already submits terms for checking; the deep level requires all terms to be verified, and omitting terms from the threshold would cause a terms-only interview to silently skip verification)
  // M9 firebreak (anti-fossilization): BEFORE the verify-cache exclusion, decide which prior 〔核实〕 entries to
  // pull back into the verify queue this batch — (M9a) any prior-verified entry whose scout cluster this batch
  // grew a NEW contradicting strong writing, and (M9b) the N oldest verified entries on a rotation by age. Both
  // are skipped when verify is off (nothing would be re-checked anyway). The reopened writings are removed from
  // excludeVerified's skip set so a re-opened entity that ALSO recurs this batch drops back into verifyTarget;
  // M9a's notes surface into the glossary render (A.reopenNotes → 本轮重新入队复核 section) and openQuestions.
  let forceReopen = []
  if (A.verifyDepth !== 'none' && prior) {
    const reopen = contradictionReopen(prior, mergedThisBatch)   // M9a: scout-evidence contradiction (no model call)
    const rot = rotateReverify(prior, ROTATE_REVERIFY)           // M9b: oldest-N age rotation
    reopenNotes = reopen.notes
    forceReopen = Array.from(new Set([...reopen.writings, ...rot.writings, ...dirReopenWritings]))
    if (reopen.notes.length) engine.log(`往批核实复核（M9a）：${reopen.notes.length} 项旧核实结论遇新写法证据，已重新入队核实`)
    if (rot.count) engine.log(`轮换复核：${rot.count} 项旧核实结论重新入队（最早 ${rot.oldest || '无日期（视为最旧）'}）`)
  }
  A.reopenNotes = reopenNotes
  // P2: don't re-verify entities the prior glossary already confirmed — verify only this batch's new ones.
  // §1: also drop locked (用户钦定) clusters — a decree is final, nothing to look up.
  // M9: forceReopen pulls the firebreak-selected prior-verified writings back out of the skip set.
  const verifyTarget = excludeVerified(dropLocked(mergedThisBatch), prior, forceReopen)
  if (prior) { const sk = (mergedThisBatch.people.length + mergedThisBatch.brands.length + mergedThisBatch.terms.length) - (verifyTarget.people.length + verifyTarget.brands.length + verifyTarget.terms.length); if (sk > 0) engine.log(`核实缓存：跳过 ${sk} 项往次已核实实体，本轮只核新实体`) }
  const doVerify = A.verifyDepth !== 'none' && (verifyTarget.people.length || verifyTarget.brands.length || verifyTarget.terms.length)
  const vc = doVerify ? verifyChunks(verifyTarget, A.verifyDepth) : { chunks: [], eligible: 0, excluded: 0, overflow: 0 }
  if (doVerify) {
    engine.log(`核实：${vc.eligible} 项分 ${vc.chunks.length} 块并行送检${vc.excluded > 0 ? `，${vc.excluded} 项低优先级未送检（由精校按原文归一）` : ''}`)
    if (vc.overflow > 0) engine.log(`核实：实体过多，${vc.overflow} 项超出 ${VERIFY_CHUNK * MAX_CHUNKS} 上限未送检`)
  }
  const dedupList = dedupListText(mergedThisBatch)
  const dedupStats = dedupCoverage(prior, mergedThisBatch)
  const skipDedup = !!(dedupList && dedupStats.skip)
  if (skipDedup) engine.log(`疑似同指缓存：跳过语义同指排查，往次校对表覆盖 ${dedupStats.covered}/${dedupStats.total} 个非钦定实体，新/未知 ${dedupStats.unknown} 个（${Math.round(dedupStats.unknownRatio * 100)}%，阈值 ≤10%）`)
  const [vparts, dedupRes] = await engine.parallel([
    () => vc.chunks.length
      ? engine.parallel(vc.chunks.map((ct, i) => () => engine.agent(verifyPrompt(ct, A), { label: `verify:${i + 1}/${vc.chunks.length}`, phase: 'Verify', model: M.verify, effort: effortFor(A, 'verify'), schema: VERIFY_SCHEMA })))
      : Promise.resolve([]),
    () => dedupList && !skipDedup
      ? engine.agent(dedupPrompt(dedupList, A), { label: 'dedup:semantic', phase: 'Verify', model: M.dedup, effort: effortFor(A, 'dedup'), schema: DEDUP_SCHEMA })
      : Promise.resolve(null),
  ])
  const goodParts = (vparts || []).filter(Boolean)
  if (vc.chunks.length) {
    // Row-level sanitisation: the schema no longer enforces fields, so degraded output may be missing query/canonical — rows missing critical fields are dropped outright
    verified = {
      resolved: goodParts.flatMap((p) => p.resolved || []).filter((r) => r && r.query && r.canonical),
      unresolved: goodParts.flatMap((p) => p.unresolved || []).filter((r) => r && r.query),
      // Contested verdicts (two-key rule blocked a referent substitution) → 〔同指两解〕 rows + 收尾待问 lines.
      contested: goodParts.flatMap((p) => p.contested || []).filter((r) => r && r.query),
    }
    engine.log(`核实完成：${verified.resolved.length} 项确认，${verified.unresolved.length} 项存疑（${goodParts.length}/${vc.chunks.length} 块返回）`)
    if (goodParts.length < vc.chunks.length) engine.log(`核实：${vc.chunks.length - goodParts.length}/${vc.chunks.length} 块未返回（疑网络劣化），该批实体本轮未核实——网络稳定后可重跑`)
    netUnverified = pickNetworkUnverified(verified)
    if (netUnverified.length) engine.log(`其中 ${netUnverified.length} 项因网络故障未核实——收尾时可向用户提供补核选项（networkUnverified）`)
  }
  conflicts = prior ? glossaryConflicts(prior, verified) : []
  if (conflicts.length) engine.log(`核实冲突：${conflicts.length} 项本轮核实与往次校对表不一致——并入 openQuestions 待人工确认（未自动改写）`)
  dedup = dedupRes ? { suspects: cleanSuspects(dedupRes.suspects) } : null
  if (dedup && dedup.suspects.length) engine.log(`疑似同指：标记 ${dedup.suspects.length} 组待人工确认`)
  // Accumulate this batch into the prior glossary (P1): verify/dedup ran on this batch's findings;
  // prior conclusions are carried forward (not re-verified). Render the cumulative glossary — refine
  // below reads it, so 写法 stay consistent across the company's whole interview set.
  const merged = prior ? mergeIntoPrior(prior, mergedThisBatch) : mergedThisBatch
  const allVerified = prior ? mergeVerified(prior.verified, verified) : verified
  const allDedup = prior ? { suspects: mergeDedup(prior.dedupSuspects, (dedup && dedup.suspects) || []) } : dedup
  weakDups = prior ? weakDupFlags(prior, mergedThisBatch) : []
  asrSuspects = suspectUnverified(mergedThisBatch, allVerified)   // suspects still unresolved after verify → ask the user
  if (asrSuspects.length) engine.log(`疑似转录误写未核实：${asrSuspects.length} 项——并入 openQuestions 待人工确认正确写法`)
  contestedAsks = contestedQuestions(merged, allVerified)   // 〔同指两解〕: spoken form kept, both hypotheses surfaced
  if (contestedAsks.length) engine.log(`同指两解：${contestedAsks.length} 项口播形存疑（正文已保留原形并标注）——并入 openQuestions 待定夺`)
  if (weakDups.length) engine.log(`称呼歧义：${weakDups.length} 个弱称呼跨批次重复（未合并）——并入 openQuestions 待人工辨认`)
  if (prior) engine.log(`累积合并：校对表现含 ${merged.people.length} 人名 / ${merged.brands.length} 品牌 / ${merged.terms.length} 术语`)
  glossary = renderGlossary(merged, allVerified, allDedup, A)
  // Condensed glossary for chunk-refine agents (full 校对表 still persisted + used by single-agent refine).
  const refineGlossary = renderRefineGlossary(merged, allVerified, allDedup, A)

  let positional = []
  if (scope.includes('refine')) {
    // Speaker identity is a whole-file decision owned by Scout, not by independent Refine chunks. Universal
    // materializes that mapping into a disposable, line-for-line input copy here. The original path stays on f
    // for source-aware audit; only Refine switches to refinePath. Runtimes without fs capability keep the prior
    // prompt-only behaviour.
    if (capabilities && typeof capabilities.prepareSpeakerInput === 'function') {
      const prepared = await engine.parallel(A.files.map((f, i) => async () => {
        const finding = cleanFindings[i] || {}
        try { return await capabilities.prepareSpeakerInput(f, finding) } catch (e) {
          if (capabilities.requireTurnContract) return { turnContractFailure: e }
          engine.log(`发言人统一输入生成失败：${f.label}（${(e && e.message) || e}）——保留原稿进入 Refine`)
          return null
        }
      }))
      prepared.forEach((resolution, i) => {
        if (!resolution) return
        const f = A.files[i]
        if (resolution.turnContractFailure) {
          f.refinePreparationFailed = true
          const failure = recordTurnContractFailure(A, f, resolution.turnContractFailure, 'prepare')
          engine.log(`精校 turn contract 输入生成失败：${f.label}（${failure.code}：${failure.message}）`)
          return
        }
        f.refinePath = resolution.refinePath || resolution.path || f.path
        f.refineSourcePath = resolution.path || f.path
        f.refineContract = resolution.refineContract || null
        if (Array.isArray(resolution.turns) && resolution.turns.length) f.turns = resolution.turns
        f.speakerResolution = {
          speakerMode: resolution.speakerMode || f.speakerMode || (resolution.labelLines ? 'tracked' : 'untracked'),
          mappings: resolution.mappings || [],
          unresolved: resolution.unresolved || [],
          changedLines: resolution.changedLines || 0,
          labelLines: resolution.labelLines || 0,
          structureWarnings: resolution.structureWarnings || [],
          recoveredByScout: resolution.recoveredByScout || [],
        }
        f.speakerMode = f.speakerResolution.speakerMode
        if (f.speakerResolution.structureWarnings.length) {
          speakerStructureWarnings.push({
            label: f.label,
            path: f.outPath,
            speakerMode: f.speakerResolution.speakerMode,
            warnings: f.speakerResolution.structureWarnings,
          })
          engine.log(`发言人结构待复核：${f.label} 有 ${f.speakerResolution.structureWarnings.length} 类解析/侦察不一致——本次质量状态将标记待复核`)
        }
        const renamed = f.speakerResolution.mappings.filter((m) => m.sourceLabel !== m.outputLabel)
        if (renamed.length) engine.log(`发言人统一：${f.label} 已在 Refine 输入中一次性应用 ${renamed.map((m) => `${m.sourceLabel}→${m.outputLabel}`).join('、')}`)
        if (f.speakerResolution.unresolved.length) engine.log(`发言人仍未识别：${f.label} 的 ${f.speakerResolution.unresolved.join('、')}（未猜名，保留源标签）`)
      })
    }
    engine.phase('Refine')
    engine.log(`▶ 3/${scope.includes('logic') ? 5 : 4} 精校 Refine：${A.files.length} 份逐份精校${A.chunkMode === 'speed' ? '（大文件分块并行）' : ''}`)
    // Refine runs even when scout failed for a file (findings[i] null): refine reads the source directly and
    // the glossary is only an aid, so a stalled cheap scout degrades the glossary but
    // never blocks the expensive pass. No barrier between files (pipeline).
    positional = await engine.pipeline(A.files,
      (f, _f, i) => f.refinePreparationFailed
        ? Promise.resolve(null)
        : refineFile(engine, f, glossary, refineGlossary, cleanFindings[i] || {}, A, M))
  }
  scoutFailed = A.files.filter((f, i) => scope.includes('refine') && positional[i] && !findings[i]).map((f) => f.label)
  if (scoutFailed.length) engine.log(`侦察未返回、已照常精校（校对表缺这几份实体，网络稳定后可重扫）：${scoutFailed.join('、')}`)
  failed = A.files.filter((f, i) => scope.includes('refine') && !positional[i]).map((f) => f.label)
  refined = positional.map((rep, i) => rep && Object.assign({}, rep, {
    outPath: A.files[i].outPath,
    complete: null,
    checkNote: '审计待跑',
    ...(A.files[i].speakerResolution ? { speakerResolution: A.files[i].speakerResolution } : {}),
  })).filter(Boolean)
  refinedPairs = A.files.map((f, i) => ({ f, rep: positional[i], anchor: cleanFindings[i] && cleanFindings[i].ending_anchor })).filter((p) => p.rep)
  if (failed.length) engine.log(`未完成：${failed.join('、')}（主代理需按 SKILL.md Step 1–2 手动补做）`)
}

// One output contract for BOTH the one-pass and standard branches. Tracked sources may use only the canonical
// mapping; untracked sources must remain untracked. Known aliases are rewritten deterministically. Unknown labels
// are left visible for the final fail-closed check below — never guessed or stripped.
if (scope.includes('refine') && refinedPairs.length && capabilities && typeof capabilities.enforceSpeakerOutput === 'function') {
  const normalized = await engine.parallel(refinedPairs.map(({ f, rep }) => async () => {
    if (!rep || rep.captured) return null
    try { return await capabilities.enforceSpeakerOutput(f, 'post_refine') } catch (e) {
      engine.log(`发言人输出收口失败：${f.label}（${(e && e.message) || e}）——最终结构契约将拒绝该草稿`)
      return { contractUnavailable: true, unknownLabels: [], violations: [] }
    }
  }))
  normalized.forEach((report, i) => {
    if (!report) return
    const { f, rep } = refinedPairs[i]
    f.speakerOutputReport = report
    const entry = {
      label: f.label,
      path: f.outPath,
      changedLines: report.changedLines || 0,
      replacements: report.replacements || [],
      unknownLabels: report.unknownLabels || [],
      valid: report.valid !== false && !report.contractUnavailable,
      violations: report.violations || [],
    }
    speakerOutputNormalizations.push(entry)
    if (entry.changedLines) engine.log(`发言人输出收口：${entry.label} 按全文统一映射修正 ${entry.changedLines} 个标签别名`)
    if (entry.unknownLabels.length) {
      const labels = [...new Set(entry.unknownLabels.map((x) => x.label))]
      engine.log(`发言人输出出现映射外候选：${entry.label} 的 ${labels.join('、')}——未自动猜改，将在最终结构契约中按需调用模型裁决`)
    }
  })
}
speakerResolutions = A.files.filter((f) => f.speakerResolution).map((f) => ({
  label: f.label,
  path: f.refineSourcePath || f.path,
  ...f.speakerResolution,
}))

// §2 Audit gate (in-pipeline): each refined file goes through the source-aware audit AFTER refine/stitch and
// BEFORE logic/summary/timeline. Any publication gate triggers at most two targeted auto-repair rounds,
// each followed by a re-audit; still-hard files are recorded in auditFailed (and get a visible 缺口 marker via --annotate).
// Anchors run on the (possibly repaired) 成稿. With fs the host injects capabilities.runAudit/annotateAnchors/
// repair; without (CC sandbox) a subagent runs audit_refined.mjs. Skipped for a scope with no refine output.
// M11b: on a batch-submit capture pass (A.captureSingleShot), no 成稿 is on disk yet (files are written on
// resume), so every captured rep is excluded from the audit gate here — resume runs the full audit after fetch.
const pairsToAudit = refinedPairs.filter((p) => !(p.rep && p.rep.captured))
if (scope.includes('refine') && pairsToAudit.length) {
  // Adjudicate residual shape candidates before the source-aware audit. Attribution uses the same parser, so
  // waiting until the final contract would let an uncertain label become a hard attribution mismatch first.
  const initialAdjudications = await engine.parallel(pairsToAudit.map(({ f }) => () => (
    adjudicateOutputSpeakerCandidates(engine, f, f.speakerOutputReport, M)
  )))
  pairsToAudit.forEach(({ f }, index) => {
    f.speakerCandidateAdjudication = initialAdjudications[index]
      || unavailableSpeakerCandidateAdjudication(f, f.speakerOutputReport, M)
  })

  engine.phase('Audit')
  engine.log(`▶ 审计门禁 Audit：${pairsToAudit.length} 份逐份源比对（正文忠实性 + 交付质量；有事务能力时最多候选修复 ${QUALITY_REPAIR_MAX_ROUNDS} 轮并逐轮复检；仍未过记入 auditFailed）`)
  // §1 one-pass branch: onePassGlossaryText (the minimal 用户钦定 rows) stands in for the outer `glossary`
  // (which is just the SINGLE_FILE_GLOSSARY placeholder there, and must NOT be handed to the audit — see
  // risk (a) test). Every multi-file pair lacks this key, so `glossary` (the real rendered 校对表) still flows
  // through unchanged.
  const results = await engine.parallel(pairsToAudit.map(({ f, onePassGlossaryText }) => () => runAuditStep(A, engine, f, capabilities, onePassGlossaryText || glossary)))
  const hasDirectAudit = !!(capabilities && typeof capabilities.runAudit === 'function')
  pairsToAudit.forEach(({ f }, k) => {
    const a = results[k] || { status: 'unavailable', auditUnavailable: true, failedFindings: [], hardFindings: [], softFindings: [], repaired: false, anchorsAdded: 0, directAudit: hasDirectAudit }
    qualityRepairAttempts.push(...(a.repairAttempts || []))
    const r = refined.find((x) => (x.outPath || x.path) === f.outPath)
    if (r) {
      r.audit = { status: a.status, hardFindings: a.hardFindings || [], softFindings: a.softFindings || [], repaired: !!a.repaired, repairAttempts: a.repairAttempts || [], anchorsAdded: a.anchorsAdded || 0, auditUnavailable: !!a.auditUnavailable }
      if (a.directAudit && !a.auditUnavailable) {
        r.complete = null
        r.checkNote = ''
      } else {
        r.complete = null
        r.checkNote = a.auditUnavailable ? 'audit unavailable' : 'no direct audit capability'
      }
    }
    if (!a.directAudit || a.auditUnavailable) unchecked.push(f.outPath)
    // P7: an audit that could NOT run (after one retry) fails the run loudly — distinct from the normal
    // "no direct audit capability" CC case (where the agent audit DID run). Only auditUnavailable qualifies.
    if (a.auditUnavailable) auditUnavailable.push({ path: f.outPath, label: f.label })
    if ((a.auditFailed || []).length) auditFailed.push({ path: f.outPath, findings: a.auditFailed })
    const seamDuplicates = (r && r.seamDuplicates) || []
    if (seamDuplicates.length) {
      if (r && r.audit) {
        r.audit.status = 'fail'
        r.audit.hardFindings = [...new Set([...(r.audit.hardFindings || []), 'seam_duplicate'])]
      }
      const existing = auditFailed.find((x) => x.path === f.outPath)
      if (existing) existing.findings = [...new Set([...(existing.findings || []), 'seam_duplicate'])]
      else auditFailed.push({ path: f.outPath, findings: ['seam_duplicate'] })
    }
  })
  if (auditFailed.length) engine.log(`审计未过（候选 / CC 定点修复后仍 hard，或当前运行时无适用自动修复能力）：${auditFailed.map((x) => `${x.path}（${x.findings.join('/')}）`).join('；')}`)
  if (auditUnavailable.length) engine.log(`⚠ 审计无法运行 ${auditUnavailable.length} 份——本次运行判定为失败，产物未经审计：${auditUnavailable.map((x) => x.label).join('、')}`)
}

// Repairs are model writes too. Run the structural contract once more after the final audit/repair round and
// fail closed. The draft remains on disk for server-side diagnosis, but it is removed from `refined`, so the
// artifact manifest cannot advertise it as a deliverable main transcript.
if (scope.includes('refine') && pairsToAudit.length && capabilities && typeof capabilities.enforceSpeakerOutput === 'function') {
  const finalContracts = await engine.parallel(pairsToAudit.map(({ f }) => async () => {
    try { return await capabilities.enforceSpeakerOutput(f, 'final_contract') } catch (e) {
      engine.log(`发言人最终结构契约无法运行：${f.label}（${(e && e.message) || e}）`)
      return { contractUnavailable: true, valid: false, unknownLabels: [], violations: [] }
    }
  }))
  const adjudications = await engine.parallel(finalContracts.map((report, index) => async () => {
    if (!report || report.contractUnavailable || !outputSpeakerCandidates(report).length) return Promise.resolve(null)
    const f = pairsToAudit[index].f
    return reuseSpeakerCandidateAdjudication(f.speakerCandidateAdjudication, f, report)
      || adjudicateOutputSpeakerCandidates(engine, f, report, M)
  }))
  const rejectedPaths = new Set()
  finalContracts.forEach((report, index) => {
    const { f } = pairsToAudit[index]
    const adjudication = adjudications[index] || unavailableSpeakerCandidateAdjudication(f, report, M)
    f.speakerCandidateAdjudication = adjudication || null
    if (adjudication) speakerCandidateAdjudications.push(adjudication)
    const decisions = (adjudication && adjudication.decisions) || []
    const blockedCandidates = decisions.filter((item) => item.outcome === 'block')
    const reviewCandidates = decisions.filter((item) => item.outcome === 'review')
    const rawCandidates = outputSpeakerCandidates(report)
    const invalid = !report
      || report.contractUnavailable
      || blockedCandidates.length > 0
      || (report.valid === false && rawCandidates.length === 0)
    if (reviewCandidates.length) {
      const labels = [...new Set(reviewCandidates.map((item) => item.label))]
      const lines = [...new Set(reviewCandidates.map((item) => item.line))]
      speakerStructureWarnings.push({
        label: f.label,
        path: f.outPath,
        speakerMode: (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode || null,
        warnings: [{
          kind: adjudication && adjudication.status === 'unavailable'
            ? 'speaker_candidate_adjudication_unavailable'
            : 'output_speaker_candidate_unresolved',
          count: reviewCandidates.length,
          lines,
          labels,
        }],
      })
      const question = `成稿有 ${reviewCandidates.length} 处疑似映射外说话人候选，模型未能高置信确认是否为新增说话人：${reviewCandidates.map((item) => `第 ${item.line} 行“${item.label}”`).join('、')}。请人工复核。`
      const pair = refinedPairs.find((item) => item.f.outPath === f.outPath)
      if (pair && pair.rep) pair.rep.open_questions = [...(pair.rep.open_questions || []), question]
      const refinedEntry = refined.find((item) => (item.outPath || item.path) === f.outPath)
      if (refinedEntry) refinedEntry.open_questions = [...(refinedEntry.open_questions || []), question]
      engine.log(`发言人候选待复核：${f.label} 的 ${labels.join('、')}——模型裁决不确定或不可用，不阻断成稿`)
    }
    if (!invalid) return
    rejectedPaths.add(f.outPath)
    const labels = [...new Set(blockedCandidates.map((item) => item.label).filter(Boolean))]
    const reason = report && report.contractUnavailable
      ? 'speaker_contract_unavailable'
      : 'speaker_structure'
    speakerStructuralFailures.push({
      path: f.outPath,
      label: f.label,
      finding: reason,
      speakerMode: (f.speakerResolution && f.speakerResolution.speakerMode) || f.speakerMode || null,
      labels,
      violations: blockedCandidates,
    })
    const existing = auditFailed.find((item) => item.path === f.outPath)
    if (existing) existing.findings = [...new Set([...(existing.findings || []), reason])]
    else auditFailed.push({ path: f.outPath, findings: [reason] })
    const refinedEntry = refined.find((item) => (item.outPath || item.path) === f.outPath)
    if (refinedEntry && refinedEntry.audit) {
      refinedEntry.audit.status = 'fail'
      refinedEntry.audit.hardFindings = [...new Set([...(refinedEntry.audit.hardFindings || []), reason])]
    }
    failed.push(f.label)
    engine.log(`发言人结构契约未通过：${f.label}${labels.length ? `（模型高置信确认新增说话人：${labels.join('、')}）` : ''}——草稿仅留服务端诊断，不声明为可交付主稿`)
  })
  if (rejectedPaths.size) {
    failed = [...new Set(failed)]
    refined = refined.filter((item) => !rejectedPaths.has(item.outPath || item.path))
    refinedPairs = refinedPairs.filter(({ f }) => !rejectedPaths.has(f.outPath))
  }
}

// Final identity is a registry update, never a Markdown edit. Only bodies that already passed the normal
// source-aware gate are eligible. The host asks for stable track-ID assignments, updates the one speakerTracks
// registry, deterministically renders the complete transcript from output blocks, then this pipeline audits that
// exact rendered body again (without opening a new repair budget) before any derivative may read it.
if (scope.includes('refine') && refinedPairs.length && capabilities && typeof capabilities.finalizeSpeakerIdentity === 'function') {
  const identityPairs = refinedPairs.filter(({ f }) => {
    const entry = refined.find((item) => (item.outPath || item.path) === f.outPath)
    return f.refineContractFinalized && f.refineContract
      && entry && entry.audit && entry.audit.status === 'ok'
      && !auditFailed.some((item) => item.path === f.outPath)
      && !auditUnavailable.some((item) => item.path === f.outPath)
  })
  if (identityPairs.length) {
    engine.phase('Audit')
    engine.log(`▶ 最终身份：${identityPairs.length} 份按 speaker track 注册表定稿，确定性重渲染后重新审计`)
    const finalizations = await engine.parallel(identityPairs.map(({ f }) => async () => {
      try { return await capabilities.finalizeSpeakerIdentity(f) } catch (error) {
        engine.log(`最终身份定稿失败：${f.label}（${(error && error.message) || error}）`)
        return null
      }
    }))
    finalizations.forEach((finalization, index) => {
      const { f } = identityPairs[index]
      if (finalization) {
        speakerIdentityFinalizations.push(finalization)
        const entry = refined.find((item) => (item.outPath || item.path) === f.outPath)
        if (entry) entry.speakerResolution = f.speakerResolution || null
      } else {
        const finding = 'speaker_identity_finalization_unavailable'
        const existing = auditFailed.find((item) => item.path === f.outPath)
        if (existing) existing.findings = [...new Set([...(existing.findings || []), finding])]
        else auditFailed.push({ path: f.outPath, findings: [finding] })
      }
    })

    const finalizedPairs = identityPairs.filter((_pair, index) => finalizations[index])
    const finalAudits = await engine.parallel(finalizedPairs.map(({ f, onePassGlossaryText }) => () => (
      runAuditStep(
        A,
        engine,
        f,
        capabilities,
        onePassGlossaryText || glossary,
        { allowRepair: false, phase: 'post_identity_finalization' },
      )
    )))
    finalizedPairs.forEach(({ f }, index) => {
      const result = finalAudits[index] || {
        status: 'unavailable', auditUnavailable: true, hardFindings: [], softFindings: [],
        repaired: false, repairAttempts: [], anchorsAdded: 0, directAudit: false,
      }
      auditFailed = auditFailed.filter((item) => item.path !== f.outPath)
      auditUnavailable = auditUnavailable.filter((item) => item.path !== f.outPath)
      const entry = refined.find((item) => (item.outPath || item.path) === f.outPath)
      if (entry) {
        entry.audit = {
          status: result.status,
          hardFindings: result.hardFindings || [],
          softFindings: result.softFindings || [],
          repaired: !!result.repaired,
          repairAttempts: result.repairAttempts || [],
          anchorsAdded: result.anchorsAdded || 0,
          auditUnavailable: !!result.auditUnavailable,
        }
      }
      if (result.auditUnavailable) auditUnavailable.push({ path: f.outPath, label: f.label })
      if ((result.auditFailed || []).length) auditFailed.push({ path: f.outPath, findings: result.auditFailed })
    })
    if (A.files.length === 1 && refined.length === 1 && speakerIdentityFinalizations.length === 1) {
      transcriptMetadata = speakerIdentityFinalizations[0].metadata || null
    }
  }
}

// Re-read the public mapping view from the registry after final identity. This view is derived metadata for
// manifests and downstream naming; renderer and audit never consume it as an authority.
speakerResolutions = A.files.filter((f) => f.speakerResolution).map((f) => ({
  label: f.label,
  path: f.refineSourcePath || f.path,
  ...f.speakerResolution,
}))

// Derivatives may only read FINAL bodies. The main transcript is still delivered when blocked (with review /
// visible markers), but logic/summary/timeline are withheld rather than fossilising a known gap or speaker swap.
const derivativesRequested = ['logic', 'summary', 'timeline'].filter((x) => scope.includes(x))
const finalBodiesReady = refined.length > 0
  && failed.length === 0
  && auditFailed.length === 0
  && auditUnavailable.length === 0
  && pairsToAudit.length === refinedPairs.length
  && refined.every((r) => r.audit && r.audit.status === 'ok')
if (derivativesRequested.length && !finalBodiesReady) {
  derivativesSkipped = derivativesRequested.map((kind) => ({ kind, reason: '正文未完成或忠实性审计未通过' }))
  engine.log(`派生产物暂停：${derivativesRequested.join('、')}——正文未完成或忠实性审计未通过；主成稿与 review 仍照常交付`)
}
const derivativePairs = finalBodiesReady ? refinedPairs : []

// Logic-order resequencing (optional): reads each refined transcript and reorders it into narrative order, run concurrently. Completeness is verified by a zero-cost JS check —
// diff the headings in the refine report against threads[].source_sections in the logic report; any headings not covered go into missingSections.
let logic = []
if (scope.includes('logic') && derivativePairs.length) {
  engine.phase('Logic')
  engine.log(`▶ 4/5 逻辑顺序 Logic：${derivativePairs.length} 份按主线重排为叙事顺序`)
  // Build one logic entry from a (report, refine-report) pair. safeName(f.title) so a title with a slash / colon
  // can't fabricate a nested directory under 逻辑顺序/ (§3). missingSections = refine小标题 not covered by threads.
  const toEntry = (lrep, f, rep) => {
    if (!lrep) return { label: f.label, path: null, mainline: '', threads: [], missingSections: [], open_questions: [] }
    const covered = new Set((lrep.threads || []).flatMap((t) => ((t && t.source_sections) || []).map(canonicalHeadingKey).filter(Boolean)))
    const srcHeadings = ((rep && rep.headings) || []).map((h) => (h || '').trim()).filter(Boolean)
    const missing = srcHeadings.filter((h) => !covered.has(canonicalHeadingKey(h)))
    return { label: f.label, path: (f.logicOutPath || `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md`), mainline: lrep.mainline || '', threads: (lrep.threads || []).map((t) => t && t.title).filter(Boolean), missingSections: missing, open_questions: lrep.open_questions || [] }
  }
  const lreps = await engine.parallel(derivativePairs.map(({ f }) => () =>
    engine.agent(logicWritePrompt(f, A), { label: `logic:${f.label}`, phase: 'Logic', model: M.logic, effort: effortFor(A, 'logic'), schema: LOGIC_REPORT_SCHEMA, outputPath: (f.logicOutPath || `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md`) })))
  logic = lreps.map((lrep, k) => toEntry(lrep, derivativePairs[k].f, derivativePairs[k].rep))
  // §5 missingSections auto-rerun (cap 1): any file whose first pass dropped ≥1 refine小标题 is re-run ONCE with
  // the omitted headings named as a must-include list. If the rerun still omits some, keep the (better of the
  // two) entry — the residual missing stays in the return for a Step-5 spot-check (current behaviour preserved).
  const rerunIdx = logic.map((l, k) => (l.path && l.missingSections.length) ? k : -1).filter((k) => k >= 0)
  if (rerunIdx.length) {
    engine.log(`逻辑顺序补漏：${rerunIdx.map((k) => `${logic[k].label}(${logic[k].missingSections.join('/')})`).join('；')}——各自动重跑一次，点名遗漏小标题`)
    const reReps = await engine.parallel(rerunIdx.map((k) => () => {
      const { f } = derivativePairs[k]
      return engine.agent(logicWritePrompt(f, A, logic[k].missingSections), { label: `logic-rerun:${f.label}`, phase: 'Logic', model: M.logic, effort: effortFor(A, 'logic'), schema: LOGIC_REPORT_SCHEMA, outputPath: (f.logicOutPath || `${A.outputDir}/逻辑顺序/${safeName(f.title)}.md`) })
    }))
    rerunIdx.forEach((k, j) => {
      const re = reReps[j]
      if (!re) return // rerun failed → keep the first-pass entry
      const entry = toEntry(re, derivativePairs[k].f, derivativePairs[k].rep)
      // Adopt the rerun only if it covers at least as many headings (fewer missing); otherwise keep the first pass.
      if (entry.path && entry.missingSections.length <= logic[k].missingSections.length) logic[k] = entry
    })
  }
  const failedLogic = logic.filter((l) => !l.path).map((l) => l.label)
  const missLogic = logic.filter((l) => l.missingSections && l.missingSections.length)
  engine.log(`逻辑顺序稿完成 ${logic.filter((l) => l.path).length}/${derivativePairs.length} 份${failedLogic.length ? `（${failedLogic.join('、')} 失败）` : ''}`)
  if (missLogic.length) engine.log(`逻辑顺序稿疑漏小标题（重跑后仍疑漏，按精校稿小标题覆盖核对，需抽查）：${missLogic.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
}

engine.phase('Deliver')
if (finalBodiesReady && (scope.includes('summary') || scope.includes('timeline'))) {
  engine.log(`▶ 交付 Deliver：${[scope.includes('summary') && '访谈总结', scope.includes('timeline') && '时间线'].filter(Boolean).join(' + ')}`)
}
const [summary, timeline] = await engine.parallel([
  () => (scope.includes('summary') && finalBodiesReady
    ? engine.agent(summaryPrompt(A, refined), { label: 'summary', phase: 'Deliver', model: M.summary, effort: effortFor(A, 'summary'), outputPath: `${A.outputDir}/${summaryDeliverableName(A.topic)}` })
    : Promise.resolve(null)),
  () => (scope.includes('timeline') && finalBodiesReady
    ? engine.agent(timelinePrompt(A, glossary, refined), { label: 'timeline', phase: 'Deliver', model: M.timeline, effort: effortFor(A, 'timeline'), outputPath: `${A.outputDir}/${timelineDeliverableName(A.topic)}` })
    : Promise.resolve(null)),
])


return {
  glossary,
  refineMode: A.refineMode === 'single-shot' ? 'single-shot' : 'agentic',  // M11a: run-level refine mode (per-file singleShot/refused markers ride on each refined[i])
  refined,
  failed,
  incomplete,
  unchecked,
  headingConflicts,
  scoutSuspect,
  scoutFailed,
  suspectedDuplicates: (dedup && dedup.suspects) || [],
  networkUnverified: netUnverified,
  auditFailed,   // §2: [{ path, findings:['content_gap',…] }] — hard audit findings still failing after at most two repair rounds
  auditUnavailable,   // P7: [{ path, label }] — files whose audit could NOT run after one retry → run marked failed (unaudited)
  plannedChunks: A.plannedChunks || [],   // recorded before any refine agent starts, so failed files remain diagnosable
  speakerResolutions,
  speakerOutputNormalizations,
  speakerStructuralFailures,
  speakerStructureWarnings,
  speakerCandidateAdjudications,
  speakerIdentityFinalizations,
  transcriptMetadata,
  qualityRepairAttempts,
  turnContractFailures: A.turnContractFailures || [],
  autoChunk: (A.plannedChunks || []).map((p) => p.autoChunk).filter(Boolean),   // includes failed provider-budget splits
  logic,
  derivativesSkipped,
  openQuestions: refined.flatMap((r) => r.open_questions || []).concat(dedupQuestions(dedup)).concat(logic.flatMap((l) => l.open_questions || [])).concat(conflicts).concat(weakDups).concat(asrSuspects).concat(contestedAsks).concat(overrideQuestions).concat(reopenNotes).concat(derivativesSkipped.map((x) => `${x.kind} 未生成：${x.reason}`)),
  summary,
  timeline,
}
}


// ===== bootstrap: Claude Code engine =====
// Appended to the end of the bundle by build/build-cc.mjs. Runs inside the Workflow sandbox,
// where agent / parallel / pipeline / phase / log / args are globals — hand them straight to core's runPipeline.
const __A = (typeof args === 'string') ? JSON.parse(args) : (args || {})

// M12: core hands each agent() call an opts object that MAY carry `effort` (the reasoning-effort knob, set per
// category from __A.effort — e.g. {refine:'medium'}). The Workflow tool's agent(prompt, opts) accepts an
// `effort` option, so we forward it explicitly here (rather than relying on unknown-key passthrough) — this is
// the CC-edition mapping point for M12. Every other opt (label, model, schema, phase) is passed through
// unchanged. When no effort is set the forwarded value is undefined, so behaviour is byte-identical to before.
const __agent = (prompt, opts = {}) => agent(prompt, opts.effort ? { ...opts, effort: opts.effort } : opts)

const __engine = { agent: __agent, parallel, pipeline, phase, log }
return await runPipeline(__A, __engine)

