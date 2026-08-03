import {
  extractPersonName,
  isGenericSpeakerLabel,
  isRoleSpeakerLabel,
  parseSpeakerDocument,
} from '../scripts/speaker-resolver.js'

export const TURN_CONTRACT_HEADER = '<!-- LRB_TURN_CONTRACT v2 -->'
const OUTPUT_OPEN_RE = /^<!-- LRB_OUTPUT_BLOCK sources=(T\d{6}(?:,T\d{6})*) disposition=(keep|merge|split|fold_noise) -->$/u
const OUTPUT_CLOSE = '<!-- /LRB_OUTPUT_BLOCK -->'
const SOURCE_META_RE = /^<!-- LRB_SOURCE_REFS [^>]+ -->$/u
const DISPOSITIONS = new Set(['keep', 'merge', 'split', 'fold_noise'])

export class TurnContractError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'TurnContractError'
    this.code = code
    this.details = details
  }
}

const stableId = (prefix, index) => `${prefix}${String(index + 1).padStart(6, '0')}`
const trimBlankEdges = (lines) => {
  let start = 0
  let end = lines.length
  while (start < end && !String(lines[start] || '').trim()) start += 1
  while (end > start && !String(lines[end - 1] || '').trim()) end -= 1
  return lines.slice(start, end)
}

function contractView(contractOrRecords) {
  if (Array.isArray(contractOrRecords)) {
    return { mode: null, records: contractOrRecords, speakerTracks: [] }
  }
  return {
    mode: contractOrRecords && contractOrRecords.mode,
    records: (contractOrRecords && contractOrRecords.records) || [],
    speakerTracks: (contractOrRecords && contractOrRecords.speakerTracks) || [],
  }
}

function sourceTracks(records, mode) {
  const byKey = new Map()
  return records.map((record) => {
    if (mode !== 'tracked') return { ...record, speakerTrackId: null }
    const key = record.speakerKey || record.speaker
    if (!key) return { ...record, speakerTrackId: null }
    if (!byKey.has(key)) byKey.set(key, stableId('S', byKey.size))
    return { ...record, speakerTrackId: byKey.get(key) }
  })
}

const identityLabelKey = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
const cleanIdentityText = (value, max = 160) => {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  return text ? text.slice(0, max) : null
}
const concretePersonLabel = (value) => {
  const label = cleanIdentityText(value, 100)
  return !!(label && extractPersonName(label))
}

function initialTrackStatus(mapping, canonicalLabel) {
  const basis = String((mapping && mapping.basis) || '')
  if (basis === 'source_name') return { identityStatus: 'source_confirmed', confidence: 'high' }
  if ((basis === 'scout_output_label' || basis === 'scout_identity') && concretePersonLabel(canonicalLabel)) {
    return { identityStatus: 'scout_confirmed', confidence: 'high' }
  }
  if (concretePersonLabel(canonicalLabel)) return { identityStatus: 'source_confirmed', confidence: 'high' }
  if (isRoleSpeakerLabel(canonicalLabel)) return { identityStatus: 'role_only', confidence: 'low' }
  return { identityStatus: 'unresolved', confidence: 'low' }
}

function buildSpeakerTrackRegistry(records, speakerResolution = null) {
  const mappings = Array.isArray(speakerResolution && speakerResolution.mappings)
    ? speakerResolution.mappings
    : []
  const mappingByKey = new Map(mappings.map((mapping) => [mapping && mapping.key, mapping]).filter(([key]) => key))
  const byTrack = new Map()
  for (const record of records) {
    if (!record.speakerTrackId) continue
    const mapping = mappingByKey.get(record.speakerKey) || null
    const current = byTrack.get(record.speakerTrackId) || {
      id: record.speakerTrackId,
      sourceKeys: [],
      sourceLabels: [],
      canonicalLabel: null,
      role: null,
      basis: null,
      identityStatus: 'unresolved',
      confidence: 'low',
      evidence: null,
    }
    if (record.speakerKey && !current.sourceKeys.includes(record.speakerKey)) current.sourceKeys.push(record.speakerKey)
    if (record.speaker && !current.sourceLabels.includes(record.speaker)) current.sourceLabels.push(record.speaker)
    const canonicalLabel = cleanIdentityText(mapping && mapping.outputLabel, 100)
      || cleanIdentityText(record.speaker, 100)
    if (!current.canonicalLabel) current.canonicalLabel = canonicalLabel
    if (!current.role) current.role = cleanIdentityText(mapping && mapping.role, 80)
    if (!current.basis) current.basis = cleanIdentityText(mapping && mapping.basis, 80) || 'source_label'
    const status = initialTrackStatus(mapping, current.canonicalLabel)
    if (status.confidence === 'high' || current.confidence !== 'high') Object.assign(current, status)
    byTrack.set(record.speakerTrackId, current)
  }
  return [...byTrack.values()]
}

export function speakerLabelForTrack(contractOrRecords, speakerTrackId) {
  if (!speakerTrackId) return null
  const contract = contractView(contractOrRecords)
  const track = contract.speakerTracks.find((item) => item && item.id === speakerTrackId)
  if (track && track.canonicalLabel) return track.canonicalLabel
  const record = contract.records.find((item) => item && item.speakerTrackId === speakerTrackId)
  return (record && record.speaker) || null
}

export function applySpeakerIdentityAssignments(contract, assignments = []) {
  const currentTracks = (contract && Array.isArray(contract.speakerTracks)) ? contract.speakerTracks : []
  const byId = new Map(currentTracks.map((track) => [track && track.id, track]).filter(([id]) => id))
  const candidates = new Map()
  const rejected = []

  for (const raw of Array.isArray(assignments) ? assignments : []) {
    const speakerTrackId = cleanIdentityText(raw && (raw.speaker_track_id || raw.speakerTrackId), 40)
    const submittedName = cleanIdentityText(raw && (raw.canonical_name || raw.canonicalName), 100)
    const canonicalName = extractPersonName(submittedName)
    const confidence = ['high', 'medium', 'low'].includes(raw && raw.confidence) ? raw.confidence : 'low'
    const evidence = cleanIdentityText(raw && raw.evidence, 300)
    if (!speakerTrackId || !submittedName) continue
    if (!byId.has(speakerTrackId)) {
      rejected.push({ speakerTrackId, canonicalName: submittedName, reason: 'unknown_track' })
      continue
    }
    if (confidence !== 'high' || !evidence || !canonicalName) {
      rejected.push({ speakerTrackId, canonicalName: submittedName, reason: 'insufficient_identity_evidence' })
      continue
    }
    if (!candidates.has(speakerTrackId)) candidates.set(speakerTrackId, [])
    candidates.get(speakerTrackId).push({ speakerTrackId, canonicalName, confidence, evidence })
  }

  const changes = []
  const tracks = currentTracks.map((track) => {
    const rows = candidates.get(track.id) || []
    const names = [...new Set(rows.map((row) => identityLabelKey(row.canonicalName)))]
    if (!rows.length) return { ...track }
    if (names.length !== 1) {
      rejected.push({
        speakerTrackId: track.id,
        canonicalName: rows.map((row) => row.canonicalName).join(' / '),
        reason: 'conflicting_assignments',
      })
      return { ...track }
    }
    const assignment = rows[0]
    const existingConfirmed = ['source_confirmed', 'scout_confirmed'].includes(track.identityStatus)
      && concretePersonLabel(track.canonicalLabel)
    if (existingConfirmed && identityLabelKey(track.canonicalLabel) !== identityLabelKey(assignment.canonicalName)) {
      rejected.push({
        speakerTrackId: track.id,
        canonicalName: assignment.canonicalName,
        reason: 'conflicts_with_confirmed_identity',
      })
      return { ...track }
    }
    const changed = identityLabelKey(track.canonicalLabel) !== identityLabelKey(assignment.canonicalName)
    if (changed) {
      changes.push({
        speakerTrackId: track.id,
        from: track.canonicalLabel,
        to: assignment.canonicalName,
      })
    }
    return {
      ...track,
      canonicalLabel: assignment.canonicalName,
      basis: existingConfirmed ? track.basis : 'final_metadata',
      identityStatus: existingConfirmed ? track.identityStatus : 'final_metadata_confirmed',
      confidence: 'high',
      evidence: assignment.evidence,
    }
  })

  return {
    contract: { ...contract, speakerTracks: tracks },
    speakerTracks: tracks,
    changes,
    rejected,
  }
}

export function reconcileSpeakerResolutionWithRegistry(resolution, speakerTracks = []) {
  const raw = resolution && typeof resolution === 'object' ? resolution : {}
  const byKey = new Map()
  for (const track of speakerTracks || []) {
    for (const key of track.sourceKeys || []) byKey.set(key, track)
  }
  const mappings = (Array.isArray(raw.mappings) ? raw.mappings : []).map((mapping) => {
    const track = byKey.get(mapping && mapping.key)
    if (!track || !track.canonicalLabel) return { ...mapping }
    return {
      ...mapping,
      outputLabel: track.canonicalLabel,
      basis: track.identityStatus === 'final_metadata_confirmed' ? 'final_metadata' : mapping.basis,
      identityConfidence: track.confidence || null,
      identityEvidence: track.evidence || null,
      speakerTrackId: track.id,
    }
  })
  const updatedKeys = new Set(mappings.filter((mapping) => mapping.basis === 'final_metadata').map((mapping) => mapping.key))
  return {
    ...raw,
    mappings,
    unresolved: (Array.isArray(raw.unresolved) ? raw.unresolved : []).filter((sourceLabel) => {
      const mapping = mappings.find((item) => item.sourceLabel === sourceLabel)
      return !mapping || !updatedKeys.has(mapping.key)
    }),
    speakerTracks,
  }
}

export function buildTurnContract(sourceText, options = {}) {
  const parsed = options.parsed || parseSpeakerDocument(sourceText, options.parseOptions || {})
  const mode = options.speakerMode || parsed.speakerMode
  const records = parsed.units.map((unit, index) => ({
    id: stableId('T', index),
    speaker: mode === 'tracked' ? (unit.speaker || null) : null,
    speakerKey: mode === 'tracked' ? (unit.speakerKey || '') : '',
    startLine: unit.startLine,
    endLine: unit.endLine,
    sourceText: String(unit.text || ''),
    headingsBefore: [],
  }))
  for (let index = 0; index < (parsed.lines || []).length; index += 1) {
    const match = String(parsed.lines[index] || '').trim().match(/^#{2,6}\s+(.+)$/u)
    if (!match || !records.length) continue
    const line = index + 1
    let target = records.find((record) => line >= record.startLine && line <= record.endLine)
    if (!target) target = records.find((record) => record.startLine > line)
    if (!target) target = records[records.length - 1]
    target.headingsBefore.push(`## ${match[1].trim()}`)
  }
  const trackedRecords = sourceTracks(records, mode)
  return {
    schemaVersion: 2,
    mode,
    title: String(options.title || ''),
    subtitle: String(options.subtitle || ''),
    records: trackedRecords,
    speakerTracks: buildSpeakerTrackRegistry(trackedRecords, options.speakerResolution),
    blocks: [],
  }
}

export function serializeOutputBlockEnvelope(blocks = [], options = {}) {
  const lines = [TURN_CONTRACT_HEADER]
  for (const block of blocks) {
    for (const heading of block.headingsBefore || []) lines.push('', String(heading))
    const ids = (block.sourceTurnIds || []).join(',')
    lines.push('', `<!-- LRB_OUTPUT_BLOCK sources=${ids} disposition=${block.disposition} -->`)
    if (options.sourceMeta) {
      const refs = (block.sourceRecords || []).map((record) =>
        `${record.id}:track=${record.speakerTrackId || 'none'}:lines=${record.startLine}-${record.endLine}`).join(',')
      if (refs) lines.push(`<!-- LRB_SOURCE_REFS ${refs} -->`)
    }
    if (block.body) lines.push(String(block.body))
    lines.push(OUTPUT_CLOSE)
  }
  return `${lines.join('\n').replace(/\s+$/, '')}\n`
}

function normalizeKnownSpeakerPrefix(body, speaker) {
  if (!speaker || !body) return body
  const lines = body.split('\n')
  const first = lines.findIndex((line) => String(line || '').trim())
  if (first < 0) return body
  const raw = lines[first]
  const indent = raw.slice(0, raw.length - raw.trimStart().length)
  const trimmed = raw.trimStart()
  const prefixes = [`${speaker}：`, `${speaker}:`]
  const prefix = prefixes.find((candidate) => trimmed.startsWith(candidate))
  if (!prefix) return body
  lines[first] = `${indent}${trimmed.slice(prefix.length).trimStart()}`
  return trimBlankEdges(lines).join('\n')
}

function relationError(code, message, block, details = {}) {
  throw new TurnContractError(code, message, {
    block: block && block.id,
    sourceTurnIds: (block && block.sourceTurnIds) || [],
    disposition: block && block.disposition,
    ...details,
  })
}

function matchExpectedSlice(block, expectedRecords, cursor) {
  const ids = block.sourceTurnIds || []
  const expected = expectedRecords.slice(cursor, cursor + ids.length).map((record) => record.id)
  if (ids.length && ids.every((id, index) => id === expected[index])) return
  relationError(
    'TURN_CONTRACT_ORDER_INVALID',
    `output block 的来源顺序不匹配：期望 ${expected.join(',') || '无'}，实际 ${ids.join(',') || '无'}`,
    block,
    { expected, actual: ids },
  )
}

export function validateOutputBlocks(blocks = [], contractOrRecords = []) {
  const contract = contractView(contractOrRecords)
  const expectedRecords = contract.records
  const recordById = new Map(expectedRecords.map((record) => [record.id, record]))
  const normalized = blocks.map((block, index) => {
    const sourceTurnIds = [...(block.sourceTurnIds || [])]
    if (!DISPOSITIONS.has(block.disposition) || !sourceTurnIds.length) {
      relationError('TURN_CONTRACT_RELATION_INVALID', 'output block 缺少有效来源关系', block)
    }
    if (new Set(sourceTurnIds).size !== sourceTurnIds.length) {
      relationError('TURN_CONTRACT_DUPLICATE_ID', '同一 output block 内 source turn ID 重复', block)
    }
    const sourceRecords = sourceTurnIds.map((id) => recordById.get(id))
    if (sourceRecords.some((record) => !record)) {
      relationError('TURN_CONTRACT_UNKNOWN_ID', 'output block 引用了不存在的 source turn ID', block)
    }
    const speakerTracks = [...new Set(sourceRecords.map((record) => record.speakerTrackId).filter(Boolean))]
    const speakers = [...new Set(speakerTracks.map((trackId) => speakerLabelForTrack(contract, trackId)).filter(Boolean))]
    return {
      ...block,
      id: stableId('B', index),
      sourceTurnIds,
      sourceRecords,
      speakerTrackId: speakerTracks.length === 1 ? speakerTracks[0] : null,
      speaker: speakers.length === 1 ? speakers[0] : null,
      body: String(block.body || '').trim(),
      headingsBefore: [...(block.headingsBefore || [])],
    }
  })

  let cursor = 0
  for (let index = 0; index < normalized.length;) {
    const block = normalized[index]
    if (block.disposition === 'split') {
      if (block.sourceTurnIds.length !== 1 || !block.body) {
        relationError('TURN_CONTRACT_RELATION_INVALID', 'split block 必须引用一个来源 turn 且正文非空', block)
      }
      matchExpectedSlice(block, expectedRecords, cursor)
      const sourceId = block.sourceTurnIds[0]
      let end = index
      while (
        end < normalized.length
        && normalized[end].disposition === 'split'
        && normalized[end].sourceTurnIds.length === 1
        && normalized[end].sourceTurnIds[0] === sourceId
      ) {
        if (!normalized[end].body) {
          relationError('TURN_CONTRACT_BODY_MISSING', 'split block 正文不能为空', normalized[end])
        }
        end += 1
      }
      if (end - index < 2) {
        relationError('TURN_CONTRACT_RELATION_INVALID', 'split 必须把同一来源 turn 连续映射到至少两个 output block', block)
      }
      cursor += 1
      index = end
      continue
    }

    matchExpectedSlice(block, expectedRecords, cursor)
    if (block.disposition === 'keep') {
      if (block.sourceTurnIds.length !== 1 || !block.body) {
        relationError('TURN_CONTRACT_RELATION_INVALID', 'keep block 必须一对一且正文非空', block)
      }
    } else if (block.disposition === 'merge') {
      if (block.sourceTurnIds.length < 2 || !block.body) {
        relationError('TURN_CONTRACT_RELATION_INVALID', 'merge block 必须引用至少两个来源 turn 且正文非空', block)
      }
      if (contract.mode === 'ambiguous' || !block.speakerTrackId) {
        relationError('TURN_CONTRACT_SPEAKER_MERGE', '只有已确认的同一说话人轨道才能合并来源 turn', block)
      }
      if (block.sourceRecords.some((record) => record.speakerTrackId !== block.speakerTrackId)) {
        relationError('TURN_CONTRACT_SPEAKER_MERGE', '不同说话人轨道不能合并到同一 speech block', block)
      }
    }
    cursor += block.sourceTurnIds.length
    index += 1
  }

  if (cursor !== expectedRecords.length) {
    throw new TurnContractError(
      'TURN_CONTRACT_COVERAGE_INVALID',
      `source turn 覆盖不完整：期望 ${expectedRecords.length}，实际记账到 ${cursor}`,
      {
        expected: expectedRecords.map((record) => record.id),
        actual: normalized.flatMap((block) => block.sourceTurnIds),
      },
    )
  }
  return normalized
}

export function makeInitialOutputBlocks(contractOrRecords = []) {
  const contract = contractView(contractOrRecords)
  return validateOutputBlocks(contract.records.map((record) => ({
    sourceTurnIds: [record.id],
    disposition: 'keep',
    body: record.sourceText,
    headingsBefore: record.headingsBefore || [],
  })), contract)
}

function envelopeDiagnostic(code, message, details = {}) {
  return {
    code,
    message,
    ...(Number(details.line) > 0 ? { line: Number(details.line) } : {}),
  }
}

function envelopeFailure(phase, errors = []) {
  const first = errors[0] || envelopeDiagnostic('TURN_CONTRACT_INVALID', 'turn contract 校验失败')
  const summary = errors
    .map((error) => `${error.code}${error.line ? `（第 ${error.line} 行）` : ''}: ${error.message}`)
    .join('；')
  return {
    ok: false,
    phase,
    code: first.code,
    message: `${phase === 'syntax' ? '结构化成稿语法校验失败' : '结构化成稿来源关系校验失败'}（${errors.length} 项）：${summary}`,
    errors,
  }
}

// Two-phase compiler boundary: collect every envelope-syntax diagnostic first, and only if syntax is clean
// validate source relations. This lets one model correction see e.g. a missing header, H1 and subtitle together
// instead of discovering them one rejection at a time.
export function validateOutputBlockEnvelope(text, contractOrRecords = []) {
  const contract = contractView(contractOrRecords)
  const recordById = new Map(contract.records.map((record) => [record.id, record]))
  const lines = String(text || '').split(/\r?\n/u)
  const blocks = []
  const errors = []
  let current = null
  let pendingHeadings = []
  const firstContent = lines.findIndex((line) => String(line || '').trim())
  const headerSeen = firstContent >= 0 && lines[firstContent].trim() === TURN_CONTRACT_HEADER
  if (!headerSeen) {
    errors.push(envelopeDiagnostic(
      'TURN_CONTRACT_HEADER_MISSING',
      firstContent >= 0 ? '第一条非空行不是 turn contract v2 头' : '结构化成稿为空或缺少 turn contract v2 头',
      firstContent >= 0 ? { line: firstContent + 1 } : {},
    ))
  }
  const startIndex = headerSeen ? firstContent + 1 : Math.max(0, firstContent)

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (current) {
      if (trimmed === OUTPUT_CLOSE) {
        const firstSource = recordById.get(current.sourceTurnIds[0])
        const body = normalizeKnownSpeakerPrefix(
          trimBlankEdges(current.body).join('\n'),
          current.disposition === 'fold_noise'
            ? null
            : firstSource && speakerLabelForTrack(contract, firstSource.speakerTrackId),
        )
        blocks.push({ ...current, body, headingsBefore: pendingHeadings })
        current = null
        pendingHeadings = []
      } else if (SOURCE_META_RE.test(trimmed)) {
        // Repair candidates may retain host-owned source references. They never become transcript prose.
      } else if (/^#{1,6}\s+\S/u.test(trimmed)) {
        errors.push(envelopeDiagnostic('TURN_CONTRACT_HEADING_IN_BODY', 'Markdown 标题不能写进 output block 正文', { line: index + 1 }))
      } else {
        if (OUTPUT_OPEN_RE.test(trimmed)) {
          errors.push(envelopeDiagnostic('TURN_CONTRACT_NESTED', 'output block 尚未结束又出现新 block', { line: index + 1 }))
          continue
        }
        current.body.push(line)
      }
      continue
    }

    if (!trimmed) continue
    const opened = trimmed.match(OUTPUT_OPEN_RE)
    if (opened) {
      current = {
        sourceTurnIds: opened[1].split(','),
        disposition: opened[2],
        body: [],
      }
      continue
    }
    if (/^##\s+\S/u.test(trimmed)) {
      pendingHeadings.push(trimmed)
      continue
    }
    errors.push(envelopeDiagnostic('TURN_CONTRACT_OUTSIDE_CONTENT', 'output block 外只能出现二级标题，不能出现自由文本', { line: index + 1 }))
  }

  if (current) errors.push(envelopeDiagnostic('TURN_CONTRACT_UNCLOSED', 'output block 未闭合'))
  if (pendingHeadings.length) errors.push(envelopeDiagnostic('TURN_CONTRACT_TRAILING_HEADING', '末尾标题没有归属到任何 output block'))
  if (errors.length) return envelopeFailure('syntax', errors)

  try {
    return { ok: true, phase: 'relation', blocks: validateOutputBlocks(blocks, contract), errors: [] }
  } catch (error) {
    const details = (error && error.details) || {}
    return envelopeFailure('relation', [envelopeDiagnostic(
      (error && error.code) || 'TURN_CONTRACT_INVALID',
      (error && error.message) || 'turn contract 来源关系校验失败',
      details,
    )])
  }
}

export function parseOutputBlockEnvelope(text, contractOrRecords = []) {
  const validation = validateOutputBlockEnvelope(text, contractOrRecords)
  if (validation.ok) return validation.blocks
  const first = validation.errors[0] || {}
  throw new TurnContractError(validation.code, validation.message, {
    phase: validation.phase,
    errors: validation.errors,
    ...(first.line ? { line: first.line } : {}),
  })
}

export function renderTurnContract(contract, blocks = contract.blocks || []) {
  const lines = []
  if (contract.title) lines.push(`# ${contract.title}`)
  if (contract.subtitle) lines.push('', contract.subtitle)
  for (const block of blocks || []) {
    for (const heading of block.headingsBefore || []) lines.push('', heading)
    const body = String(block.body || '').trim()
    if (!body) continue
    if (block.disposition === 'fold_noise') {
      const note = /^（[\s\S]*）$/u.test(body) ? body : `（${body}）`
      lines.push('', note)
      continue
    }
    const speaker = speakerLabelForTrack(contract, block.speakerTrackId)
    if (contract.mode === 'tracked' && speaker) {
      const paragraphs = body.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean)
      for (const paragraph of paragraphs) {
        const bodyLines = paragraph.split('\n')
        lines.push('', `${speaker}：${bodyLines[0]}`, ...bodyLines.slice(1))
      }
    } else {
      lines.push('', body)
    }
  }
  return `${lines.join('\n').replace(/\s+$/, '')}\n`
}

export function recordsForChunk(contract, chunk) {
  const records = (contract.records || []).filter((record) =>
    record.startLine >= chunk.startLine && record.startLine <= chunk.endLine)
  if (!records.length) {
    throw new TurnContractError('TURN_CONTRACT_EMPTY_CHUNK', `分块 ${chunk.idx} 没有 source turn`, {
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    })
  }
  return records
}

export function mergeOutputBlockEnvelopes(contract, parts = []) {
  const blocks = []
  for (const part of parts) {
    blocks.push(...parseOutputBlockEnvelope(part.text, {
      mode: contract.mode,
      records: part.expectedRecords,
      speakerTracks: contract.speakerTracks || [],
    }))
  }
  const validated = validateOutputBlocks(blocks, contract)
  return {
    blocks: validated,
    headings: validated.flatMap((block) => block.headingsBefore || []).map((heading) => heading.replace(/^##\s+/u, '')),
    text: renderTurnContract(contract, validated),
  }
}

export function bindOutputBlocksToSourceRecords(contract, blocks = contract.blocks || []) {
  const bySource = new Map((contract.records || []).map((record) => [record.id, []]))
  for (const block of blocks || []) {
    for (const sourceId of block.sourceTurnIds || []) {
      if (bySource.has(sourceId)) bySource.get(sourceId).push(block)
    }
  }
  return (contract.records || []).map((record) => {
    const related = bySource.get(record.id) || []
    return {
      ...record,
      speaker: speakerLabelForTrack(contract, record.speakerTrackId),
      body: related.map((block) => String(block.body || '').trim()).filter(Boolean).join('\n\n'),
      outputBlockIds: related.map((block) => block.id),
      dispositions: related.map((block) => block.disposition),
    }
  })
}
