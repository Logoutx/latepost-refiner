// ---------- schemas ----------
// NOTE: no schema sets `required` — a StructuredOutput validation failure triggers an unbounded retry loop.
// (Observed in the wild: network degradation truncating output caused one `required` field to spin the verify agent
// 151 times / 20 minutes.) Missing fields are covered by JS-side defaults (|| [] / normalised to null);
// the worst-case for a missing field is falling back to “retain (phonetic)” — far safer than a retry loop.
export const entitySchema = (extra) => ({
  type: 'object',
  properties: Object.assign({
    canonical: { type: 'string', description: '该实体最可信的写法' },
    variants: { type: 'array', items: { type: 'string' }, description: '文中出现的其它写法，含疑似同音误写' },
    hint: { type: 'string', description: '一句定位线索（身份/title/语境）' },
    suspect_asr: { type: 'boolean', description: 'canonical 疑为转录同音/听写误写、但拿不准正确写法时置 true——会强制联网核实这一条（哪怕只出现一处、无其它变体）' },
  }, extra || {}),
})

export const SCOUT_SCHEMA = {
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

export const VERIFY_SCHEMA = {
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

export const REFINE_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '成稿输出路径' },
    headings: { type: 'array', items: { type: 'string' }, description: '你分的 ## 小标题' },
    key_fixes: { type: 'array', items: { type: 'string' }, description: '关键修正' },
    open_questions: { type: 'array', items: { type: 'string' }, description: '仍存疑、需问委托方的点' },
  },
}

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    complete: { type: 'boolean', description: '成稿是否覆盖到源文件结尾' },
    note: { type: 'string', description: '不完整时说明缺到哪' },
  },
}

export const DEDUP_SCHEMA = {
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

export const LOGIC_REPORT_SCHEMA = {
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
export const RULES = `精校规范（务必全部遵守）：
1. 保持对话体、不要改写成叙述文章；发言人标签一律「名字：」纯文本形态，不加粗、不加时间戳、不加其它样式——写成 李明： 而不是 **李明：** 或 李明 12:03：，全篇同一形态（源转录标签里夹的时间戳一律不进成稿标签，溯源靠锚点注释，不靠标签）。
2. 删口癖、口语赘词与口语重复，合并语义重复句；以“读着顺、信息不丢”为准——不改语气风格与原意，不替发言人加观点，拿不准就保留，宁可漏删一处也别删出歧义。注意：“宁可漏删”只适用于可能改义的词，不适用于纯噪音；纯噪音（语气音、确认复读、卡顿）必须删干净。开场寒暄**只有在纯问候、无任何实质内容时**才折叠成一句括号说明；**夹在寒暄里的产品评论、事实陈述、观点原话必须逐句保留**（例：调试录音设备时对某支麦克风的吐槽、闲聊里带出的一个数字或判断，都属于必须保留的实质内容，不得随寒暄一起折叠）。
   · **径删（纯垫词，无任何语义）**：语气与卡顿音（嗯、呃、啊、哦、欸）；确认复读（对对对、是是是、嗯嗯）；纯卡顿的“那个…这个…就是说…”；句首口头禅式的“然后/其实/就是”；空洞的反问尾巴（对吧、是吧、对不对、你知道——确在向对方求证的留）。
   · **看义删（有义则留，纯垫才删）**：“一个/一种/一些”作量词废垫删、表“一/同一/特指某个”留——“为了让它有一个统一口感”→“为了有统一口感”（删），“跟咖啡豆拼配是一个道理”照留（＝同一个道理，有义），“摆在一个角落、同一个时间、给他一个机会”留；“其实”句首口头禅删、表转折（本以为…其实…、但其实）留；“然后”空接续删、表真实先后或因果留；“就是”卡顿垫词删、表“正是/只是/即”留；“的话”纯提顿删（“做手工的话”→“做手工”）、真条件（“需要的话”）留。
   · **基本别动（多为实义，硬删反而改义）**：“我觉得/我感觉”标记的是发言人立场，删了会把看法读成事实，仅紧邻重复时合并；“一点/一下”表程度或轻微动作，“对…来说/来讲”“包括”“比如”是框定与举例——一般照留。
   纯粹确认写法的来回**折叠成结果**：口头拼字（“吴，哪个杰？”“捷报的捷——提手旁那个”“哦，口天的吴”）在书面稿里没有残值，在名字首次出现处直接写澄清后的写法（“吴捷”），整段问字对话删去——但必须用**澄清后**的字（捷，非先听到的杰）；夹有信息量内容（名字来历/玩笑）的只删机械确认、内容照留；没澄清出结果的保留（音）。
3. 理顺破碎口语、修语序与冗余助词；有信息量/有个性的金句照留，不要抹平。
4. 按主题加 ## 小标题：准确概括、不篡改原意、不加原文没有的结论；一律不编号；一份通常 6–20 个。
4a. 段落边界：不要因为连续同一发言人就把多段源转录合成一个巨长段。原则上保留源文件的问答/发言轮次；只有同一发言人的相邻源段明显是同一句话被 ASR 切开、且合并后不超过约 500 字时才合并。长独白拆成多个可读段落（每段通常 200-600 字），必要时每段重复发言人标签；单个对话段超过约 900 字视为需要重切。
5. 严格按校对表统一人名/品牌/术语；删姓名后/夹行时间戳与英文听写乱码（能判断词义就替换，判断不了就顺掉）；拿不准的名字保留（音），绝不臆造。**凡校对表中标 ⚠ 或注明「保留（音）／未能核实／疑为转录误写」的名字：正文每处都写作「名字（音，存疑）」或「名字（音）」，不得裸写**（这些是尚未核实的写法，裸写会被误当成已确认）。校对表不是机械全局 find/replace：英文实体和拼音/缩写必须看词边界，禁止把相邻字母粘成新怪词；同音实体必须逐处按上下文判断，不可把不同对象硬并。
5a. 源稿编辑标记要执行，不能漏进正文：Markdown 删除线 \`~~...~~\` 默认表示删稿指令，除非其中有必须保留的事实且你明确改写说明，否则不要写入成稿；\`【换位…】\` 表示段落移动指令，按其意图调顺内容并删除标记本身。遇到不确定的剪辑标记，写进 open_questions，不能把标记原样当作采访内容。
6. 保留全部事实细节（数字/金额/时间/产品/工艺/渠道/观点）——精校不是摘要。
7. 发言人规范：采访方追问归对应记者名；被访方旁白/补充按校对表标注；拒答/「以招股书为准」等语境务必原样保留，勿替受访者补数字。
8. 文件抬头：首行 H1 标题，第二行斜体说明行。
9. 中文引号一律用全角 “”（内层 ‘’）——禁用 ASCII 直引号 "/'、禁用「」/『』；其余中文标点（，。；：？！）也用全角。转写常把引号输成直引号，逐一改成全角弯引号。**书面化的引语、专名与术语首次出现、带反讽或口头禅性质的短语，主动用全角弯引号 “” 标出**（如 他说这是 “行业惯例”、所谓 “现厂制”）。代码/英文专名/路径里的 ASCII 引号不动。
10. 数字用阿拉伯数字：把汉字数字改成阿拉伯数字（十六个部门→16 个部门，六七十 B 大模型→60-70B 大模型，三四百人→300-400 人，约数范围用连字符）。例外——很短的口语化小数目保留汉字：两个人、三五个、一两次、七八年、一两句话 等约定俗成口语不转；成语/固定词不动（三心二意、五花八门、一五一十）。带量词的确切数目（16 个、3 轮、5 家）一律用阿拉伯数字。
11. 中文与英文/数字之间加一个半角空格（盘古之白）：汉字与拉丁字母、阿拉伯数字相邻处插一个空格（用 GPT-4 做、16 个部门、覆盖 80% 用户、A 轮融资、2021 年底）。不加空格：①数字与紧跟的单位/符号之间（60-70B、80%、$50、5G、A4）；②与全角标点相邻处；③英文/数字内部与 ASCII 标点之间。已正确成对的空格不要再叠加。
12. 长文件分多次接力写（先 Write 抬头+开头，再用 Edit 以已写入的最后一句为锚点追加），务必覆盖到源文件结尾。**每次 Write/Edit 都在单次输出上限内写尽量大的整块（通常一次写完一整段主题、上千字），用尽量少的写入次数完成——别一行一行或一小段一小段地追加。**
13. **一次写对，别回头微改**：术语/人名/品牌按“写法统一”指令与校对表在初次落笔时就写对；**严禁写完后再回头做大量“改一两个字”的细小 Edit**（每次 Edit 都要把整份转录+校对表重新过一遍，十几个小改 = 成倍拖慢）。确需更正就把多处合并成尽量少的几次 Edit，别逐字逐处单独改。
14. **绝不无声跳过任何实质内容段**。若确有无法恢复的缺口（原文转录缺失、彻底无法辨认），就在原位置用**一句人话的括号说明**交代，例：（此处约 200 字因转录缺失未能恢复，见源 L120-L150）——**禁止输出工具告警式、系统报错式的文案**。此为最后手段——正常情况下整份成稿应没有任何缺口说明；口水寒暄按规范 2 折叠成一句括号说明不算缺口、不要标；段落太长也不是理由（按规范 12 分多次写完）。宁可如实标注缺口，不可无声省略。`

// Chinese typesetting rules (same source as RULES items 9/10/11): injected into every sub-agent that generates Chinese.
// Proofreading agents already get them via RULES; summaries/timelines inject this compact version separately
// (timelines are the densest for numbers/years/amounts, so rules ② and ③ matter most there).
export const TYPESET = `中文排版三规范（务必遵守）：
①引号一律用全角 “”（内层 ‘’），禁用 ASCII 直引号 "/' 与「」『』（代码/英文/路径除外）；其余中文标点也用全角。
②数字用阿拉伯数字（十六→16、六七十 B→60-70B、三四百→300-400，约数范围用连字符）；很短的口语小数目（两个人/三五个/一两次）与成语（三心二意/五花八门）保留汉字。
③盘古空格：中文与英文/阿拉伯数字相邻处加一个半角空格（用 GPT-4 做、16 个、覆盖 80%、A 轮、2021 年）；数字与紧跟的单位/符号间（60-70B、80%、$50）、与全角标点相邻处不加。`

// Single-file one-pass branch does not build a standalone glossary — use a sentinel constant rather than scattered
// string literals so that timelinePrompt can branch into the “no glossary” fallback path.
export const SINGLE_FILE_GLOSSARY = '（单文件一遍过，未建独立校对表；校对决定见成稿与精校报告）'

// ---------- machine-readable confidence markers (校对表条目置信标记) ----------
// A 校对表 entry line was previously *prose only*: “已核实” / ⚠ told a human, but a machine couldn't tell an
// already-confirmed spelling from one still awaiting review, so an erroneous entry could only be undone by
// editing the text and hoping the next run re-checked it. These four line-tail tokens make the state MACHINE-
// readable. They use full-width lenticular brackets 〔…〕 which never appear in renderGlossary's own output, so
// an old 校对表 (no markers) round-trips completely unchanged — parseGlossary just reports confidence:'unknown'.
//   〔核实·YYYY-MM〕 — verified: applied a网络核实 conclusion (date optional → 〔核实〕)
//   〔用户钦定〕     — user: a locked cluster from applyCanonicalOverrides (has structural veto, see below)
//   〔待复核〕       — recheck: a human撤销/flagged this entry; parse recognises it (render never emits it)
// Downstream contract (wired by the next task):
//   · excludeVerified skips only verified/user (both are settled); recheck must be re-verified next round;
//     unknown keeps today's behaviour verbatim (full backward compatibility — the hard requirement).
export const CONFIDENCE_VERIFIED = '核实'
export const CONFIDENCE_USER = '用户钦定'
export const CONFIDENCE_RECHECK = '待复核'
// Trailing-token matcher: 〔用户钦定〕 / 〔待复核〕 / 〔核实〕 / 〔核实·2025-07〕 at the very end of an entry line.
// SF-1: the marker must be preceded by a whitespace char or a ｜ separator (captured group 1) — the render side
// always emits exactly one leading space before it (see confidenceMark), so a *legitimate* hint that happens to
// END with the literal string 〔核实〕 (no separating space, e.g. 正文…核实〔核实〕) is NOT mistaken for metadata
// and stays in the body. Anchored to $ so it can only ever consume a real trailing marker.
// Residual edge (documented, not handled): a hint deliberately ending with a SPACE + a literal 〔核实〕 token
// (“… 〔核实〕”) is indistinguishable from a real marker and will be stripped — an extreme collision we accept.
const CONFIDENCE_RE = new RegExp(`(^|[\\s｜])〔(${CONFIDENCE_USER}|${CONFIDENCE_RECHECK}|${CONFIDENCE_VERIFIED})(?:·([0-9]{4}-[0-9]{2}))?〕\\s*$`)
// Render side: pick the marker for an entry e0, returned WITH its leading separator space (or '' when none), so
// every call site is guaranteed the SF-1 space without duplicating the rule. Priority (BLOCKER — confidence must
// round-trip across batches):
//   1. locked (in-memory 用户钦定 cluster) OR a prior entry parsed back as confidence:'user' → 〔用户钦定〕
//   2. re-verified THIS round (a writing is in resolvedMap) → 〔核实·<thisDate>〕 (date omitted when absent)
//   3. a prior entry parsed back as confidence:'verified' but NOT re-checked this round → its ORIGINAL marker
//      preserved verbatim, original date段 and all (this is what was silently lost before)
//   4. recheck / unknown with no fresh verification → no marker (recheck re-renders by this round's conclusion)
export function confidenceMark(e0, resolvedMap, date) {
  if (!e0) return ''
  if (e0.locked || e0.confidence === 'user') return ` 〔${CONFIDENCE_USER}〕`
  const names = [e0.canonical, ...(e0.variants || [])]
  const verifiedThisRound = resolvedMap && names.some((n) => resolvedMap.has(n))
  if (verifiedThisRound) return date ? ` 〔${CONFIDENCE_VERIFIED}·${date}〕` : ` 〔${CONFIDENCE_VERIFIED}〕`
  if (e0.confidence === 'verified') return e0.confidenceDate ? ` 〔${CONFIDENCE_VERIFIED}·${e0.confidenceDate}〕` : ` 〔${CONFIDENCE_VERIFIED}〕`
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
  const conf = m[2] === CONFIDENCE_USER ? 'user' : m[2] === CONFIDENCE_RECHECK ? 'recheck' : 'verified'
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
export function isWeakKey(s) {
  return /^[一-龥]{1,2}总$/.test(s)            // e.g. 王总, 李总, 欧阳总 (one/two-char surname + 总)
    || /(老师|总监|经理|主管)$/.test(s)
    || /^(董事长|老板|老板娘|总经理|总裁|创始人|CEO|CFO|CTO|COO|PR|嘉宾|记者|主持人|同事|领导)$/.test(s)
}
// The scout sometimes stuffs an identity description into canonical (e.g. “王总（示例公司董事长）”),
// which defeats the `^X总$` pattern in `isWeakKey`. Strip parenthetical annotations before testing
// whether a string is a weak title, exposing the bare honorific.
// Used only in the name guard — does not touch the merge keys inside `clusterEntities`.
export const stripDesc = (s) => (s || '').replace(/[（(][^）)]*[）)]/g, '').trim()
// Garbled-scout detection: when the network corrupts the generation stream mid-flight, the scout returns
// structurally valid JSON whose content is gibberish (a long run of rare CJK characters that the schema
// cannot reject), which would pollute the glossary. The signal: legitimate entity names and speaker labels
// are short, and long names are always interrupted by punctuation (e.g. “某集团（…）”); garbled output
// is a run of a dozen or more CJK characters with no punctuation at all.
// Empirically, the longest clean run is ≤ 6; corrupted output reached 41 — threshold set at 16,
// leaving a wide margin on both sides with virtually no false positives.
export function longestHanziRun(s) {
  let max = 0, cur = 0
  for (const ch of (s || '')) {
    if (ch >= '一' && ch <= '鿿') { cur++; if (cur > max) max = cur } else cur = 0
  }
  return max
}
export function scoutLooksGarbled(f) {
  if (!f) return false
  if (!(f.speakers || []).length) return true   // every interview has at least one speaker; empty = corrupted
  const names = []
  for (const e of [...(f.people || []), ...(f.brands || []), ...(f.terms || [])]) {
    names.push(e.canonical || ''); for (const v of e.variants || []) names.push(v)
  }
  for (const sp of f.speakers || []) names.push(sp.label || '')
  return names.some((n) => longestHanziRun(n) >= 16)
}

export function clusterEntities(entries) {
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
      suspect_asr: c.entries.some((e) => e.suspect_asr),   // any scout flagged it a likely ASR mishear → force verify
      category: c.entries.map((e) => e.category || e.domain).find(Boolean) || '',
      crossFile: files.length > 1,
    }
  })
}

export function mergeFindings(findings, files) {
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
export const VERIFY_CHUNK = 12
export const MAX_CHUNKS = 12
export const entityWorth = (e) => (e.public_figure ? 4 : 0) + (e.crossFile ? 2 : 0) + ((e.variants || []).length >= 2 ? 1 : 0)
export function verifyChunks(merged, depth) {
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
export function dedupListText(merged) {
  const lines = []
  for (const [kind, list] of [['person', merged.people], ['brand', merged.brands], ['term', merged.terms]]) {
    for (const e of list) lines.push(`- [${kind}] ${e.canonical} ← ${e.variants.join(' / ') || '（无变体）'} ｜ ${e.hint || ''} ｜ 出处：${(e.files || []).join('、')}`)
  }
  return lines.join('\n')
}

// Completion report and authoritative output path: rep.path is self-reported by the proofreading agent;
// all downstream consumers use f.outPath, which is the path we instructed it to write to.
export const withCheck = (rep, chk, f) => Object.assign({}, rep, {
  outPath: f.outPath,
  // Normalise to a strict three-state: true / false / null.
  // A failed check agent or a response missing this field (schema does not enforce it) both map to null (unchecked).
  // Leaving it as undefined would let it slip through both the "incomplete" and "unchecked" guards.
  complete: (chk && typeof chk.complete === 'boolean') ? chk.complete : null,
  checkNote: chk ? (chk.note || '') : 'check agent failed',
})

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
// Chunking is OFF unless the run explicitly asks for speed (A.chunkMode === 'speed'); the per-chunk opus
// overhead (each chunk agent re-thinks + re-ingests RULES) is an intrinsic ~1.5× token premium, so the
// user opts into it per run (SKILL.md Step 0 asks speed-vs-cost). When on, settings are CONSERVATIVE —
// only large files chunk, and into at most 2 — a balanced ~35% refine speedup for ~1.5× tokens.
// Document length is measured in 正文字数 (content chars: 汉字 + each English word/number run = 1),
// NEVER in lines — line count is a poor proxy (timestamp lines, short ASR turns inflate it; one transcript
// ran 13.9 字/line). Routing decisions (one-pass shortcut, chunk-or-not, chunk count) all key on this.
// See [[feedback-size-metric]]. Read-tool pagination stays line-addressed (readPlan) because Read is
// line-based — that's a mechanic, not a size judgment.
export function contentLength(text) {
  const t = String(text || '')
  return (t.match(/[一-龥]/g) || []).length + (t.match(/[A-Za-z0-9]+/g) || []).length
}
// Effective 字数 for routing: prefer the precomputed f.chars (from pre-flight); else estimate from
// bytes (CJK UTF-8 ≈ 3 B/char, mixed ≈ 2.6) or, last resort, lines (~14 正文字/line).
export function refineSize(f) {
  if (f && typeof f.chars === 'number') return f.chars
  if (f && f.bytes) return Math.round(f.bytes / 2.6)
  return Math.round(((f && f.lines) || 0) * 14)
}
export const ONE_PASS_CHARS = 4000          // single file under this many 正文字数 → one-pass branch (skip scout/glossary)
export const REFINE_CHUNK_CHARS = 12000     // speed mode: only files over this many 正文字数 chunk
export const TARGET_CHUNK_CHARS = 9000      // aim for ~this many 正文字数 per chunk
export const MAX_REFINE_CHUNKS = 2          // conservative cap — speed mode is a coarse batch-speed lever for Opus, not a fine split
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
export function splitForRefine(f, mode) {
  const lines = (f && f.lines) || 0
  const size = refineSize(f)                 // 字数, not lines
  if (mode !== 'speed' || size <= REFINE_CHUNK_CHARS || lines <= 1) return singleChunk(f)   // cost mode (default) → one agent
  const K = Math.min(MAX_REFINE_CHUNKS, Math.max(2, Math.ceil(size / TARGET_CHUNK_CHARS)))
  return evenLineChunks(f, K)
}

// Scout chunking is a RESILIENCE measure, not a speed lever: a single scout agent over an oversized merged
// file (a ~50K-字 merge was observed to stall) chokes the same way refine does. So the scout ALWAYS chunks
// past SCOUT_CHUNK_CHARS — no chunkMode gate (unlike refine, which is opt-in because Opus fan-out is costly;
// scout is haiku, so K cheap agents beat one stalled one). Each chunk scouts its own line span; mergeScoutChunks
// unions the per-chunk findings back into one per-file finding, leaving the rest of the pipeline unchanged.
export const SCOUT_CHUNK_CHARS = 40000         // a normal 2h interview (~20–40K 字) stays one agent; only oversized merges chunk
export const TARGET_SCOUT_CHUNK_CHARS = 20000  // aim ~this many 字/段 — comfortably inside one haiku scout's budget
export const MAX_SCOUT_CHUNKS = 6              // runaway guard (6×20K ≈ 120K 字 covers very large merges)
export function splitForScout(f) {
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
export function mergeScoutChunks(parts, f) {
  const got = (parts || []).filter(Boolean)
  if (!got.length) return null
  const speakers = []; const seenSp = new Set()
  for (const p of got) for (const s of p.speakers || []) {
    const k = ((s && s.label) || '').trim()
    if (k && !seenSp.has(k)) { seenSp.add(k); speakers.push(s) }
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
    special_notes: uniq('special_notes'),
  }
}
export const partPath = (outPath, idx) => `${outPath}.part${idx}`

// Deterministic part-merge used by the Concat file tool (engines/fileops.js) and by tests:
// join chunk part-files in order into one transcript. Pure string op (no fs) so it's portable and
// testable. Each part's trailing whitespace is trimmed and parts are separated by exactly one blank
// line; an exact-duplicate `##` heading straddling a seam (chunk i ends with the heading chunk i+1
// opens with) is collapsed to one — cheap insurance, though disjoint ownership makes it rare.
export function stitchParts(texts) {
  const parts = (texts || []).map((t) => String(t == null ? '' : t).replace(/\s+$/, '')).filter((t) => t.length)
  if (!parts.length) return ''
  let out = parts[0]
  for (let i = 1; i < parts.length; i += 1) {
    let next = parts[i]
    const prevLast = out.slice(out.lastIndexOf('\n') + 1).trim()
    const nextFirst = (next.split('\n')[0] || '').trim()
    if (prevLast.startsWith('## ') && prevLast === nextFirst) {
      next = next.split('\n').slice(1).join('\n').replace(/^\s+/, '')
    }
    out = `${out}\n\n${next}`
  }
  return `${out.replace(/\s+$/, '')}\n`
}

// Fallback for the pre-flight grep: if the scout finds that a source file already has headings but
// headingPolicy is still 'none' (the pre-flight check didn't catch it), the user must be asked at wrap-up.
export function findHeadingConflicts(findings, files, policy) {
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
export function applyVerifiedEntry(e, isPerson, resolvedMap, applied, rejected) {
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
export function renderRefineGlossary(merged, verified, dedup, a) {
  const resolvedMap = new Map()
  for (const r of (verified && verified.resolved) || []) resolvedMap.set(r.query, r)
  const applied = new Set(), rejected = new Set()
  const sec = [`# ${a.topic} 写法对照（精校用·摘自校对表）`]
  const spk = []
  for (const s of merged.speakersByFile || []) for (const sp of s.speakers || []) { if (sp && sp.label) spk.push(`${sp.label} → ${sp.role || '?'}${sp.identity ? `（${sp.identity}）` : ''}`) }
  const uspk = Array.from(new Set(spk))
  if (uspk.length) { sec.push('', '## 发言人'); for (const x of uspk) sec.push(`- ${x}`) }
  const block = (title, list, isPerson) => {
    const rows = []
    for (const e0 of list) {
      const e = applyVerifiedEntry(e0, isPerson, resolvedMap, applied, rejected)
      const hint = trimHint(e.hint)
      rows.push(`- **${e.canonical}** ← ${e.variants.join(' / ') || '—'}${hint ? ` ｜ ${hint}` : ''}${confidenceMark(e0, resolvedMap, a.date)}`)
    }
    if (rows.length) { sec.push('', `## ${title}`); sec.push(...rows) }
  }
  block('人名', merged.people, true)
  block('品牌 / 公司 / 产品', merged.brands)
  block('术语 / 专名', merged.terms)
  const { directives, flags } = splitSuspects(dedup)
  if (directives.length) { sec.push('', '## 写法统一（初次落笔即写对，勿事后回改）'); for (const s of directives) sec.push(`- ${(s.members || []).filter((x) => x !== s.preferred).join(' / ')} → **${s.preferred}**`) }
  if (flags.length) { sec.push('', '## 疑似同指（勿自动合并）'); for (const s of flags) sec.push(`- ${(s.members || []).join(' ／ ')}（${s.kind}）`) }
  if (a.doNotMerge && a.doNotMerge.length) { sec.push('', '## 确认不同指（勿合并）'); for (const p of a.doNotMerge) sec.push(`- ${(p || []).join(' ／ ')}`) }
  return sec.join('\n')
}

export function renderGlossary(merged, verified, dedup, a) {
  // Apply verified results back into the body entries first: if query matches an entry's canonical or
  // any variant, replace canonical with the verified spelling (folding the original into variants)
  // and merge the identity into hint — the archived glossary body is authoritative; no footnote corrections.
  const resolvedMap = new Map()
  for (const r of (verified && verified.resolved) || []) resolvedMap.set(r.query, r)
  const applied = new Set()   // verified conclusions actually applied into the table body
  const rejected = new Set()  // verified conclusions blocked by the person-name guard
  const applyVerified = (e, isPerson) => applyVerifiedEntry(e, isPerson, resolvedMap, applied, rejected)
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
      // A locked (用户钦定) cluster is settled — it never carries the ⚠ suspect-ASR flag even if a consumed
      // cluster was scout-flagged; it renders clean with 〔用户钦定〕 (via confidenceMark) instead.
      const susp = !e0.locked && e0.suspect_asr && ![e0.canonical, ...(e0.variants || [])].some((n) => resolvedMap.has(n))
        ? ' ｜ ⚠ 侦察疑为转录误写、未能核实——请人工确认正确写法' : ''
      sec.push(`- **${e.canonical}** ← ${e.variants.join(' / ') || '—'}${e.hint ? ` ｜ ${e.hint}` : ''}${e.crossFile ? ' ｜ 多份互证' : ''}${susp}${confidenceMark(e0, resolvedMap, a.date)}`)
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

// Scout-flagged ASR suspects that verify did not resolve — surfaced into openQuestions so a likely
// mis-transcribed name is never shipped silently (the failure mode where scout suspected it, verify
// either skipped it or couldn't confirm, and the ASR spelling went straight into the 成稿).
export function suspectUnverified(merged, verified) {
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
export function cleanSuspects(suspects) {
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
export function splitSuspects(dedup) {
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
export function pickNetworkUnverified(verified) {
  return ((verified && verified.unresolved) || []).filter((u) => u && /网络故障|网络错误|连接|超时|断路|熔断|中断|检索失败|检索报错|timed? ?out|network|connection/i.test(u.note || ''))
}

// Only pending flags go into openQuestions (spelling-unification directives have already been applied automatically
// and do not need to be surfaced to the user).
export function dedupQuestions(dedup) {
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
export function parseGlossary(md) {
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
export function mergeIntoPrior(prior, fresh) {
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
export function mergeVerified(priorV, freshV) {
  const r = new Map(), u = new Map()
  for (const v of [priorV, freshV]) { if (!v) continue; for (const x of v.resolved || []) if (x && x.query) r.set(x.query, x); for (const x of v.unresolved || []) if (x && x.query) u.set(x.query, x) }
  for (const q of r.keys()) u.delete(q)
  return { resolved: Array.from(r.values()), unresolved: Array.from(u.values()) }
}
// Carry prior dedup suspects forward, de-duped by member-set + kind signature.
export function mergeDedup(priorSuspects, freshSuspects) {
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
export function excludeVerified(merged, prior) {
  if (!prior) return merged
  const done = new Set()
  for (const r of (prior.verified && prior.verified.resolved) || []) { if (r && r.query) done.add(stripDesc(r.query)); if (r && r.canonical) done.add(stripDesc(r.canonical)) }
  const priorEntries = [...(prior.people || []), ...(prior.brands || []), ...(prior.terms || [])]
  const writingsOf = (e) => [e.canonical, ...(e.variants || [])].map(stripDesc).filter(Boolean)
  // Entries the prior glossary marks as settled (verified/user) seed the skip set directly.
  for (const e of priorEntries) { if (e.confidence === 'verified' || e.confidence === 'user') for (const n of writingsOf(e)) done.add(n) }
  // recheck overrides everything: force this batch to re-verify those writings.
  for (const e of priorEntries) { if (e.confidence === 'recheck') for (const n of writingsOf(e)) done.delete(n) }
  if (!done.size) return merged
  const covered = (e) => [e.canonical, ...(e.variants || [])].some((n) => done.has(stripDesc(n)))
  const filt = (list) => (list || []).filter((e) => !covered(e))
  return Object.assign({}, merged, { people: filt(merged.people), brands: filt(merged.brands), terms: filt(merged.terms) })
}

// P3 — cross-interview speaker registry: unify speakers recurring across ≥ 2 files (chiefly the interviewer)
// into one entry with the files they appear in. A derived view of speakersByFile (re-generated each render).
export function buildSpeakerRegistry(speakersByFile) {
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
export function glossaryConflicts(prior, verified) {
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
export function weakDupFlags(prior, fresh) {
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
export function applyCanonicalOverrides(clusters, overrides) {
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
export function applyOverridesToMerged(merged, overrides) {
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
export function dropLocked(merged) {
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
export function safeName(s, max = 80, maxBytes = 255) {
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
    while (cps.length && Buffer.byteLength(cps.join(''), 'utf8') > maxBytes) cps.pop()
  }
  out = cps.join('').replace(/[.\s]+$/g, '')     // truncation may re-expose a trailing dot/space
  return out || 'untitled'
}
