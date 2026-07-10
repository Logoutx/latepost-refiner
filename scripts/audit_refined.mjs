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
// repeats 我我/就就, phrase repeats 因为因为/涂鸦涂鸦, ASR glue such as
// 20182018/SaaSAPP, broken fragment starts, paragraphs > ~900 chars.
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

const SRT_TIME_RE = /^\s*(\d{1,2}:\d{2}:\d{2})[,.]\d{1,3}\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.]\d{1,3}(?:\s+.*)?$/

export function isSrtPath(filePath = '') {
  return path.extname(String(filePath || '')).toLowerCase() === '.srt'
}

export function looksLikeSrt(text) {
  const sample = String(text || '').slice(0, 8000)
  return /^\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/m.test(sample)
    || (sample.match(/^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/gm) || []).length >= 2
}

function parseSrtCues(text) {
  const blocks = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    if (!lines.length) continue
    let i = /^\d+$/.test(lines[0]) ? 1 : 0
    const tm = lines[i] && lines[i].match(SRT_TIME_RE)
    if (!tm) continue
    const cueText = lines.slice(i + 1).join('\n').trim()
    if (!cueText) continue
    cues.push({
      index: /^\d+$/.test(lines[0]) ? Number(lines[0]) : cues.length + 1,
      start: tm[1],
      end: tm[2],
      text: cueText,
    })
  }
  return cues
}

function normalizeCueSpeaker(label, fallback = '字幕') {
  let s = String(label || '').replace(/^<v\s+|>$/g, '').replace(/\*+/g, '').trim()
  s = s.replace(/^Speaker\s*([0-9]+)$/i, '发言人 $1')
       .replace(/^发言人\s*([0-9一二三四五六七八九十]+)$/u, '发言人 $1')
  if (!s || s.length > 18 || /[。！？!?，,；;、]/.test(s)) return fallback
  return s
}

function splitCueSpeaker(text) {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  if (!lines.length) return { speaker: '字幕', body: '' }
  const first = lines[0]
  const voice = first.match(/^<v\s+([^>]+)>\s*(.*)$/i)
  const line = voice ? voice[2].trim() : first
  const m = line.match(/^([^：:\n]{1,24})[：:]\s*(.*)$/u)
  if (m) {
    return {
      speaker: normalizeCueSpeaker(voice ? voice[1] : m[1], '字幕'),
      body: [m[2], ...lines.slice(1)].filter(Boolean).join('\n').trim(),
    }
  }
  return { speaker: normalizeCueSpeaker(voice ? voice[1] : '字幕', '字幕'), body: [line, ...lines.slice(1)].filter(Boolean).join('\n').trim() }
}

export function normalizeSrtTranscript(text, { sourceFile = '' } = {}) {
  const cues = parseSrtCues(text)
  if (!cues.length) return String(text || '')
  // Merge consecutive cues from the SAME speaker into one turn. An SRT splits a single spoken
  // statement across many short cues; one turn per cue would hand the model a stream of fragmented
  // one-line turns (a real file collapsed ~1,772 cues → ~295 turns this way). Same-speaker bodies are
  // concatenated directly (CJK: no separator, no stray spaces); the turn keeps the FIRST cue's
  // timestamp, and the provenance comment spans the merged cue-index/time range. A speaker change
  // starts a new turn, so speaker alternation is preserved.
  const turns = []
  for (const cue of cues) {
    const { speaker, body } = splitCueSpeaker(cue.text)
    if (!body) continue
    const prev = turns[turns.length - 1]
    if (prev && prev.speaker === speaker) {
      prev.body += body
      prev.endIndex = cue.index
      prev.end = cue.end
    } else {
      turns.push({ speaker, body, start: cue.start, end: cue.end, startIndex: cue.index, endIndex: cue.index })
    }
  }
  const out = [`<!-- source:srt file=${path.basename(String(sourceFile || 'source.srt'))} cues=${cues.length} -->`, '']
  for (const t of turns) {
    const cueRange = t.startIndex === t.endIndex ? `${t.startIndex}` : `${t.startIndex}-${t.endIndex}`
    out.push(`<!-- srt:cue=${cueRange} ts=${t.start}-${t.end} -->`)
    out.push(`${t.speaker} ${t.start}`)
    out.push(t.body)
    out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

export function shouldNormalizeSrtSource(text, sourceFile = '') {
  return isSrtPath(sourceFile) || looksLikeSrt(text)
}

export function normalizeTranscriptSource(text, { sourceFile = '' } = {}) {
  return shouldNormalizeSrtSource(text, sourceFile) ? normalizeSrtTranscript(text, { sourceFile }) : String(text || '')
}

export const HARD_LONG_CHARS = 900

export const REFINE_GATES = {
  CHAR_RATIO_MIN: 0.55,         // refined/source 汉字 below this → probable compression
  EMPTY_REDUCTION_MIN: 0.25,    // filler density must drop at least this much
  SOURCE_FILLER_DENSITY: 0.02,  // only apply the under-refine check when source is filler-heavy
}

const EMPTY_PHRASE = /那个|这个|就是说|对吧|是吧|对不对|你知道/g
const PHRASE_REPEAT = /因为因为|本身本身|涂鸦涂鸦|钉钉钉|然后[，,、]\s*然后|([A-Za-z][A-Za-z0-9-]{1,12})(?:\s+\1)+/g
const YEAR_REPEAT = /(?:20)?(\d{2})\s*年[，,、]\s*(?:20)?\1\s*年/g
const BROKEN_FRAGMENT_START = /^(?![#*>|])(?:[^：:\n]{1,12}[：:]\s*)?(?:呢[，,、]|那个全国|你说那个是\s*$|当时呢只是说[。.]?)/gm
const ASR_GLUE = /(?:20\d{2}){2}|一\s*20\d{2}(?:20\d{2})?|SaaSAPP/g

// 能能 lexical guard: a doubled 能 is a real stutter (吃 → 能……能) only at a phrase start. When it is preceded by
// ANOTHER hanzi it is almost always a word ending in 能 (可能/智能/性能/功能/才能/职能/本能/技能/效能/异能/热能/动能…)
// abutting a word beginning with 能 (能够/能力/能耗/能量/能级…): 可能能够 / 智能能力 / 性能能耗 are correct Chinese, not
// tics. These false-failed two graded outputs. So a 能能 match keeps firing ONLY when the char just before it is
// NOT a hanzi (line start, whitespace, punctuation, latin, digit) — i.e. 能能… at a phrase start. 我我 / 就就 /
// 对对对 / 是是是 are untouched (different chars / a different CHECK). 能能能 (triple) still flags: the guard looks at
// the char before the matched PAIR, and for the leading pair that char is the phrase-initial context, not 能.
const STUTTER_LEXICAL_GUARD = {
  stutter_repeats: (m, text) => {
    if (m.match[0] !== '能') return true              // only the 能能 case is guarded
    const prev = text[(m.index ?? 0) - 1] || ''
    return !CJK_CHAR.test(prev)                        // keep (real stutter) only when not preceded by a hanzi
  },
}

const CHECKS = [
  { name: 'confirmation_repeats', severity: 'hard', pattern: /(?:对){2,}|(?:是){2,}|嗯嗯/g },
  { name: 'stutter_repeats',      severity: 'hard', pattern: /([我你他她它这那就有没不能会要再先])\1/g },
  { name: 'phrase_repeats',       severity: 'hard', pattern: PHRASE_REPEAT },
  { name: 'repeated_years',        severity: 'hard', pattern: YEAR_REPEAT },
  { name: 'broken_fragment_starts', severity: 'hard', pattern: BROKEN_FRAGMENT_START },
  { name: 'asr_glue',             severity: 'hard', pattern: ASR_GLUE },
  { name: 'filler_particles',     severity: 'hard', pattern: /[嗯呃]/g },                 // 几乎总是垫词
  { name: 'modal_particles',      severity: 'soft', pattern: /[啊哦欸]/g },               // 可能是句末语气词，看上下文
  { name: 'empty_phrase_candidates', severity: 'soft', pattern: EMPTY_PHRASE },
]

function matches(re, text, guard) {
  let all = Array.from(text.matchAll(re)).map((m) => ({ match: m[0], index: m.index ?? 0 }))
  if (guard) all = all.filter((m) => guard(m, text))
  return all
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
// section header matching 人名 or 品牌/公司/产品. `missing_yin` is intentionally name-only: uncertain brands,
// institutions, and terms belong in review.md as open questions, but should not force awkward （音） markers.
// Returns { entries: [{ canonical, variants[], section }], unverified: [names] }.
export function parseGlossaryLite(glossaryText) {
  const entries = [], unverified = new Set()
  if (!glossaryText) return { entries, unverified: [] }
  let section = ''
  const peopleCanonicals = new Set()
  for (const raw of String(glossaryText).split(/\r?\n/)) {
    const line = raw.trim()
    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) {
      section = /人名/.test(h[1]) ? 'person' : /品牌|公司|产品/.test(h[1]) ? 'brand' : ''
      continue
    }
    // unverified-by-web line: `- query：未能核实，保留（音）…`
    const un = line.match(/^-\s*(.+?)：未能核实/)
    if (un) {
      const q = un[1].trim().replace(/\*/g, '')
      if (peopleCanonicals.has(q) && CJK_CHAR.test(q)) unverified.add(q)
      continue
    }
    if (!section) continue
    const m = line.match(/^-\s*\*\*(.+?)\*\*\s*←\s*(.*)$/)
    if (!m) continue
    const canonical = m[1].trim()
    const rest = m[2]
    const fields = rest.split('｜')
    const varsRaw = (fields.shift() || '').trim()
    const variants = (varsRaw === '—' || varsRaw === '（无变体）') ? []
      : varsRaw.split('/').map((x) => x.trim()).filter(Boolean)
    entries.push({ canonical, variants, section })
    if (section === 'person') peopleCanonicals.add(canonical)
    // A suspect/unverified person row → its canonical needs a （音） in prose. A generic ⚠ can also mean
    // "verified alias not auto-applied" (e.g. 林湛 → 林湛之), so require explicit uncertainty wording.
    if (section === 'person' && /未能核实|保留（音）|疑为转录误写/.test(rest)) {
      if (CJK_CHAR.test(canonical)) unverified.add(canonical)
    }
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

// ---------- 校对表 source-label validation (P2b) ----------
// A 校对表 row asserts a canonical writing + an identity/依据. Its content can come from what the interviewee
// ACTUALLY said (访谈) or from public/external research (公开资料). Presenting a publicly-sourced fact as if the
// interviewee confirmed it is the failure this guards: a row cited a specific technical designation to public
// sources while the interviewee had explicitly declined to name it. So every row should carry a source label
// 【访谈】 or 【公开·待记者核实】 (mirrors the 时间线/总结 label vocabulary), and the audit validates that a row
// whose note cites external sources is not passed off as 访谈. All soft (a judgment call, not a hard gate).
const GLOSSARY_LABEL_RE = /【[^】]*】/g
// Note text that clearly points at an EXTERNAL / public source (not the interviewee's own words).
const GLOSSARY_EXTERNAL_RE = /据[^，。；、｜]{0,12}(?:报道|消息|披露|介绍|记载)|公开(?:报道|资料|信息|渠道|数据)|官网|官方网站|维基|百科|招股(?:书|说明书)|年报|财报|工商(?:登记|信息|资料)|天眼查|企查查|媒体报道|根据公开|公告显示|官方公布/
// Parse the 【…】 source label carried in a row's rhs → { label, explicit }. 公开 wins the "public" side; a
// row can be 【公开+访谈…】 (both). A 【…】 that names neither 访谈 nor 公开 is not a source label (explicit=false).
function glossaryRowLabel(rest) {
  const inBr = (String(rest).match(GLOSSARY_LABEL_RE) || []).join('')
  const pub = /公开/.test(inBr), itv = /访谈/.test(inBr)
  return { label: pub && itv ? 'both' : pub ? 'public' : itv ? 'interview' : 'none', explicit: pub || itv }
}

// Parse renderGlossary's 人名 / 品牌 rows into { canonical, section, hasVariants, hasHint, label, hasExplicitLabel,
// citesExternal, publicMarker, line }. Self-contained (the real parser in core/spec.js must not be imported here).
// A row: `- **正字** ← 变体 / … ｜ hint ｜ …markers… 〔核实·date〕`. 术语 rows are intentionally excluded — 身份
// clues don't apply to terms, so counting them would depress the hint ratio unfairly; the lint judges people/brands.
export function parseGlossaryEntities(glossaryText) {
  const entities = []
  if (!glossaryText) return entities
  let section = null   // 'person' | 'brand' | null
  const lines = String(glossaryText).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
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
    const rest = m[2]
    const segs = rest.split('｜').map((s) => s.trim())
    const varsRaw = (segs.shift() || '').trim()
    const hasVariants = !(varsRaw === '' || varsRaw === '—' || varsRaw === '（无变体）')
    const hasHint = segs.some(glossarySegIsHint)
    const { label, explicit } = glossaryRowLabel(rest)
    const noteText = rest.replace(GLOSSARY_LABEL_RE, ' ').replace(/〔[^〕]*〕/g, ' ')
    const citesExternal = GLOSSARY_EXTERNAL_RE.test(noteText)
    // a row is publicly-corroborated when it says so (公开 label), or carries a 核实 concrete-source marker, or
    // is tagged 公众人物 — any of these legitimises an external-sourced note.
    const publicMarker = label === 'public' || label === 'both' || /〔核实/.test(rest) || /公众人物/.test(rest)
    entities.push({ canonical, section, hasVariants, hasHint, label, hasExplicitLabel: explicit, citesExternal, publicMarker, line: i + 1 })
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
  // P2b source labels. mislabel (fires in ANY edition; precise): a row whose note cites external/public sources but
  // is NOT marked public (no 【公开…】/〔核实〕/公众人物) — a公开 fact presented as 访谈亲述. unlabeled (only once the
  // 校对表 is USING the 【…】 convention — ≥1 labeled row — so a legacy/universal table without labels isn't nagged):
  // the rows that still lack a source label. Both soft (judgment calls, never a gate).
  const usesLabels = entities.some((e) => e.hasExplicitLabel)
  const mislabeled = entities.filter((e) => e.citesExternal && !e.publicMarker)
  const unlabeled = usesLabels ? entities.filter((e) => !e.hasExplicitLabel) : []
  findings.push({ name: 'glossary_source_mislabel', severity: 'soft', count: mislabeled.length,
    samples: mislabeled.slice(0, 12).map((e) => ({ text: `“${e.canonical}”一行引用了公开/外部来源，却${e.label === 'interview' ? '标成了【访谈】' : '未标为【公开·待记者核实】'}——公开或推算的事实勿当访谈亲述`, line: e.line })) })
  findings.push({ name: 'glossary_source_unlabeled', severity: 'soft', count: unlabeled.length,
    samples: unlabeled.slice(0, 12).map((e) => ({ text: `“${e.canonical}”未标来源——请补标【访谈】（亲述）或【公开·待记者核实】（取自公开资料）`, line: e.line })) })
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

function logicComparableLines(text) {
  return bodyLines(text)
    .map(({ raw }) => raw.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^\*〔取自精校稿：/.test(line) && !/^\*基于精校稿/.test(line))
    .map((line) => line.replace(/\s+/g, ''))
    .filter((line) => cjkLen(line) >= 8)
}

function lcsLength(a, b) {
  const prev = new Array(b.length + 1).fill(0)
  const curr = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    for (let j = 0; j <= b.length; j += 1) { prev[j] = curr[j]; curr[j] = 0 }
  }
  return prev[b.length]
}

function refinedHeadings(text) {
  return String(text || '').split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^##\s+(.+?)\s*$/)
      return m ? m[1].trim() : null
    })
    .filter(Boolean)
}

function logicProvenanceSections(logicText, sourceHeadings = []) {
  const out = []
  const source = Array.isArray(sourceHeadings) ? sourceHeadings.filter(Boolean) : []
  const re = /〔取自精校稿：([^〕]+)〕/g
  for (const m of String(logicText || '').matchAll(re)) {
    const block = m[1]
    const matched = source.filter((h) => block.includes(h))
    if (matched.length) {
      out.push(...matched)
      continue
    }
    for (const raw of block.split(/[、,，]/)) {
      const s = raw.trim()
      if (s) out.push(s)
    }
  }
  return out
}

export function checkLogicOrder(refinedText, logicText) {
  const refinedLines = logicComparableLines(refinedText)
  const logicLines = logicComparableLines(logicText)
  const minLen = Math.min(refinedLines.length, logicLines.length)
  const maxLen = Math.max(refinedLines.length, logicLines.length)
  const lcs = lcsLength(refinedLines, logicLines)
  const sameOrderRatio = minLen ? Number((lcs / minLen).toFixed(3)) : 0
  const lineCountRatio = minLen ? Number((maxLen / minLen).toFixed(3)) : 1
  const unchanged = minLen >= 20 && sameOrderRatio > 0.85 && lineCountRatio <= 1.08
  return {
    metrics: { refinedComparableLines: refinedLines.length, logicComparableLines: logicLines.length, sameOrderRatio, lineCountRatio },
    finding: {
      name: 'logic_order_unchanged',
      severity: 'hard',
      count: unchanged ? 1 : 0,
      samples: unchanged ? [{ text: `逻辑稿与精校稿行级同序率 ${sameOrderRatio}，实质重排不足；需先做 logic-plan，再按主线重写`, line: 1 }] : [],
    },
  }
}

export function checkLogicSectionCoverage(refinedText, logicText) {
  const source = refinedHeadings(refinedText)
  const cited = logicProvenanceSections(logicText, source)
  const citedSet = new Set(cited)
  const missing = source.filter((h) => !citedSet.has(h))
  const dupes = Array.from(cited.reduce((m, h) => m.set(h, (m.get(h) || 0) + 1), new Map()))
    .filter(([, n]) => n > 1)
    .map(([h]) => h)
  const enough = source.length < 3 || missing.length === 0
  const findings = []
  findings.push({
    name: 'logic_section_coverage',
    severity: 'hard',
    count: enough ? 0 : 1,
    samples: enough ? [] : [{ text: `逻辑稿来源标注漏掉 ${missing.length}/${source.length} 个精校小标题：${missing.slice(0, 8).join('、')}`, line: 1 }],
  })
  findings.push({
    name: 'logic_section_duplicate',
    severity: 'soft',
    count: dupes.length,
    samples: dupes.slice(0, 8).map((h) => ({ text: `同一精校小标题被多个逻辑线索重复引用：${h}`, line: 1 })),
  })
  return {
    metrics: { refinedSections: source.length, citedSections: cited.length, missingSections: missing.length, duplicateSections: dupes.length },
    findings,
  }
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
    if (/^<!--/.test(line)) continue
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
    t.matchType = null   // 'shingle' = contiguous high-confidence; 'bag' = rare-bigram fallback (low-confidence)
    for (const w of pickShingles(t.norm, rarity)) {
      const idx = ref.norm.indexOf(w)
      if (idx >= 0) { t.found = true; t.matchType = 'shingle'; t.anchor = { normIdx: idx, line: lineAt(idx + w.length - 1) }; break }
    }
    if (!t.found) {
      const m = bagMatch(t.norm, rarity, refPositions)
      if (m) { t.found = true; t.matchType = 'bag'; t.anchor = { normIdx: m.normIdx, line: lineAt(m.normIdx) } }
    }
  }
  return { turns, subs }
}

// ===== Meaning-atom fidelity (M4): the MUTATION tier =====
// Every gate above catches DELETION-shaped failures (a stretch vanished). None catches MUTATION-shaped ones,
// where the words survive but a fact is quietly altered: 亏损 2 亿→2 亿 (lost 亏损), 不到 30%→30% (lost the bound),
// 可能明年盈利→明年盈利 (lost the hedge), 2019→2021 (changed value). The coverage anchoring is structurally BLIND
// to these: it excludes number-ish shingles on purpose (NUMBERISH_RE) because RULES 10 rewrites 汉字数字→阿拉伯,
// so a turn whose only change is a flipped number still "anchors" fine. This tier re-checks exactly what
// coverage skips — numeric tokens and their polarity/bound qualifiers, plus per-turn hedge density — by
// NORMALIZING BOTH SIDES the same way (mirroring RULES 10) and diffing the resulting atom multisets, turn-scoped
// via the existing anchor positions. All findings are SOFT this pass (promotion to hard waits on real-world FP
// data); leniency contract identical to coverage: unparseable source or zero anchored turns → assessed:false.
export const ATOMS = {
  POLARITY_WINDOW: 6,       // chars before a number scanned for a polarity/bound qualifier (不到/亏损/超过…)
  HEDGE_TURN_MIN: 2,        // source turn needs ≥ this many hedge markers before a total wipe is worth flagging
  DRIFT_SAMPLES: 12,        // cap on number_drift sample texts (total count still reported)
  NOTE_SAMPLES: 12,         // cap on number_drift_note sample texts (downgraded, garbage/low-confidence)
  WINDOW_LINES: 6,          // refined lines each side of a turn's anchor line = its search window
  STUTTER_GAP_MAX: 3,       // max chars between two same-value atoms for them to count as ONE stuttered fact
  MIN_ATOM_VALUE_LEN: 1,    // (reserved) minimum canonical-value length to register an atom
}

// Polarity / bound / sign qualifiers that ride just before a number and flip its meaning. Losing one is as bad
// as changing the digits (不到 30% → 30% overstates; 亏损 2 亿 → 2 亿 hides a loss). Ordered longest-first so the
// window scan prefers 亏损 over a bare 亏, 不足 over 不.
const POLARITY_TOKENS = [
  '亏损', '盈利', '不到', '不足', '超过', '多于', '少于', '以上', '以下', '左右', '上下', '接近', '将近', '至少', '最多', '大约',
  '涨', '跌', '降', '增', '减', '亏', '近', '约', '超', '余', '多', '不', '未', '没',
]
// Colloquial small oral quantities RULES 10 KEEPS as 汉字 (两三年 / 三五个 / 一两次 / 七八年 / 一两句 / 两个人): a refine
// that leaves these as 汉字 is CORRECT, so extracting them would false-flag every faithful output. Two cases:
//   (a) an APPROXIMATION — two adjacent han-digits (三五 / 一两 / 七八 / 两三) — always oral, regardless of what
//       follows. RULES 10 lists 三五个 / 一两次 / 七八年 verbatim.
//   (b) a bare single han-digit (no scale, no RECOGNIZED unit) hugging a colloquial 量词 (两个人 / 三个 / 五位):
//       these are vague small counts. A single digit + a REAL measured unit (3 个月 / 6% / 5 家营收) is NOT oral —
//       RULES 10 converts those — so this only fires when the trailing unit is a soft classifier, not in ATOM_UNITS.
const SMALL_ORAL_APPROX_RE = /^[一二两三四五六七八九][一二两三四五六七八九]$/           // 三五 / 一两 / 七八 / 两三
const SOFT_CLASSIFIER = '个位人句块只种样步口台家'                                   // colloquial 量词 (NOT measured units)
// Lexical guard: characters that, right after a bare 一/两/三, form a common NON-numeric word — 一直/一般/一下/一些/
// 一起/一切/一旦/一样/一定/一边/一律/一带/一度/一点/一会/一再/一齐/一致/一连/一味/一同/一块; 两下/两旁; 三番. Without this,
// 一 (by far the commonest character in Chinese prose) floods the audit with phantom "number 1" atoms even when a
// polarity word happens to sit nearby. Applied only to a bare single han-digit with no scale and no strong unit.
const LEXICAL_AFTER_ONE = '直般下些起切旦样定边律带度点会再齐致连味同块流成'
const LEXICAL_AFTER_TWO = '下旁'            // 两下 / 两旁 (两 is usually numeric, so keep this list tiny)
// 成语 / fixed four-char idioms containing number chars — never numeric facts. A compact blocklist of the ones
// that actually collide with number extraction (三心二意 etc. have no trailing unit so rarely reach extraction,
// but 一五一十 / 五花八门 / 三三两两 look number-dense). Matched as substrings around a candidate.
const NUMBER_IDIOMS = ['一五一十', '五花八门', '三心二意', '七上八下', '乱七八糟', '三三两两', '五颜六色', '四面八方', '九牛一毛', '十全十美', '一心一意', '独一无二', '三言两语', '千方百计', '成千上万', '五湖四海']
// Units we canonicalize and keep attached to the value. Longest-first (个月 before 月, 千万 before 万, 美元 before 元).
// Split by STRENGTH — the single most important false-positive control in this whole tier:
//   STRONG units are measured quantities (money / percent / multiples / durations-with-classifier). A bare single
//     han-digit + a STRONG unit is a real fact (三个月 / 六% / 两亿) and is always extracted.
//   WEAK units are plain time nouns (年/月/日/天). A BARE single-or-double han-digit + a WEAK unit is usually
//     LEXICAL, not a quantity — 那一年 / 两天后 / 头一天 — and refine legitimately drops the 一 (疫情那一年→那年). So a
//     weak-unit atom is only kept when the number is arabic, carries a scale char (十/百/千), or has a polarity
//     qualifier. This is what stops 一/两/三 in running prose from flooding the audit with phantom drift.
// A number with NO unit at all becomes a bare-value atom ONLY when it is arabic or scale-bearing (2019 / 一百二十);
// a bare unitless single han-digit (一 in 一下/一般, 两 in 两块, 第三…) is dropped — see the acceptance gate below.
const STRONG_UNITS = ['千万', '亿', '万', '%', '个月', '个点', '美元', '港元', '倍', '元', '小时', 'B', 'K', 'W', 'k']
const WEAK_UNITS = ['年', '月', '日', '天']
const ATOM_UNITS = [...STRONG_UNITS, ...WEAK_UNITS]
const STRONG_UNIT_SET = new Set(STRONG_UNITS)
// Char classes.
const HAN_DIGIT = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 }
const HAN_SMALL_UNIT = { 十: 10, 百: 100, 千: 1000 }
const HAN_NUM_CHARS = '〇零一二两三四五六七八九十百千'   // NOTE: 万/亿 are treated as trailing UNITS, not scale, so a value
                                                    // written 八千万 canonicalizes to 8000万 (== 8000 万) not 80000000.

// Parse one contiguous hanzi-number section (already stripped of any trailing 万/亿/% unit) → integer, or null.
function parseHanSection(s) {
  if (!s) return null
  // positional/year style: contains 〇 or is a bare digit run with no scale unit and length ≥2 (二〇一九 / 一九九八)
  if (/[〇零]/.test(s) || (/^[一二两三四五六七八九]{2,}$/.test(s) && !/[十百千]/.test(s))) {
    let out = ''
    for (const c of s) { if (!(c in HAN_DIGIT)) return null; out += HAN_DIGIT[c] }
    return Number(out)
  }
  let total = 0, cur = 0, seen = false
  for (const c of s) {
    if (c in HAN_DIGIT) { cur = HAN_DIGIT[c]; seen = true }
    else if (c in HAN_SMALL_UNIT) { total += (cur === 0 ? 1 : cur) * HAN_SMALL_UNIT[c]; cur = 0; seen = true }
    else return null
  }
  total += cur
  return seen ? total : null
}

// Canonicalize a numeric value string (arabic or hanzi, possibly a range) to a stable key so both sides compare
// equal regardless of writing system. Ranges (六七十 / 三四十 / 30到40 / 30-40 / 三四百) → "lo-hi"; scalars → the
// number as a string. Returns null when it isn't really a number. `unit` is passed in only to disambiguate the
// adjacent-digit range heuristic (六七十 with scale 十 → 60-70; a bare 34 is just 34).
function canonValue(raw, scale) {
  const s = String(raw).trim()
  if (!s) return null
  // adjacent hanzi digits that form an approximate range: 六七十 (→60-70), 三四百 (→300-400), 两三 (→2-3).
  // Trigger: 2 distinct consecutive single han-digits, optionally followed by ONE scale char (十/百/千).
  const rng = s.match(/^([一二两三四五六七八九])([一二两三四五六七八九])([十百千]?)$/)
  if (rng) {
    const a = HAN_DIGIT[rng[1]], b = HAN_DIGIT[rng[2]]
    if (b === a + 1 || b === a) {
      const mul = rng[3] ? HAN_SMALL_UNIT[rng[3]] : 1
      const lo = Math.min(a, b) * mul, hi = Math.max(a, b) * mul
      return `${lo}-${hi}`
    }
  }
  // explicit arabic range 30-40 / 30~40 / 30到40 / 30至40
  const arng = s.match(/^(\d+(?:\.\d+)?)\s*(?:[-~—－]|到|至)\s*(\d+(?:\.\d+)?)$/)
  if (arng) return `${Number(arng[1])}-${Number(arng[2])}`
  // explicit hanzi range 三十到四十
  if (/[到至]/.test(s)) {
    const [l, r] = s.split(/[到至]/)
    const lv = parseHanSection(l), rv = parseHanSection(r)
    if (lv != null && rv != null) return `${lv}-${rv}`
  }
  // pure arabic scalar (allow a decimal)
  if (/^\d+(?:\.\d+)?$/.test(s)) return String(Number(s))
  // pure hanzi scalar
  const v = parseHanSection(s)
  if (v != null) return String(v)
  return null
}

// Attach 万/亿 large-scale words that trail the digits as part of the UNIT (八千万 → value 8000, unit 万; 两亿 →
// value 2, unit 亿), so an arabic 8000 万 / 2 亿 compares equal. Given the raw run + the matched unit, if the value
// section still ends in 千万/万/亿 fold it into unit and reparse the head. Returns { value, unit } or null.
function foldScaleUnit(valueRaw, unit) {
  let v = valueRaw, u = unit || ''
  const m = v.match(/(千万|万|亿)$/)
  if (m && !/^(千万|万|亿)/.test(u)) { u = m[1] + u; v = v.slice(0, v.length - m[1].length) }
  const cv = canonValue(v)
  if (cv == null) return null
  return { value: cv, unit: u }
}

// Extract meaning-atoms (number + unit + polarity) from ONE turn's raw text. Deterministic, position-tagged so a
// finding can cite the source line. Skips speaker labels / HH:MM(:SS) timestamps / URLs / small oral numbers /
// 成语 (all per the EXCEPTIONS contract). `lineBase`/`lineText` let a caller stamp a source line; when scanning a
// turn we pass the turn's own text so offsets map back through its startLine.
export function extractNumberAtoms(text) {
  const atoms = []
  // Markdown escaping: a raw ASR/Word export writes decimals as 80\.3 / 4\.8 (backslash before the dot); the
  // refined side un-escapes them to 80.3 / 4.8. Strip a backslash sitting before a dot FIRST so a decimal parses
  // whole and identically on both sides — otherwise 80\.3% splits into 80 + 3% and phantom-drifts against 80.3%.
  const raw = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\\(?=[.])/g, '')
  // Blank out HH:MM(:SS) timestamps and URLs so their digits never register.
  const masked = raw
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, (m) => ' '.repeat(m.length))
    .replace(/https?:\/\/[^\s]+/g, (m) => ' '.repeat(m.length))
  // A number run = arabic digits (with optional decimal / range punctuation) OR a hanzi-number run, then an
  // optional trailing unit. Full-width digits are folded to half-width first.
  const half = masked.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
                     .replace(/％/g, '%')
                     // Spoken measure-word form "N 个 + 大额单位" (2 个亿 / 1.5 个亿 / 两个亿): the 个 is a colloquial
                     // filler between the number and a scale word — semantically identical to 2 亿 / 两亿. Blank the
                     // 个 to a single space (length-preserving, so idx/claimed offsets stay aligned with `raw`) ONLY
                     // when it sits between a number char and 亿/万/千万 (the scale words foldScaleUnit knows). The
                     // tight scale-word lookahead is what keeps 个月 (a real duration unit) and 个 + noun (3 个人 /
                     // 5 个方面) untouched. Capturing the prefix + re-emitting "$1 " avoids variable-length lookbehind.
                     .replace(new RegExp(`([\\d${HAN_NUM_CHARS}]\\s*)个(?=\\s*(?:千万|亿|万))`, 'g'), '$1 ')
  const unitAlt = ATOM_UNITS.map(escapeRe).join('|')
  const numCore = `(?:\\d+(?:\\.\\d+)?(?:\\s*(?:[-~—－]|到|至)\\s*\\d+(?:\\.\\d+)?)?|[${HAN_NUM_CHARS}]+(?:[到至][${HAN_NUM_CHARS}]+)?)`
  const NUM_RE = new RegExp(`(${numCore})\\s*(百分之)?\\s*(${unitAlt})?`, 'g')
  // 百分之X → treat as X with unit %. Handle the prefix form separately first (percent BEFORE the digits).
  const PCT_PREFIX_RE = new RegExp(`百分之\\s*([${HAN_NUM_CHARS}\\d]+(?:[到至\\-~—－][${HAN_NUM_CHARS}\\d]+)?)`, 'g')
  const claimed = new Array(half.length).fill(false)
  const pushAtom = (valueRaw, unit, idx, endIdx) => {
    // skip if this run is inside a number 成语 (一五一十 / 五花八门 …)
    for (const idm of NUMBER_IDIOMS) {
      const w = raw.indexOf(idm)
      if (w >= 0 && idx >= w && idx < w + idm.length) return
    }
    // Idiom guard: 千万 as the adverb "绝对/务必" (千万不要 / 千万别 / 千万要), NOT the number 10,000,000. Fires only
    // for a BARE 千万 run (value 千, unit 万) hugging 别/要/不X — a real 一千万 / 五千万 carries a digit prefix (run
    // "一千" / "五千"), so valueRaw is not '千' and it is unaffected; 千万不止 / 千万不等 (a genuine quantity) are
    // excluded by the explicit follow-set.
    if (valueRaw === '千' && unit === '万' && /^(?:别|要|不要|不能|不可|不得|不会|不敢|不应)/.test(raw.slice(endIdx, endIdx + 2))) return
    // English magnitude words (billion / million / bn / mn): the refine legitimately converts these to 亿/万
    // (源 1.03 billion → 成稿 10.3 亿美元, 860 million → 8.6 亿), which no value-level comparison can verify. Skip a
    // number immediately followed by one — extracting it only manufactures conversion-shaped false drift.
    if (/^\s*(?:billion|million|bn|mn|bil|mil)\b/i.test(raw.slice(endIdx, endIdx + 12))) return
    const hasArabic = /\d/.test(valueRaw)
    const hasScale = /[十百千]/.test(valueRaw)      // 一百二十 / 六七十 — a scale char makes a hanzi run unambiguously numeric
    const isYearForm = /[〇零]/.test(valueRaw) || (/^[一二两三四五六七八九]{3,}$/.test(valueRaw)) // 二〇一九 / 一九九八
    const pureHan = !hasArabic && /^[一二两三四五六七八九十百千]+(?:[到至][一二两三四五六七八九十百千]+)?$/.test(valueRaw)
    // small oral approximation kept as 汉字 (三五 / 一两 / 七八) — always oral, drop regardless of unit-lessness
    if (pureHan && !hasScale && SMALL_ORAL_APPROX_RE.test(valueRaw)) return
    // colloquial single bare han-digit + soft 量词 (两个人 / 三个 / 五位) with no measured unit → oral, keep as 汉字
    if (pureHan && !hasScale && !unit && valueRaw.length === 1) {
      const tail = raw.slice(endIdx, endIdx + 1)
      if (tail && SOFT_CLASSIFIER.includes(tail)) return
    }
    // lexical guard: a bare 一/两/三 that starts a common function word (一直/一般/两下…) is NOT a number — drop it
    // even if a polarity word happens to sit within the window. Only for a bare single han-digit with no scale.
    // (tail must be non-empty — ''.includes-style checks would wrongly swallow a number at end-of-string.)
    if (pureHan && !hasScale && valueRaw.length === 1) {
      const tail = raw.slice(endIdx, endIdx + 1)
      if (tail && valueRaw === '一' && LEXICAL_AFTER_ONE.includes(tail)) return
      if (tail && valueRaw === '两' && LEXICAL_AFTER_TWO.includes(tail)) return
    }
    // polarity: scan a small window of ORIGINAL chars before the number for the nearest qualifier (不到/亏损/超过…)
    const before = raw.slice(Math.max(0, idx - ATOMS.POLARITY_WINDOW), idx)
    let polarity = null
    for (const p of POLARITY_TOKENS) { if (before.includes(p)) { polarity = p; break } }
    // ACCEPTANCE GATE (false-positive control): a bare/weak hanzi number in running prose (一 in 一下/一般, 两 in
    // 两块, 第三, 那一年) is lexical noise. Accept a hanzi number only when it is unambiguously a quantity —
    // arabic digits, a scale char (十/百/千), a year form (含〇 或 ≥3 连续汉数), a STRONG measured unit, or a
    // polarity qualifier riding on it. A WEAK time unit (年/月/日/天) on a bare single/double han-digit does NOT
    // qualify on its own (那一年 / 两天), which is what keeps 一/两 in running prose out of the atom set.
    if (!hasArabic) {
      const strong = unit && STRONG_UNIT_SET.has(unit)
      if (!hasScale && !isYearForm && !strong && !polarity) return
    }
    const folded = foldScaleUnit(valueRaw, unit)
    if (!folded) return
    atoms.push({ value: folded.value, unit: folded.unit, polarity, idx, end: endIdx, key: `${folded.value}|${folded.unit}` })
  }
  for (const m of half.matchAll(PCT_PREFIX_RE)) {
    const idx = m.index ?? 0
    for (let k = idx; k < idx + m[0].length; k += 1) claimed[k] = true
    pushAtom(m[1], '%', idx, idx + m[0].length)
  }
  for (const m of half.matchAll(NUM_RE)) {
    const idx = m.index ?? 0
    if (claimed[idx]) continue
    const valueRaw = m[1]
    // 百分之 captured as the mid group → percent
    const unit = m[3] || (m[2] ? '%' : '')
    // guard: a lone scale/number char that is actually part of a claimed percent run
    let overlap = false
    for (let k = idx; k < idx + m[0].length; k += 1) if (claimed[k]) { overlap = true; break }
    if (overlap) continue
    pushAtom(valueRaw, unit, idx, idx + m[0].length)
  }
  return atoms
}

// Hedge / evidentiality markers (modality). Losing ALL of them from a turn that otherwise survived turns a hedged
// claim into a flat assertion (可能明年盈利 → 明年盈利). Counted per turn; 左右 is deliberately omitted (it is almost
// always the numeric "约" sense handled as polarity, not a standalone hedge).
const HEDGE_TOKENS = ['可能', '也许', '大概', '应该', '据说', '听说', '号称', '估计', '差不多', '我觉得', '我感觉', '大约', '或许', '说不定', '好像', '似乎', '恐怕']
export function countHedges(text) {
  const s = String(text || '')
  let n = 0
  for (const h of HEDGE_TOKENS) { let i = 0; while ((i = s.indexOf(h, i)) >= 0) { n += 1; i += h.length } }
  return n
}

// The refined PARAGRAPH containing a given 1-based line: the contiguous run of non-blank lines around it (a
// refined turn is one paragraph). Tighter than the ±N-line number window on purpose — hedge detection must not
// bleed into a neighboring section's hedges (which would mask a real wipe as a false negative).
function paragraphAround(refLines, line1) {
  let i = Math.min(Math.max(line1 - 1, 0), refLines.length - 1)
  if (!refLines[i] || !refLines[i].trim()) return refLines[i] || ''
  let lo = i, hi = i
  while (lo > 0 && refLines[lo - 1].trim()) lo -= 1
  while (hi < refLines.length - 1 && refLines[hi + 1].trim()) hi += 1
  return refLines.slice(lo, hi + 1).join('\n')
}

// Human-facing atom label with 盘古之白: a space between the digits and a CJK unit (2 亿 / 8000 万 / 3 个月) and
// after a polarity word (不到 30% / 亏损 2 亿), but NOT before a symbol unit (30%, $50) or when there is no unit.
export function atomLabel(a) {
  const symbolUnit = !a.unit || /^[%$]/.test(a.unit) || /^[A-Za-z]/.test(a.unit)
  const core = symbolUnit ? `${a.value}${a.unit || ''}` : `${a.value} ${a.unit}`
  return a.polarity ? `${a.polarity} ${core}` : core
}

// ===== P3 number-drift precision helpers =====
// ASR-garbage spans inside ONE source turn: the union of the exact noise patterns the output-only detectors
// treat as hard failures (ASR glue 20182018/SaaSAPP, phrase/year repeats 因为因为/2018,2018年, broken fragment
// starts). A source number ATOM whose index sits inside such a span is噪音 the refine CORRECTLY cleaned — it
// must NOT read as a "missing" number drift (deleting garbage is the right edit, not a mutation). Returns
// sorted [start, end) ranges over the turn text; cheap (a handful of matches per turn). Regexes are cloned per
// call so the shared module-level lastIndex is never disturbed.
const NUMBER_GARBAGE_RES = [PHRASE_REPEAT, YEAR_REPEAT, BROKEN_FRAGMENT_START, ASR_GLUE]
function numberGarbageSpans(text) {
  const s = String(text || '')
  const spans = []
  for (const base of NUMBER_GARBAGE_RES) {
    for (const m of s.matchAll(new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g'))) {
      const i = m.index ?? 0
      spans.push([i, i + m[0].length])
    }
  }
  return spans.sort((a, b) => a[0] - b[0])
}
const inSpans = (idx, spans) => spans.some(([s, e]) => idx >= s && idx < e)

// Stutter dedup: an ASR doubling ("三十 三十" / "30 30" / "百分之六 百分之六") extracts the SAME canonical atom
// twice in a row. Collapse a run of same-key atoms separated by only a tiny gap (whitespace / a repeated number
// word, no sentence punctuation) to ONE fact, keeping the first — so the echo can neither inflate the source
// count nor read as an extra atom the refine "dropped". Two same-value atoms in DIFFERENT clauses (a comma or
// 。！？ between them) are left as-is: they are a genuine restatement, not a stutter.
function dedupStutterAtoms(atoms, text) {
  const s = String(text || '')
  const out = []
  for (const a of atoms) {
    const prev = out[out.length - 1]
    if (prev && prev.key === a.key && a.idx >= (prev.end ?? prev.idx)) {
      const gap = s.slice(prev.end ?? prev.idx, a.idx)
      if (gap.length <= ATOMS.STUTTER_GAP_MAX && !/[，。！？；、,.!?;：:]/.test(gap)) continue
    }
    out.push(a)
  }
  return out
}

// Compare source-turn atoms against the refined region. Turn-scoped: each substantive anchored source turn's
// atoms are looked for in a window of refined lines around its anchor line (± ATOMS.WINDOW_LINES); a miss there
// falls back to a document-wide check (lower confidence, so it only ever downgrades — never invents — a finding).
// Returns { assessed, sourceNumbers, refinedNumbers, drifted, driftSamples, hedgeTurnsLost, hedgeSamples,
// assessedTurns, sourceHedges, refinedHedges, perTurn } where perTurn feeds M5's section flags.
// Unit synonym families for the mutation tier (Finding 2). A same-value pair whose units fall in the SAME family
// is NOT drift (3 千米 vs 3 公里); the same value under a DIFFERENT family IS a unit mutation (3 个月 → 3 年).
// 百分点 / 个点 is deliberately its own family — a percentage-point is not the same as a percent. Among the units
// extractNumberAtoms actually attaches, only 个月/月 are synonyms; the rest document the intended equivalences and
// cover values that carry those units through other paths.
const UNIT_FAMILY = new Map([
  ['个月', '月'], ['月', '月'],
  ['千米', '公里'], ['公里', '公里'],
  ['个小时', '小时'], ['小时', '小时'],
  ['块', '元'], ['元', '元'],
  ['％', '%'], ['%', '%'],
])
const unitFamily = (u) => (u ? (UNIT_FAMILY.get(u) || u) : '')

export function checkMeaningAtoms(sourceText, refinedText) {
  const empty = {
    assessed: false, sourceNumbers: 0, refinedNumbers: 0, drifted: 0, driftSamples: [],
    driftNotes: 0, driftNoteSamples: [],
    hedgeTurnsLost: 0, hedgeSamples: [], assessedTurns: 0, sourceHedges: 0, refinedHedges: 0, perTurn: [],
  }
  const { turns, subs } = anchorTurns(sourceText, refinedText)
  if (!turns.length || !subs.length) return empty
  const refLines = refinedText.split(/\r?\n/)
  const refAllAtoms = extractNumberAtoms(refinedText)
  // Match on VALUE, not value+unit. A raw ASR transcript frequently drops or mis-attaches the unit that the
  // refine then restores (源 69.2 → 成稿 69.2%, 源 52 倍 → 成稿 252 倍), and unit-strict matching turns every such
  // asymmetry into phantom drift. The value carries the fact; polarity carries the direction — those two are what
  // we defend. A pure unit swap between two magnitudes is rarer and far noisier to flag, so it is left out this
  // pass (SOFT tier, near-zero-FP mandate). refValueSet is the doc-wide fallback; the window is value-scoped too.
  const refValueSet = new Set(refAllAtoms.map((a) => a.value))
  const sourceNumbers = subs.reduce((s, t) => s + extractNumberAtoms(t.text).length, 0)
  const refinedNumbers = refAllAtoms.length
  const sourceHedges = subs.reduce((s, t) => s + countHedges(t.text), 0)
  const refinedHedges = countHedges(refinedText)

  const driftSamples = []
  const driftNoteSamples = []
  const hedgeSamples = []
  const perTurn = []
  let drifted = 0
  let driftNotes = 0
  let hedgeTurnsLost = 0
  let assessedTurns = 0

  for (const t of subs) {
    if (!t.found || !t.anchor) continue   // no reliable region to compare against → skip (lenient)
    assessedTurns += 1
    const lo = Math.max(0, t.anchor.line - 1 - ATOMS.WINDOW_LINES)
    const hi = Math.min(refLines.length, t.anchor.line + ATOMS.WINDOW_LINES)
    const windowText = refLines.slice(lo, hi).join('\n')
    const winAtoms = extractNumberAtoms(windowText)
    const winValueSet = new Set(winAtoms.map((a) => a.value))
    const winByValue = new Map()
    for (const a of winAtoms) { if (!winByValue.has(a.value)) winByValue.set(a.value, []); winByValue.get(a.value).push(a) }
    // Turn-aware pairing precision (P3): stutter-dedup the source atoms (三十 三十 → one), and mark ASR-garbage
    // atoms + low-confidence (bag-anchored) turns. A bag-anchored turn's refined region is fuzzy — its atoms may
    // pair against UNRELATED refined content — so a miss there is a note, not a confirmed drift. Confirmed drift
    // stays reserved for shingle-anchored (high-confidence aligned) turns whose atom is genuine (non-garbage).
    const srcAtoms = dedupStutterAtoms(extractNumberAtoms(t.text), t.text)
    const gspans = numberGarbageSpans(t.text)
    const lowConf = t.matchType !== 'shingle'
    const turnDrift = []
    const turnNotes = []
    for (const sa of srcAtoms) {
      const inWindow = winValueSet.has(sa.value)
      const inDoc = refValueSet.has(sa.value)
      // route a would-be drift to the confirmed tier or the downgraded note tier
      const downgrade = inSpans(sa.idx, gspans) || lowConf
      const sink = downgrade ? turnNotes : turnDrift
      if (!inWindow && !inDoc) {
        // the number VALUE vanished from the refined output entirely → a changed or dropped number
        sink.push({ kind: 'missing', atom: sa, downgrade, foundText: windowText.replace(/\s+/g, ' ').slice(0, 50) })
        continue
      }
      // unit mutation (Finding 2): the same VALUE survived but its unit changed families (3 个月 → 3 年). Judged only
      // when the SOURCE atom carries a unit AND the value matched IN-WINDOW (a doc-wide match is too far, like the
      // polarity check below). Unit-synonym families (个月/月, 千米/公里…) are NOT drift. A value that is BARE (no unit)
      // on the refined side is NOT counted — prose reflow can drop a unit, and unit-present-vs-absent is too FP-prone
      // (this mirrors the value-only match policy: the value carries the fact, so a lone unit drop is not a mutation).
      if (sa.unit && inWindow) {
        const cands = winByValue.get(sa.value) || []
        const refUnitAtom = cands.find((ra) => ra.unit)
        const sameFamily = cands.some((ra) => ra.unit && unitFamily(ra.unit) === unitFamily(sa.unit))
        if (refUnitAtom && !sameFamily) {
          sink.push({ kind: 'unit', atom: sa, downgrade, foundText: atomLabel(refUnitAtom) })
          continue
        }
      }
      // present, but did the polarity/sign qualifier survive nearby? Only assess when the SOURCE carried one
      // and the value matched IN-WINDOW (a doc-wide match is too far to judge polarity).
      if (sa.polarity && inWindow) {
        const cands = winByValue.get(sa.value) || []
        const polarityKept = cands.some((ra) => ra.polarity === sa.polarity)
        // For sign words (亏损/盈利/涨/跌) also accept the qualifier appearing anywhere in the window text.
        const inWindowText = windowText.includes(sa.polarity)
        if (!polarityKept && !inWindowText) {
          sink.push({ kind: 'polarity', atom: sa, downgrade, foundText: (cands[0] ? `${cands[0].value}${cands[0].unit}` : windowText.replace(/\s+/g, ' ').slice(0, 40)) })
        }
      }
    }
    // hedge wipe: source turn had ≥ HEDGE_TURN_MIN hedges, yet its refined PARAGRAPH has none, while the turn
    // otherwise anchored (content kept, uncertainty stripped). Use the tighter paragraph (not the ±N window) so a
    // neighboring section's hedge can't mask a real wipe.
    const srcHedge = countHedges(t.text)
    const paraText = paragraphAround(refLines, t.anchor.line)
    const winHedge = countHedges(paraText)
    const hedgeLost = srcHedge >= ATOMS.HEDGE_TURN_MIN && winHedge === 0
    if (hedgeLost) {
      hedgeTurnsLost += 1
      hedgeSamples.push({ text: `源第 ${t.startLine} 行：${srcHedge} 处不确定语气（${HEDGE_TOKENS.filter((h) => t.text.includes(h)).slice(0, 4).join('、')}）在成稿窗口内全部消失`, line: t.startLine })
    }
    if (turnDrift.length) {
      drifted += turnDrift.length
      for (const d of turnDrift) {
        if (driftSamples.length < ATOMS.DRIFT_SAMPLES) {
          const a = d.atom
          driftSamples.push({
            text: d.kind === 'polarity'
              ? `源第 ${t.startLine} 行：“${atomLabel(a)}” 的限定词“${a.polarity}”在成稿中消失，成稿作“${d.foundText}”`
              : d.kind === 'unit'
              ? `源第 ${t.startLine} 行：“${atomLabel(a)}” 的单位在成稿中被改写，成稿作“${d.foundText}”`
              : `源第 ${t.startLine} 行：“${atomLabel(a)}” 未在成稿对应段出现（成稿作“${d.foundText}”）`,
            line: t.startLine,
          })
        }
      }
    }
    if (turnNotes.length) {
      driftNotes += turnNotes.length
      for (const d of turnNotes) {
        if (driftNoteSamples.length < ATOMS.NOTE_SAMPLES) {
          const a = d.atom
          const why = inSpans(a.idx, gspans) ? '源文该处为 ASR 噪音/粘连，精校已清理' : '所在轮次对齐置信低（改写较多）'
          driftNoteSamples.push({ text: `源第 ${t.startLine} 行：“${atomLabel(a)}” 未在成稿对应段出现，但${why}——不计漂移，仅复核`, line: t.startLine })
        }
      }
    }
    perTurn.push({ startLine: t.startLine, endLine: t.endLine, anchorLine: t.anchor.line, drift: turnDrift, notes: turnNotes, hedgeLost, srcHedge })
  }

  return {
    assessed: assessedTurns > 0,
    sourceNumbers, refinedNumbers,
    drifted, driftSamples,
    driftNotes, driftNoteSamples,
    hedgeTurnsLost, hedgeSamples,
    assessedTurns, sourceHedges, refinedHedges,
    perTurn,
  }
}

// ===== Attribution audit (M6): the SPEAKER-MISATTRIBUTION tier =====
// Coverage/atoms defend WHAT was said; this defends WHO said it. A refine can silently move a speaker's words
// under the other person's label (the 小米→智谱 class for people): a Henry answer glued onto the interviewer's
// question, or the reverse. Fully deterministic, zero model calls, and — crucially — SELF-CALIBRATING: it needs
// no external alias table. It learns each source speaker's dominant refined label from the high-confidence anchors
// themselves (发言人2 lands under "Henry" in ~99% of anchored turns → 发言人2→Henry), then flags the rare anchored
// turn whose refined-side label contradicts that learned majority. refine mode only, SOFT only.
//
// FALSE-POSITIVE controls (calibrated on three real engine outputs — the claude pair, human-verified 6/6 correct,
// must stay silent; a deepseek pair with a real Henry-answer-under-interviewer glue must fire once):
//  - HIGH-CONFIDENCE anchors only (contiguous shingle, not the rare-bigram bag): the bag fallback lands reworded
//    turns imprecisely and produced most of the raw noise.
//  - STRUCK speaker labels excluded: a source turn whose text carries a deletion-marked label (~~发言人2 14:49~~,
//    the transcriber's own on-the-fly speaker correction) has an AMBIGUOUS true speaker — the parser reads the
//    active label but the content belongs to the struck one. These both poison the majority map and masquerade as
//    mismatches, so they are dropped from BOTH the map and the flags. (This is the single biggest FP source across
//    all three engines.)
//  - FIRST / LAST turn of the doc excluded from FLAGS (still counted toward the map): opening/closing glue is a
//    known boundary-ambiguity; the spec asks to keep them but at lower confidence — we keep them for learning, not
//    for accusing.
//  - anchor ON a heading excluded: a turn whose anchor lands on a section heading straddles a boundary → skip.
//  - CORROBORATION: the flagged turn must place ≥ ATTR.MIN_CORROBORATION of its anchor shingles inside the SAME
//    refined paragraph the wrong label governs. A single shingle that merely echoes a phrase the interviewer's
//    adjacent question reused (…一家公司持续领先… appears in both the question and the answer) is NOT enough — that
//    lone echo was every remaining false positive. This corroboration ALSO subsumes the "straddles the label
//    boundary" case the spec asks to exclude: content merely glued at a label edge leaves few shingles inside the
//    wrong paragraph, whereas a genuinely misplaced turn (Henry's answer sitting in the middle of the interviewer's
//    paragraph) corroborates fully. A line/char proximity test to the label would MIS-fire on the inline
//    `名字：内容` shape (there the anchor line == the label line for the whole turn), so corroboration replaces it.
//  - short turns excluded (norm < ATTR.MIN_TURN_CHARS): too little content to attribute reliably.
export const ATTR = {
  MIN_MAP_SAMPLE: 8,       // a source speaker needs ≥ this many high-confidence anchored turns before its map is trusted
  MAJORITY_MIN: 0.8,       // …and its dominant refined label must own ≥ this fraction of them; else 'unassessable'
  MIN_TURN_CHARS: 40,      // normalized-hanzi length a turn needs before an attribution flag is worth raising
  MIN_CORROBORATION: 2,    // anchor shingles that must co-locate in the wrong-label paragraph to confirm a mismatch
  MULTI_PARTY_MIN: 3,      // ≥ this many distinct source speakers → a multi-party conversation (stricter hard bar)
  MULTI_STRONG_CORROBORATION: 3,  // multi-party hard flag: ≥ this many corroborating anchors in the wrong paragraph
  MULTI_CORROBORATION_FRACTION: 0.6, // …AND ≥ this fraction of the turn's anchors — the whole turn sits under the wrong label
}
const ATTR_LABEL_RE = /^\s*([一-龥A-Za-z0-9·]{1,12})[：:]/   // `名字：` at line start (inline OR label-on-own-line)
const ATTR_HEAD_RE = /^#{1,6}\s/
// source turn text carrying a deletion-marked speaker label near its start → true speaker ambiguous
const ATTR_STRUCK_RE = /~~[^~]{0,30}发言人[^~]{0,20}~~/

// The refined-side speaker label GOVERNING a given 1-based refined line: the nearest `名字：` at or above it.
// Stops at a heading (a heading with no label above it inside the section → no governing label). Returns
// { label, labelLine } (label null when none). Handles both the inline `名字：内容` shape and the label-on-its-
// own-line shape (`名字：` then a blank line then the content) the same way — both start with `名字：`.
function governingLabel(refLines, line1) {
  for (let i = Math.min(line1, refLines.length) - 1; i >= 0; i -= 1) {
    const raw = refLines[i]
    const m = raw.match(ATTR_LABEL_RE)
    if (m) return { label: m[1], labelLine: i + 1 }
    if (ATTR_HEAD_RE.test(raw)) return { label: null, labelLine: i + 1 }
  }
  return { label: null, labelLine: -1 }
}
// The refined PARAGRAPH containing a 1-based line, bounded by blank lines AND headings (a paragraph never spans a
// heading). Used to corroborate a mismatch: how much of the turn actually sits in the wrong-label paragraph.
function attrParagraphNorm(refLines, line1) {
  let i = Math.min(Math.max(line1 - 1, 0), refLines.length - 1)
  let lo = i, hi = i
  while (lo > 0 && refLines[lo - 1].trim() && !ATTR_HEAD_RE.test(refLines[lo - 1])) lo -= 1
  while (hi < refLines.length - 1 && refLines[hi + 1].trim() && !ATTR_HEAD_RE.test(refLines[hi + 1])) hi += 1
  return normalizeWithMap(refLines.slice(lo, hi + 1).join('\n')).norm
}

// Build the source-speaker → refined-label majority map from high-confidence anchors, then flag the anchored turns
// that contradict it. Returns { assessed, map, speakers, assessedTurns, mappedSpeakers, mismatches, samples,
// review, reviewSamples, partyCount, perTurn } — perTurn (each { startLine, endLine, anchorLine, speaker, label,
// expected, mismatch, review }) feeds M5's section flags. Leniency contract identical to coverage/atoms: no
// parseable anchors → assessed:false.
//
// P4 multi-party tolerance: with ≥ ATTR.MULTI_PARTY_MIN distinct source speakers, turn alignment drifts (the
// refined edition merges / splits turns) so a SINGLE misaligned pairing is a weak signal — every one of the four
// attribution flags on a real 4-speaker run was this artifact. So in multi-party mode a mismatch only HARD-flags
// when the wrong-label paragraph corroborates the WHOLE turn (≥ MULTI_STRONG_CORROBORATION anchors AND ≥
// MULTI_CORROBORATION_FRACTION of the turn's anchors — a genuine relabel of the entire turn); a weaker mismatch
// that merely clears the base bar drops to a warning-tier 复核 item (review) instead of accusing. A true swap
// still hard-fails (the whole answer sits under the wrong name → full corroboration). Two-party interviews (≤2
// speakers, where the check was already accurate) keep the exact prior behavior.
export function checkAttribution(sourceText, refinedText) {
  const empty = { assessed: false, map: {}, speakers: {}, assessedTurns: 0, mappedSpeakers: 0, mismatches: 0, samples: [], review: 0, reviewSamples: [], partyCount: 0, perTurn: [] }
  const { subs } = anchorTurns(sourceText, refinedText)
  if (!subs.length) return empty
  // distinct source speakers among substantive turns — the number of parties in the conversation (P4).
  const partyCount = new Set(subs.map((t) => t.speaker)).size
  const multiParty = partyCount >= ATTR.MULTI_PARTY_MIN
  const refLines = refinedText.split(/\r?\n/)
  // rarity over the same substantive source text anchorTurns used, so pickShingles reproduces the anchor shingles.
  const freq = new Map()
  let total = 0
  for (const t of subs) for (const ch of t.norm) { freq.set(ch, (freq.get(ch) || 0) + 1); total += 1 }
  const rarity = new Map()
  for (const [ch, n] of freq) rarity.set(ch, Math.log(total / n))

  // usable = high-confidence, non-struck, substantive anchored turns
  const usable = subs.filter((t) => t.found && t.matchType === 'shingle' && !ATTR_STRUCK_RE.test(t.text.slice(0, 40)))
  const firstSub = subs[0], lastSub = subs[subs.length - 1]

  // 1) tally source speaker → governing refined label (all usable turns contribute to LEARNING the map)
  const tally = {}
  for (const t of usable) {
    const g = governingLabel(refLines, t.anchor.line)
    if (!g.label) continue
    ;(tally[t.speaker] = tally[t.speaker] || {})[g.label] = (tally[t.speaker][g.label] || 0) + 1
  }
  // 2) derive the trusted map + a per-speaker assessment record
  const map = {}
  const speakers = {}
  for (const s of Object.keys(tally)) {
    const entries = Object.entries(tally[s]).sort((a, b) => b[1] - a[1])
    const sampled = entries.reduce((x, [, c]) => x + c, 0)
    const [label, count] = entries[0]
    const frac = Number((count / sampled).toFixed(3))
    const trusted = sampled >= ATTR.MIN_MAP_SAMPLE && frac >= ATTR.MAJORITY_MIN
    speakers[s] = { sampled, label, frac, trusted }
    if (trusted) map[s] = label
  }
  const mappedSpeakers = Object.keys(map).length
  if (!mappedSpeakers) return { ...empty, assessed: false, speakers, partyCount }

  // 3) flag mismatches against the trusted map (FLAGS exclude the doc's first/last turn + boundary-glue anchors)
  const samples = []
  const reviewSamples = []
  const perTurn = []
  let mismatches = 0
  let review = 0
  let assessedTurns = 0
  const mkText = (t, g, expected) => {
    const snippet = t.text.replace(/\s+/g, ' ').replace(/~~[^~]*~~/g, '').trim().slice(0, 42)
    return `源第 ${t.startLine} 行（${t.speaker}）的内容落到了成稿“${g.label}”名下（应为“${expected}”）：${snippet}`
  }
  for (const t of usable) {
    if (!(t.speaker in map)) continue
    const g = governingLabel(refLines, t.anchor.line)
    if (!g.label) continue
    const expected = map[t.speaker]
    assessedTurns += 1
    const isMismatch = g.label !== expected
    let flagged = false      // hard mismatch (attribution_mismatch)
    let reviewed = false     // warning-tier 复核 item (attribution_review) — multi-party low-confidence only
    if (isMismatch) {
      const isBoundaryTurn = t === firstSub || t === lastSub
      const onHeading = ATTR_HEAD_RE.test(refLines[t.anchor.line - 1] || '')
      const longEnough = t.norm.length >= ATTR.MIN_TURN_CHARS
      // corroboration: shingles of this turn that land inside the wrong-label paragraph
      const paraNorm = attrParagraphNorm(refLines, t.anchor.line)
      const shingles = pickShingles(t.norm, rarity)
      const corroboration = shingles.filter((w) => paraNorm.includes(w)).length
      const baseOk = !isBoundaryTurn && !onHeading && longEnough && corroboration >= ATTR.MIN_CORROBORATION
      if (baseOk) {
        // Multi-party: HARD only when the wrong-label paragraph corroborates the WHOLE turn (a genuine relabel);
        // a weaker (single-/partial-anchor) mismatch is alignment drift → 复核 warning, not an accusation.
        // Two-party: the base bar already sufficed (accurate there), so it stays hard exactly as before.
        const strong = corroboration >= ATTR.MULTI_STRONG_CORROBORATION
          && corroboration >= Math.ceil(shingles.length * ATTR.MULTI_CORROBORATION_FRACTION)
        if (!multiParty || strong) flagged = true
        else reviewed = true
      }
      if (flagged && samples.length < 12) samples.push({ text: mkText(t, g, expected), line: t.anchor.line })
      if (reviewed && reviewSamples.length < 12) reviewSamples.push({ text: `${mkText(t, g, expected)}（多方访谈·对齐存疑，请复核而非直接改）`, line: t.anchor.line })
    }
    if (flagged) mismatches += 1
    if (reviewed) review += 1
    perTurn.push({ startLine: t.startLine, endLine: t.endLine, anchorLine: t.anchor.line, speaker: t.speaker, label: g.label, expected, mismatch: flagged, review: reviewed })
  }
  return { assessed: true, map, speakers, assessedTurns, mappedSpeakers, mismatches, samples, review, reviewSamples, partyCount, perTurn }
}

// ===== Quote-integrity + entity-substitution guards (M7) =====
// M6 defends WHO said it; these two defend WHAT is inside a quote and WHICH entity a local mention names. Both
// deterministic, refine mode only, SOFT only.
export const QUOTE = {
  MIN_HANZI: 12,          // curly-quote spans shorter than this are term marks / short phrases → exempt
  BAG_GRAMS: 10,          // rarest distinct source-checked bigrams sampled from the span
  MIN_FRACTION: 0.6,      // fraction of them that must co-occur in ONE source window to call the quote grounded
  WIN_MIN: 80, WIN_PER_CHAR: 1.5, WIN_MAX: 400,   // source co-occurrence window sizing (mirrors COVERAGE.BAG_*)
  MIN_DISTINCT_GRAMS: 4,  // a span offering fewer usable rare bigrams than this is not judgeable → skip
}
export const ENTITY = {
  MAX_REFINED_OCCURRENCES: 3,  // a canonical appearing MORE than this in refined is pervasive (glossary-driven) → skip
  MIN_CANONICAL_HANZI: 2,      // sub-2-hanzi canonicals are too collision-prone to judge
  WINDOW_LINES: 6,             // refined lines each side of an occurrence's anchor = the source region checked
}

const QUOTE_SPAN_RE = /“([^”]{1,400})”/g
const NUMBERISH_BIGRAM_RE = NUMBERISH_RE   // reuse the same number-ish exclusion (数字 conversion breaks bigrams)

// Reverse-anchor one normalized span against a prebuilt bigram→positions map of the SOURCE: are ≥ minFraction of
// the span's rarest distinct bigrams co-located inside ONE bounded source window? Same sliding-window co-occurrence
// as bagMatch (O(k log k)), just aimed at the source. Returns { grounded, coLocated, need } or { grounded:null }
// when the span offers too few usable bigrams to judge. number-ish bigrams excluded (数字→阿拉伯 breaks them).
function bagCoLocated(spanNorm, rarity, positions, cfg) {
  const cand = new Map()
  for (let i = 0; i + 2 <= spanNorm.length; i += 1) {
    const g = spanNorm.slice(i, i + 2)
    if (NUMBERISH_BIGRAM_RE.test(g) || cand.has(g)) continue
    cand.set(g, (rarity.get(g[0]) || 0) + (rarity.get(g[1]) || 0))
  }
  const picked = Array.from(cand.entries()).sort((a, b) => b[1] - a[1]).slice(0, cfg.grams).map(([g]) => g)
  if (picked.length < cfg.minDistinct) return { grounded: null }
  const need = Math.ceil(picked.length * cfg.minFraction)
  const W = Math.min(cfg.winMax, Math.max(cfg.winMin, Math.round(spanNorm.length * cfg.winPerChar)))
  const events = []
  picked.forEach((g, ci) => { for (const p of positions.get(g) || []) events.push([p, ci]) })
  if (events.length < need) return { grounded: false, coLocated: 0, need }
  events.sort((a, b) => a[0] - b[0])
  const count = new Array(picked.length).fill(0)
  let distinctIn = 0, lo = 0, best = 0
  for (let hi = 0; hi < events.length; hi += 1) {
    const [p, ci] = events[hi]
    if (count[ci] === 0) distinctIn += 1
    count[ci] += 1
    while (events[lo][0] < p - W) { const cj = events[lo][1]; count[cj] -= 1; if (count[cj] === 0) distinctIn -= 1; lo += 1 }
    if (distinctIn > best) best = distinctIn
    if (distinctIn >= need) return { grounded: true, coLocated: best, need }
  }
  return { grounded: false, coLocated: best, need }
}

// Source bigram → sorted positions over the normalized source (built once, shared by both M7 checks + reused shape
// of the refined map anchorTurns builds). Also returns char rarity over the same normalized source.
function sourceBigramIndex(sourceText) {
  const norm = normalizeWithMap(sourceText).norm
  const positions = new Map()
  for (let i = 0; i + 2 <= norm.length; i += 1) {
    const g = norm.slice(i, i + 2)
    let arr = positions.get(g)
    if (!arr) { arr = []; positions.set(g, arr) }
    arr.push(i)
  }
  const freq = new Map()
  let total = 0
  for (const ch of norm) { freq.set(ch, (freq.get(ch) || 0) + 1); total += 1 }
  const rarity = new Map()
  for (const [ch, n] of freq) rarity.set(ch, Math.log(total / n))
  return { norm, positions, rarity }
}

// quote_fabrication_risk: a refined curly-quote span (“…”, ≥ QUOTE.MIN_HANZI hanzi) whose rare bigrams cannot be
// found co-located ANYWHERE in the source is a candidate manufactured quote — a polished line the model wrote and
// then quotation-marked as if the speaker said it. Short spans (term marks / brand names) are exempt. Deterministic;
// leniency contract: empty source → assessed:false. Returns { assessed, spansChecked, flagged, samples }.
export function checkQuoteFabrication(sourceText, refinedText) {
  const empty = { assessed: false, spansChecked: 0, flagged: 0, samples: [] }
  const src = sourceBigramIndex(sourceText)
  if (!src.norm.length) return empty
  const cfg = { grams: QUOTE.BAG_GRAMS, minFraction: QUOTE.MIN_FRACTION, minDistinct: QUOTE.MIN_DISTINCT_GRAMS, winMin: QUOTE.WIN_MIN, winPerChar: QUOTE.WIN_PER_CHAR, winMax: QUOTE.WIN_MAX }
  const refLines = refinedText.split(/\r?\n/)
  let spansChecked = 0, flagged = 0
  const samples = []
  for (let li = 0; li < refLines.length; li += 1) {
    const line = refLines[li]
    if (line.indexOf('“') < 0) continue
    for (const m of line.matchAll(QUOTE_SPAN_RE)) {
      const span = m[1]
      if ((span.match(/[一-龥]/g) || []).length < QUOTE.MIN_HANZI) continue   // short → exempt
      const spanNorm = normalizeWithMap(span).norm
      const res = bagCoLocated(spanNorm, src.rarity, src.positions, cfg)
      if (res.grounded === null) continue   // too few rare bigrams to judge
      spansChecked += 1
      if (res.grounded === false) {
        flagged += 1
        if (samples.length < 12) {
          samples.push({ text: `成稿第 ${li + 1} 行引号内“${span.slice(0, 36)}${span.length > 36 ? '…' : ''}”在源文中找不到对应措辞（最多只对上 ${res.coLocated}/${res.need} 个稀有二元组）——疑似炮制引语`, line: li + 1 })
        }
      }
    }
  }
  return { assessed: true, spansChecked, flagged, samples }
}

// entity_substitution_risk: the 小米→智谱 class for named entities. For a glossary canonical present in the refined
// text, if the anchored SOURCE region for that occurrence contains neither the canonical, nor any of its variants,
// nor a plausible ASR-garble of it, the mention may be an unauthorized substitution (a different company/product
// name swapped in). VERY FP-prone, so deliberately conservative: only high-confidence anchored regions, canonicals
// ≥ ENTITY.MIN_CANONICAL_HANZI hanzi, and canonicals appearing ≤ ENTITY.MAX_REFINED_OCCURRENCES times in the
// refined text (a pervasive term is glossary-driven by design, not a local swap). Because a real 校对表 may not
// render in the `- **正字** ← 变体` shape parseGlossaryLite expects (some engines emit tables / reverse arrows),
// this check is only as strong as the parsed canonicals; when the glossary yields none, it is silently dormant.
// Off by default behind `strict` when calibration can't keep it quiet — see the wiring in auditPair. Returns
// { assessed, canonicalsChecked, flagged, samples }.
export function checkEntitySubstitution(sourceText, refinedText, glossary) {
  const empty = { assessed: false, canonicalsChecked: 0, flagged: 0, samples: [] }
  const entries = (glossary && glossary.entries) || []
  if (!entries.length) return empty
  // hanzi-only source text (+ norm→line map) for a cheap substring presence test inside a windowed region
  const srcHanByLine = normalizeWithMap(sourceText)
  if (!srcHanByLine.norm.length) return empty
  const { subs } = anchorTurns(sourceText, refinedText)
  const refLines = refinedText.split(/\r?\n/)
  let canonicalsChecked = 0, flagged = 0
  const samples = []
  for (const e of entries) {
    const canon = e.canonical
    if ((canon.match(/[一-龥]/g) || []).length < ENTITY.MIN_CANONICAL_HANZI) continue   // sub-2-hanzi → skip (collision-prone)
    // count refined occurrences; a pervasive canonical is glossary-driven, not a local swap
    const occ = []
    for (let li = 0; li < refLines.length; li += 1) { let idx = refLines[li].indexOf(canon); while (idx >= 0) { occ.push({ line: li + 1 }); idx = refLines[li].indexOf(canon, idx + canon.length) } }
    if (!occ.length || occ.length > ENTITY.MAX_REFINED_OCCURRENCES) continue
    // the set of forms the source is allowed to contain to "support" this canonical: canonical + variants (hanzi
    // ones checked as substrings; latin variants are ASR-noise-prone so we treat any hanzi variant as support).
    const supportForms = [canon, ...e.variants].filter((v) => (v.match(/[一-龥]/g) || []).length >= 2)
    canonicalsChecked += 1
    for (const o of occ) {
      // find the source turn anchored nearest this refined occurrence line (high-confidence only)
      let best = null
      for (const t of subs) { if (t.found && t.matchType === 'shingle') { const d = Math.abs(t.anchor.line - o.line); if (!best || d < best.d) best = { t, d } } }
      if (!best || best.d > ENTITY.WINDOW_LINES) continue   // no high-confidence anchor near this occurrence → can't judge
      // source region = the anchored turn's source line span, as hanzi-only text
      const t = best.t
      const regionHan = sliceSourceHan(srcHanByLine, t.startLine, t.endLine)
      const supported = supportForms.some((f) => regionHan.includes(f)) || plausibleGarblePresent(canon, regionHan)
      if (!supported) {
        flagged += 1
        if (samples.length < 12) {
          samples.push({ text: `成稿第 ${o.line} 行出现“${canon}”，但其对应源文段（源 L${t.startLine}-${t.endLine}）里既无“${canon}”也无其已知写法——疑似实体被替换`, line: o.line })
        }
      }
    }
  }
  return { assessed: canonicalsChecked > 0, canonicalsChecked, flagged, samples }
}

// hanzi-only slice of the SOURCE between two 1-based source line numbers, using the norm→line map so it aligns with
// how anchors are computed. Cheap and allocation-light (the map is built once by the caller).
function sliceSourceHan(normMap, startLine, endLine) {
  const { norm, lineOf } = normMap
  let out = ''
  for (let i = 0; i < norm.length; i += 1) { const ln = lineOf[i]; if (ln >= startLine && ln <= endLine) out += norm[i] }
  return out
}
// A very conservative ASR-garble presence heuristic for a hanzi canonical: does the source region contain a run
// sharing ≥ half of the canonical's characters in order (subsequence)? Only used to AVOID false substitution flags
// (it can only mark a canonical as SUPPORTED, never as swapped), so erring toward "supported" is safe.
function plausibleGarblePresent(canon, regionHan) {
  const chars = (canon.match(/[一-龥]/g) || [])
  if (chars.length < 2) return false
  let hit = 0
  for (const c of chars) if (regionHan.includes(c)) hit += 1
  return hit / chars.length >= 0.5
}

// ===== Per-section operator review checklist (M5) =====
// auditPair returns sections[]: one entry per ## heading of the refined doc, carrying every issue localizable to
// that section so a human can jump straight to the risky stretches instead of re-reading the whole file. Reuses
// the SAME section-detection + source-range logic annotateAnchors uses (headings, section body span, matched
// turns → sectionRange), so a section's reported source range stays in lock-step with its anchor comment. A
// section with an empty flags[] is a trusted section (rendered only in the count, not the checklist).
const M5_HEADING_RE = /^##\s+/
// Heading-level fallback (micro-fix): sectioning defaults to `## `, but real outputs vary. Two failures seen:
// (a) a doc with a full nested hierarchy (5 band-level `## `, 16 leaf `#### `) collapsed into 5 GIANT pseudo-
// sections spanning hundreds of lines each — the reader-meaningful granularity was the `#### ` leaves; (b) a doc
// with < 3 `## ` at all but ≥ 3 of a deeper level had almost no sectioning. Rule: pick the heading level (2..6)
// with the MOST headings, but only let a DEEPER level override `## ` when it has strictly MORE headings than `## `
// (a deeper level being denser is the signal that `## ` is merely band-level). H1 `# ` is never used for
// sectioning (it is the doc title / part banner). This keeps a normal `## `-sectioned doc on `## ` (its 23 `## `
// out-number its 5 `### `), keeps an 18-`## ` doc on `## ` (18 > 17 `### `), and moves the 5/10/16 hierarchy onto
// its 16 `#### ` leaves. Returns a fresh anchored regex matching exactly the chosen level.
const SECTION_MIN_HEADINGS = 3
export function detectHeadingRegex(refinedText) {
  const lines = String(refinedText || '').split(/\r?\n/)
  const count = (n) => lines.filter((l) => new RegExp(`^#{${n}}\\s+`).test(l)).length
  const h2 = count(2)
  // deeper level with the most headings (tie → shallower, i.e. closer to ## )
  let best = null
  for (let n = 3; n <= 6; n += 1) {
    const c = count(n)
    if (c >= SECTION_MIN_HEADINGS && (!best || c > best.c)) best = { n, c }
  }
  // Override ## only when a deeper level is BOTH eligible and strictly denser than ## (band-level ## signal).
  if (best && best.c > h2) return new RegExp(`^#{${best.n}}\\s+`)
  return /^##\s+/   // normal case: ## is as dense as anything deeper (may yield 0 sections, which callers handle)
}

export function buildSections(sourceText, refinedText, { atoms = null, coverage = null, glossary = null, attribution = null } = {}) {
  const lines = refinedText.split(/\r?\n/)
  const HEADING_RE = detectHeadingRegex(refinedText)
  const headIdx = lines.map((l, i) => (HEADING_RE.test(l) ? i : -1)).filter((i) => i >= 0)
  if (!headIdx.length) return []
  const { subs } = anchorTurns(sourceText, refinedText)
  // ghost/yin hits carry a refined line already — bucket by section via line ranges.
  const ghostHits = glossary ? checkGhostName(refinedText, glossary).samples : []
  const yinHits = glossary ? checkMissingYin(refinedText, glossary).samples : []
  const sections = []
  for (let k = 0; k < headIdx.length; k += 1) {
    const h = headIdx[k]
    const title = lines[h].replace(HEADING_RE, '').trim()
    // Section span is the heading's own 1-based line through the line before the next heading. Include the
    // heading line itself: refined headings carry hanzi (## 海外扩张), so a turn's anchor legitimately lands on
    // the heading rather than the first body line — counting from `h+1` keeps that turn inside its section.
    const from = h + 1   // 1-based, heading line inclusive
    const to = k + 1 < headIdx.length ? headIdx[k + 1] : lines.length
    const refinedLines = { start: h + 1, end: to }
    const matched = subs.filter((t) => t.found && t.anchor.line >= from && t.anchor.line <= to)
    const range = matched.length ? sectionRange(matched) : null
    const flags = []
    // number_drift / hedge_loss localized by the anchor line of each per-turn record
    if (atoms && atoms.assessed) {
      const inHere = (aln) => aln >= from && aln <= to
      const driftHere = atoms.perTurn.filter((p) => inHere(p.anchorLine) && p.drift.length)
      const driftCount = driftHere.reduce((s, p) => s + p.drift.length, 0)
      if (driftCount) {
        const sample = driftHere.flatMap((p) => p.drift).slice(0, 2).map((d) => atomLabel(d.atom)).join('、')
        flags.push({ kind: 'number_drift', count: driftCount, sample })
      }
      const hedgeHere = atoms.perTurn.filter((p) => inHere(p.anchorLine) && p.hedgeLost).length
      if (hedgeHere) flags.push({ kind: 'hedge_loss', count: hedgeHere })
    }
    // attribution_mismatch localized by the anchor line of each flagged per-turn record
    if (attribution && attribution.assessed) {
      const attrHere = attribution.perTurn.filter((p) => p.mismatch && p.anchorLine >= from && p.anchorLine <= to)
      if (attrHere.length) flags.push({ kind: 'attribution_mismatch', count: attrHere.length, sample: attrHere.map((p) => `${p.speaker}→${p.label}`).slice(0, 2).join('、') })
      const attrReview = attribution.perTurn.filter((p) => p.review && p.anchorLine >= from && p.anchorLine <= to)
      if (attrReview.length) flags.push({ kind: 'attribution_review', count: attrReview.length, sample: attrReview.map((p) => `${p.speaker}→${p.label}`).slice(0, 2).join('、') })
    }
    // content_gap_soft / scattered loss whose source range overlaps this section's matched source range
    if (coverage && coverage.assessed && range) {
      const soft = (coverage.gaps || []).filter((g) => g.severity === 'soft' && g.startLine <= range.endLine && g.endLine >= range.startLine)
      if (soft.length) flags.push({ kind: 'content_gap_soft', count: soft.length })
    }
    // unverified （音） names present in this section (ghost/yin sample lines are 1-based refined body lines)
    const ghostN = ghostHits.filter((s) => s.line >= from && s.line <= to).length
    const yinN = yinHits.filter((s) => s.line >= from && s.line <= to).length
    if (ghostN) flags.push({ kind: 'ghost_name', count: ghostN })
    if (yinN) flags.push({ kind: 'missing_yin', count: yinN })
    // weak / no anchor: substantive-looking section body (has anchorable content nearby) yet no matched turns
    if (!matched.length) flags.push({ kind: 'weak_anchor', count: 1 })
    sections.push({
      title,
      refinedLines,
      sourceRange: range ? { startLine: range.startLine, endLine: range.endLine } : null,
      ts: range ? range.ts : null,
      flags,
    })
  }
  return sections
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
  // Same heading-level fallback as buildSections: a doc that sub-sections with #### (few ## band headers) gets
  // anchors on the #### headings, so 复核清单 and 源锚点 stay in lock-step at the granularity a reader actually sees.
  const HEADING_RE = detectHeadingRegex(refinedText)
  const headIdx = lines.map((l, i) => (HEADING_RE.test(l) ? i : -1)).filter((i) => i >= 0)
  if (!headIdx.length) return { text: refinedText, updated: [], skipped: [] }
  const { subs } = anchorTurns(sourceText, refinedText)
  const updated = [], skipped = []
  // reverse order so insertions never shift earlier heading indices
  for (let k = headIdx.length - 1; k >= 0; k -= 1) {
    const h = headIdx[k]
    const title = lines[h].replace(HEADING_RE, '').trim()
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
    const found = matches(c.pattern, text, STUTTER_LEXICAL_GUARD[c.name])
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
export function auditPair({ sourceText, refinedText, sourceFile = '<source>', refinedFile = '<refined>', mode = 'refine', glossaryText = null, strict = false }) {
  sourceText = normalizeTranscriptSource(sourceText, { sourceFile })
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
  // M4 mutation tier: number-atom + hedge fidelity. refine mode only (a summary/timeline legitimately drops
  // qualifiers). All-soft; SOFT findings never enter failed[] this pass (see below).
  const atoms = mode === 'refine' ? checkMeaningAtoms(sourceText, refinedText) : null
  // M6 attribution tier: speaker-misattribution via a self-calibrated majority map. refine mode only (a summary /
  // timeline / logic draft has no per-turn labels to defend). SOFT only.
  const attribution = mode === 'refine' ? checkAttribution(sourceText, refinedText) : null
  // M7 quote-integrity guard: manufactured-quote detection. refine mode only, SOFT. Reliably quiet on faithful
  // quotes (verified on real pairs), so it is default-on.
  const quoteFab = mode === 'refine' ? checkQuoteFabrication(sourceText, refinedText) : null
  // P6 within-document numeric consistency: the SAME measured quantity stated twice with conflicting numbers in
  // the 成稿 itself. Warning tier only (never a gate); cheap + deterministic, so it runs on every refine.
  const numericConsistency = mode === 'refine' ? checkNumericConsistency(refinedText) : null

  const metrics = {
    sourceChars: sChars, refinedChars: rChars, charRatio,
    sourceTurns: sTurns, refinedTurns: rTurns, speakerTurnRatio, // turnRatio is confirming-only, never an independent gate
    sourceEmptyDensity: Number(sEmptyDensity.toFixed(4)), refinedEmptyDensity: Number(rEmptyDensity.toFixed(4)), emptyReduction,
    endingCovered: ending,
    coverage: { assessed: coverage.assessed, turnsSubstantive: coverage.turnsSubstantive, turnsLost: coverage.turnsLost, lostChars: coverage.lostChars, lostRatio: coverage.lostRatio },
    ...(atoms ? { atoms: { sourceNumbers: atoms.sourceNumbers, refinedNumbers: atoms.refinedNumbers, drifted: atoms.drifted, driftNotes: atoms.driftNotes, hedgeTurnsLost: atoms.hedgeTurnsLost, assessed: atoms.assessed } } : {}),
    ...(attribution ? { attribution: { assessed: attribution.assessed, mapped: attribution.mappedSpeakers, mismatches: attribution.mismatches, review: attribution.review, partyCount: attribution.partyCount } } : {}),
    ...(quoteFab ? { quotes: { assessed: quoteFab.assessed, spansChecked: quoteFab.spansChecked, flagged: quoteFab.flagged } } : {}),
    ...(numericConsistency ? { numericConsistency: { conflicts: numericConsistency.conflicts.length } } : {}),
  }

  // Editorial deterministic checks (typesetting + glossary residue). quote_style is HARD → it opens its own
  // gate; the rest are soft findings only. ghost_name/missing_yin need a glossary — parsed leniently here.
  const glossary = parseGlossaryLite(glossaryText)
  const quoteFindings = checkQuoteStyle(refinedText)
  const speakerFindings = checkSpeakerLabelStyle(refinedText)
  const ghostFinding = checkGhostName(refinedText, glossary)
  const yinFinding = checkMissingYin(refinedText, glossary)
  const quoteHard = quoteFindings.find((f) => f.name === 'quote_style')
  // M7 entity-substitution guard: the 小米→智谱 class. FP-prone on real transcripts (heavy ASR garbling +
  // merged turns make the source-region check unreliable), so it is OPT-IN behind `strict` (default off) per the
  // spec's escape hatch. When off it is fully dormant. refine mode only, SOFT.
  const entitySub = (strict && mode === 'refine') ? checkEntitySubstitution(sourceText, refinedText, glossary) : null

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
    // M4 mutation-tier findings — SOFT ONLY this pass (deliberately NOT added to gates/failed[]; promotion to
    // hard waits until real-world FP data accumulates). number_drift: a source number atom absent from the
    // refined region (changed / dropped) or present with its polarity qualifier stripped (不到 30%→30%, 亏 2 亿→
    // 2 亿). hedge_loss: turns whose ≥2 uncertainty markers were all wiped though the content otherwise anchored.
    ...(atoms && atoms.assessed ? [
      { name: 'number_drift', severity: 'soft', count: atoms.drifted, samples: atoms.driftSamples },
      { name: 'hedge_loss', severity: 'soft', count: atoms.hedgeTurnsLost,
        samples: atoms.hedgeSamples.concat(atoms.hedgeTurnsLost ? [{ text: `全篇不确定语气密度：源 ${atoms.sourceHedges} 处 → 成稿 ${atoms.refinedHedges} 处`, line: 1 }] : []) },
    ] : []),
    // P3 downgraded drift: source numbers absent from the成稿 that sit in ASR-garbage spans or low-confidence
    // aligned turns — the refine likely cleaned噪音 rather than mutating a fact. Listed for review, never a drift.
    ...(atoms && atoms.assessed && atoms.driftNotes ? [
      { name: 'number_drift_note', severity: 'soft', count: atoms.driftNotes, samples: atoms.driftNoteSamples },
    ] : []),
    // M6 attribution-tier finding — SOFT ONLY (a mislabeled speaker is a review flag, not a hard gate this pass).
    // attribution_mismatch: a high-confidence anchored turn whose refined-side label contradicts the self-learned
    // majority map for its source speaker (Henry's answer sitting under the interviewer's label, or vice versa).
    ...(attribution && attribution.assessed ? [
      { name: 'attribution_mismatch', severity: 'soft', count: attribution.mismatches, samples: attribution.samples },
    ] : []),
    // P4 multi-party 复核 tier: a low-confidence attribution mismatch (a single misaligned pairing in a ≥3-party
    // conversation) — surfaced for human review rather than accused as a hard mismatch. Present only when non-empty.
    ...(attribution && attribution.assessed && attribution.review ? [
      { name: 'attribution_review', severity: 'soft', count: attribution.review, samples: attribution.reviewSamples },
    ] : []),
    // M7 quote-integrity finding — SOFT ONLY. quote_fabrication_risk: a refined curly-quote span whose rare bigrams
    // are absent from the source everywhere (a polished line quotation-marked as if spoken).
    ...(quoteFab && quoteFab.assessed ? [
      { name: 'quote_fabrication_risk', severity: 'soft', count: quoteFab.flagged, samples: quoteFab.samples },
    ] : []),
    // M7 entity-substitution finding — SOFT ONLY, only present when strict is on (default off; see above).
    ...(entitySub && entitySub.assessed ? [
      { name: 'entity_substitution_risk', severity: 'soft', count: entitySub.flagged, samples: entitySub.samples },
    ] : []),
    // P6 within-document numeric consistency — SOFT ONLY, present only when a conflict is found. The same measured
    // quantity stated twice with disjoint numbers in the 成稿 (毛利率 30% here / 45% there) → a 复核 review item.
    ...(numericConsistency && numericConsistency.conflicts.length ? [
      { name: 'numeric_inconsistency', severity: 'soft', count: numericConsistency.conflicts.length,
        samples: numericConsistency.conflicts.slice(0, 12).map((c) => ({
          text: `“${c.keyNoun}”在本文出现互相矛盾的数值：${c.values.map((v) => `第 ${v.line} 行作“${atomLabel({ value: v.value, unit: c.unit })}”`).join('，')}——请对照录音确认`,
          line: c.values[0] ? c.values[0].line : 1,
        })) },
    ] : []),
  ])
  // M5 per-section review checklist: one entry per ## section of the refined doc, flags aggregate everything
  // localizable to it (number_drift / hedge_loss / content_gap_soft / ghost_name / missing_yin / weak_anchor).
  const sections = buildSections(sourceText, refinedText, { atoms, coverage, glossary, attribution })
  return { file: out.file, mode, status: failed.length ? 'fail' : 'ok', failed, metrics, long_paragraphs: out.long_paragraphs, findings, gaps: coverage.gaps, modelMarkers: coverage.modelMarkers, sections, numericConflicts: numericConsistency ? numericConsistency.conflicts : [] }
}

// Compare the logic-ordered draft (逻辑稿) against the refined 成稿: it must stay reasonably sized, carry source
// provenance for every refined section, and show real reordering when a logic稿 is produced. Size/duplicate findings
// remain soft; fake same-order logic稿 and missing section provenance are hard.
export function auditLogicPair(refinedText, logicText, { refinedFile = '<refined>', logicFile = '<logic>' } = {}) {
  const rChars = hanzi(refinedText)
  const lChars = hanzi(logicText)
  const order = checkLogicOrder(refinedText, logicText)
  const coverage = checkLogicSectionCoverage(refinedText, logicText)
  const findings = checkLogicSize(refinedText, logicText).concat(order.finding, coverage.findings)
  const failed = findings.filter((f) => f.severity === 'hard' && f.count).map((f) => f.name)
  return {
    file: logicFile, mode: 'logic', status: failed.length ? 'fail' : 'ok', failed,
    metrics: { refinedFile, refinedChars: rChars, logicChars: lChars, sizeRatio: rChars ? Number((lChars / rChars).toFixed(3)) : 1, ...order.metrics, ...coverage.metrics },
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
    strict: !!p.strict,   // opt-in entity_substitution_risk
  }))
  return { status: files.some((f) => f.status === 'fail') ? 'fail' : 'ok', files }
}

// ============================================================================
// M8 — cross-file claim consistency (batch-level, deterministic, ZERO model calls)
// ----------------------------------------------------------------------------
// The gap: two files in ONE batch can state the SAME fact with DIFFERENT numbers and every per-file gate passes
// (each file is internally faithful to its own source — the audit compares a refined file only against ITS source,
// never against a sibling file). checkCrossFileClaims is a pure, append-only cross-check over a whole batch's
// refined texts: it extracts (entity, number-atom) pairs per file — reusing extractNumberAtoms (the M4 number
// atoms: value + unit + polarity, writing-system-normalized) — associates each atom with the ONE unambiguous
// entity in a small char window, and flags an entity+unit-class that carries MATERIALLY different values across
// files. It is deliberately conservative (near-zero false positives): a flag is only raised when association is
// unambiguous, both sides carry a unit, and the values genuinely conflict (range overlap and scalar==range-endpoint
// are NOT conflicts; 30 vs 30.0 is not a conflict — extractNumberAtoms already canonicalizes both to "30").
// Wired at the batch level in universal/jobs.js (which has every refined file + the glossary); the Claude Code
// edition's core/pipeline.js runs in a no-fs sandbox and cannot read the refined files back, so M8 is universal-only
// (documented in claude-code-skill/references/return-handling.md).
export const XFILE = {
  WINDOW: 24,          // chars each side of a number atom scanned for an associating entity token
  MIN_LATIN_LEN: 2,    // a capitalized/Latin candidate entity must be ≥ this many chars (drops "A轮"/"5G" noise)
  MAX_SNIPPET: 60,     // per-value snippet length in a conflict record
  MAX_VALUES: 8,       // cap on distinct values reported per conflict (runaway guard)
}

// Parse a canonical atom value string (already normalized by extractNumberAtoms: a scalar "2019"/"30" or a range
// "60-70") into { lo, hi } numbers. A scalar becomes lo==hi. Returns null if it isn't a clean numeric form.
function xfileValueSpan(value) {
  const s = String(value == null ? '' : value).trim()
  const rng = s.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/)
  if (rng) { const lo = Number(rng[1]), hi = Number(rng[2]); if (Number.isFinite(lo) && Number.isFinite(hi)) return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) } }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) { const v = Number(s); if (Number.isFinite(v)) return { lo: v, hi: v } }
  return null
}
// Two canonical values MATERIALLY conflict iff their spans are DISJOINT (no overlap). This single rule subsumes
// every "do not flag" case the spec names: identical scalars overlap (30 vs 30.0 → both "30" → overlap → no flag);
// a scalar inside a range overlaps (60-70 vs 65 → [65,65]⊂[60,70] → overlap → no flag); a scalar at a range
// endpoint overlaps (60-70 vs 60 → overlap → no flag); two overlapping ranges do not flag. Only genuinely
// separated values (2019 vs 2020, 60-70 vs 80) are disjoint → a real conflict.
function xfileValuesConflict(a, b) {
  const sa = xfileValueSpan(a), sb = xfileValueSpan(b)
  if (!sa || !sb) return false
  return sa.hi < sb.lo || sb.hi < sa.lo   // disjoint ⇒ conflict
}

// All occurrence start-indices of `needle` in `hay` (non-overlapping, plain substring). Used to place entity
// tokens on a line so a number atom can find the entity(ies) within its window.
function xfileOccurrences(hay, needle) {
  const out = []
  if (!needle) return out
  let i = 0
  while ((i = hay.indexOf(needle, i)) >= 0) { out.push(i); i += needle.length }
  return out
}

// Build the candidate-entity index for ONE line: glossary canonicals that occur on the line, plus capitalized
// Latin runs (e.g. a fictional product code "GX200"). Each candidate is { name, positions:[startIdx…] }. Latin
// candidates are lower-noise-gated by length; a Latin run that is a substring of a matched glossary canonical is
// dropped (the glossary name is the more specific association). De-duped by name.
function xfileLineCandidates(line, glossaryCanonicals) {
  const byName = new Map()
  const add = (name, positions) => { if (!name || !positions.length) return; const prev = byName.get(name); if (prev) prev.positions.push(...positions); else byName.set(name, { name, positions: [...positions] }) }
  for (const g of glossaryCanonicals || []) { const name = String(g || '').trim(); if (!name) continue; const pos = xfileOccurrences(line, name); if (pos.length) add(name, pos) }
  // Capitalized/Latin tokens (start uppercase, ≥ MIN_LATIN_LEN alphanumerics) — a lightweight entity signal when
  // the glossary is thin. Skip one already covered as a substring of a matched glossary canonical.
  const gnames = Array.from(byName.keys())
  for (const m of line.matchAll(/[A-Z][A-Za-z0-9]{1,}/g)) {
    const tok = m[0]
    if (tok.length < XFILE.MIN_LATIN_LEN) continue
    if (gnames.some((gn) => gn.includes(tok))) continue
    add(tok, [m.index ?? 0])
  }
  return Array.from(byName.values())
}

// The ONE unambiguous entity for an atom at char offset `idx` on a line: an entity is a candidate if any of its
// occurrences falls within ±XFILE.WINDOW of idx. If exactly ONE DISTINCT candidate name qualifies → return it;
// zero or ≥2 distinct names → null (ambiguous; the atom is dropped, per the conservative contract).
function xfileAssociate(idx, candidates) {
  const near = []
  for (const c of candidates) {
    if (c.positions.some((p) => Math.abs(p - idx) <= XFILE.WINDOW)) near.push(c.name)
  }
  const distinct = Array.from(new Set(near))
  return distinct.length === 1 ? distinct[0] : null
}

// Blank a leading speaker label so the SPEAKER's name is never mistaken for the entity a number is about. The
// refined format is `名字：内容` (a short label + full-width colon at line start, RULES 1). Without this, the
// label name (often itself a glossary canonical) sits within the window of an early atom and makes EVERY such
// atom's association ambiguous (2 candidates) → the whole check would silently find nothing. We replace the label
// span (up to and incl. the first 全角冒号, only when it is short and near line start) with spaces so char offsets
// stay aligned for extractNumberAtoms + candidate positions. A 半角: is left alone (it is not the label form and
// commonly appears mid-sentence, e.g. a ratio). Markdown 小标题 (`## …`) lines carry no label and pass through.
function xfileStripLabel(line) {
  const c = line.indexOf('：')
  if (c < 0 || c > 12) return line                 // no 全角冒号, or too far in to be a label
  const label = line.slice(0, c)
  if (/[\s，。；？！,.;?!]/.test(label)) return line // real prose punctuation inside → not a bare label
  return ' '.repeat(c + 1) + line.slice(c + 1)
}

// checkCrossFileClaims(files, glossaryCanonicals):
//   files = [{ label, sourceText?, refinedText }]  — sourceText is accepted for signature parity but the cross-check
//     runs on refinedText (the shipped artifact; that is where a cross-file discrepancy actually lands).
//   glossaryCanonicals = string[] — the per-company 校对表 canonical names, passed in for entity association
//     (parseGlossaryLite(...).entries.map(e => e.canonical) at the call site).
// Returns { conflicts } where each conflict = { entity, unit, values:[{label, value, line, snippet}…] }: the SAME
// entity + SAME unit-class carrying disjoint values in ≥2 DIFFERENT files. `unit` is the canonical atom unit
// (''=no unit); a conflict requires a NON-empty unit on both sides (a bare unitless count is too ambiguous to
// cross-compare). Pure and order-stable.
export function checkCrossFileClaims(files, glossaryCanonicals = []) {
  const list = (files || []).filter((f) => f && typeof f.refinedText === 'string' && f.refinedText.trim())
  if (list.length < 2) return { conflicts: [] }
  // key = `${entity}\u0000${unit}` → Map(fileLabel → { label, value, line, snippet }). One observation per
  // (entity, unit, file): the FIRST occurrence in that file wins (stable, and keeps the snippet deterministic).
  // A per-file value that is internally inconsistent (same entity+unit stated two ways within ONE file) is out of
  // M8's scope — that is a single-file audit concern — so we only record the first and compare ACROSS files.
  const table = new Map()
  for (const f of list) {
    const label = f.label || '(未命名)'
    const lines = String(f.refinedText).split(/\r?\n/)
    const seenInFile = new Set()   // `${entity}\u0000${unit}` already recorded for THIS file
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li]
      if (!line || !line.trim()) continue
      const scan = xfileStripLabel(line)   // speaker label blanked (offsets preserved) so it can't self-associate
      const atoms = extractNumberAtoms(scan)
      if (!atoms.length) continue
      const candidates = xfileLineCandidates(scan, glossaryCanonicals)
      if (!candidates.length) continue
      for (const a of atoms) {
        if (!a.unit) continue                                  // both sides must carry a unit — skip unitless
        const entity = xfileAssociate(a.idx, candidates)
        if (!entity) continue                                  // ambiguous / no entity in window → skip
        const key = `${entity}\u0000${a.unit}`
        if (seenInFile.has(key)) continue                      // first occurrence per file only
        seenInFile.add(key)
        if (!table.has(key)) table.set(key, new Map())
        const perFile = table.get(key)
        if (perFile.has(label)) continue                       // (defensive) one obs per file
        const snippet = line.trim().slice(0, XFILE.MAX_SNIPPET)
        perFile.set(label, { label, value: a.value, line: li + 1, snippet })
      }
    }
  }
  const conflicts = []
  for (const [key, perFile] of table) {
    const obs = Array.from(perFile.values())
    if (obs.length < 2) continue                               // need ≥2 different files
    // Conflict iff at least one pair of observations carries disjoint values. (All values agreeing → no conflict.)
    let conflict = false
    for (let i = 0; i < obs.length && !conflict; i += 1) for (let j = i + 1; j < obs.length; j += 1) { if (xfileValuesConflict(obs[i].value, obs[j].value)) { conflict = true; break } }
    if (!conflict) continue
    const [entity, unit] = key.split('\u0000')
    conflicts.push({ entity, unit, values: obs.slice(0, XFILE.MAX_VALUES) })
  }
  return { conflicts }
}

// ============================================================================
// P6 — within-document numeric consistency (single-file, deterministic, ZERO model calls, WARNING tier only)
// ----------------------------------------------------------------------------
// M8 catches the SAME quantity carrying different values ACROSS files. This catches it WITHIN one document: an
// interviewee (or a derivative) states the same measured quantity twice with conflicting numbers (毛利率 30% here,
// 毛利率 45% there) and every other gate passes. Deterministic, reuses the M4 number atoms + the M8 disjoint-span
// conflict rule. Deliberately conservative (a warning that must not drown the 复核清单):
//   · only EXACT, UNQUALIFIED values compare — an atom carrying ANY polarity/estimate qualifier (约/不到/超过/
//     左右…) or sitting next to a hedge (大概/可能/估计…) is a bound/estimate, not a stated fact, and is skipped
//     (so 不到 30% never "conflicts" with 28%).
//   · a quantity is keyed by (measured-noun, unit): the noun is the trailing 汉字 run right before the number
//     (a few chars), so a conflict needs the SAME noun AND SAME unit — 毛利率 30% vs 净利率 45% do NOT conflict.
//   · both sides must carry a unit (a bare count is too ambiguous), and values must be genuinely DISJOINT
//     (xfileValuesConflict: 30 vs 30.0 / a scalar inside a range are NOT conflicts).
// NEVER hard-fails; capped at NUMERIC_CONSISTENCY.MAX_CONFLICTS (most-specific noun first). Pure, order-stable.
// (The considered duration-vs-date-span sub-check — "18 个月" against a start/end date implying 28 — was dropped:
//  founding years and unrelated durations co-occur constantly, so it was too false-positive-prone to ship. The
//  repeated-quantity conflict is the reliable core.)
export const NUMERIC_CONSISTENCY = {
  KEYNOUN_MAX: 8,      // max 汉字 of the measured-noun context captured before a number
  KEYNOUN_MIN: 2,      // a noun shorter than this is too generic to group on
  WINDOW: 12,          // chars before a number scanned for the noun + any hedge/estimate marker
  MAX_CONFLICTS: 10,   // cap on review items (most-specific noun first) so the 复核清单 can't be drowned
  SNIPPET: 60,
}
// Near a number these mark it as an estimate/bound, not an exact stated fact → the atom is skipped.
const NUMERIC_APPROX_NEAR = /约|左右|上下|接近|将近|大约|大概|差不多|可能|估计|也许|或许|至少|最多|起码|将近|好几|几十|上百|上千/

// Trailing copula / connector particles peeled off a measured-noun key so equivalent copula wording keys to the
// SAME quantity (毛利率为 / 毛利率是 / 增长率达到 → 毛利率 / 增长率). Conservative list; a char is peeled ONLY when it
// is the last char of the run AND the remainder stays ≥ 2 chars (never strip to empty or a single ambiguous char).
const KEYNOUN_COPULA_TAIL = new Set(['为', '是', '约', '达', '到', '在', '有', '共', '计', '至', '近', '超', '逾'])
// Shared measured-noun extraction — used by BOTH checkNumericConsistency (P6, within-doc conflicts) and the P1
// derivative_context_review, so both group a quantity by the same key. Given the text immediately BEFORE a number,
// return the noun key: the trailing 汉字 run (Pangu space trimmed), capped at KEYNOUN_MAX, with trailing copulas
// peeled. Returns '' when there is no 汉字 run or the result is shorter than KEYNOUN_MIN.
function measuredNounKey(before) {
  const m = String(before || '').replace(/\s+$/, '').match(/[一-龥]+$/)
  if (!m) return ''
  let noun = m[0].slice(-NUMERIC_CONSISTENCY.KEYNOUN_MAX)
  while (noun.length >= 3 && KEYNOUN_COPULA_TAIL.has(noun[noun.length - 1])) noun = noun.slice(0, -1)
  return noun.length >= NUMERIC_CONSISTENCY.KEYNOUN_MIN ? noun : ''
}

// checkNumericConsistency(text): the SAME (measured-noun, unit) carrying DISJOINT exact values ≥2 times in ONE
// document. Returns { conflicts } where each = { keyNoun, unit, values:[{ value, line, snippet }…] }.
export function checkNumericConsistency(text) {
  const lines = String(text || '').split(/\r?\n/)
  const groups = new Map()   // `${keyNoun} ${unit}` → [{ value, line, snippet }]
  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li]
    if (!raw || !raw.trim()) continue
    if (/^\s*#{1,6}\s|^\s*>|^\s*<!--/.test(raw)) continue        // headings / blockquotes / comments are not prose
    const line = xfileStripLabel(raw)                            // blank a leading 名字： so a speaker isn't the noun
    for (const a of extractNumberAtoms(line)) {
      if (!a.unit) continue                                      // need a unit to compare (a bare count is ambiguous)
      if (a.polarity) continue                                   // any qualifier → a bound/estimate, not an exact fact
      const before = line.slice(Math.max(0, a.idx - NUMERIC_CONSISTENCY.WINDOW), a.idx)
      if (NUMERIC_APPROX_NEAR.test(before)) continue             // hedge/estimate right before → skip
      // measured-noun key (trailing 汉字 run before the number, Pangu space trimmed, trailing copulas peeled so
      // 毛利率为 / 毛利率是 group together) — the shared helper the derivative_context_review check also uses.
      const keyNoun = measuredNounKey(before)
      if (!keyNoun) continue
      const key = `${keyNoun} ${a.unit}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ value: a.value, line: li + 1, snippet: raw.trim().slice(0, NUMERIC_CONSISTENCY.SNIPPET) })
    }
  }
  const conflicts = []
  for (const [key, occ] of groups) {
    if (occ.length < 2) continue
    let has = false
    for (let i = 0; i < occ.length && !has; i += 1) for (let j = i + 1; j < occ.length; j += 1) { if (xfileValuesConflict(occ[i].value, occ[j].value)) { has = true; break } }
    if (!has) continue
    const [keyNoun, unit] = key.split(' ')
    const seen = new Map()                                       // one line ref per DISTINCT value (first wins)
    for (const o of occ) if (!seen.has(o.value)) seen.set(o.value, o)
    conflicts.push({ keyNoun, unit, values: Array.from(seen.values()).slice(0, XFILE.MAX_VALUES) })
  }
  // most-specific (longest) noun first = highest confidence; then fewer distinct values.
  conflicts.sort((a, b) => b.keyNoun.length - a.keyNoun.length || a.values.length - b.values.length)
  return { conflicts: conflicts.slice(0, NUMERIC_CONSISTENCY.MAX_CONFLICTS) }
}

// ============================================================================
// P1 — derivative attribution guard (时间线 / 访谈总结)
// ----------------------------------------------------------------------------
// A derived deliverable can state a figure and attribute it to the interview that the interviewee never actually
// said — the highest-risk newsroom failure (a fabricated 访谈 number reads as fact). The per-file source-aware
// audit never looked at 时间线/总结. This check does, deterministically, using the SAME extractNumberAtoms +
// normalisation the rest of the file uses (writing-system + full/half-width folding, timestamp/URL masking):
//   · Every figure carries a source label the prompts establish: 【访谈】 (interview), 【公开…】 / 【公开+访谈…】
//     (public / mutually-corroborated — implies 待记者核实), or none.
//   · An interview-labeled MAGNITUDE atom (money / mass / distance / percent / duration — a measured quantity)
//     absent from the interview corpus → HARD FAIL (a fabricated 访谈 figure). Bare integers stay warning-tier
//     (FP-prone: counts, ordinals, list numbers); dates/years used as entry anchors are never flagged.
//   · A public / 待核 atom → passes, listed as a reporter-verification item.
//   · An unlabeled atom → warning-tier 复核 item (a summary paraphrases; never hard-fail), listed.
// "Interview corpus" = the union of the SOURCE transcript(s) AND the refined 成稿 the derivative was built from.
// extractNumberAtoms canonicalises both writing systems identically; including the 成稿 removes false drift from
// legitimate unit restoration (源 "1.03 billion" is skipped, 成稿 "10.3 亿" the derivative copied is matched).

// Mass / distance / energy / area / volume units that ATOM_UNITS does NOT attach (it covers money / percent /
// duration / 倍). These promote a bare "15 吨" to a hard-fail-eligible measured quantity — the exact class the
// motivating failure invented. Longest-first so 平方公里 beats 公里, 千瓦时 beats 瓦. FP surface is tiny: a match
// only fires as <number><unit>, and a hard fail additionally requires a pure-【访谈】 line AND absence from the
// corpus (a real measured quantity is echoed in the 成稿 the derivative was built from).
const DERIV_MAGNITUDE_UNITS = ['平方公里', '平方千米', '立方米', '平方米', '千瓦时', '兆瓦', '千瓦', '公顷', '千米', '海里', '毫升', '毫克', '千克', '公斤', '公里', '摄氏度', '马赫', '吨', '克', '米', '升', '瓦', '亩']

// Money-scale words → absolute multiplier. The derivative agent may legitimately re-express the same 成稿 amount
// across scales (8000 万 ⇄ 0.8 亿, both 8e7); comparing only value|unit keys would false-fail that conversion. So
// a money atom ALSO matches when its absolute magnitude overlaps a same-family source amount. (元/美元 stay
// key-matched — a currency's magnitude word is what converts, not the currency itself.)
const DERIV_MONEY_SCALE = { 万: 1e4, 千万: 1e7, 亿: 1e8 }

// One derivative/corpus atom = { value, unit, idx, magnitude }. Base atoms come from extractNumberAtoms (money /
// percent / duration / 万亿 / bare integer / year); a supplementary pass adds the mass/distance/… magnitudes it
// misses. A supplementary atom at the same start index as a base bare atom WINS (the unit-bearing reading), so a
// "15 吨" is one magnitude atom, not a bare "15" plus a "15 吨".
function extractDerivativeAtoms(text) {
  const s = String(text || '')
  const base = extractNumberAtoms(s).map((a) => ({ value: a.value, unit: a.unit, idx: a.idx, magnitude: STRONG_UNIT_SET.has(a.unit) }))
  // Reuse extractNumberAtoms' masking + width folding so offsets and values line up with the base pass.
  const raw = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\\(?=[.])/g, '')
  const masked = raw.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, (m) => ' '.repeat(m.length)).replace(/https?:\/\/[^\s]+/g, (m) => ' '.repeat(m.length))
  const half = masked.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/％/g, '%')
  const unitAlt = DERIV_MAGNITUDE_UNITS.map(escapeRe).join('|')
  const numCore = `(?:\\d+(?:\\.\\d+)?(?:\\s*(?:[-~—－]|到|至)\\s*\\d+(?:\\.\\d+)?)?|[${HAN_NUM_CHARS}]+(?:[到至][${HAN_NUM_CHARS}]+)?)`
  const RE = new RegExp(`(${numCore})\\s*(${unitAlt})`, 'g')
  const supp = []
  for (const m of half.matchAll(RE)) {
    const folded = foldScaleUnit(m[1], m[2])
    if (!folded) continue
    supp.push({ value: folded.value, unit: folded.unit, idx: m.index ?? 0, magnitude: true })
  }
  const suppIdx = new Set(supp.map((a) => a.idx))
  return base.filter((a) => !suppIdx.has(a.idx)).concat(supp).sort((a, b) => a.idx - b.idx)
}

// A derivative atom's value string carries a 4-digit year (2019 / 2019-2020 / 2025-07) → it is a DATE anchor, not
// a claimed measured quantity. Timelines are built on dates; flagging them would fire on every entry. Weak time
// units (年/月/日/天) are dropped for the same reason.
const DERIV_WEAK_TIME = new Set(['年', '月', '日', '天'])
function derivIsDateAtom(a) {
  return DERIV_WEAK_TIME.has(a.unit) || /(?:19|20)\d{2}/.test(String(a.value))
}

// The governing source label of ONE derivative line. 【公开…】 (incl. 【公开+访谈…】) → 'public': the public
// component is a legitimate reason a figure is absent from the transcript, so it never hard-fails — it is a
// reporter-verification item. A pure 【访谈】 (no 公开) → 'interview' (hard-fail eligible). Otherwise 'none'.
function derivLineLabel(line) {
  const inBrackets = String(line).match(/【[^】]*】/g) || []
  const joined = inBrackets.join('')
  if (/公开/.test(joined)) return 'public'
  if (/访谈/.test(joined)) return 'interview'
  return 'none'
}

// Absolute money magnitude span of an atom whose unit is a scale word (万/千万/亿), else null.
function derivMoneyAbsSpan(a) {
  const scale = DERIV_MONEY_SCALE[a.unit]
  if (!scale) return null
  const span = xfileValueSpan(a.value)
  return span ? { lo: span.lo * scale, hi: span.hi * scale } : null
}

// A magnitude atom matches the corpus if its exact value|unit key is present, OR its numeric span overlaps a
// same-unit corpus span (so a timeline "65 亿"【访谈】 is covered by a source range "60-70 亿", not a fabrication;
// but "80 亿" against "60-70 亿" stays disjoint → unmatched), OR (money scale words only) its ABSOLUTE amount
// overlaps a same-family source amount (8000 万 ⇄ 0.8 亿). Reuses xfileValueSpan (range/scalar canonical form).
function derivMagnitudeMatches(a, corpusKeys, corpusByUnit, corpusMoneyAbs) {
  if (corpusKeys.has(`${a.value}|${a.unit}`)) return true
  const span = xfileValueSpan(a.value)
  if (span) for (const cs of corpusByUnit.get(a.unit) || []) if (!(span.hi < cs.lo || cs.hi < span.lo)) return true
  const abs = derivMoneyAbsSpan(a)
  if (abs) for (const cs of corpusMoneyAbs || []) if (!(abs.hi < cs.lo || cs.hi < abs.lo)) return true
  return false
}

// derivative_context_review (warning tier): an interview magnitude that PASSES the hard gate by matching the corpus
// value+unit can still be a fabrication BUILT AROUND an unrelated corpus number of the same magnitude (corpus 融资 2
// 亿 → derivative 亏损 2 亿【访谈】). This corroborates the LOCAL context: does the derivative line's own measured-
// noun (or a ≥2-char tail of it) appear within ±DERIV_CONTEXT_CHARS of ANY corpus occurrence of that exact value+
// unit? Returns { ok, snippet } — ok:false with the nearest corpus window when the noun is nowhere near the figure.
// Never hard-fails; a too-short/absent derivative noun is handled by the caller (it simply does not run the check).
const DERIV_CONTEXT_CHARS = 40
function derivContextCorroboration(derivNoun, corpusStr, occIdxs) {
  let nearest = ''
  for (const idx of occIdxs || []) {
    const win = corpusStr.slice(Math.max(0, idx - DERIV_CONTEXT_CHARS), idx + DERIV_CONTEXT_CHARS)
    if (!nearest) nearest = win
    // look for the derivative noun, then progressively shorter tails down to 2 chars (the specific measured concept
    // — 亏损 / 融资 — sits at the tail, closest to the number; a generic subject prefix like 公司去年 is dropped).
    for (let len = derivNoun.length; len >= 2; len -= 1) {
      if (win.includes(derivNoun.slice(derivNoun.length - len))) return { ok: true, snippet: '' }
    }
  }
  return { ok: false, snippet: nearest.replace(/\s+/g, ' ').trim().slice(0, 60) }
}

// checkDerivativeAttribution(corpusText, derivativeText):
//   corpusText = source transcript(s) + refined 成稿 concatenated (the interview's ground-truth figures).
//   derivativeText = the rendered 时间线 or 访谈总结.
// Returns { assessed, hardFail[], reporterVerify[], review[] }. Pure and order-stable.
export function checkDerivativeAttribution(corpusText, derivativeText) {
  const empty = { assessed: false, hardFail: [], reporterVerify: [], review: [], contextReview: [] }
  const deriv = String(derivativeText || '')
  if (!deriv.trim()) return empty
  const corpusStr = String(corpusText || '')
  const corpusAtoms = extractDerivativeAtoms(corpusStr)
  const corpusKeys = new Set(corpusAtoms.map((a) => `${a.value}|${a.unit}`))
  const corpusValues = new Set(corpusAtoms.map((a) => a.value))
  // exact value+unit → the corpus offsets where that figure occurs (feeds the derivative_context_review windows).
  const corpusOccByKey = new Map()
  for (const a of corpusAtoms) {
    const k = `${a.value}|${a.unit}`
    if (!corpusOccByKey.has(k)) corpusOccByKey.set(k, [])
    corpusOccByKey.get(k).push(a.idx)
  }
  const corpusByUnit = new Map()
  const corpusMoneyAbs = []
  for (const a of corpusAtoms) {
    if (!a.magnitude) continue
    const span = xfileValueSpan(a.value)
    if (!span) continue
    if (!corpusByUnit.has(a.unit)) corpusByUnit.set(a.unit, [])
    corpusByUnit.get(a.unit).push(span)
    const abs = derivMoneyAbsSpan(a)
    if (abs) corpusMoneyAbs.push(abs)
  }
  // Safety valve: with a ZERO-atom corpus (e.g. the source/成稿 failed to load) we cannot verify anything, so we
  // must not hard-fail every interview figure and spuriously block a whole delivery — downgrade to review instead.
  const canHardFail = corpusAtoms.length > 0
  const hardFail = []
  const reporterVerify = []
  const review = []
  const contextReview = []
  const lines = deriv.split(/\r?\n/)
  for (let li = 0; li < lines.length; li += 1) {
    const rawLine = lines[li]
    if (!rawLine || !rawLine.trim()) continue
    // Skip non-data lines: markdown headings, blockquotes (the 标注 legend / 整理依据 header), HTML comments.
    if (/^\s*#{1,6}\s/.test(rawLine) || /^\s*>/.test(rawLine) || /^\s*<!--/.test(rawLine)) continue
    // Strip a leading bullet / list-number marker so "1. …" / "- …" don't yield a phantom "1" atom.
    const line = rawLine.replace(/^\s*(?:[-*+]|\d+[.)、])\s+/, '')
    const atoms = extractDerivativeAtoms(line)
    if (!atoms.length) continue
    const label = derivLineLabel(rawLine)
    const snippet = rawLine.trim().slice(0, 80)
    for (const a of atoms) {
      if (derivIsDateAtom(a)) continue                     // dates / years / entry anchors are never flagged
      const unitLabel = a.unit ? `${a.value} ${a.unit}` : a.value
      if (label === 'public') {
        reporterVerify.push({ line: li + 1, value: a.value, unit: a.unit, text: unitLabel, snippet })
        continue
      }
      if (label === 'interview') {
        if (a.magnitude) {
          if (!derivMagnitudeMatches(a, corpusKeys, corpusByUnit, corpusMoneyAbs)) {
            if (canHardFail) hardFail.push({ line: li + 1, value: a.value, unit: a.unit, text: unitLabel, snippet })
            else review.push({ line: li + 1, value: a.value, unit: a.unit, text: unitLabel, snippet, note: '访谈标注量纲数字，但无可比对语料（复核）' })
          } else if (corpusKeys.has(`${a.value}|${a.unit}`)) {
            // Hard gate satisfied by an EXACT value+unit corpus match (range / scale overlaps are skipped — no single
            // occurrence to window around). Corroborate the LOCAL context: is the derivative's measured-noun echoed
            // near the figure in the corpus? If not, raise a SOFT 复核 item — the figure may be lifted off an
            // unrelated corpus number of the same magnitude. Never a hard fail.
            const derivNoun = measuredNounKey(line.slice(0, a.idx))
            if (derivNoun) {
              const corr = derivContextCorroboration(derivNoun, corpusStr, corpusOccByKey.get(`${a.value}|${a.unit}`))
              if (!corr.ok) contextReview.push({ line: li + 1, value: a.value, unit: a.unit, text: unitLabel, snippet,
                note: `标【访谈】、该数值在语料中出现过，但邻近语境“${derivNoun}”与语料对不上（语料邻近：${corr.snippet || '—'}）——请核对是否套用了无关数字` })
            }
          }
        } else if (!corpusValues.has(a.value)) {
          review.push({ line: li + 1, value: a.value, unit: a.unit, text: unitLabel, snippet, note: '访谈标注但源文无对应，且非量纲数字（复核）' })
        }
        continue
      }
      // Unlabeled: surface the ones that carry signal — a magnitude, or a value absent from the interview.
      if (a.magnitude || !corpusValues.has(a.value)) {
        review.push({ line: li + 1, value: a.value, unit: a.unit, text: unitLabel, snippet, note: '未标注来源（复核：访谈？公开？）' })
      }
    }
  }
  return { assessed: true, hardFail, reporterVerify, review, contextReview }
}

// auditDerivative: wrap checkDerivativeAttribution into a file-result shaped like the rest of the audit
// (status + findings[]), so callers wire it into pass/fail exactly as the other hard detectors.
export function auditDerivative({ corpusText, derivativeText, kind = 'derivative', derivativeFile = '<derivative>' }) {
  const r = checkDerivativeAttribution(corpusText, derivativeText)
  // P6: a 时间线/总结 can also contradict itself (same measured quantity, two numbers). Cheap, warning tier.
  const numericConflicts = checkNumericConsistency(derivativeText).conflicts
  const findings = [
    { name: 'derivative_attribution', severity: 'hard', count: r.hardFail.length,
      samples: r.hardFail.slice(0, 12).map((x) => ({ text: `${x.text}（第 ${x.line} 行，标【访谈】但源文无此数字——疑炮制）`, line: x.line })) },
    { name: 'derivative_reporter_verify', severity: 'soft', count: r.reporterVerify.length,
      samples: r.reporterVerify.slice(0, 12).map((x) => ({ text: `${x.text}（第 ${x.line} 行，公开来源·待记者核实）`, line: x.line })) },
    { name: 'derivative_review', severity: 'soft', count: r.review.length,
      samples: r.review.slice(0, 12).map((x) => ({ text: `${x.text}（第 ${x.line} 行，${x.note}）`, line: x.line })) },
    { name: 'derivative_context_review', severity: 'soft', count: r.contextReview.length,
      samples: r.contextReview.slice(0, 12).map((x) => ({ text: `${x.text}（第 ${x.line} 行，${x.note}）`, line: x.line })) },
    { name: 'numeric_inconsistency', severity: 'soft', count: numericConflicts.length,
      samples: numericConflicts.slice(0, 12).map((c) => ({ text: `“${c.keyNoun}”在本件出现互相矛盾的数值：${c.values.map((v) => `第 ${v.line} 行作“${atomLabel({ value: v.value, unit: c.unit })}”`).join('，')}——请对照核对`, line: c.values[0] ? c.values[0].line : 1 })) },
  ]
  return { file: derivativeFile, kind, mode: 'derivative', status: r.hardFail.length ? 'fail' : 'ok', assessed: r.assessed, failed: r.hardFail.length ? ['derivative_attribution'] : [], findings, hardFail: r.hardFail, reporterVerify: r.reporterVerify, review: r.review, contextReview: r.contextReview, numericConflicts }
}

// auditDerivativeFile: read the derivative + its interview corpus (source transcripts and/or refined 成稿) from
// disk and run the guard. corpusPaths are normalised (SRT → turns) so an SRT source's figures still compare.
export function auditDerivativeFile(derivativePath, corpusPaths = [], { kind = 'derivative' } = {}) {
  const derivativeText = fs.readFileSync(derivativePath, 'utf8')
  const corpusText = (corpusPaths || [])
    .map((p) => { try { return normalizeTranscriptSource(fs.readFileSync(p, 'utf8'), { sourceFile: p }) } catch { return '' } })
    .join('\n\n')
  return auditDerivative({ corpusText, derivativeText, kind, derivativeFile: path.resolve(derivativePath) })
}

function usage() {
  return `用法:
  node scripts/audit_refined.mjs <精校稿.md> [更多.md...]          # 只查输出干净度
  node scripts/audit_refined.mjs --source <源稿.md> --refined <精校稿.md> [--mode refine|summary] [--glossary <校对表.md>] [--strict]
                                                                  # 对比源文：查压缩/欠精校/内容缺口/发言人错归/炮制引语；给 --glossary 时另查残留变体/裸写未核实名
                                                                  # --strict 额外开启 entity_substitution_risk（音近实体替换，误报率偏高，默认关闭）
  node scripts/audit_refined.mjs --logic <逻辑稿.md> --refined <成稿.md>   # 逻辑稿体检：同序复制/漏来源为 hard，膨胀/重复段为 soft
  node scripts/audit_refined.mjs --derivative <时间线|总结.md> --kind timeline|summary --corpus <源稿.md,成稿1.md,…>
                                                                  # 派生件溯源体检：标【访谈】的量纲数字（金额/吨/公里/%/时长）源文无对应 → hard（疑炮制）；
                                                                  # 【公开…】/【公开+访谈…】→ 待记者核实（soft 列出）；未标注 → 复核（soft）；纯数字/年份日期不算 hard
  node scripts/audit_refined.mjs --glossary-only <校对表.md>       # 校对表结构体检（条目数/身份线索/变体比例，独立入口，全 soft）
  … --source <源稿> --refined <精校稿> --annotate [--dry-run]      # 把 hard 内容缺口标记插进成稿（--dry-run 只演示不落盘）
  … --source <源稿> --refined <精校稿> --anchors [--dry-run]       # 给每个 ## 小节插入源锚点注释 <!-- 源 L25-L38 · 08:00-12:05 -->
                                                                  # （渲染不可见；引文可循此跳回源文件行号与录音时间；可与 --annotate 同用）

输出-only hard（算失败）：嗯/呃、对对对/是是是、我我/就就、因为因为/涂鸦涂鸦、重复年份、20182018/SaaSAPP 等纯噪音或 ASR 粘连；超约 900 字的对话长段。
对比源文 hard（mode=refine）：charRatio < 0.55（疑似压缩成摘要）、欠精校、结尾缺失、
  content_gap（成段源内容未出现在成稿且无折叠痕迹——疑似被模型无声略过/审查，附源文件行号）、
  quote_style（ASCII 直引号紧贴中文，或出现「」『』——排版规范明令禁止）。
soft（不算失败、需看上下文）：句末语气词 啊/哦/欸，那个/这个/就是说 等；小缺口/折叠缺口/散点流失；
  number_drift / hedge_loss（数字漂移 / 不确定语气被抹平）、attribution_mismatch（某轮内容落到了另一位发言人名下）、
  quote_fabrication_risk（引号内措辞源文中无对应——疑似炮制引语）、entity_substitution_risk（仅 --strict）、
  quote_density_low（长正文无弯引号）、speaker_label_style（标签风格混用）、ghost_name（残留错写变体）、
  missing_yin（未核实名裸写缺（音））、logic_order_unchanged / logic_section_coverage（逻辑稿假重排或漏来源，hard）、
  logic_size_sanity / logic_duplicate_para（逻辑稿膨胀或重复段，soft）、
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
  const derivative = getOpt(argv, '--derivative')
  const glossaryOnly = getOpt(argv, '--glossary-only')
  // --derivative audits a 时间线/总结 against the interview corpus (--corpus = comma-joined source transcript(s)
  // and/or 成稿). Standalone entry: fabricated 访谈 figures → hard (exit 1); 待核/未标注 items are soft (listed).
  if (derivative) {
    const corpus = (getOpt(argv, '--corpus') || '').split(',').map((s) => s.trim()).filter(Boolean)
    const kind = getOpt(argv, '--kind') || 'derivative'
    const file = auditDerivativeFile(derivative, corpus, { kind })
    const result = { status: file.status, files: [file] }
    console.log(JSON.stringify(result, null, 2))
    return result.status === 'fail' ? 1 : 0
  }
  // --glossary-only lints a rendered 校对表 on its own (条目数/身份线索/变体比例). Standalone entry, all soft →
  // always exit 0; a caller reads findings[*].count>0 to see which warnings fired.
  if (glossaryOnly) {
    const result = { status: 'ok', files: [auditGlossaryFile(glossaryOnly)] }
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  // --logic pairs the 逻辑稿 against the 成稿 (--refined); it is a standalone entry, no --source needed.
  if (logic && refined) {
    const file = auditLogicFile(refined, logic)
    const result = { status: file.status, files: [file] }
    console.log(JSON.stringify(result, null, 2))
    return result.status === 'fail' ? 1 : 0
  }
  if (source && refined) {
    const glossary = getOpt(argv, '--glossary')
    const result = auditPairs([{ sourcePath: source, refinedPath: refined, mode: getOpt(argv, '--mode') || 'refine', glossaryPath: glossary, strict: argv.includes('--strict') }])
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
