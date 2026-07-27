// Deterministic bridge between full-text Scout and Refine.
//
// Scout decides who each source speaker track represents. This module never re-diarizes prose and never lets
// Refine invent a second mapping: it rewrites only recognized speaker-label lines in a disposable model-input
// copy. The untouched source remains the ground truth for the downstream source-aware audit.

const TIMESTAMP = '\\d{1,2}:\\d{2}(?::\\d{2})?'
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
const NAMED_TIMESTAMP_RE = new RegExp(`^(\\s*)\\*{0,2}\\s*(.{1,40}?)\\s+(${TIMESTAMP})\\s*\\*{0,2}\\s*$`, 'u')
const INLINE_RE = /^(\s*)([^：:\r\n]{1,40})[：:]\s*(.*)$/u
const ROLE_TOKEN = '(?:记者|采访者|访谈者|提问者|主持人|受访者|嘉宾|回答者|主讲人|PR|公关|同事|协调)'
const ROLE_RE = new RegExp(`^${ROLE_TOKEN}(?:[／/][一-龥A-Za-z]{1,16})*(?:\\s*\\d+)?$`, 'iu')
const TITLE_WORD_RE = /(?:创始人|联合创始人|负责人|总裁|董事|经理|老师|先生|女士|博士|教授|CEO|CTO|COO|CFO|公司|团队|产品)/iu

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

function plausibleLabel(value) {
  const label = normalizeLabel(value)
  if (!label || label.length > 32) return false
  if (/^[#*>|<]/u.test(label) || /[：:，。；;！？!?]/u.test(label)) return false
  return /[一-龥A-Za-z]/u.test(label)
}

export function speakerKey(value) {
  const label = normalizeLabel(value).replace(/\s*[（(]\s*(?:uid-ref|uid)\s*=[^（）()]*[）)]\s*$/iu, '').trim()
  const generic = label.match(new RegExp(`^(${GENERIC_PREFIX})\\s*(${GENERIC_NUMBER})$`, 'iu'))
  if (generic) return `generic:${generic[2].normalize('NFKC')}`
  return label ? `label:${label}` : ''
}

export function isGenericSpeakerLabel(value) {
  return speakerKey(value).startsWith('generic:')
}

export function isRoleSpeakerLabel(value) {
  return ROLE_RE.test(normalizeLabel(value))
}

function strongLabel(rawLine) {
  let match = String(rawLine || '').match(GENERIC_INLINE_RE)
  if (match) {
    const label = normalizeLabel(`${match[2]} ${match[3]}`)
    return { indent: match[1], key: speakerKey(label), label, kind: 'generic-inline', body: match[4] || '', generic: true }
  }
  match = String(rawLine || '').match(GENERIC_LINE_RE)
  if (match) {
    const label = normalizeLabel(`${match[2]} ${match[3]}`)
    return { indent: match[1], key: speakerKey(label), label, kind: 'generic', body: '', timestamp: match[4] || '', generic: true }
  }
  match = String(rawLine || '').match(CITE_RE)
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
      timestamp: match[3] || '',
      generic: false,
    }
  }
  match = String(rawLine || '').match(NAMED_TIMESTAMP_RE)
  if (match) {
    const label = normalizeLabel(match[2])
    if (!plausibleLabel(label)) return null
    return { indent: match[1], key: speakerKey(label), label, kind: 'timestamp', body: '', timestamp: match[3] || '', generic: false }
  }
  return null
}

function substantiveLine(value) {
  const line = String(value || '').trim()
  return Boolean(line && !/^<!--/u.test(line) && !/^[#*>|]/u.test(line))
}

export function parseSpeakerLabels(sourceText) {
  const text = String(sourceText || '')
  const lines = text.split(/\r?\n/)
  const facts = lines.map(strongLabel)
  const strongNames = new Set(facts.filter(Boolean).flatMap((fact) => [fact.label, fact.matchKey]).filter(Boolean))
  const inlineCounts = new Map()
  let substantive = 0
  let inlineCandidates = 0

  for (let i = 0; i < lines.length; i += 1) {
    if (facts[i] || !substantiveLine(lines[i])) continue
    substantive += 1
    const match = lines[i].match(INLINE_RE)
    if (!match || !plausibleLabel(match[2])) continue
    const label = normalizeLabel(match[2])
    inlineCandidates += 1
    inlineCounts.set(label, (inlineCounts.get(label) || 0) + 1)
  }

  const pureInline = !facts.some(Boolean) && inlineCandidates >= 2 && inlineCandidates === substantive
  for (let i = 0; i < lines.length; i += 1) {
    if (facts[i]) continue
    const match = lines[i].match(INLINE_RE)
    if (!match) continue
    const label = normalizeLabel(match[2])
    if (!plausibleLabel(label)) continue
    const accepted = strongNames.has(label) || (inlineCounts.get(label) || 0) >= 2 || isRoleSpeakerLabel(label) || pureInline
    if (!accepted) continue
    facts[i] = {
      indent: match[1],
      key: speakerKey(label),
      label,
      kind: isGenericSpeakerLabel(label) ? 'generic-inline' : 'inline',
      body: match[3] || '',
      generic: isGenericSpeakerLabel(label),
    }
  }

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

  return {
    lines,
    labels,
    tracks: [...tracks.values()],
    labelLines: labels.length,
    needsResolution: [...tracks.values()].some((track) => track.generic || track.roleLike),
  }
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
  for (const record of speakers || []) {
    if (!record) continue
    const keys = [speakerKey(record.label)]
    const sampleHead = String(record.sample || '').split(/\r?\n/u, 1)[0]
    if (sampleHead) keys.push(speakerKey(sampleHead.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/u, '')))
    for (const key of keys.filter(Boolean)) {
      if (!records.has(key) || recordScore(record) > recordScore(records.get(key))) records.set(key, record)
    }
  }
  return records
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

export function resolveSpeakerMapping(sourceText, scoutSpeakers = []) {
  const parsed = parseSpeakerLabels(sourceText)
  const records = scoutRecordsByKey(scoutSpeakers)
  const mappings = parsed.tracks.map((track) => {
    const record = records.get(track.key)
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
  }
}

export function rewriteSpeakerLabels(sourceText, scoutSpeakers = [], options = {}) {
  const source = String(sourceText || '')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const { parsed, mappings, unresolved } = resolveSpeakerMapping(source, scoutSpeakers)
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
  }
}

function aliasKey(value) {
  const label = normalizeLabel(value)
  const role = normalizeRole(label)
  return role ? `role:${role}` : speakerKey(label)
}

export function enforceCanonicalSpeakerLabels(refinedText, mappings = []) {
  const source = String(refinedText || '')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const parsed = parseSpeakerLabels(source)
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
  for (const fact of parsed.labels) {
    const canonical = aliases.get(aliasKey(fact.label))
    if (!canonical) {
      if (!canonicalSet.has(fact.label)) unknownLabels.push({ line: fact.line, label: fact.label })
      continue
    }
    const rewritten = `${fact.indent || ''}${canonical}：${fact.body || ''}`
    if (out[fact.line - 1] === rewritten) continue
    replacements.push({ line: fact.line, from: fact.label, to: canonical })
    out[fact.line - 1] = rewritten
  }
  return {
    text: out.join(newline),
    replacements,
    changedLines: replacements.length,
    unknownLabels,
    labelLines: parsed.labelLines,
  }
}
