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

// ===== Editorial deterministic checks (typesetting / glossary residue) =====
// These live in the SOURCE-AWARE path (auditPair / auditLogicPair): they enforce editing rules that a
// prose skill was previously trusted to self-apply — the very rules that produced three different failure
// pictures across three engines. All soft by default (first version under-reports rather than mis-fires),
// except the two typesetting rules the spec bans outright (ASCII quotes hugging CJK, 直角引号), which are hard.

const CJK_CHAR = /[一-龥]/                       // same Han range the rest of the file uses ([一-龥])
const CORNER_QUOTES_RE = /[「」『』]/g              // 直角引号 — banned by the typesetting spec
const CURLY_QUOTE_RE = /[“”]/                     // full-width curly quote (the ONLY sanctioned form)

// Iterate the refined text as body lines with true 1-based line numbers, skipping regions where a stray
// quote / colon / label is not prose: YAML front matter, fenced code blocks, HTML comments (可跨行),
// heading lines, and blockquote/table/list-marker lines. Within each surviving line, inline `code` spans
// and URLs are blanked to spaces (length-preserving) so their ASCII quotes/colons never trip a check.
// Returns [{ no, raw, text }] where `text` is the sanitized content (same length as raw).
function bodyLines(text) {
  const out = []
  const lines = String(text || '').split(/\r?\n/)
  let inFence = false, inComment = false, inFront = false
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trim()
    // YAML front matter: only when the very first line is a lone `---`, until the closing `---`.
    if (i === 0 && trimmed === '---') { inFront = true; continue }
    if (inFront) { if (trimmed === '---') inFront = false; continue }
    // fenced code block toggles on a line whose first non-space token is ``` or ~~~
    const fence = trimmed.match(/^(```+|~~~+)/)
    if (fence) { inFence = !inFence; continue }
    if (inFence) continue
    // HTML comment regions (may span multiple lines); a line that both opens and closes stays inspectable
    // for its non-comment remainder.
    let line = raw
    if (inComment) {
      const end = line.indexOf('-->')
      if (end < 0) continue
      line = ' '.repeat(end + 3) + line.slice(end + 3)
      inComment = false
    }
    // blank out any complete <!-- ... --> on this line, then detect an unterminated opener
    line = line.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    const open = line.indexOf('<!--')
    if (open >= 0) { inComment = true; line = line.slice(0, open) + ' '.repeat(line.length - open) }
    if (!line.trim()) continue
    if (/^\s*[#>|]/.test(line)) continue                 // heading / blockquote / table row → not prose
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) continue    // list item marker line (glossary-style rows等)
    // blank inline code spans, markdown-link target+title segments, and URLs so their inner ASCII quotes/colons
    // don't fire. SF-4: a link title `[文字](url "中文")` puts ASCII quotes hugging CJK — mask the whole `](...)`
    // segment (the visible `[文字]` label stays prose). Done before URL masking so the title inside is covered too.
    line = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    line = line.replace(/\]\([^)]*\)/g, (m) => ' '.repeat(m.length))
    line = line.replace(/https?:\/\/[^\s]+/g, (m) => ' '.repeat(m.length))
    out.push({ no: i + 1, raw, text: line })
  }
  return out
}

// quote_style: ASCII "/' hugging a CJK char (hard), 直角引号 (hard), and a low-curly-quote density hint.
export function checkQuoteStyle(refinedText) {
  const body = bodyLines(refinedText)
  const straight = [], corner = []
  let curly = 0
  for (const { no, text } of body) {
    for (let k = 0; k < text.length; k += 1) {
      const ch = text[k]
      if (ch === '"' || ch === "'") {
        const prev = text[k - 1] || '', next = text[k + 1] || ''
        if (CJK_CHAR.test(prev) || CJK_CHAR.test(next)) straight.push({ text: text.trim().slice(0, 60), line: no })
      }
    }
    for (const _ of text.matchAll(CORNER_QUOTES_RE)) corner.push({ text: text.trim().slice(0, 60), line: no })
    if (CURLY_QUOTE_RE.test(text)) curly += 1
  }
  const findings = [
    { name: 'quote_style', severity: 'hard', count: straight.length + corner.length,
      samples: straight.concat(corner).slice(0, 12) },
  ]
  // Only when the body is substantial and carries ZERO sanctioned curly quotes do we hint that quoting /
  // term-marking may have been dropped — a soft nudge, never a gate.
  if (curly === 0 && body.length >= 200) {
    findings.push({ name: 'quote_density_low', severity: 'soft', count: 1,
      samples: [{ text: `成稿 ${body.length} 行正文无一处弯引号 “”——引语/术语可能未标注`, line: body[0].no }] })
  }
  return findings
}

// speaker_label_style: two label shapes — `名字 12:34` (timestamp) and `名字：` (colon). If BOTH shapes
// each occur ≥3 times, the file mixes label styles → soft, with 2 samples of each shape.
const LABEL_TS_RE = /^\s*([^\s：:]{1,12})\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/   // name (≤12, no space) + HH:MM(:SS)
const LABEL_COLON_RE = /^\s*([一-龥A-Za-z0-9·]{1,12})[：:]/                 // name-like token + colon
export function checkSpeakerLabelStyle(refinedText) {
  const ts = [], colon = []
  for (const { no, text } of bodyLines(refinedText)) {
    if (LABEL_TS_RE.test(text)) { ts.push({ text: text.trim().slice(0, 40), line: no }); continue }
    if (LABEL_COLON_RE.test(text)) colon.push({ text: text.trim().slice(0, 40), line: no })
  }
  if (ts.length >= 3 && colon.length >= 3) {
    return [{ name: 'speaker_label_style', severity: 'soft', count: ts.length + colon.length,
      samples: ts.slice(0, 2).concat(colon.slice(0, 2)) }]
  }
  return [{ name: 'speaker_label_style', severity: 'soft', count: 0, samples: [] }]
}

// ---- lightweight glossary parsing (in-file; the real parser in core/spec.js must not be imported) ----
// Recognizes the 人名 / 品牌 entity rows this repo renders — `- **正字** ← 变体1 / 变体2 ｜ …hint…` — under a
// section header matching 人名 or 品牌/公司/产品. Also collects names marked unverified: a row whose text
// carries ⚠ or 未能核实, plus `- query：未能核实，保留（音）` lines from the 联网核实结论 section.
// Returns { entries: [{ canonical, variants[], section }], unverified: [names] }.
export function parseGlossaryLite(glossaryText) {
  const entries = [], unverified = new Set()
  if (!glossaryText) return { entries, unverified: [] }
  let inNameOrBrand = false
  for (const raw of String(glossaryText).split(/\r?\n/)) {
    const line = raw.trim()
    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) { inNameOrBrand = /人名|品牌|公司|产品/.test(h[1]); continue }
    // unverified-by-web line: `- query：未能核实，保留（音）…`
    const un = line.match(/^-\s*(.+?)：未能核实/)
    if (un) { const q = un[1].trim(); if (CJK_CHAR.test(q)) unverified.add(q.replace(/\*/g, '')); continue }
    if (!inNameOrBrand) continue
    const m = line.match(/^-\s*\*\*(.+?)\*\*\s*←\s*(.*)$/)
    if (!m) continue
    const canonical = m[1].trim()
    const rest = m[2]
    const fields = rest.split('｜')
    const varsRaw = (fields.shift() || '').trim()
    const variants = (varsRaw === '—' || varsRaw === '（无变体）') ? []
      : varsRaw.split('/').map((x) => x.trim()).filter(Boolean)
    entries.push({ canonical, variants, section: 'nameOrBrand' })
    // a suspect/unverified entry (⚠ or 未能核实 anywhere in the row) → its canonical needs a （音） in prose
    if (/⚠|未能核实/.test(rest)) if (CJK_CHAR.test(canonical)) unverified.add(canonical)
  }
  return { entries, unverified: [...unverified] }
}

const cjkLen = (s) => (String(s).match(CJK_CHAR) ? (s.match(/[一-龥]/g) || []).length : 0)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ghost_name: a corrected-away variant (≠ canonical, CJK length ≥2) still present in the refined prose.
// Overlap guard: when a variant is a substring of its canonical, blank canonical occurrences on the line
// before searching, so a correct 张伟明 doesn't count as a stray 张伟.
export function checkGhostName(refinedText, glossary) {
  const { entries } = glossary || {}
  const findings = { name: 'ghost_name', severity: 'soft', count: 0, samples: [] }
  if (!entries || !entries.length) return findings
  const body = bodyLines(refinedText)
  const hits = []
  for (const e of entries) {
    for (const v of e.variants) {
      if (v === e.canonical || cjkLen(v) < 2) continue
      const re = new RegExp(escapeRe(v), 'g')
      const canonHasV = e.canonical.includes(v)
      const canonRe = canonHasV ? new RegExp(escapeRe(e.canonical), 'g') : null
      for (const { no, text } of body) {
        const scan = canonRe ? text.replace(canonRe, (m) => ' '.repeat(m.length)) : text
        if (re.test(scan)) { re.lastIndex = 0; hits.push({ text: `${v}（应为 ${e.canonical}）：${text.trim().slice(0, 40)}`, line: no }) }
        else re.lastIndex = 0
      }
    }
  }
  findings.count = hits.length
  findings.samples = hits.slice(0, 12)
  return findings
}

// missing_yin: a glossary name flagged ⚠ / 未能核实 appears in prose on a line lacking a （音 annotation.
export function checkMissingYin(refinedText, glossary) {
  const names = (glossary && glossary.unverified) || []
  const findings = { name: 'missing_yin', severity: 'soft', count: 0, samples: [] }
  if (!names.length) return findings
  const body = bodyLines(refinedText)
  const hits = []
  for (const nm of names) {
    if (cjkLen(nm) < 2) continue
    const re = new RegExp(escapeRe(nm), 'g')
    for (const { no, text } of body) {
      if (re.test(text) && !/（音/.test(text)) hits.push({ text: `${nm}（未核实、缺（音）标注）：${text.trim().slice(0, 40)}`, line: no })
      re.lastIndex = 0
    }
  }
  findings.count = hits.length
  findings.samples = hits.slice(0, 12)
  return findings
}

// ===== 校对表 structural lint (E13) =====
// The 校对表 is the pipeline's cross-file归一 + 身份/依据 record. A *thin* one — very few named entities, most
// without any identity clue, or barely any variant写法 recorded — usually means scout under-extracted, verify
// was skipped, or the table was hand-stubbed. All findings here are SOFT (a warning to review, never a gate):
// small, tightly-scoped interviews legitimately produce short tables, so this must under-report rather than
// mis-fire. It reads the glossary TEXT alone (no source/refined), so it also drives the standalone
// --glossary-only CLI. Thresholds are intentionally lenient; tune from real 校对表 corpora, not from one file.
export const GLOSSARY_LINT = {
  MIN_ENTITIES: 3,        // fewer than this many 人名+品牌 rows total → the whole table is suspiciously sparse
  HINT_RATIO_MIN: 0.5,    // < half the rows carry a 身份/依据 clue → weak for verification & speaker-mapping
  VARIANT_RATIO_MIN: 0.3, // < this fraction records any ASR 写法 variant → cross-file 归一 likely incomplete
}

// A renderGlossary row segment counts as a NON-hint (not an identity clue) when — after peeling any trailing
// 〔核实/用户钦定/待复核〕 confidence marker (renderGlossary appends it to the LAST segment, e.g. the crossFile
// tag `多份互证 〔核实·2025-05〕`) — what remains is empty or a pure marker: the 多份互证 cross-file tag, a
// 公众人物 tag, a ⚠ suspect note, or a 出处/依据 provenance tail. Anything else is the hint (身份/title/语境).
const GLOSSARY_MARKER_ONLY = /^多份互证$|^公众人物$|^⚠|^出处：|^依据：/
const CONFIDENCE_TAIL = /\s*〔[^〕]*〕\s*$/
function glossarySegIsHint(seg) {
  const s = seg.replace(CONFIDENCE_TAIL, '').trim()
  return !!s && !GLOSSARY_MARKER_ONLY.test(s)
}

// Parse renderGlossary's 人名 / 品牌 rows into { canonical, hasVariants, hasHint }. Self-contained (the real
// parser in core/spec.js must not be imported here). A row: `- **正字** ← 变体 / … ｜ hint ｜ …markers…`.
// 术语 rows are intentionally excluded — 身份 clues don't apply to terms, so counting them would depress the
// hint ratio unfairly; the lint judges people/brands, where an identity clue is meaningful.
export function parseGlossaryEntities(glossaryText) {
  const entities = []
  if (!glossaryText) return entities
  let section = null   // 'person' | 'brand' | null
  for (const raw of String(glossaryText).split(/\r?\n/)) {
    const line = raw.trim()
    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) {
      const t = h[1]
      section = /人名/.test(t) ? 'person' : (/品牌|公司|产品/.test(t) ? 'brand' : null)
      continue
    }
    if (!section) continue
    const m = line.match(/^-\s*\*\*(.+?)\*\*\s*←\s*(.*)$/)
    if (!m) continue
    const canonical = m[1].trim()
    const segs = m[2].split('｜').map((s) => s.trim())
    const varsRaw = (segs.shift() || '').trim()
    const hasVariants = !(varsRaw === '' || varsRaw === '—' || varsRaw === '（无变体）')
    const hasHint = segs.some(glossarySegIsHint)
    entities.push({ canonical, section, hasVariants, hasHint })
  }
  return entities
}

// auditGlossary: soft structural warnings on a rendered 校对表. Returns { entities, people, brands, findings }
// where findings is an array of the standard { name, severity, count, samples } shape. count>0 means the
// warning fired. An empty / entity-less table reports 0 entities and fires glossary_thin only (no ratio
// warnings — a ratio over zero rows is meaningless). Never throws; a non-string / empty input → empty report.
export function auditGlossary(glossaryText) {
  const entities = parseGlossaryEntities(glossaryText)
  const people = entities.filter((e) => e.section === 'person').length
  const brands = entities.filter((e) => e.section === 'brand').length
  const total = entities.length
  const withHint = entities.filter((e) => e.hasHint).length
  const withVar = entities.filter((e) => e.hasVariants).length
  const hintRatio = total ? Number((withHint / total).toFixed(3)) : 0
  const variantRatio = total ? Number((withVar / total).toFixed(3)) : 0

  const findings = []
  const thin = total < GLOSSARY_LINT.MIN_ENTITIES
  findings.push({ name: 'glossary_thin', severity: 'soft', count: thin ? 1 : 0,
    samples: thin ? [{ text: `校对表仅 ${total} 条人名/品牌（人名 ${people}、品牌 ${brands}）——疑侦察抽取过少或核实被跳过`, line: 1 }] : [] })
  // Ratio warnings only make sense once there are enough rows to judge a proportion.
  if (total >= GLOSSARY_LINT.MIN_ENTITIES) {
    const hintThin = hintRatio < GLOSSARY_LINT.HINT_RATIO_MIN
    findings.push({ name: 'glossary_hints_sparse', severity: 'soft', count: hintThin ? 1 : 0,
      samples: hintThin ? [{ text: `仅 ${withHint}/${total}（${Math.round(hintRatio * 100)}%）条带身份/依据线索——多数人名/品牌缺当时 title 或核实依据`, line: 1 }] : [] })
    const varThin = variantRatio < GLOSSARY_LINT.VARIANT_RATIO_MIN
    findings.push({ name: 'glossary_variants_sparse', severity: 'soft', count: varThin ? 1 : 0,
      samples: varThin ? [{ text: `仅 ${withVar}/${total}（${Math.round(variantRatio * 100)}%）条记录了转写变体——跨文件写法归一可能不完整`, line: 1 }] : [] })
  }
  return {
    file: '<glossary>', mode: 'glossary',
    status: 'ok',   // all soft — a thin glossary never fails the audit, only warns
    entities: total, people, brands,
    metrics: { entities: total, people, brands, withHint, withVariants: withVar, hintRatio, variantRatio },
    findings,
  }
}

export function auditGlossaryFile(glossaryPath) {
  const r = auditGlossary(fs.readFileSync(glossaryPath, 'utf8'))
  return { ...r, file: path.resolve(glossaryPath) }
}

// logic_size_sanity: the logic-ordered draft (逻辑稿) must not balloon past the refined 成稿 (~5-8% 脚手架
// tolerance → 1.10 cap), and it must not carry duplicated long paragraphs (a reorder-gone-wrong signal).
export function checkLogicSize(refinedText, logicText) {
  const rChars = hanzi(refinedText)
  const lChars = hanzi(logicText)
  const ratio = rChars ? Number((lChars / rChars).toFixed(3)) : 1
  const findings = []
  if (rChars > 0 && lChars > rChars * 1.10) {
    findings.push({ name: 'logic_size_sanity', severity: 'soft', count: 1,
      samples: [{ text: `逻辑稿 ${lChars} 字 / 成稿 ${rChars} 字 = ${ratio}×，超 1.10——疑非保序重排而是扩写`, line: 1 }] })
  } else {
    findings.push({ name: 'logic_size_sanity', severity: 'soft', count: 0, samples: [] })
  }
  // duplicated long lines (≥25 CJK chars, identical trimmed text appearing ≥2 times)
  const seen = new Map()
  for (const { no, raw } of bodyLines(logicText)) {
    const key = raw.trim()
    if (cjkLen(key) < 25) continue
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(no)
  }
  const dups = []
  for (const [key, nos] of seen) if (nos.length >= 2) dups.push({ text: `重复长行（${nos.join(' / ')} 行）：${key.slice(0, 40)}`, line: nos[0] })
  findings.push({ name: 'logic_duplicate_para', severity: 'soft', count: dups.length, samples: dups.slice(0, 12) })
  return findings
}

// Ordered speaker identifiers from either format: source "**发言人 1 …**" or
// refined "李某：/记者：". Headings/quotes/tables are skipped.
function speakerSeq(text) {
  const ids = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const src = line.match(/^\*{0,2}\s*发言人\s*([0-9一二三四五六七八九十]+)/)
    if (src) { ids.push('S' + src[1]); continue }
    // bare name+timestamp label line (`李某 15:12`) — the common ASR export format
    const ts = line.match(/^\*{0,2}([一-龥A-Za-z][^：:\s]{0,7})\s+\d{1,2}:\d{2}(?::\d{2})?\s*\*{0,2}$/)
    if (ts) { ids.push('T' + ts[1]); continue }
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

// ===== Content-gap detection (coverage scan) =====
// Detects source sections that never made it into the refined output — the silent-omission failure
// (observed live: a model content-policy pass dropped a contiguous ~1500-字 segment mid-file; the global
// charRatio said "something is missing" but couldn't say WHERE). Pure JS, zero model calls, position-
// independent (immune to section reordering), and it does NOT trust the possibly-censoring model to
// self-report. Legitimate refine operations must not hard-flag: filler deletion, same-speaker merging,
// 汉字数字→阿拉伯 conversion, global ASR-spelling correction, and noise folded into a stage direction.
export const COVERAGE = {
  MIN_SUBSTANTIVE_CHARS: 20, // normalized 汉字 per turn to count as substantive
  SHINGLE_LEN: 6,            // normalized-hanzi window per anchor
  SHINGLES_MIN: 3, SHINGLES_MAX: 8, SHINGLE_PER_CHARS: 80, // per-turn count = clamp(3, ceil(len/80), 8)
  SHINGLE_SPACING: 24,       // min normalized-char distance between a turn's selected shingles
  GAP_HARD_CHARS: 400, GAP_HARD_TURNS: 3,  // hard requires BOTH, and no fold trace between the anchors
  GAP_SOFT_CHARS: 150, GAP_SOFT_TURNS: 2,  // soft: run ≥ 2 turns & ≥ 150 字
  GAP_SINGLE_TURN_SOFT: 300,               // …or a single lost turn ≥ 300 字
  LOST_RATIO_SOFT: 0.15,                   // global scattered-loss signal
  // Rare-bigram-bag fallback (see bagMatch), calibrated on real pairs. Contiguous shingles alone
  // false-flagged known-good outputs whose content survived but was reworded (修语序 / 合并语义重复);
  // single-CHAR bags then matched even truly censored turns against kept same-topic sections. Bigrams
  // thread the needle: rewording keeps words intact (within-word bigrams survive a faithful retelling),
  // while topic-cousin turns share far fewer exact bigrams than characters.
  BAG_GRAMS: 10, BAG_MIN_FRACTION: 0.6, BAG_WIN_MIN: 80, BAG_WIN_PER_CHAR: 1.5, BAG_WIN_MAX: 400,
}
// Stripped from BOTH sides before matching (refine deletes these; symmetric corruption inside real
// words is harmless because the normalized text is only ever used for substring matching, never shown).
const FILLER_RE = /嗯|呃|啊|哦|欸|那个|这个|就是|然后/g
// Shingle windows containing number-ish chars are excluded: RULES 10 converts 汉字数字→阿拉伯 (十六个→16 个),
// which would break the anchor even though the content survived.
const NUMBERISH_RE = /[0-9A-Za-z〇一二三四五六七八九十百千万亿两]/
// Fold trace: a cooperative refine that collapses a stretch leaves a visible residue — a stage-direction
// line, a 从略-style note, or a marker. Censorship leaves none. Its presence caps a gap's severity at soft.
const FOLD_TRACE_RE = /^（[^（）]{2,60}）$|从略|寒暄|闲聊|客套/
// L3 deterministic marker (also parsed back for overlap-idempotency).
const GAP_MARKER_RE = /【内容缺口：源文件第\s*(\d+)\s*[-–—~至]\s*(\d+)\s*行/
// L1 model self-report marker — detected leniently (models paraphrase); line numbers inside are NOT trusted.
const MODEL_MARKER_RE = /[⚠!！]?\s*[【\[]?未精校段/

// Parse the SOURCE transcript into ordered speaker turns with line ranges. Recognizes the three label
// shapes seen in real transcripts: `**发言人 1 00:03:22**` (bold, optional trailing timestamp, label-only
// line), `名字 15:12` (bare name+timestamp line, optional bold/trailing spaces), and inline `名字：内容`.
// Zero turns parsed → caller treats coverage as not assessable (never a gate), same leniency contract as
// endingCovered.
export function parseSourceTurns(sourceText) {
  const turns = []
  let cur = null
  const lines = sourceText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const line = lines[i].trim()
    if (!line) continue
    const a = line.match(/^\*{0,2}\s*发言人\s*([0-9一二三四五六七八九十]+)(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?\s*\*{0,2}$/)
    const b = a ? null : line.match(/^\*{0,2}([一-龥A-Za-z][^：:\s]{0,7})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*\*{0,2}$/)
    if (a || b) {
      if (cur) turns.push(cur)
      // ts = the label's raw timestamp verbatim (HH:MM or HH:MM:SS), or null — feeds the source anchors.
      cur = { speaker: a ? '发言人' + a[1] : b[1], startLine: lineNo, endLine: lineNo, text: '', ts: (a ? a[2] : b[2]) || null }
      continue
    }
    if (/^[#*>|]/.test(line)) continue
    const c = line.match(/^([一-龥A-Za-z][^：:\s]{0,7})[：:]\s*(.*)$/)
    if (c) {
      if (cur) turns.push(cur)
      cur = { speaker: c[1], startLine: lineNo, endLine: lineNo, text: c[2] || '', ts: null }
      continue
    }
    if (cur) { cur.text += (cur.text ? '\n' : '') + line; cur.endLine = lineNo }
  }
  if (cur) turns.push(cur)
  return turns
}

// Normalize to hanzi-only with filler stripped, keeping a norm-index → 1-based raw line map
// (the map is what lets a detected gap be turned into an insertion point in the raw file).
export function normalizeWithMap(text) {
  // Strip HTML comments (source-anchor comments contain the hanzi 源, which would otherwise leak
  // into the coverage norm). Replaced with same-shape whitespace — NOT deleted — so newlines inside
  // a multi-line comment can't shift the norm-index → line map.
  text = String(text || '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const chars = []
  const lineOfAll = []
  let line = 1
  for (const ch of text) {
    if (ch === '\n') { line += 1; continue }
    if (/[一-龥]/.test(ch)) { chars.push(ch); lineOfAll.push(line) }
  }
  const joined = chars.join('')
  const drop = new Array(joined.length).fill(false)
  for (const m of joined.matchAll(FILLER_RE)) {
    for (let k = 0; k < m[0].length; k += 1) drop[(m.index ?? 0) + k] = true
  }
  let norm = ''
  const lineOf = []
  for (let k = 0; k < joined.length; k += 1) {
    if (!drop[k]) { norm += joined[k]; lineOf.push(lineOfAll[k]) }
  }
  return { norm, lineOf }
}
const normalize = (text) => normalizeWithMap(text).norm

// Select anchor shingles for one normalized turn. "Rarest 6-gram" degenerates on a long document
// (almost every 6-gram is unique) and biases toward mis-heard names — the very strings the refine
// corrects — so instead: score windows by summed per-character rarity, enforce positional spacing so
// the picks spread across the turn, and exclude number-ish windows (broken by 数字 conversion) unless
// the turn offers too few alternatives. Any-of-N matching then survives one spelling correction.
export function pickShingles(normTurn, rarity) {
  const L = COVERAGE.SHINGLE_LEN
  if (normTurn.length < L) return []
  const want = Math.min(COVERAGE.SHINGLES_MAX, Math.max(COVERAGE.SHINGLES_MIN, Math.ceil(normTurn.length / COVERAGE.SHINGLE_PER_CHARS)))
  const score = (w) => { let s = 0; for (const ch of w) s += rarity.get(ch) || 0; return s }
  const clean = [], numberish = []
  for (let i = 0; i + L <= normTurn.length; i += 1) {
    const w = normTurn.slice(i, i + L)
    ;(NUMBERISH_RE.test(w) ? numberish : clean).push({ i, w, s: score(w) })
  }
  const pick = (cands, picked) => {
    for (const c of cands.sort((x, y) => y.s - x.s)) {
      if (picked.length >= want) break
      if (picked.every((p) => Math.abs(p.i - c.i) >= COVERAGE.SHINGLE_SPACING)) picked.push(c)
    }
    return picked
  }
  let picked = pick(clean, [])
  if (picked.length < COVERAGE.SHINGLES_MIN) picked = pick(numberish, picked) // fallback: number-dense turn
  return picked.sort((x, y) => x.i - y.i).map((p) => p.w)
}

// Fallback matcher for reworded-but-present turns. A faithful refine 修语序 / merges semantic repeats /
// corrects spellings — all of which break contiguous 6-char shingles — but WORDS survive a faithful
// retelling, so the turn's rare within-word BIGRAMS do too. Found when ≥ BAG_MIN_FRACTION of the turn's
// rarest distinct bigrams co-occur inside one bounded window of the refined text (sliding window over
// merged position lists, O(k log k)). A truly deleted turn's bigrams may appear scattered in a long
// document, but not co-located; and unlike single chars, they don't false-match kept same-topic sections.
function bagMatch(turnNorm, rarity, refPositions) {
  const cand = new Map() // bigram → rarity score (number-ish grams excluded — 数字 conversion breaks them)
  for (let i = 0; i + 2 <= turnNorm.length; i += 1) {
    const g = turnNorm.slice(i, i + 2)
    if (NUMBERISH_RE.test(g) || cand.has(g)) continue
    cand.set(g, (rarity.get(g[0]) || 0) + (rarity.get(g[1]) || 0))
  }
  const picked = Array.from(cand.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, COVERAGE.BAG_GRAMS)
    .map(([g]) => g)
  if (picked.length < 4) return null
  const need = Math.ceil(picked.length * COVERAGE.BAG_MIN_FRACTION)
  const W = Math.min(COVERAGE.BAG_WIN_MAX, Math.max(COVERAGE.BAG_WIN_MIN, Math.round(turnNorm.length * COVERAGE.BAG_WIN_PER_CHAR)))
  const events = []
  picked.forEach((ch, ci) => { for (const p of refPositions.get(ch) || []) events.push([p, ci]) })
  if (events.length < need) return null
  events.sort((a, b) => a[0] - b[0])
  const count = new Array(picked.length).fill(0)
  let distinctIn = 0
  let lo = 0
  for (let hi = 0; hi < events.length; hi += 1) {
    const [p, ci] = events[hi]
    if (count[ci] === 0) distinctIn += 1
    count[ci] += 1
    while (events[lo][0] < p - W) { const cj = events[lo][1]; count[cj] -= 1; if (count[cj] === 0) distinctIn -= 1; lo += 1 }
    if (distinctIn >= need) return { normIdx: events[lo][0] }
  }
  return null
}

// Shared anchoring pass: parse source turns, normalize both sides, and locate each substantive
// source turn in the refined text (contiguous shingles first, rare-bigram-bag fallback). Returns
// { turns, subs } where subs carry .found and .anchor = { normIdx, line (1-based refined line) }.
// Both scanCoverage (gap detection) and annotateAnchors (source anchors) consume this, so the two
// features stay in lock-step forever.
export function anchorTurns(sourceText, refinedText) {
  const turns = parseSourceTurns(sourceText)
  const subs = turns
    .map((t) => ({ ...t, norm: normalize(t.text) }))
    .filter((t) => t.norm.length >= COVERAGE.MIN_SUBSTANTIVE_CHARS)
  if (!subs.length) return { turns, subs }
  // char rarity over the source's substantive text
  const freq = new Map()
  let total = 0
  for (const t of subs) for (const ch of t.norm) { freq.set(ch, (freq.get(ch) || 0) + 1); total += 1 }
  const rarity = new Map()
  for (const [ch, n] of freq) rarity.set(ch, Math.log(total / n))
  const ref = normalizeWithMap(refinedText)
  // bigram → sorted positions in the refined norm (for the bag-match fallback)
  const refPositions = new Map()
  for (let i = 0; i + 2 <= ref.norm.length; i += 1) {
    const g = ref.norm.slice(i, i + 2)
    let arr = refPositions.get(g)
    if (!arr) { arr = []; refPositions.set(g, arr) }
    arr.push(i)
  }
  // per-turn lookup; record an anchor (norm index + raw line) for found turns.
  // Contiguous shingles first (precise, cheap); rare-bigram-bag fallback for reworded-but-present turns.
  const lineAt = (idx) => ref.lineOf[Math.min(Math.max(idx, 0), ref.lineOf.length - 1)] || 1
  for (const t of subs) {
    t.found = false
    for (const w of pickShingles(t.norm, rarity)) {
      const idx = ref.norm.indexOf(w)
      if (idx >= 0) { t.found = true; t.anchor = { normIdx: idx, line: lineAt(idx + w.length - 1) }; break }
    }
    if (!t.found) {
      const m = bagMatch(t.norm, rarity, refPositions)
      if (m) { t.found = true; t.anchor = { normIdx: m.normIdx, line: lineAt(m.normIdx) } }
    }
  }
  return { turns, subs }
}

// The scan: which substantive source turns never surface in the refined text, grouped into gaps.
export function scanCoverage(sourceText, refinedText) {
  const { turns, subs } = anchorTurns(sourceText, refinedText)
  const empty = { assessed: false, turnsTotal: turns.length, turnsSubstantive: 0, turnsLost: 0, lostChars: 0, lostRatio: 0, modelMarkers: [], gaps: [] }
  if (!turns.length || !subs.length) return empty
  const refLines = refinedText.split(/\r?\n/)
  const modelMarkers = []
  refLines.forEach((l, i) => { if (MODEL_MARKER_RE.test(l)) modelMarkers.push({ line: i + 1, text: l.trim().slice(0, 80) }) })
  // group consecutive lost substantive turns into gaps
  const gaps = []
  let run = []
  const flush = () => {
    if (!run.length) return
    const chars = run.reduce((s, t) => s + t.norm.length, 0)
    const kFirst = subs.indexOf(run[0]); const kLast = subs.indexOf(run[run.length - 1])
    const pre = kFirst > 0 ? subs[kFirst - 1].anchor || null : null
    const post = kLast < subs.length - 1 ? subs[kLast + 1].anchor || null : null
    // fold trace: any residue line in the refined stretch between the bracketing anchors
    const lo = pre ? pre.line : 1
    const hi = post ? Math.max(post.line, lo) : refLines.length
    let trace = false
    for (let i = Math.min(lo, hi) - 1; i < Math.max(lo, hi) && i < refLines.length; i += 1) {
      const l = refLines[i].trim()
      if (l && (FOLD_TRACE_RE.test(l) || GAP_MARKER_RE.test(l) || MODEL_MARKER_RE.test(l))) { trace = true; break }
    }
    const hard = run.length >= COVERAGE.GAP_HARD_TURNS && chars >= COVERAGE.GAP_HARD_CHARS && !trace
    const soft = (run.length >= COVERAGE.GAP_SOFT_TURNS && chars >= COVERAGE.GAP_SOFT_CHARS)
      || (run.length === 1 && chars >= COVERAGE.GAP_SINGLE_TURN_SOFT)
    if (hard || soft) {
      gaps.push({
        startLine: run[0].startLine, endLine: run[run.length - 1].endLine,
        turns: run.length, chars, severity: hard ? 'hard' : 'soft', trace,
        firstText: run[0].text.replace(/\s+/g, ' ').slice(0, 40), lastText: run[run.length - 1].text.replace(/\s+/g, ' ').slice(0, 40),
        preAnchor: pre, postAnchor: post,
      })
    }
    run = []
  }
  for (const t of subs) { if (t.found) flush(); else run.push(t) }
  flush()
  const lostChars = subs.filter((t) => !t.found).reduce((s, t) => s + t.norm.length, 0)
  const totalChars = subs.reduce((s, t) => s + t.norm.length, 0)
  return {
    assessed: true,
    turnsTotal: turns.length,
    turnsSubstantive: subs.length,
    turnsLost: subs.filter((t) => !t.found).length,
    lostChars,
    lostRatio: totalChars ? Number((lostChars / totalChars).toFixed(3)) : 0,
    modelMarkers,
    gaps,
  }
}

// Insert deterministic 内容缺口 markers into the refined text — HARD gaps only (soft = traced folds or
// small losses; writing markers for those would pollute archive documents — they surface in the report
// instead). Insertion goes after the END of the paragraph containing the pre-gap anchor (never
// mid-paragraph); a file-start gap goes after the H1/subtitle block; no anchors at all → append at EOF.
// Idempotent by range-OVERLAP with existing markers (a re-run detecting 300–425 must not double-mark
// 301–423). Preserves CRLF. Pure — annotateFile is the fs wrapper.
export function annotateGaps(refinedText, gaps) {
  const eol = /\r\n/.test(refinedText) ? '\r\n' : '\n'
  const lines = refinedText.split(/\r?\n/)
  const existing = []
  for (const l of lines) { const m = l.match(GAP_MARKER_RE); if (m) existing.push([Number(m[1]), Number(m[2])]) }
  const inserted = [], skipped = []
  const jobs = []
  for (const g of gaps || []) {
    if (g.severity !== 'hard') { skipped.push({ gap: g, reason: 'soft' }); continue }
    if (existing.some(([a, b]) => g.startLine <= b && g.endLine >= a)) { skipped.push({ gap: g, reason: 'already-marked' }); continue }
    let at // 0-based line index to insert AFTER
    if (g.preAnchor) {
      at = g.preAnchor.line - 1
      while (at + 1 < lines.length && lines[at + 1].trim()) at += 1 // extend to end of paragraph
    } else {
      at = -1 // top-of-file: skip the leading H1 / subtitle / blank block
      while (at + 1 < lines.length && (/^#|^\*[^*].*\*$|^\s*$/.test(lines[at + 1]) || !lines[at + 1].trim())) at += 1
      if (at >= lines.length - 1) at = lines.length - 1
    }
    if (!g.preAnchor && !g.postAnchor) at = lines.length - 1 // nothing to anchor on → EOF
    const marker = `> ⚠【内容缺口：源文件第 ${g.startLine}-${g.endLine} 行，约 ${g.chars} 字没能出现在成稿里——这段可能在整理时被漏掉了，也可能因内容较敏感被跳过；请对照源文件人工补回这一段。】`
    jobs.push({ at, marker, gap: g })
  }
  // apply bottom-up so earlier insertions don't shift later indices
  for (const j of jobs.sort((x, y) => y.at - x.at)) {
    lines.splice(j.at + 1, 0, '', j.marker)
    inserted.push(j.gap)
  }
  return { text: lines.join(eol), inserted, skipped }
}

export function annotateFile(refinedPath, gaps) {
  const before = fs.readFileSync(refinedPath, 'utf8')
  const r = annotateGaps(before, gaps)
  if (r.inserted.length) fs.writeFileSync(refinedPath, r.text)
  return { path: path.resolve(refinedPath), inserted: r.inserted, skipped: r.skipped }
}

// ===== Source anchors (provenance) =====
// Refining strips timestamps for readability, which severs the chain quote → transcript → audio.
// These anchors restore it: each ## section gets an invisible HTML comment directly under the
// heading — `<!-- 源 L25-L38 · 08:00-12:05 -->` — the source line range and (when the source labels
// carry timestamps) the time range, so a quote can be jumped back to the recording. Deterministic
// inversion of the coverage scan: a section's anchor is built from the source turns whose matched
// position falls inside that section. Works retroactively on any existing source/refined pair.
// Semantics: ranges MAY overlap between sections and appear out of source order (reordering and
// repeat-merging are legitimate refine operations — anchors follow content). A section with zero
// matched turns gets NO anchor: a wrong anchor is worse than none for a verification aid.
export const ANCHOR = {
  GAP_MAX_LINES: 18, // source-line gap that splits a section's turns into runs (outlier rejection)
}
const ANCHOR_HEADING_RE = /^##\s+/
const ANCHOR_COMMENT_RE = /^\s*<!--\s*源\s+L\d+-L\d+(?:\s*·\s*[\d:]+-[\d:]+)?\s*-->\s*$/

// Robust range for one section's matched turns: sort by source startLine, split into contiguous
// runs (gap > GAP_MAX_LINES starts a new run), keep the run with the most turns (tie → most chars).
// Exploits the real signal — a section's turns are contiguous in the SOURCE even when the refined
// side reorders — so a stray bag-match false positive forms its own 1-turn run and loses.
export function sectionRange(matched) {
  const sorted = matched.slice().sort((x, y) => x.startLine - y.startLine)
  const runs = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].startLine - sorted[i - 1].endLine > ANCHOR.GAP_MAX_LINES) runs.push([])
    runs[runs.length - 1].push(sorted[i])
  }
  const size = (r) => r.reduce((s, t) => s + t.norm.length, 0)
  let best = runs[0]
  for (const r of runs) { if (r.length > best.length || (r.length === best.length && size(r) > size(best))) best = r }
  const first = best.find((t) => t.ts)
  const last = [...best].reverse().find((t) => t.ts)
  return {
    startLine: best[0].startLine,
    endLine: best[best.length - 1].endLine,
    ts: first && last ? `${first.ts}-${last.ts}` : null,
  }
}

// Pure: compute + write the per-section anchor comments into the refined text. Idempotent —
// an existing anchor comment directly under a heading is REPLACED, never duplicated (fresh scan
// each run; source line numbers come from the SOURCE so they are invariant across re-runs).
export function annotateAnchors(sourceText, refinedText) {
  const eol = /\r\n/.test(refinedText) ? '\r\n' : '\n'
  const lines = refinedText.split(/\r?\n/)
  const headIdx = lines.map((l, i) => (ANCHOR_HEADING_RE.test(l) ? i : -1)).filter((i) => i >= 0)
  if (!headIdx.length) return { text: refinedText, updated: [], skipped: [] }
  const { subs } = anchorTurns(sourceText, refinedText)
  const updated = [], skipped = []
  // reverse order so insertions never shift earlier heading indices
  for (let k = headIdx.length - 1; k >= 0; k -= 1) {
    const h = headIdx[k]
    const title = lines[h].replace(ANCHOR_HEADING_RE, '').trim()
    const from = h + 2            // section body spans (1-based) lines h+2 .. next heading
    const to = k + 1 < headIdx.length ? headIdx[k + 1] : lines.length
    const matched = subs.filter((t) => t.found && t.anchor.line >= from && t.anchor.line <= to)
    const existing = h + 1 < lines.length && ANCHOR_COMMENT_RE.test(lines[h + 1])
    if (!matched.length) {
      // no evidence → no anchor; also remove a stale one left by an earlier run
      if (existing) lines.splice(h + 1, 1)
      skipped.push({ title, reason: 'no-matched-turns' })
      continue
    }
    const r = sectionRange(matched)
    const comment = `<!-- 源 L${r.startLine}-L${r.endLine}${r.ts ? ` · ${r.ts}` : ''} -->`
    if (existing) lines[h + 1] = comment
    else lines.splice(h + 1, 0, comment)
    updated.push({ title, startLine: r.startLine, endLine: r.endLine, ts: r.ts })
  }
  return { text: lines.join(eol), updated: updated.reverse(), skipped: skipped.reverse() }
}

export function annotateAnchorsFile(sourcePath, refinedPath) {
  const src = fs.readFileSync(sourcePath, 'utf8')
  const before = fs.readFileSync(refinedPath, 'utf8')
  const r = annotateAnchors(src, before)
  if (r.text !== before) fs.writeFileSync(refinedPath, r.text)
  return { path: path.resolve(refinedPath), updated: r.updated, skipped: r.skipped }
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
// glossaryText (optional): a rendered 校对表.md — enables ghost_name / missing_yin. When absent, those
// two checks are silently skipped (count 0), same leniency contract as the coverage scan.
export function auditPair({ sourceText, refinedText, sourceFile = '<source>', refinedFile = '<refined>', mode = 'refine', glossaryText = null }) {
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

  const coverage = scanCoverage(sourceText, refinedText)

  const metrics = {
    sourceChars: sChars, refinedChars: rChars, charRatio,
    sourceTurns: sTurns, refinedTurns: rTurns, speakerTurnRatio, // turnRatio is confirming-only, never an independent gate
    sourceEmptyDensity: Number(sEmptyDensity.toFixed(4)), refinedEmptyDensity: Number(rEmptyDensity.toFixed(4)), emptyReduction,
    endingCovered: ending,
    coverage: { assessed: coverage.assessed, turnsSubstantive: coverage.turnsSubstantive, turnsLost: coverage.turnsLost, lostChars: coverage.lostChars, lostRatio: coverage.lostRatio },
  }

  // Editorial deterministic checks (typesetting + glossary residue). quote_style is HARD → it opens its own
  // gate; the rest are soft findings only. ghost_name/missing_yin need a glossary — parsed leniently here.
  const glossary = parseGlossaryLite(glossaryText)
  const quoteFindings = checkQuoteStyle(refinedText)
  const speakerFindings = checkSpeakerLabelStyle(refinedText)
  const ghostFinding = checkGhostName(refinedText, glossary)
  const yinFinding = checkMissingYin(refinedText, glossary)
  const quoteHard = quoteFindings.find((f) => f.name === 'quote_style')

  const gates = {
    residual_noise: out.hard_issues > 0,
    long_paragraphs: (out.long_paragraphs || []).length > 0,
    quote_style: (quoteHard ? quoteHard.count : 0) > 0,
  }
  if (mode === 'refine') {
    gates.compression_risk = charRatio < REFINE_GATES.CHAR_RATIO_MIN
    gates.under_refined = sEmptyDensity > REFINE_GATES.SOURCE_FILLER_DENSITY && emptyReduction < REFINE_GATES.EMPTY_REDUCTION_MIN
    gates.ending_missing = !ending
    // content_gap: a substantial contiguous source stretch never surfaced in the refined text and left
    // no fold trace — the silent-omission (possible censorship) failure. Soft gaps and scattered loss
    // are reported as findings below, never gates.
    gates.content_gap = coverage.assessed && coverage.gaps.some((g) => g.severity === 'hard')
  }
  const failed = Object.keys(gates).filter((k) => gates[k])
  const findings = out.findings.concat([
    { name: 'content_gap_soft', severity: 'soft', count: coverage.gaps.filter((g) => g.severity === 'soft').length, samples: coverage.gaps.filter((g) => g.severity === 'soft').slice(0, 12).map((g) => ({ text: `第 ${g.startLine}-${g.endLine} 行 约 ${g.chars} 字${g.trace ? '（有折叠痕迹）' : ''}`, line: g.startLine })) },
    { name: 'model_marker', severity: 'soft', count: coverage.modelMarkers.length, samples: coverage.modelMarkers.slice(0, 12).map((m) => ({ text: m.text, line: m.line })) },
    ...(coverage.assessed && coverage.lostRatio >= COVERAGE.LOST_RATIO_SOFT
      ? [{ name: 'scattered_loss', severity: 'soft', count: coverage.turnsLost, samples: [{ text: `实质轮次流失率 ${Math.round(coverage.lostRatio * 100)}%（${coverage.turnsLost}/${coverage.turnsSubstantive} 轮）`, line: 1 }] }] : []),
    ...quoteFindings,      // quote_style (hard) + optional quote_density_low (soft)
    ...speakerFindings,    // speaker_label_style (soft)
    ghostFinding,          // ghost_name (soft; empty when no glossary)
    yinFinding,            // missing_yin (soft; empty when no glossary)
  ])
  return { file: out.file, mode, status: failed.length ? 'fail' : 'ok', failed, metrics, long_paragraphs: out.long_paragraphs, findings, gaps: coverage.gaps, modelMarkers: coverage.modelMarkers }
}

// Compare the logic-ordered draft (逻辑稿) against the refined 成稿: it must stay ≤ 1.10× the 成稿 in 汉字
// count (导读/出处 scaffold tolerance) and carry no duplicated long paragraphs. Both findings soft — a
// reorder deliverable is judged on preservation, not gated like a refine. Standalone entry (its own CLI
// flag --logic); returns the same finding shape so downstream wiring is uniform.
export function auditLogicPair(refinedText, logicText, { refinedFile = '<refined>', logicFile = '<logic>' } = {}) {
  const rChars = hanzi(refinedText)
  const lChars = hanzi(logicText)
  const findings = checkLogicSize(refinedText, logicText)
  const failed = [] // both findings are soft → never fails
  return {
    file: logicFile, mode: 'logic', status: 'ok', failed,
    metrics: { refinedFile, refinedChars: rChars, logicChars: lChars, sizeRatio: rChars ? Number((lChars / rChars).toFixed(3)) : 1 },
    findings,
  }
}

export function auditLogicFile(refinedPath, logicPath) {
  return auditLogicPair(fs.readFileSync(refinedPath, 'utf8'), fs.readFileSync(logicPath, 'utf8'), { refinedFile: path.resolve(refinedPath), logicFile: path.resolve(logicPath) })
}

export function auditPairs(pairs) {
  const files = (pairs || []).map((p) => auditPair({
    sourceText: p.sourceText != null ? p.sourceText : fs.readFileSync(p.sourcePath, 'utf8'),
    refinedText: p.refinedText != null ? p.refinedText : fs.readFileSync(p.refinedPath, 'utf8'),
    sourceFile: p.sourcePath || p.sourceFile,
    refinedFile: p.refinedPath || p.refinedFile,
    mode: p.mode || 'refine',
    // glossaryText (inline) wins; else glossaryPath is read; else the two glossary checks stay dormant.
    glossaryText: p.glossaryText != null ? p.glossaryText : (p.glossaryPath ? fs.readFileSync(p.glossaryPath, 'utf8') : null),
  }))
  return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
}

function usage() {
  return `用法:
  node scripts/audit_refined.mjs <精校稿.md> [更多.md...]          # 只查输出干净度
  node scripts/audit_refined.mjs --source <源稿.md> --refined <精校稿.md> [--mode refine|summary] [--glossary <校对表.md>]
                                                                  # 对比源文：查压缩/欠精校/内容缺口；给 --glossary 时另查残留变体/裸写未核实名
  node scripts/audit_refined.mjs --logic <逻辑稿.md> --refined <成稿.md>   # 逻辑稿膨胀/重复段体检（独立入口，soft）
  node scripts/audit_refined.mjs --glossary-only <校对表.md>       # 校对表结构体检（条目数/身份线索/变体比例，独立入口，全 soft）
  … --source <源稿> --refined <精校稿> --annotate [--dry-run]      # 把 hard 内容缺口标记插进成稿（--dry-run 只演示不落盘）
  … --source <源稿> --refined <精校稿> --anchors [--dry-run]       # 给每个 ## 小节插入源锚点注释 <!-- 源 L25-L38 · 08:00-12:05 -->
                                                                  # （渲染不可见；引文可循此跳回源文件行号与录音时间；可与 --annotate 同用）

输出-only hard（算失败）：嗯/呃、对对对/是是是、我我/就就 等纯噪音；超约 900 字的对话长段。
对比源文 hard（mode=refine）：charRatio < 0.55（疑似压缩成摘要）、欠精校、结尾缺失、
  content_gap（成段源内容未出现在成稿且无折叠痕迹——疑似被模型无声略过/审查，附源文件行号）、
  quote_style（ASCII 直引号紧贴中文，或出现「」『』——排版规范明令禁止）。
soft（不算失败、需看上下文）：句末语气词 啊/哦/欸，那个/这个/就是说 等；小缺口/折叠缺口/散点流失；
  quote_density_low（长正文无弯引号）、speaker_label_style（标签风格混用）、ghost_name（残留错写变体）、
  missing_yin（未核实名裸写缺（音））、logic_size_sanity / logic_duplicate_para（逻辑稿膨胀或重复段）、
  glossary_thin / glossary_hints_sparse / glossary_variants_sparse（校对表偏薄，见 --glossary-only）。`
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
  const logic = getOpt(argv, '--logic')
  const glossaryOnly = getOpt(argv, '--glossary-only')
  // --glossary-only lints a rendered 校对表 on its own (条目数/身份线索/变体比例). Standalone entry, all soft →
  // always exit 0; a caller reads findings[*].count>0 to see which warnings fired.
  if (glossaryOnly) {
    const result = { status: 'ok', files: [auditGlossaryFile(glossaryOnly)] }
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  // --logic pairs the 逻辑稿 against the 成稿 (--refined); it is a standalone entry, no --source needed.
  if (logic && refined) {
    const result = { status: 'ok', files: [auditLogicFile(refined, logic)] }
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  if (source && refined) {
    const glossary = getOpt(argv, '--glossary')
    const result = auditPairs([{ sourcePath: source, refinedPath: refined, mode: getOpt(argv, '--mode') || 'refine', glossaryPath: glossary }])
    if (argv.includes('--annotate')) {
      const gaps = result.files[0].gaps || []
      if (argv.includes('--dry-run')) {
        const r = annotateGaps(fs.readFileSync(refined, 'utf8'), gaps)
        result.annotation = { dryRun: true, inserted: r.inserted, skipped: r.skipped }
      } else {
        result.annotation = annotateFile(refined, gaps)
      }
    }
    // anchors run AFTER gap annotation (they re-scan the current on-disk/on-hand text, so they see
    // and coexist with any just-inserted gap markers)
    if (argv.includes('--anchors')) {
      if (argv.includes('--dry-run')) {
        const r = annotateAnchors(fs.readFileSync(source, 'utf8'), fs.readFileSync(refined, 'utf8'))
        result.anchors = { dryRun: true, updated: r.updated, skipped: r.skipped }
      } else {
        result.anchors = annotateAnchorsFile(source, refined)
      }
    }
    console.log(JSON.stringify(result, null, 2))
    return result.status === 'fail' ? 1 : 0
  }
  const files = argv.filter((a) => !a.startsWith('--'))
  const result = auditFiles(files)
  console.log(JSON.stringify(result, null, 2))
  return result.status === 'fail' ? 1 : 0
}

// Main-module detection. A plain path.resolve compare breaks when argv[1] and import.meta.url resolve
// through different symlink aliases for the same file (e.g. macOS /tmp → /private/tmp, or a symlinked
// launcher) — the CLI then silently produces no output. Compare fully-resolved real paths, falling back
// to the non-realpath compare if realpathSync throws (e.g. the entry path no longer exists).
function isMainModule() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const self = fileURLToPath(import.meta.url)
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(self)
  } catch {
    return path.resolve(argv1) === self
  }
}
if (isMainModule()) {
  process.exitCode = main()
}
