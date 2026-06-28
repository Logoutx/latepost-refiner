import { RULES, TYPESET, SINGLE_FILE_GLOSSARY, partPath } from './spec.js'

// ---------- prompt builders ----------
// Computed read plan: pagination is specified explicitly rather than left to the model
// (Haiku tends to take 8–9 small 100–200-line bites; Opus reads large chunks —
// the same instruction “page through the file” is interpreted differently per tier).
// Since f.lines is known at script time, we emit an exact Read checklist; the model
// just executes it, so read behavior is decoupled from model tier.
// Page size is constrained by the Read tool's ~25K-token limit:
// dense Chinese interviews run ~30–40 tok/line → 600 lines/page is safe.
export const READ_PAGE = 600          // line cap: dense Chinese ~600 lines ≈ 18–22K tok, with headroom
export const READ_BYTES_PER_PAGE = 45000  // density guard: ~45 KB/page ≈ 18K tok (Chinese UTF-8 ≈ 2.5 B/tok); only used to lower page size to prevent silent truncation at the token limit — never raised (an oversized page that gets cut silently loses content, not worth saving one round-trip)
export function readPlan(f) {
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
export const CHUNK_MARGIN = 30
export function readPlanRange(f, startLine, endLine) {
  const lines = f.lines || 0
  const from = Math.max(1, (startLine || 1) - CHUNK_MARGIN)               // 1-indexed first line to read
  const to = lines ? Math.min(lines, (endLine || lines) + CHUNK_MARGIN) : (endLine || 0) + CHUNK_MARGIN // 1-indexed last line
  let page = READ_PAGE
  if (f.bytes && lines) page = Math.min(READ_PAGE, Math.max(150, Math.floor(lines * READ_BYTES_PER_PAGE / f.bytes)))
  const steps = []
  for (let o = from - 1; o < to; o += page) steps.push(`Read(offset=${o}, limit=${Math.min(page, to - o)})`) // o is a 0-based offset
  return steps
}

export function headingNote(policy) {
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

export function scoutPrompt(f, a, chunk) {
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
- speakers：每个发言人标签 → 角色，附一处原文样例；文中若点出真名/title，写进 identity。
- 特别留意**口头拼字澄清段**（“哪个杰？”“捷报的捷”“口天吴”）——这是人名/术语正确写法的**最强内部证据**：把澄清后的写法记为 canonical，hint 注明「本人口述拼字确认」。
- people / brands / terms：反复出现的实体；canonical 填你判断的最可信写法，variants 列文中全部其它写法（含疑似同音误写），hint 一句定位线索；公众人物标 public_figure=true。
  · **知名实体用你已知的正确写法做 canonical**：若这是你认得的知名公司/产品/机构/公众人物，canonical 一律填**你所知的规范写法**，哪怕转录通篇是另一种听写——把转录里的写法放进 variants。例：转录一直写「苍碧科技」、而你知道这家公司规范写法是「苍璧科技」（碧→璧 同音误写），则 canonical=苍璧科技、variants 含 苍碧科技。别让一个一直被听错的名字、因为转录里写法统一就当成正确写法。
  · **拿不准就置 suspect_asr=true**：当你怀疑 canonical 可能是转录的同音/听写误写、却又给不出有把握的正确写法时，suspect_asr=true——这会强制对这一条联网核实（哪怕它只出现一处、没有别的变体，正常不会送核的）。一个写法"看着像真名"、却疑似听错的实体，正是最该标的；宁可多标。
- errors：明显转写错误按类别举例（同音字错/英文听写错/（音）标记/夹行时间戳/乱码/Word 残讯）。
- themes：这份大致谈了哪些主题。
- has_existing_headings：源文件是否已带小标题行（#/##/【】式标题）。
${endingBullet}
- special_notes：该份特别提醒（拒答/敏感语境要保留、收尾离场后的闲聊、称呼混乱重灾区等）。`
}

export function verifyPrompt(table, a) {
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

export function refinePrompt(f, glossary, finding, a, chunk) {
  // Scout results may be missing fields (schema is not strict, to avoid validation-retry loops) — if the anchor is absent, let the refine agent Read the source file's tail itself
  const anchor = finding.ending_anchor || {}
  const notes = (finding.special_notes || []).map((s) => '- ' + s).join('\n')
  const speakers = (finding.speakers && finding.speakers.length) ? JSON.stringify(finding.speakers) : '侦察未提取到发言人——精校时据原文发言人标签自行归位（若有），见规范 1/7'

  // Chunked branch: this agent refines ONLY its line span and writes a part file; a stitch agent merges
  // the parts afterwards. Ownership rule keeps the K parallel agents from overlapping or leaving a gap.
  if (chunk && chunk.count > 1) {
    const outPart = partPath(f.outPath, chunk.idx)
    const steps = readPlanRange(f, chunk.startLine, chunk.endLine)
    const headBlock = chunk.isFirst
      ? `【抬头】你是第 1 块：第一行写 \`# ${f.title}\`，第二行写 \`${f.subtitle}\`，然后从第一个 \`##\` 小标题开始正文。`
      : `【抬头】你是第 ${chunk.idx} 块（非首块）：**不要写 H1 标题、不要写说明行**，直接从一个 \`##\` 小标题开始正文。`
    const tailNote = chunk.isLast
      ? `【收尾】你这一块覆盖到源文件结尾（约第 ${f.lines} 行${anchor.text ? `，最后一句「${anchor.text}」` : ''}）——必须精校到最后，正文绝不能中途断掉（结尾客套可折成一句说明）。`
      : '【收尾】你不是最后一块，正常精校到你负责的最后一轮发言即可，**不要补任何结束语 / 总结 / 收束注**——后面还有别的块接着写。'
    return `你是访谈转录「精校」子代理（分块并行：本份共 ${chunk.count} 块，你负责第 ${chunk.idx} 块）。

【写法对照表（精校用）】（表中已是核实后的统一写法，照此统一人名/品牌/术语——**标 ⚠ 的人名条目未采纳、勿套用**；「写法统一」一节的术语/品牌请**初次落笔就写对**，不要先写错再回头逐字改）：
${glossary}

【源文件】${f.path}（全文约 ${f.lines} 行）。你只负责其中**第 ${chunk.startLine}–${chunk.endLine} 行**这一段。
读取计划（首尾各多读约 ${CHUNK_MARGIN} 行邻接内容，好看清边界处的整轮发言；只精校属于你的那些发言轮）：
${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

【分块边界规则——务必严格，确保各块不重不漏】
- “一轮发言”以发言人标签行开头（如「发言人 N」「记者：」「张三：」）。一轮发言归属于**其开头标签所在行号**落在哪一块的范围，就由哪一块精校，整轮归一块、绝不拆到两块。
- 你的起点：从行号 ≥ ${chunk.startLine} 的**第一个发言人标签**开始精校。${chunk.isFirst ? '（你是第 1 块，从第 1 行正常开始，不跳过任何内容。）' : `若第 ${chunk.startLine} 行正处在某轮发言中间（该轮标签行在 ${chunk.startLine} 之前），那一轮属于上一块——**跳过、不要精校它**（往前多读几行确认标签位置即可；若那轮特别长、邻接内容里没看到它的标签，就再往前读到看见为止）。`}
- 你的终点：凡标签行号 ≤ ${chunk.endLine} 的发言轮都归你；${chunk.isLast ? '你是最后一块，精校到文件末尾。' : `若你负责的最后一轮发言正文越过第 ${chunk.endLine} 行，**继续往下读、把这一轮精校完整**；但**不要开始**任何标签行号 > ${chunk.endLine} 的发言轮（那是下一块的）。`}

【输出】Write 到 ${outPart}
${headBlock}
【该份发言人】${speakers}
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

// Merge the K chunk part-files into the final transcript. The script can't touch the filesystem, so a
// cheap agent does it — but by CONCATENATION (one tool call), never by retyping the content (which would
// hit the per-response output cap on a long transcript and risk paraphrase). The post-stitch completeness
// check + the source-aware audit (charRatio) backstop a bad merge.
export function stitchPrompt(f, chunks) {
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

export function checkPrompt(f, anchor) {
  const src = (anchor && anchor.text)
    ? `源转录共 ${anchor.line || '?'} 行，原文最后一句是：“${anchor.text}”。`
    : `先用 Read 读源文件 ${f.path} 的最后约 30 行，确定原文结尾内容。`
  return `你是「结尾完整性」核对代理。${src}
用 Read 读成稿 ${f.outPath} 的最后约 60 行。**判 complete 前先确认成稿倒数若干段的实质内容确实对应到了源文件结尾（上面的锚点附近）**：
- **注意：精校稿因删口癖、并碎句，行数与字数本就比源文件少约 15-30%——绝不能因为成稿比源文件短、或行数比源文件少就判 complete=false。完整性只看「源文件结尾那句的实质内容有没有出现在成稿结尾」，不做行数/字数比例的推断。**
- 对应上了 → complete=true。
- 成稿在**远早于结尾处**就以一句收束注（如“后续为离场闲聊，从略”）收住、中间大段源文件内容缺失 → 这是中途截断，**complete=false**，在 note 写明大约从哪一段起缺。
- 只有当收束注**前一段已对应到源文件末尾区域**时，该收束注才算正常收尾（complete=true）。
再用 Search/Read 快速抽查成稿质量：若仍有明显纯噪音口癖（嗯、呃、对对对、是是是、我我、就就 等；“那个/这个/就是说”仅在纯卡顿时算）或单段超过约 900 字，写进 note，即使结尾完整也要提醒。
按 schema 返回 complete 与 note。`
}

export function dedupPrompt(listText, a) {
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

export function singlePassPrompt(f, a) {
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

export function summaryPrompt(a, refined) {
  const list = refined.map((r) => '- ' + (r.outPath || r.path)).join('\n')
  return `你是「访谈总结」子代理。基于以下精校成稿（先逐一 Read），产出《${a.topic}访谈总结》：
${list}

结构模板：先 Read ${a.skillDir}/references/deliverables.md 的「访谈总结」部分。
三部分：分类要点（### 按主题小节，每条带具体事实或数字）；金句 Quotes（按发言人归类，忠实引用、只去口癖不改意）；行业与公司/人物洞察（分行业与该公司/人物两块，点出看点与风险，体现判断而非复述）。**所有标题一律不编号**（洞察等列表项也用 - 项目符号，不要 1./一、编号）。
**源头可溯**：每条金句末尾标〔出处：成稿文件标题 · 所在小标题〕；分类要点凡引用具体数字/事实也尽量带〔出处：标题 · 小标题〕——成稿里每段都在某个 ## 小标题下，照抄那个小标题原文，便于读者一键核对。

${TYPESET}

写到 ${a.outputDir}/${a.topic}访谈总结.md（输出根目录，不是 Transcripts/）。抬头 H1 + 第二行斜体说明（受访者与采访方、采访时间 ${a.date}）。末尾注一行配套文档（Transcripts/ 下各精校全文）。
你的最终回复即返回值：输出路径 + 各部分小节标题清单。`
}

export function timelinePrompt(a, glossary, refined) {
  const list = refined.map((r) => '- ' + (r.outPath || r.path)).join('\n')
  const hasGlossary = glossary && glossary.trim() && glossary !== SINGLE_FILE_GLOSSARY
  const glossaryBlock = hasGlossary
    ? `附关键人物对照表（结合下方校对表的真名核实结论；查不到的标“真名未公开”）。\n\n统一校对表（含核实结论）：\n${glossary}`
    : `附关键人物对照表——本次无独立校对表，关键人物真名请你直接用 WebSearch 现查、查不到标“真名未公开”，绝不臆造。`
  return `你是「时间线」子代理。把 ${a.topic} 访谈口述与公开资料对照，产出《${a.topic}时间线》。

步骤：先 Read ${a.skillDir}/references/deliverables.md 的「时间线」部分作为结构模板；再逐一 Read 本次精校成稿（只读下面这些——目录里可能还有往次旧稿，不要读）：
${list}
抽出所有带时间/阶段的事实（成立、产品、融资、人事、渠道、出海…）；然后用 WebSearch / WebFetch 按“公司名 + 融资/成立/创始人”等核实年份、轮次、金额、关键人物（网页留在你的上下文里）。访谈与公开资料冲突时两边都列、注明分歧，不强行二选一；逐条标【访谈】/【公开】/【公开+访谈】；**源头可溯**：凡【访谈】或【公开+访谈】的事件，在该条末尾标〔出处：成稿标题 · 小标题〕指明取自哪份成稿哪段，便于核对。${glossaryBlock}

${TYPESET}

写到 ${a.outputDir}/${a.topic}时间线.md。标题一律不编号。你的最终回复即返回值：输出路径 + 时间线小节清单。`
}

// Logic-reordered draft: reads the **refined transcript** (not the raw source — names/terms already unified), reordering Q&A from recording order into narrative order.
// Order-preserving reconstruction (lossless): Q&A blocks are copied verbatim, positions only are swapped; [Editor] bridging notes added only where a move breaks a reference.
export function logicWritePrompt(f, a) {
  return `你是「逻辑顺序重排」子代理。把一份**已精校**的访谈稿从“录音顺序”重排成“叙事顺序”——让散落在访谈各处、其实属于同一条线的问答聚到一起，读起来是一个完整的故事。**这是重排，不是改写、更不是摘要**：问答块整段照搬精校稿原文，一字不改、一处不漏，只调换位置。

【输入·精校稿】${f.outPath}（已精校，人名/术语已统一）。${readPlan(f)}（这是读精校稿——它可能比源文件略短，读到没有更多内容即止。**只读这一份，不读源转录、不联网。**）
【结构模板】先 Read ${a.skillDir}/references/deliverables.md 的「逻辑顺序稿」部分。
【输出】Write 到 ${a.outputDir}/逻辑顺序/${f.title}.md
【抬头】第一行 \`# ${f.title} · 逻辑顺序稿\`；第二行斜体：\`*基于精校稿重排为叙事顺序，内容照搬未改，仅调顺序 + 少量 [编者] 衔接；原顺序见 Transcripts/${f.title}.md*\`

做法：
1. 通读精校稿，**理出这次访谈的主线**：3–7 条叙事线索（如 创业缘起 / 战略转折 / 某产品始末 / 组织 / 行业判断），各给一个自描述 \`##\` 小标题（**一律不编号**）。**源头可溯**：每条线索 \`##\` 小标题下、正文之前，加一行斜体 \`〔取自精校稿：<小标题1>、<小标题2>…〕\`，列出本线索取自精校稿的哪些 \`##\` 小标题（原样照抄精校稿小标题文字，与返回的 source_sections 一致），便于读者回溯原稿对应段落。
2. 每条线索选一个**内部顺序逻辑**：讲历史按时间，讲决策按 问题→洞察→决定→结果，讲产品/事件按 起因→经过→结果。
3. 把精校稿里属于该线索的问答**整段照原文搬过来**，按上面的逻辑排好——保留 \`发言人：\` 标签**及其在精校稿里的原样式**（精校稿是 \`张三：\` 就写 \`张三：\`，**别改成** \`**张三：**\` 加粗或其它样式）、保留全部事实细节与原话措辞，**只换位置，不改一字**。
4. **指代修复（克制）**：仅当某段被移走后、开头的“他 / 那个 / 上面说的 / 然后”等指代或承接断了，才加一句 \`> [编者] …\` 衔接（如“此段原在访谈后段，承前文同属早期创业”），或把孤立的“他”补成名字。**绝不**改写原话、绝不补受访者没说的、绝不替他下结论。
5. **不丢不重**：精校稿里每一段实质问答都要在重排稿里出现且**只出现一次**（纯客套/重复可省，与精校稿口径一致）。一段问答若横跨两条线索，放进主线索一次，必要时另一处用一句 \`> [编者]\` 指路。
6. 开头加一节 \`## 主线脉络（导读）\`：一段话讲清这次访谈的主线与你的重排逻辑。

${TYPESET}

完成后按 schema 返回：path、mainline（导读那段）、threads（每条线索的 title、logic、以及它取自精校稿的哪些小标题 source_sections——**source_sections 必须原样照抄精校稿里的 \`##\` 小标题文字**，供完整性核对）、open_questions。`
}

