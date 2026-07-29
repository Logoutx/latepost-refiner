import { readPlan } from './prompts.js'

export const TRANSCRIPT_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    interviewee_name: { type: 'string', description: '能由稿件明确确认的核心人物规范姓名：访谈取主要受访者，独白/演讲取主讲人或作者；无法确认时留空' },
    interviewee_aliases: { type: 'array', items: { type: 'string' }, description: '稿件中明确出现、且确定指向该核心人物的其它姓名写法' },
    organization_name: { type: 'string', description: '内容发生时核心人物明确所属的公司或机构规范名；无法确认时留空' },
    organization_aliases: { type: 'array', items: { type: 'string' }, description: '稿件中明确出现、且确定指向该机构的其它写法' },
    role_title: { type: 'string', description: '稿内可确认、用于文件命名的简短身份（不超过 8 字，如“经济学家”“播客主持人”“英伟达CEO”）；无法确认时留空，不能只填机构名' },
    interviewee_intro: { type: 'string', description: '一到两句具体人物介绍：受访者做什么、与本次访谈主题有什么关系；只能写稿内可确认的信息' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high=稿件直接明示；medium=多处线索一致；low=无法可靠确认' },
    evidence: { type: 'string', description: '不超过两句的稿内依据或无法确认原因，不要长段摘录' },
  },
}

const cleanString = (value, maxLength) => {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, maxLength) : null
}

const cleanAliases = (value, canonical) => {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const canonicalKey = canonical ? canonical.normalize('NFKC').toLocaleLowerCase() : null
  const out = []
  for (const raw of value) {
    const alias = cleanString(raw, 100)
    if (!alias) continue
    const key = alias.normalize('NFKC').toLocaleLowerCase()
    if (key === canonicalKey || seen.has(key)) continue
    seen.add(key)
    out.push(alias)
    if (out.length >= 12) break
  }
  return out
}

export function sanitizeTranscriptMetadata(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low'
  const evidence = cleanString(raw.evidence, 300)
  // “low” means the document did not establish identity. Enforce blank entity fields even if a model
  // contradicts its own confidence, so downstream catalogs cannot turn a guess into a canonical entity.
  if (confidence === 'low') {
    return {
      interviewee_name: null,
      interviewee_aliases: [],
      organization_name: null,
      organization_aliases: [],
      role_title: null,
      interviewee_intro: null,
      confidence,
      evidence,
    }
  }
  const intervieweeName = cleanString(raw.interviewee_name, 100)
  const organizationName = cleanString(raw.organization_name, 160)
  return {
    interviewee_name: intervieweeName,
    interviewee_aliases: cleanAliases(raw.interviewee_aliases, intervieweeName),
    organization_name: organizationName,
    organization_aliases: cleanAliases(raw.organization_aliases, organizationName),
    // role_title is no longer requested, but keep accepting it for old manifests and downstream rollback.
    role_title: cleanString(raw.role_title, 120),
    interviewee_intro: cleanString(raw.interviewee_intro, 300),
    confidence,
    evidence,
  }
}

const compactCatalog = (catalog) => {
  if (!catalog || typeof catalog !== 'object') return '（无既有目录）'
  const people = Array.isArray(catalog.people) ? catalog.people.slice(0, 500) : []
  const organizations = Array.isArray(catalog.organizations) ? catalog.organizations.slice(0, 500) : []
  if (!people.length && !organizations.length) return '（无既有目录）'
  return JSON.stringify({ people, organizations })
}

const compactSpeakerResolution = (resolution) => {
  if (!resolution || typeof resolution !== 'object') return '（无可靠说话人映射）'
  const mappings = (Array.isArray(resolution.mappings) ? resolution.mappings : []).slice(0, 50).map((item) => ({
    source_label: cleanString(item && item.sourceLabel, 80),
    output_label: cleanString(item && item.outputLabel, 80),
    role: cleanString(item && item.role, 80),
    basis: cleanString(item && item.basis, 80),
  })).filter((item) => item.source_label || item.output_label || item.role)
  const unresolved = (Array.isArray(resolution.unresolved) ? resolution.unresolved : [])
    .slice(0, 50).map((item) => cleanString(item, 80)).filter(Boolean)
  if (!mappings.length && !unresolved.length) return '（无可靠说话人映射）'
  return JSON.stringify({ mappings, unresolved })
}

const readOnlyFilePolicy = (sourceFile, refinedFile) => ({
  readRoots: [],
  writeRoots: [],
  readPaths: [sourceFile && sourceFile.path, refinedFile && refinedFile.path].filter(Boolean),
  writePaths: [],
  writePartBases: [],
})

export function transcriptMetadataPrompt(file, context = {}) {
  const refined = context.refinedFile
  const finalSection = refined
    ? `
最终精校稿：${refined.path}（约 ${refined.lines || 0} 行）
${readPlan(refined)}

全文说话人映射（由精校前 Scout 识别，并已用于精校和审计）：
${compactSpeakerResolution(context.speakerResolution)}
`
    : ''
  return `你是访谈转录的“目录身份定稿”代理。你的输出只用于建立转录稿目录和交付命名，不参与正文改写，也不得修改任何文件。

源文件：${file.path}（约 ${file.lines || 0} 行）
采访主题：${context.topic || '未提供'}
采访背景：${context.background || '未提供'}

既有规范实体目录：
${compactCatalog(context.catalog)}

${readPlan(file)}
${finalSection}

完整读完后，按 schema 返回结构化结果。规则：
1. 源稿是身份事实的最高依据；最终精校稿只用于理解已经规范化的表达，说话人映射只用于确认角色归属。不得采用仅在精校稿中新增、却无法回指源稿或说话人映射的姓名、机构或身份。
2. 不联网，不用外部记忆补全。
3. interviewee_name 沿用历史字段名，实际表示本稿核心人物：访谈取主要受访者，单人播客、独白或演讲取主讲人/作者。不能填写“受访者”“嘉宾”“发言人 1”等角色，也不能把记者、PR 或稿件编辑当成访谈核心人物。
4. organization_name 是内容发生时核心人物明确所属的公司或机构，不是稿中讨论到的其它公司。媒体、学校、政府、基金会等也属于机构。
5. role_title 是稿内能够确认的简短身份，用于“人物-身份”文件名；不超过 8 字，优先职业或职务，可在确有必要时写“机构+职务”，不能只复制 organization_name。
6. 若既有目录中已有同一实体，必须原样复用其 canonical_name；稿内其它明确写法放 aliases。不要仅因字面相近就强行合并。
7. 多位受访者时，仅在稿件明确存在主受访者时填写；主次不清则姓名留空，并在 evidence 说明“多位受访者，主次不明”。
8. 姓名、机构、简短身份、人物介绍分别判断，不能确认的字段单独留空；不要为了填满字段而猜测。
9. interviewee_intro 用一到两句具体说明受访者做什么、为何与本次访谈主题相关；只写稿内可确认的信息，不写评价、宣传话术或外部常识。
10. high 仅用于标题、自我介绍、明确身份说明等直接证据；medium 用于多处一致且无冲突的稿内线索；只剩弱推断或有冲突时 confidence=low。confidence=low 时姓名、机构、简短身份和人物介绍必须留空。
11. evidence 只写不超过两句的稿内依据或无法确认原因，不要长段摘录。`
}

export async function extractTranscriptMetadata(engine, file, context = {}) {
  if (!engine || typeof engine.agent !== 'function' || !file) return sanitizeTranscriptMetadata(null)
  try {
    const raw = await engine.agent(transcriptMetadataPrompt(file, context), {
      label: `metadata:${file.label || 'transcript'}`,
      phase: context.refinedFile ? 'Deliver' : 'Scout',
      model: context.model || 'haiku',
      schema: TRANSCRIPT_METADATA_SCHEMA,
      filePolicy: readOnlyFilePolicy(file, context.refinedFile),
    })
    return sanitizeTranscriptMetadata(raw)
  } catch (error) {
    if (typeof engine.log === 'function') engine.log(`metadata extraction failed: ${error && error.message ? error.message : String(error)}`)
    return sanitizeTranscriptMetadata({ confidence: 'low', evidence: '元数据提取失败' })
  }
}
