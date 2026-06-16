// ---------- schemas ----------
// 注意：所有 schema 一律不设 required——StructuredOutput 的校验失败会触发无上限的重试循环
// （实测网络劣化把输出截断时，一个 required 字段让 verify 代理空转 151 次 / 20 分钟）。
// 字段缺失由 JS 侧默认值兜底（|| [] / 归一为 null），缺字段最坏退化成“保留（音）”，比重试循环安全得多。
export const entitySchema = (extra) => ({
  type: 'object',
  properties: Object.assign({
    canonical: { type: 'string', description: '该实体最可信的写法' },
    variants: { type: 'array', items: { type: 'string' }, description: '文中出现的其它写法，含疑似同音误写' },
    hint: { type: 'string', description: '一句定位线索（身份/title/语境）' },
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


// ---------- 精校规范（与 SKILL.md Step 2 保持一致） ----------
export const RULES = `精校规范（务必全部遵守）：
1. 保持对话体，保留发言人标签（如「张璐：」），不要改写成叙述文章。
2. 删口癖与口语重复（对对对/嗯/那个/就是说/这个这个），合并语义重复句；不改语气风格与原意，不替发言人加观点。纯粹确认写法的来回**折叠成结果**：口头拼字（“吴，哪个杰？”“捷报的捷——提手旁那个”“哦，口天的吴”）在书面稿里没有残值，在名字首次出现处直接写澄清后的写法（「吴捷」），整段问字对话删去——但必须用**澄清后**的字（捷，非先听到的杰）；夹有信息量内容（名字来历/玩笑）的只删机械确认、内容照留；没澄清出结果的保留（音）。
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

// 中文排版三规范（与 RULES 9/10/11 同源）：凡生成中文的子代理都注入——精校经 RULES 已含，
// 总结/时间线另行注入此压缩版（时间线数字/年份/金额最密集，最需要②③）。
export const TYPESET = `中文排版三规范（务必遵守）：
①引号一律用全角 “”（内层 ‘’），禁用 ASCII 直引号 "/' 与「」『』（代码/英文/路径除外）；其余中文标点也用全角。
②数字用阿拉伯数字（十六→16、六七十 B→60-70B、三四百→300-400，约数范围用连字符）；很短的口语小数目（两个人/三五个/一两次）与成语（三心二意/五花八门）保留汉字。
③盘古空格：中文与英文/阿拉伯数字相邻处加一个半角空格（用 GPT-4 做、16 个、覆盖 80%、A 轮、2021 年）；数字与紧跟的单位/符号间（60-70B、80%、$50）、与全角标点相邻处不加。`

// 单文件一遍过分支不建独立校对表——用一个 sentinel 而非散落字面串，timelinePrompt 据此走“无校对表”兜底
export const SINGLE_FILE_GLOSSARY = '（单文件一遍过，未建独立校对表；校对决定见成稿与精校报告）'


// ---------- 纯 JS 合并（无模型成本） ----------
// 泛称/敬称是“弱键”：单独共享它不足以判定同一人。转录里「张总」可能同时指受访者(被礼貌称张总)
// 和董事长，「陆总/老师/董事长」同理。若按任意共享串链式合并，一个歧义敬称会把多个不同的人并成一团。
// 因此：只在共享“强名”（实名/产品名/术语等非泛称）时才合并；仅共享弱键不合并（宁可欠并，不可错并——
// 欠并留两条目，精校读原文自会归位；错并把两个人写成一个，会污染成稿）。
export function isWeakKey(s) {
  return /^[一-龥]{1,2}总$/.test(s)            // 张总、陆总、王总…
    || /(老师|总监|经理|主管)$/.test(s)
    || /^(董事长|老板|老板娘|总经理|总裁|创始人|CEO|CFO|CTO|COO|PR|嘉宾|记者|主持人|同事|领导)$/.test(s)
}
// 侦察有时把身份描述塞进 canonical（如「张总（蜜雪冰城董事长）」），会骗过 isWeakKey 的 ^X总$。
// 判断“是不是弱称”前先剥掉括注，露出核心称谓——仅人名守卫用，不动 clusterEntities 的合并键。
export const stripDesc = (s) => (s || '').replace(/[（(][^）)]*[）)]/g, '').trim()
// 垃圾侦察检测：网络中途毁坏生成流时，scout 会回传“结构合法但内容乱码”的 JSON（一长串罕用汉字，schema 拦不住），
// 污染校对表。判据：合法实体名/发言人标签都很短、且长名必有标点（如「大咖国际（…）」）断开；乱码是十几二十个汉字
// 不带任何标点的连串。实测干净侦察最长连串 ≤6，损坏的达 41——取阈值 16，两边余量极大、几乎不会误判。
export function longestHanziRun(s) {
  let max = 0, cur = 0
  for (const ch of (s || '')) {
    if (ch >= '一' && ch <= '鿿') { cur++; if (cur > max) max = cur } else cur = 0
  }
  return max
}
export function scoutLooksGarbled(f) {
  if (!f) return false
  if (!(f.speakers || []).length) return true   // 任何访谈都至少有一个发言人；空 = 损坏
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
    // 计票用 trim 后的 canonical，并跳过空/纯空白——否则空 canonical 可能被选为簇代表，渲染出空 **加粗**
    for (const e of c.entries) { const k = (e.canonical || '').trim(); if (k) counts[k] = (counts[k] || 0) + 1 }
    // 兜底：万一全簇 canonical 皆空，退用 names 里第一个非空强名/任意名
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

// 核实清单分块（不丢弃 worthy 实体）：单个核实代理塞太多项会逐条联网串行检索、拖慢整轮（实测 30 项一锅 ≈ 30 次串行检索 ~10min，
// 且早期 90+ 项还会反复重试超时 ~35min）。病根是单代理过载——分块并行，每块 ≤ VERIFY_CHUNK，块内串行、块间并发，谁都不会被压垮，也不丢任何 worthy 条目。
// 块大小取小（12）：核实是网络往返密集型，块越小越能并行摊薄检索时延（~30 项 → 3 块并发，verify 阶段从 ~10min 降到 ~3–4min）；
// 块越大省不了 token 却串行更久。代价是多几个 sonnet 代理（便宜且并行），还需 ≤ 并发上限 min(16,核数-2) 才不排队。
// key（默认）：只送“值得核实”的——公众人物 / 跨文件互证 / 写法混乱（≥2 变体）；w=0 的低优先级内部术语不送检（精校按原文归一，会记日志）。
// deep：全量送检。两档都按权重排序后分块；MAX_CHUNKS×CHUNK=144 为失控护栏，足够覆盖 deep 实测 ~95 项。
export const VERIFY_CHUNK = 12
export const MAX_CHUNKS = 12
export const entityWorth = (e) => (e.public_figure ? 4 : 0) + (e.crossFile ? 2 : 0) + ((e.variants || []).length >= 2 ? 1 : 0)
export function verifyChunks(merged, depth) {
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

// H 的输入：全量实体（含 w=0 的低存在感条目——同音同指最爱藏这儿），含类别与出处，供语义同指核查
export function dedupListText(merged) {
  const lines = []
  for (const [kind, list] of [['person', merged.people], ['brand', merged.brands], ['term', merged.terms]]) {
    for (const e of list) lines.push(`- [${kind}] ${e.canonical} ← ${e.variants.join(' / ') || '（无变体）'} ｜ ${e.hint || ''} ｜ 出处：${(e.files || []).join('、')}`)
  }
  return lines.join('\n')
}

// 收尾完整性报告与权威输出路径：rep.path 是精校代理自报的，downstream 一律用我们命令它写入的 f.outPath
export const withCheck = (rep, chk, f) => Object.assign({}, rep, {
  outPath: f.outPath,
  // 归一成严格三态：true/false/null——check 代理失败或返回缺字段（schema 不强制）都算 null（未核对），
  // 否则 undefined 会同时漏过 incomplete 和 unchecked 两张网
  complete: (chk && typeof chk.complete === 'boolean') ? chk.complete : null,
  checkNote: chk ? (chk.note || '') : 'check 代理失败',
})

// 预检 grep 的兜底：侦察发现源文件带小标题、而 headingPolicy 仍是 'none'（预检没拦住）→ 收尾时必须问用户
export function findHeadingConflicts(findings, files, policy) {
  if ((policy || 'none') !== 'none') return []
  return files.filter((f, i) => findings[i] && findings[i].has_existing_headings).map((f) => f.label)
}

export function renderGlossary(merged, verified, dedup, a) {
  // 先把核实结论应用回正文条目：query 命中条目的 canonical 或任一 variant，就用核实后的写法当
  // canonical（原写法折进 variants），身份并进 hint——存档的校对表正文自身就是对的，不靠脚注纠错
  const resolvedMap = new Map()
  for (const r of (verified && verified.resolved) || []) resolvedMap.set(r.query, r)
  const applied = new Set()   // 真正写入正文的核实结论
  const rejected = new Set()  // 被人名守卫拦下的核实结论
  const applyVerified = (e, isPerson) => {
    const hit = resolvedMap.get(e.canonical) || (e.variants || []).map((v) => resolvedMap.get(v)).find(Boolean)
    if (!hit) return e
    const names = [e.canonical, ...(e.variants || [])]
    // 人名守卫：本条目已含某个实名（强名），核实却给出另一个不在本条目内的强名——疑似张冠李戴
    // （实测网络劣化时 verify 幻觉过 张璐→张红超，把受访者改写成董事长）。不改写正文，只附注存疑：
    // 把一个人改成另一个人的伤害远大于留一个待核名。弱称（张总/董事长）解析成实名仍照常应用——那正是核实的本职。
    // 注意：守卫看的是“本条目所有名字里的强名集合”（ownStrong），不只 canonical——
    // 聚类可能把弱称（张总）选作 canonical 而把实名（张璐）放进 variants，只看 canonical 会漏防。
    const ownStrong = names.map(stripDesc).filter((n) => n && !isWeakKey(n))
    if (isPerson && hit.canonical && ownStrong.length
        && !ownStrong.includes(stripDesc(hit.canonical)) && !isWeakKey(stripDesc(hit.canonical))) {
      rejected.add(hit)
      const hint = [e.hint, `⚠ 联网核实给出“${hit.canonical}”，与本条强名不符，疑似张冠李戴——未采用，待人工确认`].filter(Boolean).join('；')
      return Object.assign({}, e, { hint })
    }
    applied.add(hit)
    const variants = Array.from(new Set(names.filter((n) => n && n !== hit.canonical)))
    const hint = [hit.identity ? `${hit.identity}（已核实）` : '', e.hint].filter(Boolean).join('；')
    return Object.assign({}, e, { canonical: hit.canonical, variants, hint })
  }
  const sec = []
  sec.push(`# ${a.topic} 统一校对表（采访时间 ${a.date}）`, '', '## 采访背景', a.background, '')
  sec.push('## 发言人统一标注')
  for (const s of merged.speakersByFile) {
    sec.push(`**${s.label}**`)
    for (const sp of s.speakers) { if (sp && sp.label) sec.push(`- ${sp.label} → ${sp.role || '?'}${sp.identity ? `（${sp.identity}）` : ''}`) }
  }
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
      // 拒绝优先：只要任一条目对它起了人名守卫就标 ⚠（同一结论若同时被另一条目合法采纳，仍宁可多警示——
      // 把一个人改成另一个人的伤害远大于一次多余告警）。措辞用“与部分条目强名冲突”，兼容“别处已采纳”的情形。
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
  return sec.join('\n')
}

// 防御：滤掉模型偶发的占位/自我否定项（实测会冒出 members<2 或 why 写“撤回/不适用”的噪声组）
export function cleanSuspects(suspects) {
  return (suspects || [])
    .filter((s) => s && (s.members || []).length >= 2 && !/撤回|不适用|不适合|不属于|仅供参考/.test(s.why || ''))
    .map((s) => Object.assign({}, s, { kind: s.kind || '未标类', why: s.why || '' }))
}

// dedup 结果分两路：term/brand 且给了有效 preferred → 可直接套用的“写法统一”指令；其余（人名身份合并 / 拿不准）→ 待人工确认的 flag
export function splitSuspects(dedup) {
  const directives = [], flags = []
  // 主流程已先过 cleanSuspects，这里再过一遍是防御（直接调用/劣化输入也不抛）
  for (const s of cleanSuspects((dedup && dedup.suspects) || [])) {
    const m = s.members || []
    if ((s.kind === 'term' || s.kind === 'brand') && s.preferred && m.includes(s.preferred) && m.length >= 2) directives.push(s)
    else flags.push(s)
  }
  return { directives, flags }
}

// 断路器产物：核实代理因网络故障熔断、未核实的项——这些不是“查无此人”，是“没查成”，
// 网络恢复后值得补核。单列出来供收尾时向用户提供“补核”选项（处理流程见 SKILL.md 返回处理）
export function pickNetworkUnverified(verified) {
  return ((verified && verified.unresolved) || []).filter((u) => u && /网络故障|网络错误|连接|超时|断路|熔断|中断|检索失败|检索报错|timed? ?out|network|connection/i.test(u.note || ''))
}

// 只有待确认的 flag 进 openQuestions（写法统一指令已自动套用，无需再问）
export function dedupQuestions(dedup) {
  return splitSuspects(dedup).flags.map((s) => `疑似同指（${s.kind}）：${(s.members || []).join(' ／ ')} 是否指同一对象？（${s.why}）——脚本未自动合并，请确认`)
}

