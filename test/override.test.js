import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCanonicalOverrides,
  applyOverridesToMerged,
  dropLocked,
  excludeVerified,
  clusterEntities,
  mergeFindings,
  mergeIntoPrior,
  applyVerifiedEntry,
  renderGlossary, parseGlossary,
  confidenceMark,
  safeName,
} from '../core/spec.js'

// All fixtures are fictional: 陈涛/陈焘 是虚构同音人名对，示例公司/云洲仪器/沈其安 为仓库既有虚构占位。

// ---------- applyCanonicalOverrides ----------

test('override forces canonical on a variant-matched cluster and locks it', () => {
  const clusters = clusterEntities([{ canonical: '真选', variants: ['臻选'], hint: '品质计划' }])
  const [c] = applyCanonicalOverrides(clusters, [{ canonical: '甄选', variants: ['真选', '臻选'] }])
  assert.equal(c.canonical, '甄选', 'canonical forced to the decreed spelling')
  assert.ok(c.variants.includes('真选') && c.variants.includes('臻选'), 'other writings folded into variants')
  assert.ok(!c.variants.includes('甄选'), 'canonical is not duplicated inside variants')
  assert.equal(c.locked, true, 'the cluster is locked')
  assert.equal(c.lockReason, '用户钦定', 'default lockReason when no note given')
})

test('override.note is carried verbatim into lockReason', () => {
  const clusters = clusterEntities([{ canonical: '真选', variants: [] }])
  const [c] = applyCanonicalOverrides(clusters, [{ canonical: '甄选', variants: ['真选'], note: '创始人本人确认' }])
  assert.equal(c.lockReason, '创始人本人确认')
})

test('a decree collapses MULTIPLE matched clusters into one locked cluster (overrides the weak-key no-merge guard)', () => {
  // Two clusters the merge machinery would never join (a bare 王总 is a weak key), but the user says they are one.
  const clusters = clusterEntities([
    { canonical: '陈涛', variants: [], hint: '受访者' },
    { canonical: '陈焘', variants: [], hint: '同一人另一处误写' },
  ])
  assert.equal(clusters.length, 2, 'precondition: the two homophone spellings clustered apart')
  const out = applyCanonicalOverrides(clusters, [{ canonical: '陈涛', variants: ['陈焘'] }])
  assert.equal(out.length, 1, 'the decree merged them into a single cluster')
  assert.equal(out[0].canonical, '陈涛')
  assert.deepEqual(out[0].variants, ['陈焘'], 'the other spelling is a variant')
  assert.equal(out[0].locked, true)
  assert.ok(out[0].hint.includes('受访者') && out[0].hint.includes('同一人另一处误写'), 'hints from both clusters preserved')
})

test('an override that matches nothing still produces a locked cluster (refine glossary is guaranteed to carry it)', () => {
  const clusters = clusterEntities([{ canonical: '示例公司', variants: [] }])
  const out = applyCanonicalOverrides(clusters, [{ canonical: '云洲仪器', variants: ['云州仪器'] }])
  assert.equal(out.length, 2, 'pass-through cluster + a fresh locked cluster')
  const locked = out.find((c) => c.canonical === '云洲仪器')
  assert.ok(locked, 'the decreed canonical exists even though the scout never surfaced it')
  assert.equal(locked.locked, true)
  assert.deepEqual(locked.variants, ['云州仪器'], 'the decree\'s own variants are carried')
  const passthrough = out.find((c) => c.canonical === '示例公司')
  assert.ok(passthrough && !passthrough.locked, 'the unrelated cluster is untouched and unlocked')
})

test('applyCanonicalOverrides does not mutate its inputs (pure)', () => {
  const clusters = clusterEntities([{ canonical: '真选', variants: ['臻选'] }])
  const before = JSON.stringify(clusters)
  const overrides = [{ canonical: '甄选', variants: ['真选'] }]
  const ovBefore = JSON.stringify(overrides)
  const out = applyCanonicalOverrides(clusters, overrides)
  assert.equal(JSON.stringify(clusters), before, 'input clusters unchanged')
  assert.equal(JSON.stringify(overrides), ovBefore, 'input overrides unchanged')
  assert.notEqual(out, clusters, 'a fresh array is returned')
  assert.notEqual(out[0], clusters[0], 'returned cluster is a fresh object')
})

test('no overrides → clusters pass through as fresh copies, unlocked', () => {
  const clusters = clusterEntities([{ canonical: '示例公司', variants: ['示例'] }])
  for (const ov of [undefined, null, []]) {
    const out = applyCanonicalOverrides(clusters, ov)
    assert.equal(out.length, 1)
    assert.equal(out[0].canonical, '示例公司')
    assert.ok(!out[0].locked, 'nothing is locked when there are no overrides')
    assert.notEqual(out[0].variants, clusters[0].variants, 'variants array is copied, not shared')
  }
})

test('pass-through order is stable; the locked cluster sits at its first contributor\'s position', () => {
  const clusters = clusterEntities([
    { canonical: '甲公司', variants: [] },
    { canonical: '真选', variants: [] },   // will be locked in place (index 1)
    { canonical: '乙公司', variants: [] },
  ])
  const out = applyCanonicalOverrides(clusters, [{ canonical: '甄选', variants: ['真选'] }])
  assert.deepEqual(out.map((c) => c.canonical), ['甲公司', '甄选', '乙公司'], 'locked cluster replaces its source in place')
})

// ---------- machine-readable confidence markers (render → parse round-trip) ----------

const GA = { topic: '示例公司', date: '2025-07', background: '虚构采访背景。', doNotMerge: [] }

function findEntry(g, canonical) {
  return [...g.people, ...g.brands, ...g.terms].find((e) => e.canonical === canonical)
}

test('confidenceMark: locked → 〔用户钦定〕; verified name → 〔核实·date〕 (date optional); otherwise empty', () => {
  const resolved = new Map([['臻选', { query: '臻选', canonical: '真选', source: 'example.com 官网品牌介绍页' }]])
  // SF-1: confidenceMark returns the marker WITH its leading separator space (or '' when none).
  assert.equal(confidenceMark({ canonical: '甄选', locked: true }, resolved, '2025-07'), ' 〔用户钦定〕')
  assert.equal(confidenceMark({ canonical: '真选', variants: ['臻选'] }, resolved, '2025-07'), ' 〔核实·2025-07〕')
  assert.equal(confidenceMark({ canonical: '真选', variants: ['臻选'] }, resolved, undefined), ' 〔核实〕', 'date段可省略')
  assert.equal(confidenceMark({ canonical: '无关术语', variants: [] }, resolved, '2025-07'), '', '未核实、未锁定 → 无标记')
})

test('render→parse: a verified entry round-trips to confidence "verified"', () => {
  const merged = {
    speakersByFile: [],
    people: [], brands: [],
    terms: [{ canonical: '臻选', variants: ['真选'], hint: '核心计划', files: ['A'], crossFile: false }],
    errors: [], notes: [],
  }
  const verified = { resolved: [{ query: '臻选', canonical: '甄选', identity: '品质战略', source: 'example.com 官网品牌介绍页' }], unresolved: [] }
  const md = renderGlossary(merged, verified, null, GA)
  assert.ok(md.includes('〔核实·2025-07〕'), 'a verified entry line carries the machine marker')
  const g = parseGlossary(md)
  const e = findEntry(g, '甄选')            // canonical was rewritten by the verify result
  assert.ok(e, 'the verified entry parses back')
  assert.equal(e.confidence, 'verified', 'confidence decoded as verified')
  assert.ok(e.hint.includes('核心计划'), 'hint content survives the marker strip')
  assert.ok(!/〔|〕/.test(e.hint), 'the marker is NOT left inside the hint')
})

test('render→parse: a locked (user-decreed) entry round-trips to confidence "user"', () => {
  const merged = {
    speakersByFile: [],
    people: [], brands: [],
    terms: [{ canonical: '甄选', variants: ['真选', '臻选'], hint: '用户钦定的写法', files: ['A'], crossFile: false, locked: true, lockReason: '用户钦定' }],
    errors: [], notes: [],
  }
  const md = renderGlossary(merged, { resolved: [], unresolved: [] }, null, GA)
  assert.ok(md.includes('〔用户钦定〕'), 'the locked entry renders the 〔用户钦定〕 marker')
  const g = parseGlossary(md)
  const e = findEntry(g, '甄选')
  assert.equal(e.confidence, 'user', 'confidence decoded as user')
  assert.deepEqual(e.variants, ['真选', '臻选'], 'variants intact')
})

test('parse recognises a hand-written 〔待复核〕 marker as confidence "recheck"', () => {
  // render never emits 待复核; a human writes it to flag an entry for re-verification. Parse must认得它.
  const md = [
    '# T 统一校对表（采访时间 2025-07）',
    '',
    '## 人名（写法 → 统一）',
    '- **陈涛** ← 陈焘 ｜ 受访者 〔待复核〕',
  ].join('\n')
  const g = parseGlossary(md)
  const e = findEntry(g, '陈涛')
  assert.ok(e, 'the entry parses')
  assert.equal(e.confidence, 'recheck', 'the hand-written 待复核 marker is decoded')
  assert.equal(e.hint, '受访者', 'hint keeps its prose, marker stripped')
  assert.deepEqual(e.variants, ['陈焘'])
})

test('backward compat: an UNMARKED legacy line parses exactly as before, only gaining confidence:"unknown"', () => {
  // This line uses every legacy segment kind (variants ｜ hint ｜ 多份互证) and NO marker.
  const line = '- **示例公司** ← 示例 / X 公司 ｜ 本访谈对象企业 ｜ 多份互证'
  const md = ['# T 统一校对表（采访时间 2025-07）', '', '## 品牌 / 公司 / 产品（写法 → 统一）', line].join('\n')
  const g = parseGlossary(md)
  const e = findEntry(g, '示例公司')
  // Fields must match the pre-marker parse verbatim:
  assert.deepEqual(e.variants, ['示例', 'X 公司'], 'variants identical to legacy parse')
  assert.equal(e.hint, '本访谈对象企业', 'hint identical to legacy parse')
  assert.equal(e.crossFile, true, 'crossFile flag identical to legacy parse')
  assert.equal(e.confidence, 'unknown', 'the only addition: confidence defaults to unknown')
})

test('full renderGlossary→parseGlossary round-trip is idempotent and adds no marker to a plain entry', () => {
  // A plain (unverified, unlocked) entry must NOT gain a marker, so re-parsing keeps it "unknown"
  // (this is what preserves total backward compatibility for ordinary entries).
  const merged = {
    speakersByFile: [{ label: 'A', speakers: [{ label: '记者', role: '记者', identity: '主持' }] }],
    people: [], brands: [],
    terms: [{ canonical: '示例术语', variants: ['示例術語'], hint: '一句线索', files: ['A'], crossFile: false }],
    errors: [], notes: [],
  }
  const md1 = renderGlossary(merged, { resolved: [], unresolved: [] }, null, GA)
  assert.ok(!/示例术语.*〔/.test(md1), 'a plain entry gets no confidence marker')
  const g = parseGlossary(md1)
  assert.equal(findEntry(g, '示例术语').confidence, 'unknown')
})

// ---------- BLOCKER: confidence round-trip closes the loop (render → parse → merge → re-render) ----------

test('BLOCKER: verified/user markers survive a full render→parse→merge→re-render; user stays verify-免 + name-guard-免', () => {
  // Round 1 render: a web-verified person (王志远), a user-decreed brand (甄选), and an ordinary term (示例术语).
  const round1 = {
    speakersByFile: [{ label: 'A', speakers: [{ label: '记者', role: '记者', identity: '主持' }] }],
    people: [{ canonical: '王志远', variants: ['王总'], hint: '受访者', files: ['A'], crossFile: false }],
    brands: [{ canonical: '甄选', variants: ['真选', '臻选'], hint: '用户钦定的写法', files: ['A'], crossFile: false, locked: true, lockReason: '用户钦定' }],
    terms: [{ canonical: '示例术语', variants: [], hint: '一句线索', files: ['A'], crossFile: false }],
    errors: [], notes: [],
  }
  // 王志远 was resolved THIS round (query 王总 → 王志远), so it renders 〔核实·2025-07〕.
  const verified1 = { resolved: [{ query: '王总', canonical: '王志远', identity: '受访者', source: 'example.com 官网团队页' }], unresolved: [] }
  const md1 = renderGlossary(round1, verified1, null, GA)
  assert.ok(md1.includes('王志远') && /王志远.*〔核实·2025-07〕/.test(md1), 'round-1: verified marker present')
  assert.ok(/甄选.*〔用户钦定〕/.test(md1), 'round-1: user marker present')

  // Parse round 1 back into prior memory (this is what a next batch reads).
  const prior = parseGlossary(md1)
  prior.verified = { resolved: [], unresolved: [] }   // no carried verify rows — force the entry-level markers to do the work
  const pv = findEntry(prior, '王志远'), pu = findEntry(prior, '甄选')
  assert.equal(pv.confidence, 'verified', 'parsed: 王志远 is verified')
  assert.equal(pv.confidenceDate, '2025-07', 'parsed: original date captured')
  assert.equal(pu.confidence, 'user', 'parsed: 甄选 is user')

  // Round 2: a fresh (empty) batch merges into prior, then we re-render with NO fresh verify (resolvedMap empty).
  const fresh = { speakersByFile: [], people: [], brands: [], terms: [], errors: [], notes: [] }
  const merged2 = mergeIntoPrior(prior, fresh)
  const md2 = renderGlossary(merged2, { resolved: [], unresolved: [] }, null, GA)
  // The BLOCKER: both markers must STILL be there even though nothing was re-verified this round.
  assert.ok(/王志远.*〔核实·2025-07〕/.test(md2), 'round-2: verified marker (with original date) NOT lost')
  assert.ok(/甄选.*〔用户钦定〕/.test(md2), 'round-2: user marker NOT lost')

  // user entry keeps its cross-batch VETO: excludeVerified skips it, and the name-guard short-circuits on it.
  const skip = excludeVerified({ people: clusterEntities([{ canonical: '甄选', variants: ['真选'] }]), brands: [], terms: [] }, prior)
  assert.ok(!skip.people.some((e) => e.canonical === '甄选'), 'user entry is免verify across batches')
  // A stray verify hit that collides with a user entry must NOT rewrite it (name-guard短路 on confidence:user).
  const applied = new Set(), rejected = new Set()
  const guarded = applyVerifiedEntry({ canonical: '甄选', variants: ['真选', '臻选'], confidence: 'user' }, true,
    new Map([['真选', { canonical: '别的名字', identity: 'x' }]]), applied, rejected)
  assert.equal(guarded.canonical, '甄选', 'name-guard: a user entry keeps its钦定 canonical against a colliding verify hit')
})

test('BLOCKER: a hand-written 待复核 forces re-verify (免verify权被撤销), and re-renders clean until re-verified', () => {
  const priorMd = [
    '# 示例公司 统一校对表（采访时间 2025-07）', '', '## 人名（写法 → 统一）',
    '- **陈涛** ← 陈焘 ｜ 受访者 〔待复核〕',    // human flagged for re-verification
  ].join('\n')
  const prior = parseGlossary(priorMd)
  const e = findEntry(prior, '陈涛')
  assert.equal(e.confidence, 'recheck', 'parsed as recheck')
  // recheck overrides a stale verify row: its writings are removed from the skip set → it IS re-verified.
  const priorWithStaleRow = Object.assign({}, prior, { verified: { resolved: [{ query: '陈涛', canonical: '陈涛' }], unresolved: [] } })
  const merged = { people: clusterEntities([{ canonical: '陈涛', variants: ['陈焘'] }, { canonical: '新人物', variants: [] }]), brands: [], terms: [] }
  const out = excludeVerified(merged, priorWithStaleRow)
  assert.ok(out.people.some((x) => x.canonical === '陈涛'), 'recheck FORCES re-verify despite a covering verify row')
  // Re-render without a fresh conclusion → the recheck entry carries NO marker (it is genuinely unsettled again).
  const merged2 = mergeIntoPrior(prior, { speakersByFile: [], people: [], brands: [], terms: [], errors: [], notes: [] })
  const md2 = renderGlossary(merged2, { resolved: [], unresolved: [] }, null, GA)
  const line = md2.split('\n').find((l) => l.includes('陈涛')) || ''
  assert.ok(!/〔/.test(line), 'an un-re-verified recheck entry re-renders with no marker (not silently kept as settled)')
})

// ---------- SF-1: a legitimate hint tail that looks like a marker is not stripped ----------

test('SF-1: a hint ending with the LITERAL 〔核实〕 (no preceding space) is body text, not metadata', () => {
  // Before SF-1 this tail was mis-stripped. Now the marker must be preceded by a space/｜ to count.
  const md = ['# T 统一校对表（采访时间 2025-07）', '', '## 术语 / 专名（写法 → 统一）',
    '- **甲术语** ← — ｜ 他管这叫行业〔核实〕'].join('\n')   // 〔核实〕 glued to 业 → prose
  const g = parseGlossary(md)
  const e = findEntry(g, '甲术语')
  assert.equal(e.confidence, 'unknown', 'no separator before 〔核实〕 → not treated as a marker')
  assert.equal(e.hint, '他管这叫行业〔核实〕', 'the literal token stays in the hint')
})

test('SF-1: a real marker (one leading space) is still stripped and decoded', () => {
  const md = ['# T 统一校对表（采访时间 2025-07）', '', '## 术语 / 专名（写法 → 统一）',
    '- **乙术语** ← — ｜ 正常线索 〔核实·2025-07〕'].join('\n')
  const g = parseGlossary(md)
  const e = findEntry(g, '乙术语')
  assert.equal(e.confidence, 'verified', 'a space-separated marker is decoded')
  assert.equal(e.confidenceDate, '2025-07')
  assert.equal(e.hint, '正常线索', 'the marker (and its separating space) is stripped, hint intact')
})

// ---------- SF-2: a cluster claimed by two decrees → one locked cluster + a conflict record ----------

test('SF-2: one cluster hit by TWO decrees collapses to a single locked cluster, no duplicate, and records a conflict', () => {
  // The cluster 苍碧科技/苍碧 is hit by BOTH decree A (via 苍碧科技) and decree B (via 苍碧) — competing canonicals.
  const clusters = clusterEntities([{ canonical: '苍碧科技', variants: ['苍碧'], hint: '自家产品' }])
  const out = applyCanonicalOverrides(clusters, [
    { canonical: '苍璧科技', variants: ['苍碧科技'] },   // decree A claims the cluster via 苍碧科技
    { canonical: '沧碧科技', variants: ['苍碧'] },       // decree B claims the SAME cluster via 苍碧
  ])
  assert.equal(out.length, 1, 'the two competing decrees + the one cluster produce exactly ONE locked cluster (no phantom)')
  assert.equal(out[0].canonical, '苍璧科技', 'canonical is the FIRST decree')
  assert.equal(out[0].locked, true)
  for (const w of ['苍碧科技', '苍碧', '沧碧科技']) assert.ok(out[0].variants.includes(w), `${w} folded into variants`)
  assert.ok(!out[0].variants.includes('苍璧科技'), 'the winning canonical is not duplicated inside variants')
  // The disagreement is surfaced for the human.
  assert.equal(out.conflicts.length, 1, 'one conflict recorded')
  assert.deepEqual(out.conflicts[0].canonicals.sort(), ['沧碧科技', '苍璧科技'].sort(), 'both competing canonicals listed')
  assert.equal(out.conflicts[0].resolvedTo, '苍璧科技', 'resolvedTo is the winning canonical')
})

test('SF-2: two decrees naming the SAME canonical merge WITHOUT a conflict (intentional dedup)', () => {
  const clusters = clusterEntities([{ canonical: '甲', variants: [] }, { canonical: '乙', variants: [] }])
  const out = applyCanonicalOverrides(clusters, [{ canonical: '丙', variants: ['甲'] }, { canonical: '丙', variants: ['乙'] }])
  assert.equal(out.length, 1, 'same-canonical decrees collapse to one cluster')
  assert.equal(out[0].canonical, '丙')
  assert.equal(out.conflicts.length, 0, 'a same-canonical merge is NOT a conflict')
})

// ---------- SF-3: safeName byte-budget truncation on astral (4-byte) input ----------

test('SF-3: 80 astral (4-byte) chars are truncated to a valid-UTF-8 name within the byte budget', () => {
  const astral = '𝔘'.repeat(80)                 // U+1D518, 4 bytes each in UTF-8 → 320 bytes
  const out = safeName(astral)
  const bytes = Buffer.byteLength(out, 'utf8')
  assert.ok(bytes <= 255, `output ${bytes} bytes is within the 255-byte budget`)
  // Valid UTF-8 with no split surrogate pair: round-tripping through a Buffer must not introduce U+FFFD.
  assert.ok(!out.includes('�'), 'no broken/half code point in the output')
  assert.equal(Array.from(out).join(''), out, 'output is a clean sequence of whole code points')
  assert.ok(out.length > 0 && Array.from(out).every((c) => c === '𝔘'), 'only whole astral chars remain')
})

test('SF-3: the common CJK path is unchanged by the byte budget (80 CJK chars = 240 bytes < 255)', () => {
  const out = safeName('沈'.repeat(80))
  assert.equal(Array.from(out).length, 80, '80 CJK chars survive (char cap 80, 240 bytes under budget)')
})

// ---------- safeName ----------

test('safeName replaces slashes and colons so a name can never fabricate a directory', () => {
  assert.equal(safeName('公司/部门:2025'), '公司 部门 2025')
  assert.equal(safeName('a\\b/c'), 'a b c')
})

test('safeName strips the full ASCII reserved set and full-width colon/question/asterisk', () => {
  assert.equal(safeName('a*b?c"d<e>f|g'), 'a b c d e f g')
  assert.equal(safeName('问：为何？＊'), '问 为何')   // full-width：？＊ removed, trailing space trimmed
})

test('safeName folds newlines and collapses whitespace runs to a single space', () => {
  assert.equal(safeName('第一行\n\n第二行\t 第三行'), '第一行 第二行 第三行')
})

test('safeName trims leading/trailing whitespace and dots', () => {
  assert.equal(safeName('  ...标题...  '), '标题')
  assert.equal(safeName('.hidden.'), 'hidden')
})

test('safeName truncates by CHARACTER count (CJK counts as 1)', () => {
  const long = '沈'.repeat(200)
  assert.equal(Array.from(safeName(long)).length, 80, 'defaults to max 80 chars')
  assert.equal(Array.from(safeName(long, 10)).length, 10, 'honours an explicit max')
  // A cut that lands on a trailing space must not leave one dangling.
  assert.equal(safeName('沈其安 云洲仪器', 4), '沈其安', 'trailing space exposed by the cut is trimmed')
})

test('safeName preserves CJK and mixed content unchanged when clean', () => {
  assert.equal(safeName('沈其安 · 云洲仪器 2025'), '沈其安 · 云洲仪器 2025')
})

test('safeName falls back to "untitled" for empty / all-stripped input', () => {
  assert.equal(safeName(''), 'untitled')
  assert.equal(safeName('   '), 'untitled')
  assert.equal(safeName('///'), 'untitled')
  assert.equal(safeName(null), 'untitled')
  assert.equal(safeName('...'), 'untitled')
})

// ---------- applyOverridesToMerged (per-category routing) ----------

function mergedBundle() {
  return mergeFindings([{
    speakers: [{ label: '记者', role: '记者' }],
    people: [{ canonical: '陈涛', variants: [] }, { canonical: '陈焘', variants: [] }],
    brands: [{ canonical: '示例公司', variants: [] }],
    terms: [{ canonical: '现场制', variants: [] }],
    errors: [], themes: [],
  }], [{ label: 'A' }])
}

test('applyOverridesToMerged routes each override to its declared category only (default person)', () => {
  const merged = mergedBundle()
  const out = applyOverridesToMerged(merged, [
    { canonical: '陈涛', variants: ['陈焘'] },                 // default person → collapses the homophones
    { canonical: '云洲仪器', variants: ['云州仪器'], category: 'brand' }, // no match → locked brand cluster
  ])
  assert.deepEqual(out.people.map((e) => e.canonical), ['陈涛'], 'person decree collapsed 陈涛/陈焘 into one')
  assert.equal(out.people[0].locked, true)
  const lockedBrand = out.brands.find((e) => e.canonical === '云洲仪器')
  assert.ok(lockedBrand && lockedBrand.locked, 'no-match brand override emits a locked cluster in brands')
  assert.ok(!out.people.some((e) => e.canonical === '云洲仪器'), 'the brand decree did NOT leak into people')
  assert.ok(!out.terms.some((e) => e.canonical === '云洲仪器'), 'the brand decree did NOT leak into terms')
  assert.equal(out.terms.length, 1, 'terms untouched')
})

test('applyOverridesToMerged with no overrides returns the bundle unchanged (fresh copies)', () => {
  const merged = mergedBundle()
  for (const ov of [undefined, null, [], [{ variants: ['x'] }]]) { // last: no canonical → ignored
    const out = applyOverridesToMerged(merged, ov)
    assert.deepEqual(out.people.map((e) => e.canonical).sort(), ['陈涛', '陈焘'].sort())
    assert.ok(!out.people.some((e) => e.locked), 'nothing locked without a valid override')
  }
})

// ---------- dropLocked (verify-target filter) ----------

test('dropLocked removes only locked clusters, keeping the rest for verify', () => {
  const merged = applyOverridesToMerged(mergedBundle(), [{ canonical: '陈涛', variants: ['陈焘'] }])
  const kept = dropLocked(merged)
  assert.equal(kept.people.length, 0, 'the sole (locked) person cluster is dropped from the verify view')
  assert.deepEqual(kept.brands.map((e) => e.canonical), ['示例公司'], 'an unlocked brand stays')
  // the full bundle is untouched — dropLocked is a view, not a mutation
  assert.equal(merged.people.length, 1, 'source bundle still has the locked cluster (render/accumulate use it)')
})

// ---------- excludeVerified (confidence-aware, §1) ----------

test('excludeVerified skips verified/user prior entries, force-re-verifies recheck, keeps unknown', () => {
  const prior = {
    people: [
      { canonical: '王志远', variants: [], confidence: 'user' },     // settled → skip
      { canonical: '李明', variants: [], confidence: 'recheck' },    // force re-verify (even though a verify row covers it)
      { canonical: '周霞', variants: [], confidence: 'verified' },    // settled → skip
    ],
    brands: [], terms: [],
    verified: { resolved: [{ query: '李明', canonical: '李明' }], unresolved: [] },
  }
  const merged = {
    people: clusterEntities([{ canonical: '王志远', variants: [] }, { canonical: '李明', variants: [] }, { canonical: '周霞', variants: [] }, { canonical: '新人物', variants: [] }]),
    brands: [], terms: [],
  }
  const out = excludeVerified(merged, prior)
  const names = out.people.map((e) => e.canonical).sort()
  assert.ok(!names.includes('王志远'), 'confidence:user prior entry is skipped')
  assert.ok(!names.includes('周霞'), 'confidence:verified prior entry is skipped')
  assert.ok(names.includes('李明'), 'confidence:recheck FORCES re-verify — kept despite a covering verify row')
  assert.ok(names.includes('新人物'), 'a brand-new entity (no prior) is kept')
})

test('excludeVerified with no prior returns merged unchanged; a null prior is a no-op', () => {
  const merged = { people: clusterEntities([{ canonical: '甲', variants: [] }]), brands: [], terms: [] }
  assert.equal(excludeVerified(merged, null), merged)
})

test('excludeVerified back-compat: an unknown-confidence prior entry only skips via a verify conclusion (legacy behaviour)', () => {
  // No entry-level confidence markers → the ONLY skip source is prior.verified.resolved, exactly as before.
  const prior = { people: [{ canonical: '甲', variants: ['甲乙'], confidence: 'unknown' }], brands: [], terms: [], verified: { resolved: [{ query: '甲乙', canonical: '甲' }], unresolved: [] } }
  const merged = { people: clusterEntities([{ canonical: '甲', variants: ['甲乙'] }, { canonical: '丙', variants: [] }]), brands: [], terms: [] }
  const out = excludeVerified(merged, prior)
  assert.ok(!out.people.some((e) => e.canonical === '甲'), '甲 skipped via the verify conclusion (unchanged)')
  assert.ok(out.people.some((e) => e.canonical === '丙'), '丙 kept')
})
