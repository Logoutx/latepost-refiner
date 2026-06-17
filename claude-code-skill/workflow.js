export const meta = {
  name: 'transcriber',
  description: 'Scout → verify → glossary → refine+check → summary/timeline for interview transcripts',
  whenToUse: 'transcriber 技能的 Claude Code 快路径：多份访谈转录并行侦察、统一校对表、并行精校与交付物生成',
  phases: [
    { title: 'Scout', detail: '每份转录一个侦察代理，返回结构化清单（默认 haiku）' },
    { title: 'Verify', detail: '关键实体联网核实（默认 sonnet）' },
    { title: 'Refine', detail: '逐份精校 + 结尾完整性核对（默认 opus + haiku）' },
    { title: 'Logic', detail: '逐份逻辑顺序重排稿（按主线把问答重排成叙事顺序，默认 opus）' },
    { title: 'Deliver', detail: '访谈总结 / 时间线（默认 opus）' },
  ],
}

// args contract (assembled by the main agent after the Step 0 pre-flight):
// { topic, date, background, outputDir, skillDir,
//   scope: ['refine','logic','summary','timeline'] trimmed as needed ('logic' = logical-order rewrite, depends on refine output),
//   verifyDepth: 'key'|'deep'|'none', headingPolicy: 'none'|'regenerate'|'keep',
//   models?: {scout,verify,refine,summary,timeline},
//   priorGlossaryText?: full text of an existing <outputDir>/校对表.md (per-company persistent glossary, P1) —
//     Step 0 reads it if present; the workflow parses it to seed scout and accumulates this batch into it.
//   fresh?: true to ignore any prior glossary and rebuild from scratch.
//   files: [{ path, label, lines, bytes?, title, subtitle, outPath, speakerHints?, notes? }] }
//   (bytes optional: from pre-flight `wc -c`; used to shrink the read pagination by density to avoid over-limit truncation)

// ===== Generated from core/* by build/build-cc.mjs — do not edit by hand; edit core/ and re-run build =====

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
  }, extra || {}),
})

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    speakers: { type: 'array', items: { type: 'object', properties: {
      label: { type: 'string', description: '转录中的发言人标签原样' },
      role: { type: 'string', description: '受访者 / 记者 / PR陪同 / 同事 / 协调 等' },
      identity: { type: 'string', description: '对应到谁 + title（若文中可判断）' },
      sample: { type: 'string', description: '一处原文标签样例' },
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

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'array', items: { type: 'object', properties: {
      query: { type: 'string', description: '清单中的候选写法' },
      canonical: { type: 'string', description: '核实后的正确写法' },
      identity: { type: 'string', description: '身份/title' },
      source: { type: 'string', description: '依据来源一句话' },
    } } },
    unresolved: { type: 'array', items: { type: 'object', properties: {
      query: { type: 'string' },
      note: { type: 'string' },
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

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean', description: '成稿是否覆盖到源文件结尾' },
    note: { type: 'string', description: '不完整时说明缺到哪' },
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


// ---------- proofreading rules (kept in sync with SKILL.md Step 2) ----------
const RULES = `精校规范（务必全部遵守）：
1. 保持对话体、不要改写成叙述文章；保留发言人标签，一律用纯文本、不加粗也不加其它样式——写成 张璐： 而不是 **张璐：**，全篇统一（同一份稿子里所有发言人标签样式必须一致）。
2. 删口癖、口语赘词与口语重复，合并语义重复句；以“读着顺、信息不丢”为准——不改语气风格与原意，不替发言人加观点，拿不准就保留，宁可漏删一处也别删出歧义。
   · **径删（纯垫词，无任何语义）**：语气与卡顿音（嗯、呃、啊、哦、欸）；确认复读（对对对、是是是、嗯嗯）；纯卡顿的“那个…这个…就是说…”；句首口头禅式的“然后/其实/就是”；空洞的反问尾巴（对吧、是吧、对不对、你知道——确在向对方求证的留）。
   · **看义删（有义则留，纯垫才删）**：“一个/一种/一些”作量词废垫删、表“一/同一/特指某个”留——“为了让它有一个统一口感”→“为了有统一口感”（删），“跟咖啡豆拼配是一个道理”照留（＝同一个道理，有义），“摆在一个角落、同一个时间、给他一个机会”留；“其实”句首口头禅删、表转折（本以为…其实…、但其实）留；“然后”空接续删、表真实先后或因果留；“就是”卡顿垫词删、表“正是/只是/即”留；“的话”纯提顿删（“做手工的话”→“做手工”）、真条件（“需要的话”）留。
   · **基本别动（多为实义，硬删反而改义）**：“我觉得/我感觉”标记的是发言人立场，删了会把看法读成事实，仅紧邻重复时合并；“一点/一下”表程度或轻微动作，“对…来说/来讲”“包括”“比如”是框定与举例——一般照留。
   纯粹确认写法的来回**折叠成结果**：口头拼字（“吴，哪个杰？”“捷报的捷——提手旁那个”“哦，口天的吴”）在书面稿里没有残值，在名字首次出现处直接写澄清后的写法（“吴捷”），整段问字对话删去——但必须用**澄清后**的字（捷，非先听到的杰）；夹有信息量内容（名字来历/玩笑）的只删机械确认、内容照留；没澄清出结果的保留（音）。
3. 理顺破碎口语、修语序与冗余助词；有信息量/有个性的金句照留，不要抹平。
4. 按主题加 ## 小标题：准确概括、不篡改原意、不加原文没有的结论；一律不编号；一份通常 6–20 个。
5. 严格按校对表统一人名/品牌/术语；删姓名后/夹行时间戳与英文听写乱码（能判断词义就替换，判断不了就顺掉）；拿不准的名字保留（音），绝不臆造。
6. 保留全部事实细节（数字/金额/时间/产品/工艺/渠道/观点）——精校不是摘要。
7. 发言人规范：采访方追问归对应记者名；被访方旁白/补充按校对表标注；拒答/「以招股书为准」等语境务必原样保留，勿替受访者补数字。
8. 文件抬头：首行 H1 标题，第二行斜体说明行。
9. 中文引号一律用全角 “”（内层 ‘’）——禁用 ASCII 直引号 "/'、禁用「」/『』；其余中文标点（，。；：？！）也用全角。转写常把引号输成直引号，逐一改成全角弯引号。代码/英文专名/路径里的 ASCII 引号不动。
10. 数字用阿拉伯数字：把汉字数字改成阿拉伯数字（十六个部门→16 个部门，六七十 B 大模型→60-70B 大模型，三四百人→300-400 人，约数范围用连字符）。例外——很短的口语化小数目保留汉字：两个人、三五个、一两次、七八年、一两句话 等约定俗成口语不转；成语/固定词不动（三心二意、五花八门、一五一十）。带量词的确切数目（16 个、3 轮、5 家）一律用阿拉伯数字。
11. 中文与英文/数字之间加一个半角空格（盘古之白）：汉字与拉丁字母、阿拉伯数字相邻处插一个空格（用 GPT-4 做、16 个部门、覆盖 80% 用户、A 轮融资、2021 年底）。不加空格：①数字与紧跟的单位/符号之间（60-70B、80%、$50、5G、A4）；②与全角标点相邻处；③英文/数字内部与 ASCII 标点之间。已正确成对的空格不要再叠加。
12. 长文件分多次接力写（先 Write 抬头+开头，再用 Edit 以已写入的最后一句为锚点追加），务必覆盖到源文件结尾。**每次 Write/Edit 都在单次输出上限内写尽量大的整块（通常一次写完一整段主题、上千字），用尽量少的写入次数完成——别一行一行或一小段一小段地追加。**
13. **一次写对，别回头微改**：术语/人名/品牌按“写法统一”指令与校对表在初次落笔时就写对；**严禁写完后再回头做大量“改一两个字”的细小 Edit**（每次 Edit 都要把整份转录+校对表重新过一遍，十几个小改 = 成倍拖慢）。确需更正就把多处合并成尽量少的几次 Edit，别逐字逐处单独改。`

// Chinese typesetting rules (same source as RULES items 9/10/11): injected into every sub-agent that generates Chinese.
// Proofreading agents already get them via RULES; summaries/timelines inject this compact version separately
// (timelines are the densest for numbers/years/amounts, so rules ② and ③ matter most there).
const TYPESET = `中文排版三规范（务必遵守）：
①引号一律用全角 “”（内层 ‘’），禁用 ASCII 直引号 "/' 与「」『』（代码/英文/路径除外）；其余中文标点也用全角。
②数字用阿拉伯数字（十六→16、六七十 B→60-70B、三四百→300-400，约数范围用连字符）；很短的口语小数目（两个人/三五个/一两次）与成语（三心二意/五花八门）保留汉字。
③盘古空格：中文与英文/阿拉伯数字相邻处加一个半角空格（用 GPT-4 做、16 个、覆盖 80%、A 轮、2021 年）；数字与紧跟的单位/符号间（60-70B、80%、$50）、与全角标点相邻处不加。`

// Single-file one-pass branch does not build a standalone glossary — use a sentinel constant rather than scattered
// string literals so that timelinePrompt can branch into the “no glossary” fallback path.
const SINGLE_FILE_GLOSSARY = '（单文件一遍过，未建独立校对表；校对决定见成稿与精校报告）'


// ---------- pure JS merge (no model cost) ----------
// Generic titles / honorifics are “weak keys”: sharing one alone is insufficient to identify the same person.
// In a transcript “张总” may simultaneously refer to the interviewee (politely addressed as 张总) and the
// chairman; “陆总 / 老师 / 董事长” follow the same pattern. Chaining clusters on any shared string means a
// single ambiguous honorific would collapse multiple distinct people into one blob.
// Rule: only merge when a “strong name” (real name / product name / term — not a generic title) is shared;
// never merge on weak keys alone. Under-merging is safer than over-merging:
// under-merging leaves two entries and the proofreader resolves them from the source text;
// over-merging writes two different people as one, corrupting the final transcript.
function isWeakKey(s) {
  return /^[一-龥]{1,2}总$/.test(s)            // e.g. 张总, 陆总, 王总 (one/two-char surname + 总)
    || /(老师|总监|经理|主管)$/.test(s)
    || /^(董事长|老板|老板娘|总经理|总裁|创始人|CEO|CFO|CTO|COO|PR|嘉宾|记者|主持人|同事|领导)$/.test(s)
}
// The scout sometimes stuffs an identity description into canonical (e.g. “张总（蜜雪冰城董事长）”),
// which defeats the `^X总$` pattern in `isWeakKey`. Strip parenthetical annotations before testing
// whether a string is a weak title, exposing the bare honorific.
// Used only in the name guard — does not touch the merge keys inside `clusterEntities`.
const stripDesc = (s) => (s || '').replace(/[（(][^）)]*[）)]/g, '').trim()
// Garbled-scout detection: when the network corrupts the generation stream mid-flight, the scout returns
// structurally valid JSON whose content is gibberish (a long run of rare CJK characters that the schema
// cannot reject), which would pollute the glossary. The signal: legitimate entity names and speaker labels
// are short, and long names are always interrupted by punctuation (e.g. “大咖国际（…）”); garbled output
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
    const hints = Array.from(new Set(c.entries.map((e) => e.hint).filter(Boolean))).slice(0, 2)
    const files = Array.from(new Set(c.entries.map((e) => e.file)))
    return {
      canonical,
      variants,
      hint: hints.join('；'),
      files,
      public_figure: c.entries.some((e) => e.public_figure),
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
  const row = (e) => `- ${e.canonical} ← ${e.variants.join(' / ') || '（无变体）'} ｜ ${e.hint || ''}${e.public_figure ? ' ｜ 公众人物' : ''}`
  const tagged = []
  for (const [sec, list] of [['人名', merged.people], ['品牌/公司/产品', merged.brands], ['术语', merged.terms]]) {
    for (const e of list) tagged.push({ sec, e, w: entityWorth(e) })
  }
  const eligible = (depth === 'deep' ? tagged.slice() : tagged.filter((t) => t.w > 0)).sort((a, b) => b.w - a.w)
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

// Completion report and authoritative output path: rep.path is self-reported by the proofreading agent;
// all downstream consumers use f.outPath, which is the path we instructed it to write to.
const withCheck = (rep, chk, f) => Object.assign({}, rep, {
  outPath: f.outPath,
  // Normalise to a strict three-state: true / false / null.
  // A failed check agent or a response missing this field (schema does not enforce it) both map to null (unchecked).
  // Leaving it as undefined would let it slip through both the "incomplete" and "unchecked" guards.
  complete: (chk && typeof chk.complete === 'boolean') ? chk.complete : null,
  checkNote: chk ? (chk.note || '') : 'check agent failed',
})

// Fallback for the pre-flight grep: if the scout finds that a source file already has headings but
// headingPolicy is still 'none' (the pre-flight check didn't catch it), the user must be asked at wrap-up.
function findHeadingConflicts(findings, files, policy) {
  if ((policy || 'none') !== 'none') return []
  return files.filter((f, i) => findings[i] && findings[i].has_existing_headings).map((f) => f.label)
}

function renderGlossary(merged, verified, dedup, a) {
  // Apply verified results back into the body entries first: if query matches an entry's canonical or
  // any variant, replace canonical with the verified spelling (folding the original into variants)
  // and merge the identity into hint — the archived glossary body is authoritative; no footnote corrections.
  const resolvedMap = new Map()
  for (const r of (verified && verified.resolved) || []) resolvedMap.set(r.query, r)
  const applied = new Set()   // verified conclusions actually applied into the table body
  const rejected = new Set()  // verified conclusions blocked by the person-name guard
  const applyVerified = (e, isPerson) => {
    const hit = resolvedMap.get(e.canonical) || (e.variants || []).map((v) => resolvedMap.get(v)).find(Boolean)
    if (!hit) return e
    const names = [e.canonical, ...(e.variants || [])]
    // Name guard: if this entry already contains a real name (strong name) and the verifier returns a
    // different strong name not present in this entry, it likely indicates a misattribution
    // (observed in the wild during network degradation: verify hallucinated 张璐→张红超, rewriting the
    // interviewee as the chairman). Do not rewrite the body; append a warning note instead.
    // The harm of replacing one person with another far outweighs leaving a name unresolved.
    // Weak titles (张总 / 董事长) resolving to a real name are still applied normally — that is the
    // whole point of verification.
    // Note: the guard checks `ownStrong`, the set of strong names across ALL names in this entry, not
    // just canonical — clustering may elect a weak title (张总) as canonical while placing the real name
    // (张璐) in variants; checking only canonical would leave the guard blind to those cases.
    const ownStrong = names.map(stripDesc).filter((n) => n && !isWeakKey(n))
    if (isPerson && hit.canonical && ownStrong.length
        && !ownStrong.includes(stripDesc(hit.canonical)) && !isWeakKey(stripDesc(hit.canonical))) {
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
  const sec = []
  sec.push(`# ${a.topic} 统一校对表（采访时间 ${a.date}）`, '', '## 采访背景', a.background, '')
  sec.push('## 发言人统一标注')
  for (const s of merged.speakersByFile) {
    sec.push(`**${s.label}**`)
    for (const sp of s.speakers) { if (sp && sp.label) sec.push(`- ${sp.label} → ${sp.role || '?'}${sp.identity ? `（${sp.identity}）` : ''}`) }
  }
  // Cross-interview speaker registry (P3): a derived view unifying speakers that recur across ≥2 files
  // (chiefly the interviewer), so refine labels them consistently and the human sees who recurs.
  const reg = buildSpeakerRegistry(merged.speakersByFile)
  if (reg.length) { sec.push('', '## 发言人登记（跨访谈）'); for (const r of reg) sec.push(`- ${r.label}（${r.role}）${r.identity ? ` ｜ ${r.identity}` : ''} ｜ 出现：${r.files.join('、')}`) }
  const block = (title, list, isPerson) => {
    sec.push('', `## ${title}（写法 → 统一）`)
    for (const e0 of list) {
      const e = applyVerified(e0, isPerson)
      sec.push(`- **${e.canonical}** ← ${e.variants.join(' / ') || '—'}${e.hint ? ` ｜ ${e.hint}` : ''}${e.crossFile ? ' ｜ 多份互证' : ''}`)
    }
  }
  block('人名', merged.people, true)
  block('品牌 / 公司 / 产品', merged.brands)
  block('术语 / 专名', merged.terms)
  sec.push('', '## 需特别处理的转写错误')
  for (const er of merged.errors) sec.push(`- [${er.file}] ${er.kind}：${er.examples.slice(0, 6).join('；')}`)
  if (merged.notes.length) sec.push('', '## 各份特别提醒', ...merged.notes.map((n) => '- ' + n))
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
    for (const u of verified.unresolved || []) sec.push(`- ${u.query}：未能核实，保留（音）${u.note ? ` ｜ ${u.note}` : ''}`)
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
  return sec.join('\n')
}

// Defensive filter: drop the model's occasional placeholder/self-negating entries
// (observed in the wild: groups with members < 2, or why = “撤回 / 不适用” noise).
function cleanSuspects(suspects) {
  return (suspects || [])
    .filter((s) => s && (s.members || []).length >= 2 && !/撤回|不适用|不适合|不属于|仅供参考/.test(s.why || ''))
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
  const m = l.match(/^- \*\*(.+?)\*\* ← (.*)$/)
  if (!m) return null
  const parts = (m[2] || '').split(' ｜ ')
  const varsRaw = (parts.shift() || '—').trim()
  const variants = varsRaw === '—' ? [] : varsRaw.split(' / ').map((x) => x.trim()).filter(Boolean)
  let hint = '', crossFile = false
  for (const p of parts) { if (p.trim() === '多份互证') crossFile = true; else if (p.trim()) hint = hint ? `${hint} ｜ ${p.trim()}` : p.trim() }
  return { canonical: m[1], variants, hint, crossFile }
}
function parseResolvedLine(body, out) {
  let s = body, rejected = false
  if (s.startsWith('⚠ ')) { rejected = true; s = s.slice(2) }
  const rm = s.match(/^(.+?) → \*\*(.+?)\*\*(?:（(.+?)）)?(?:\s*｜\s*(?!依据：).*?)?\s*｜\s*依据：(.*)$/)
  if (rm) { out.push({ query: rm[1], canonical: rm[2], identity: rm[3] || '', source: rm[4], rejected }); return true }
  return false
}
function parseGlossary(md) {
  const g = { topic: '', date: '', background: '', speakersByFile: [], people: [], brands: [], terms: [], errors: [], notes: [], verified: { resolved: [], unresolved: [] }, dedupSuspects: [], doNotMerge: [], extra: [] }
  if (!md || !md.trim()) return g
  const lines = md.split('\n')
  const mh = (lines.find((l) => /统一校对表/.test(l)) || '').match(/^#\s*(.+?)\s*统一校对表（采访时间\s*(.+?)）/)
  if (mh) { g.topic = mh[1]; g.date = mh[2] }
  const sections = []
  let cur = { title: '__preamble__', body: [] }
  for (const l of lines) { const m = l.match(/^##\s+(.*)$/); if (m) { sections.push(cur); cur = { title: m[1], body: [] } } else cur.body.push(l) }
  sections.push(cur)
  const get = (re) => sections.find((s) => re.test(s.title))
  const bg = get(/^采访背景/); if (bg) g.background = bg.body.join('\n').trim()
  const spk = get(/^发言人统一标注/)
  if (spk) {
    let grp = null
    for (const l of spk.body) {
      const mb = l.match(/^\*\*(.+?)\*\*\s*$/)
      if (mb) { grp = { label: mb[1], speakers: [] }; g.speakersByFile.push(grp); continue }
      const ms = l.match(/^- (.+?) → (.+?)(?:（(.+)）)?$/)
      if (ms && grp) grp.speakers.push({ label: ms[1], role: ms[2], identity: ms[3] || '' })
    }
  }
  const parseEntities = (sec) => { const out = []; if (!sec) return out; for (const l of sec.body) { if (!l.startsWith('- ')) continue; const e = parseEntityLine(l); if (e) out.push(e); else g.extra.push(l) } return out }
  g.people = parseEntities(get(/^人名（写法/))
  g.brands = parseEntities(get(/^品牌.*（写法/))
  g.terms = parseEntities(get(/^术语.*（写法/))
  const errs = get(/^需特别处理的转写错误/)
  if (errs) for (const l of errs.body) { const m = l.match(/^- \[(.+?)\]\s*(.+?)：(.*)$/); if (m) g.errors.push({ file: m[1], kind: m[2], examples: m[3] ? m[3].split('；') : [] }) }
  const nt = get(/^各份特别提醒/)
  if (nt) for (const l of nt.body) { const m = l.match(/^- (.+)$/); if (m) g.notes.push(m[1]) }
  for (const vsec of [get(/^联网核实结论/), get(/^补核结论/)]) {
    if (!vsec) continue
    for (const l of vsec.body) {
      if (!l.startsWith('- ')) continue
      const body = l.slice(2)
      const un = body.match(/^(.+?)：未能核实，保留（音）(?:\s*｜\s*(.*))?$/)
      if (un) { g.verified.unresolved.push({ query: un[1], note: un[2] || '' }); continue }
      if (!parseResolvedLine(body, g.verified.resolved)) g.extra.push(l)
    }
  }
  const dr = get(/^写法统一/)
  if (dr) for (const l of dr.body) {
    const m = l.match(/^- (.+?) → 统一写 \*\*(.+?)\*\*（(.*)）$/)
    if (m) { const members = m[1].split(' / ').map((x) => x.trim()).filter(Boolean); if (!members.includes(m[2])) members.push(m[2]); g.dedupSuspects.push({ members, kind: 'term', preferred: m[2], why: m[3] }) }
  }
  const fl = get(/^疑似同指/)
  if (fl) for (const l of fl.body) { const m = l.match(/^- (.+?)（(.+?)）：(.*)$/); if (m) g.dedupSuspects.push({ members: m[1].split(' ／ ').map((x) => x.trim()).filter(Boolean), kind: m[2], why: m[3] }) }
  const dn = get(/^确认不同指/)
  if (dn) for (const l of dn.body) { const m = l.match(/^- (.+)$/); if (m) { const grp = m[1].split(' ／ ').map((x) => x.trim()).filter(Boolean); if (grp.length >= 2) g.doNotMerge.push(grp) } }
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
      if (!home.hint && fe.hint) home.hint = fe.hint
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
  }
}
// Carry prior verify conclusions forward; fresh overrides prior for the same query; a resolved query
// is removed from unresolved.
function mergeVerified(priorV, freshV) {
  const r = new Map(), u = new Map()
  for (const v of [priorV, freshV]) { if (!v) continue; for (const x of v.resolved || []) if (x && x.query) r.set(x.query, x); for (const x of v.unresolved || []) if (x && x.query) u.set(x.query, x) }
  for (const q of r.keys()) u.delete(q)
  return { resolved: Array.from(r.values()), unresolved: Array.from(u.values()) }
}
// Carry prior dedup suspects forward, de-duped by member-set + kind signature.
function mergeDedup(priorSuspects, freshSuspects) {
  const m = new Map()
  for (const s of [...(priorSuspects || []), ...(freshSuspects || [])]) { if (s && (s.members || []).length >= 2) m.set((s.members || []).map((x) => stripDesc(x)).sort().join('|') + '#' + (s.kind || ''), s) }
  return Array.from(m.values())
}

// P2 — verify-cache exclusion: drop entities already covered by the prior glossary's verify conclusions
// from THIS batch's verify list (they stay in the cumulative glossary via mergeIntoPrior + carried-forward
// verified — they just aren't re-checked). The real cost/latency win of the persistent glossary.
function excludeVerified(merged, prior) {
  if (!prior) return merged
  const done = new Set()
  for (const r of (prior.verified && prior.verified.resolved) || []) { if (r && r.query) done.add(stripDesc(r.query)); if (r && r.canonical) done.add(stripDesc(r.canonical)) }
  if (!done.size) return merged
  const covered = (e) => [e.canonical, ...(e.variants || [])].some((n) => done.has(stripDesc(n)))
  const filt = (list) => (list || []).filter((e) => !covered(e))
  return Object.assign({}, merged, { people: filt(merged.people), brands: filt(merged.brands), terms: filt(merged.terms) })
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

function scoutPrompt(f, a) {
  return `你是访谈转录「侦察」子代理。

采访背景：${a.background}

本份文件：${f.path}（约 ${f.lines} 行）
${f.speakerHints ? `已知发言人线索：${f.speakerHints}` : ''}
${f.notes ? `额外提醒：${f.notes}` : ''}
${knownNote(a)}

任务：用 Read 把这份转录**整份读完**（绝不能只读开头），**不精校、不联网、不大段摘录原文**。
${readPlan(f)}
读完后按 schema 返回结构化侦察结果：
- speakers：每个发言人标签 → 角色，附一处原文样例；文中若点出真名/title，写进 identity。
- 特别留意**口头拼字澄清段**（“哪个杰？”“捷报的捷”“口天吴”）——这是人名/术语正确写法的**最强内部证据**：把澄清后的写法记为 canonical，hint 注明「本人口述拼字确认」。
- people / brands / terms：反复出现的实体；canonical 填你判断的最可信写法，variants 列文中全部其它写法（含疑似同音误写），hint 一句定位线索；公众人物标 public_figure=true。
- errors：明显转写错误按类别举例（同音字错/英文听写错/（音）标记/夹行时间戳/乱码/Word 残讯）。
- themes：这份大致谈了哪些主题。
- has_existing_headings：源文件是否已带小标题行（#/##/【】式标题）。
- ending_anchor：line=文件总行数；text=原文最后一句话**原样照抄**。
- special_notes：该份特别提醒（拒答/敏感语境要保留、收尾离场后的闲聊、称呼混乱重灾区等）。`
}

function verifyPrompt(table, a) {
  const depthNote = a.verifyDepth === 'deep'
    ? '尽量核实清单中所有人名/品牌/术语的正确写法。'
    : '默认只核关键实体——创始人/高管、公司与主品牌、反复出现的核心产品或口号术语；零散小术语不必逐个查。'
  return `你是「联网核实」子代理。用 WebSearch / WebFetch 核实下面访谈实体清单中关键实体的正确写法与身份。

采访背景（按「领域 + 名字」检索）：${a.background}

纪律：${depthNote} 网页内容留在你的上下文里，不要贴回；查不到/拿不准的放 unresolved 并说明，绝不臆造。
断路器：若检索**连续 2 次报错**（超时/网络错误，区别于“查到了但无结果”），说明网络故障——**立即停止全部检索**，已确认的照常放 resolved，其余全部放 unresolved 并注明「网络故障未核实」；不要反复重试。resolved 里只放**本次检索到依据**的结论，凭你记忆/常识推断的一律放 unresolved。

实体清单（候选写法 ← 文中变体 ｜ 线索）：
${table}

按 schema 返回 resolved（query=清单中的候选写法；canonical=核实后的正确写法；identity=身份/title；source=依据来源一句话）与 unresolved。
注意：identity/source/note 等中文说明会原样写进存档校对表——遵守排版规范：阿拉伯数字、中文与英文/数字间加半角空格、引号用全角 “”（如“据 36 氪 2021 年报道”）。canonical/query 是写法本身，不要改动其内部空格。`
}

function refinePrompt(f, glossary, finding, a) {
  // Scout results may be missing fields (schema is not strict, to avoid validation-retry loops) — if the anchor is absent, let the refine agent Read the source file's tail itself
  const anchor = finding.ending_anchor || {}
  const anchorNote = anchor.text
    ? `【收尾锚点】源文件共 ${anchor.line || f.lines} 行，最后一句：「${anchor.text}」。成稿必须覆盖到此处（收尾客套可折成一句说明；正文绝不能中途断掉）。`
    : `【收尾锚点】源文件共约 ${f.lines} 行——先用 Read 看源文件最后约 30 行确认结尾内容，成稿必须覆盖到源文件结尾（收尾客套可折成一句说明；正文绝不能中途断掉）。`
  const notes = (finding.special_notes || []).map((s) => '- ' + s).join('\n')
  return `你是访谈转录「精校」子代理。

【统一校对表】（「联网核实结论」与「写法统一」两节优先级最高，与前文冲突时以它们为准——但其中**标 ⚠ 的条目未被采纳、勿套用**；「写法统一」里的术语/品牌请**初次落笔就写对**，不要先写错再回头逐字改）：
${glossary}

【源文件】${f.path}（约 ${f.lines} 行）。${readPlan(f)}
【输出】Write 到 ${f.outPath}
【抬头】第一行 \`# ${f.title}\`；第二行 \`${f.subtitle}\`
【该份发言人】${(finding.speakers && finding.speakers.length) ? JSON.stringify(finding.speakers) : '侦察未提取到发言人——精校时据原文发言人标签自行归位（若有），见规范 1/7'}
${notes ? `【该份特别提醒】\n${notes}` : ''}
${headingNote(a.headingPolicy)}

${RULES}

${anchorNote}

完成后按 schema 返回 path、headings、key_fixes、open_questions。`
}

function checkPrompt(f, anchor) {
  const src = (anchor && anchor.text)
    ? `源转录共 ${anchor.line || '?'} 行，原文最后一句是：“${anchor.text}”。`
    : `先用 Read 读源文件 ${f.path} 的最后约 30 行，确定原文结尾内容。`
  return `你是「结尾完整性」核对代理。${src}
用 Read 读成稿 ${f.outPath} 的最后约 60 行。**判 complete 前先确认成稿倒数若干段的实质内容确实对应到了源文件结尾（上面的锚点附近）**：
- 对应上了 → complete=true。
- 成稿在**远早于结尾处**就以一句收束注（如“后续为离场闲聊，从略”）收住、中间大段源文件内容缺失 → 这是中途截断，**complete=false**，在 note 写明大约从哪一段起缺。
- 只有当收束注**前一段已对应到源文件末尾区域**时，该收束注才算正常收尾（complete=true）。
按 schema 返回 complete 与 note。`
}

function dedupPrompt(listText, a) {
  return `你是「疑似同指」核查子代理。下面是从多份访谈里抽出、已按“共享强名”聚类后的实体清单。聚类是纯字符串匹配，**抓不到写法完全不同、却其实指同一对象**的情况——例如同音异写的人名（周勇 / 尹勇）、口号的不同转写（三现主义 / 三线主义）、同一产品的不同叫法。

采访背景（判断时参考）：${a.background}

任务：通读清单，**只挑出你怀疑其实是同一对象、但被聚成了不同条目**的组。判断依据：同音/形近、身份线索（hint）一致、同一文件里的角色重叠等。
纪律（重要）：
- 你只**标记**，**绝不**断言合并——拿不准也列出来，由人工/精校最终定夺；宁可多报，不可漏报。
- 真正不同的对象（如董事长 张红超 与其弟 张红甫；不同竞品）**不要**列。
- **suspects 里只放你真心建议人工确认的组**；不要放“此组不适用/撤回/仅供参考”之类的占位或自我否定项——拿不准要不要放，就别放。
- 每组 members 至少 2 个写法；给出 kind（person/brand/term）、why（一句话理由）。没有可疑项就返回空 suspects=[]。
- **preferred（关键）**：当 kind 是 **term/brand**（术语/口号/品牌/产品名）且你有把握时，给出该组的**正确标准写法**（必须是 members 里的某一个，如「真鲜醇 / 真鲜纯」给 preferred=「真鲜纯」）——这会作为“写法统一”指令直接交给精校套用，省去它来回改字。**人名（person）一律留空 preferred**（合并人名身份须人工确认，绝不自动并）；术语但你拿不准标准写法的也留空。

${(a.doNotMerge && a.doNotMerge.length) ? `已人工确认为**不同对象**、**勿再标记为疑似同指**：${a.doNotMerge.map((p) => (p || []).join('／')).join('；')}\n` : ''}实体清单（canonical ← 变体 ｜ 线索 ｜ 类别/出处）：
${listText}

按 schema 返回 suspects。注意：why（理由）会原样写进存档校对表——遵守排版规范：阿拉伯数字、中文与英文/数字间加半角空格、引号用全角 “”。members/preferred 是写法本身，不要改动其内部空格。`
}

function singlePassPrompt(f, a) {
  return `你是访谈转录「精校」子代理（单文件一遍过）。

采访背景：${a.background}

【源文件】${f.path}（约 ${f.lines} 行）。先把全文**整份读完**。${readPlan(f)}
边读边记发言人对应、人名/品牌/术语的各种写法、明显转写错误（同音/英文/时间戳/乱码），在心里建一张迷你校对表（不必落盘）；拿不准的名字保留（音），绝不臆造。然后按规范精校全文：
【输出】Write 到 ${f.outPath}
【抬头】第一行 \`# ${f.title}\`；第二行 \`${f.subtitle}\`
${f.speakerHints ? `【发言人线索】${f.speakerHints}` : ''}
${f.notes ? `【额外提醒】${f.notes}` : ''}
${headingNote(a.headingPolicy)}
若读全文时发现源文件其实已带（记者/速记的）小标题、而上方又没有【小标题处理】交代——按默认规范精校，但把这一情况写进 open_questions 提醒委托方决定保留还是重做。

${RULES}

完成后按 schema 返回 path、headings、key_fixes、open_questions。`
}

function summaryPrompt(a, refined) {
  const list = refined.map((r) => '- ' + (r.outPath || r.path)).join('\n')
  return `你是「访谈总结」子代理。基于以下精校成稿（先逐一 Read），产出《${a.topic}访谈总结》：
${list}

结构模板：先 Read ${a.skillDir}/references/deliverables.md 的「访谈总结」部分。
三部分：分类要点（### 按主题小节，每条带具体事实或数字）；金句 Quotes（按发言人归类，忠实引用、只去口癖不改意）；行业与公司/人物洞察（分行业与该公司/人物两块，点出看点与风险，体现判断而非复述）。**所有标题一律不编号**（洞察等列表项也用 - 项目符号，不要 1./一、编号）。

${TYPESET}

写到 ${a.outputDir}/${a.topic}访谈总结.md（输出根目录，不是 Transcripts/）。抬头 H1 + 第二行斜体说明（受访者与采访方、采访时间 ${a.date}）。末尾注一行配套文档（Transcripts/ 下各精校全文）。
你的最终回复即返回值：输出路径 + 各部分小节标题清单。`
}

function timelinePrompt(a, glossary, refined) {
  const list = refined.map((r) => '- ' + (r.outPath || r.path)).join('\n')
  const hasGlossary = glossary && glossary.trim() && glossary !== SINGLE_FILE_GLOSSARY
  const glossaryBlock = hasGlossary
    ? `附关键人物对照表（结合下方校对表的真名核实结论；查不到的标“真名未公开”）。\n\n统一校对表（含核实结论）：\n${glossary}`
    : `附关键人物对照表——本次无独立校对表，关键人物真名请你直接用 WebSearch 现查、查不到标“真名未公开”，绝不臆造。`
  return `你是「时间线」子代理。把 ${a.topic} 访谈口述与公开资料对照，产出《${a.topic}时间线》。

步骤：先 Read ${a.skillDir}/references/deliverables.md 的「时间线」部分作为结构模板；再逐一 Read 本次精校成稿（只读下面这些——目录里可能还有往次旧稿，不要读）：
${list}
抽出所有带时间/阶段的事实（成立、产品、融资、人事、渠道、出海…）；然后用 WebSearch / WebFetch 按“公司名 + 融资/成立/创始人”等核实年份、轮次、金额、关键人物（网页留在你的上下文里）。访谈与公开资料冲突时两边都列、注明分歧，不强行二选一；逐条标【访谈】/【公开】/【公开+访谈】；${glossaryBlock}

${TYPESET}

写到 ${a.outputDir}/${a.topic}时间线.md。标题一律不编号。你的最终回复即返回值：输出路径 + 时间线小节清单。`
}

// Logic-reordered draft: reads the **refined transcript** (not the raw source — names/terms already unified), reordering Q&A from recording order into narrative order.
// Order-preserving reconstruction (lossless): Q&A blocks are copied verbatim, positions only are swapped; [Editor] bridging notes added only where a move breaks a reference.
function logicWritePrompt(f, a) {
  return `你是「逻辑顺序重排」子代理。把一份**已精校**的访谈稿从“录音顺序”重排成“叙事顺序”——让散落在访谈各处、其实属于同一条线的问答聚到一起，读起来是一个完整的故事。**这是重排，不是改写、更不是摘要**：问答块整段照搬精校稿原文，一字不改、一处不漏，只调换位置。

【输入·精校稿】${f.outPath}（已精校，人名/术语已统一）。${readPlan(f)}（这是读精校稿——它可能比源文件略短，读到没有更多内容即止。**只读这一份，不读源转录、不联网。**）
【结构模板】先 Read ${a.skillDir}/references/deliverables.md 的「逻辑顺序稿」部分。
【输出】Write 到 ${a.outputDir}/逻辑顺序/${f.title}.md
【抬头】第一行 \`# ${f.title} · 逻辑顺序稿\`；第二行斜体：\`*基于精校稿重排为叙事顺序，内容照搬未改，仅调顺序 + 少量 [编者] 衔接；原顺序见 Transcripts/${f.title}.md*\`

做法：
1. 通读精校稿，**理出这次访谈的主线**：3–7 条叙事线索（如 创业缘起 / 战略转折 / 某产品始末 / 组织 / 行业判断），各给一个自描述 \`##\` 小标题（**一律不编号**）。
2. 每条线索选一个**内部顺序逻辑**：讲历史按时间，讲决策按 问题→洞察→决定→结果，讲产品/事件按 起因→经过→结果。
3. 把精校稿里属于该线索的问答**整段照原文搬过来**，按上面的逻辑排好——保留 \`发言人：\` 标签**及其在精校稿里的原样式**（精校稿是 \`张三：\` 就写 \`张三：\`，**别改成** \`**张三：**\` 加粗或其它样式）、保留全部事实细节与原话措辞，**只换位置，不改一字**。
4. **指代修复（克制）**：仅当某段被移走后、开头的“他 / 那个 / 上面说的 / 然后”等指代或承接断了，才加一句 \`> [编者] …\` 衔接（如“此段原在访谈后段，承前文同属早期创业”），或把孤立的“他”补成名字。**绝不**改写原话、绝不补受访者没说的、绝不替他下结论。
5. **不丢不重**：精校稿里每一段实质问答都要在重排稿里出现且**只出现一次**（纯客套/重复可省，与精校稿口径一致）。一段问答若横跨两条线索，放进主线索一次，必要时另一处用一句 \`> [编者]\` 指路。
6. 开头加一节 \`## 主线脉络（导读）\`：一段话讲清这次访谈的主线与你的重排逻辑。

${TYPESET}

完成后按 schema 返回：path、mainline（导读那段）、threads（每条线索的 title、logic、以及它取自精校稿的哪些小标题 source_sections——**source_sections 必须原样照抄精校稿里的 \`##\` 小标题文字**，供完整性核对）、open_questions。`
}




async function runPipeline(A, engine) {
const M = Object.assign(
  { scout: 'haiku', verify: 'sonnet', dedup: 'sonnet', refine: 'opus', logic: 'opus', summary: 'opus', timeline: 'opus' },
  A.models || {}
)
const scope = A.scope || ['refine']
const EMPTY_RETURN = (error) => ({ error, glossary: '', refined: [], failed: [], incomplete: [], unchecked: [], headingConflicts: [], scoutSuspect: [], suspectedDuplicates: [], networkUnverified: [], logic: [], openQuestions: [], summary: null, timeline: null })
if (!Array.isArray(A.files) || A.files.length === 0) {
  return EMPTY_RETURN('args.files 为空——需在 Step 0 预检后组装 files 再派发')
}
// summary / timeline / logical-order rewrite all take this session's refined output as input; a scope with a
  // deliverable but no refine would silently produce nothing — so fail early and diagnosably.
if ((scope.includes('summary') || scope.includes('timeline') || scope.includes('logic')) && !scope.includes('refine')) {
  return EMPTY_RETURN('summary/时间线/逻辑顺序稿依赖本会话 refine 产物，scope 须同时含 refine（本工作流不支持只对历史成稿单独出交付物）')
}

// Persistent per-company glossary (P1): if Step 0 found an existing 校对表.md and passed its text,
// parse it into prior memory to seed scout + accumulate into. A.fresh forces a from-scratch rebuild.
// Attached to A so scoutPrompt can read it. Absent/empty → null → behaviour identical to a first run.
const prior = (A.priorGlossaryText && !A.fresh) ? parseGlossary(A.priorGlossaryText) : null
A.prior = prior
A.doNotMerge = (prior && prior.doNotMerge) || []   // P4: human-confirmed distinct referents, carried forward to dedup + render
let conflicts = []                                  // P4: this batch's verify conclusions that disagree with the prior glossary
if (prior) engine.log(`沿用往次校对表：已知 ${prior.people.length} 人名 / ${prior.brands.length} 品牌 / ${prior.terms.length} 术语、${(prior.verified.resolved || []).length} 条核实结论——本轮在其上累积`)

let glossary = ''
let netUnverified = []
let refined = []
let failed = []
let headingConflicts = []
let scoutSuspect = []
let dedup = null
let refinedPairs = []   // [{ f, rep }]: successfully refined files and their reports (including headings); used by the logic-reorder phase to read f.title/outPath and verify section-heading coverage

if (A.files.length === 1 && (A.files[0].lines || 9999) < 400) {
  // Single short file: one-pass refine (mirrors the fast path in SKILL.md), skip Scout/Verify
  const f = A.files[0]
  engine.phase('Refine')
  engine.log(`单份短文件（${f.lines} 行）：一遍过精校，不建独立校对表`)
  const rep = await engine.agent(singlePassPrompt(f, A), { label: `refine:${f.label}`, model: M.refine, schema: REFINE_REPORT_SCHEMA })
  if (rep) {
    const chk = await engine.agent(checkPrompt(f, null), { label: `check:${f.label}`, model: 'haiku', schema: CHECK_SCHEMA })
    refined = [withCheck(rep, chk, f)]
    refinedPairs = [{ f, rep: refined[0] }]
  } else {
    failed = [f.label]
  }
  glossary = SINGLE_FILE_GLOSSARY
} else {
  engine.phase('Scout')
  let findings = await engine.parallel(A.files.map((f) => () =>
    engine.agent(scoutPrompt(f, A), { label: `scout:${f.label}`, model: M.scout, schema: SCOUT_SCHEMA })))
  // Garbled-scout self-healing: if a scout result looks garbled, retry it once (a haiku call is cheap); if still garbled, flag it in scoutSuspect and warn at delivery that the glossary entry for that file is unreliable.
  // The refined transcript is unaffected — refine reads the source file directly and does not blindly trust the scout output — but the archived glossary entry for that file will be dirty.
  const retryIdx = A.files.map((f, i) => (findings[i] && scoutLooksGarbled(findings[i])) ? i : -1).filter((i) => i >= 0)
  if (retryIdx.length) {
    engine.log(`侦察疑似损坏（疑网络中途毁坏生成流）：${retryIdx.map((i) => A.files[i].label).join('、')}——各重试一次`)
    const retries = await engine.parallel(retryIdx.map((i) => () =>
      engine.agent(scoutPrompt(A.files[i], A), { label: `scout-retry:${A.files[i].label}`, model: M.scout, schema: SCOUT_SCHEMA })))
    retryIdx.forEach((i, k) => { if (retries[k] && !scoutLooksGarbled(retries[k])) findings[i] = retries[k] })
  }
  scoutSuspect = A.files.filter((f, i) => findings[i] && scoutLooksGarbled(findings[i])).map((f) => f.label)
  engine.log(`侦察完成 ${findings.filter(Boolean).length}/${A.files.length} 份${scoutSuspect.length ? `（${scoutSuspect.join('、')} 重试后仍疑损坏，校对表该份不可靠）` : ''}`)
  // Still-garbled scout results are dropped entirely from the merge: this prevents polluting the glossary body and avoids wasting verify/dedup web-lookup calls on garbage input.
  // Refine for that file still runs normally (it reads the source file directly, not the scout output); scoutSuspect still prompts the user to re-run scout for that file.
  // If every scout is garbled, cleanFindings is all-null → merged lists are all empty → doVerify is naturally false and dedupList is empty, so the whole verify/dedup block short-circuits safely.
  const cleanFindings = findings.map((fd) => (fd && scoutLooksGarbled(fd)) ? null : fd)
  const mergedThisBatch = mergeFindings(cleanFindings, A.files)
  headingConflicts = findHeadingConflicts(cleanFindings, A.files, A.headingPolicy)
  if (headingConflicts.length) engine.log(`注意：${headingConflicts.join('、')} 源文件已带小标题但 headingPolicy=none——收尾时需问用户保留还是重做`)

  engine.phase('Verify')
  // verify (web-lookup fact-checking, chunked and parallelised) and dedup (semantic co-reference check across all entities) are independent of each other — run both concurrently in the same parallel
  let verified = null
  // terms count too (verifyChunks already submits terms for checking; the deep level requires all terms to be verified, and omitting terms from the threshold would cause a terms-only interview to silently skip verification)
  // P2: don't re-verify entities the prior glossary already confirmed — verify only this batch's new ones.
  const verifyTarget = excludeVerified(mergedThisBatch, prior)
  if (prior) { const sk = (mergedThisBatch.people.length + mergedThisBatch.brands.length + mergedThisBatch.terms.length) - (verifyTarget.people.length + verifyTarget.brands.length + verifyTarget.terms.length); if (sk > 0) engine.log(`核实缓存：跳过 ${sk} 项往次已核实实体，本轮只核新实体`) }
  const doVerify = A.verifyDepth !== 'none' && (verifyTarget.people.length || verifyTarget.brands.length || verifyTarget.terms.length)
  const vc = doVerify ? verifyChunks(verifyTarget, A.verifyDepth) : { chunks: [], eligible: 0, excluded: 0, overflow: 0 }
  if (doVerify) {
    engine.log(`核实：${vc.eligible} 项分 ${vc.chunks.length} 块并行送检${vc.excluded > 0 ? `，${vc.excluded} 项低优先级未送检（由精校按原文归一）` : ''}`)
    if (vc.overflow > 0) engine.log(`核实：实体过多，${vc.overflow} 项超出 ${VERIFY_CHUNK * MAX_CHUNKS} 上限未送检`)
  }
  const dedupList = dedupListText(mergedThisBatch)
  const [vparts, dedupRes] = await engine.parallel([
    () => vc.chunks.length
      ? engine.parallel(vc.chunks.map((ct, i) => () => engine.agent(verifyPrompt(ct, A), { label: `verify:${i + 1}/${vc.chunks.length}`, phase: 'Verify', model: M.verify, schema: VERIFY_SCHEMA })))
      : Promise.resolve([]),
    () => dedupList
      ? engine.agent(dedupPrompt(dedupList, A), { label: 'dedup:semantic', phase: 'Verify', model: M.dedup, schema: DEDUP_SCHEMA })
      : Promise.resolve(null),
  ])
  const goodParts = (vparts || []).filter(Boolean)
  if (vc.chunks.length) {
    // Row-level sanitisation: the schema no longer enforces fields, so degraded output may be missing query/canonical — rows missing critical fields are dropped outright
    verified = {
      resolved: goodParts.flatMap((p) => p.resolved || []).filter((r) => r && r.query && r.canonical),
      unresolved: goodParts.flatMap((p) => p.unresolved || []).filter((r) => r && r.query),
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
  if (prior) engine.log(`累积合并：校对表现含 ${merged.people.length} 人名 / ${merged.brands.length} 品牌 / ${merged.terms.length} 术语`)
  glossary = renderGlossary(merged, allVerified, allDedup, A)

  let positional = []
  if (scope.includes('refine')) {
    engine.phase('Refine')
    positional = await engine.pipeline(A.files,
      (f, _f, i) => findings[i] && engine.agent(refinePrompt(f, glossary, findings[i], A),
        { label: `refine:${f.label}`, phase: 'Refine', model: M.refine, schema: REFINE_REPORT_SCHEMA }),
      (rep, f, i) => rep && engine.agent(checkPrompt(f, findings[i].ending_anchor),
        { label: `check:${f.label}`, phase: 'Refine', model: 'haiku', schema: CHECK_SCHEMA })
        .then((chk) => withCheck(rep, chk, f)))
  }
  failed = A.files.filter((f, i) => !findings[i] || (scope.includes('refine') && !positional[i])).map((f) => f.label)
  refined = positional.filter(Boolean)
  refinedPairs = A.files.map((f, i) => ({ f, rep: positional[i] })).filter((p) => p.rep)
  if (failed.length) engine.log(`未完成：${failed.join('、')}（主代理需按 SKILL.md Step 1–2 手动补做）`)
}

// Logic-order resequencing (optional): reads each refined transcript and reorders it into narrative order, run concurrently. Completeness is verified by a zero-cost JS check —
// diff the headings in the refine report against threads[].source_sections in the logic report; any headings not covered go into missingSections.
let logic = []
if (scope.includes('logic') && refinedPairs.length) {
  engine.phase('Logic')
  const lreps = await engine.parallel(refinedPairs.map(({ f }) => () =>
    engine.agent(logicWritePrompt(f, A), { label: `logic:${f.label}`, model: M.logic, schema: LOGIC_REPORT_SCHEMA })))
  lreps.forEach((lrep, k) => {
    const { f, rep } = refinedPairs[k]
    if (!lrep) { logic.push({ label: f.label, path: null, mainline: '', threads: [], missingSections: [], open_questions: [] }); return }
    const covered = new Set((lrep.threads || []).flatMap((t) => ((t && t.source_sections) || []).map((s) => (s || '').trim()).filter(Boolean)))
    const srcHeadings = ((rep && rep.headings) || []).map((h) => (h || '').trim()).filter(Boolean)
    const missing = srcHeadings.filter((h) => !covered.has(h))
    logic.push({ label: f.label, path: `${A.outputDir}/逻辑顺序/${f.title}.md`, mainline: lrep.mainline || '', threads: (lrep.threads || []).map((t) => t && t.title).filter(Boolean), missingSections: missing, open_questions: lrep.open_questions || [] })
  })
  const failedLogic = logic.filter((l) => !l.path).map((l) => l.label)
  const missLogic = logic.filter((l) => l.missingSections && l.missingSections.length)
  engine.log(`逻辑顺序稿完成 ${logic.filter((l) => l.path).length}/${refinedPairs.length} 份${failedLogic.length ? `（${failedLogic.join('、')} 失败）` : ''}`)
  if (missLogic.length) engine.log(`逻辑顺序稿疑漏小标题（按精校稿小标题覆盖核对，需抽查）：${missLogic.map((l) => `${l.label}:${l.missingSections.join('/')}`).join('；')}`)
}

engine.phase('Deliver')
const [summary, timeline] = await engine.parallel([
  () => (scope.includes('summary') && refined.length
    ? engine.agent(summaryPrompt(A, refined), { label: 'summary', model: M.summary })
    : Promise.resolve(null)),
  () => (scope.includes('timeline') && refined.length
    ? engine.agent(timelinePrompt(A, glossary, refined), { label: 'timeline', model: M.timeline })
    : Promise.resolve(null)),
])

return {
  glossary,
  refined,
  failed,
  incomplete: refined.filter((r) => r.complete === false).map((r) => ({ path: r.outPath || r.path, note: r.checkNote })),
  unchecked: refined.filter((r) => r.complete === null).map((r) => r.outPath || r.path),
  headingConflicts,
  scoutSuspect,
  suspectedDuplicates: (dedup && dedup.suspects) || [],
  networkUnverified: netUnverified,
  logic,
  openQuestions: refined.flatMap((r) => r.open_questions || []).concat(dedupQuestions(dedup)).concat(logic.flatMap((l) => l.open_questions || [])).concat(conflicts),
  summary,
  timeline,
}
}


// ===== bootstrap: Claude Code engine =====
// Appended to the end of the bundle by build/build-cc.mjs. Runs inside the Workflow sandbox,
// where agent / parallel / pipeline / phase / log / args are globals — hand them straight to core's runPipeline.
const __A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const __engine = { agent, parallel, pipeline, phase, log }
return await runPipeline(__A, __engine)

