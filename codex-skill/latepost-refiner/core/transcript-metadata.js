// GENERATED FILE — DO NOT EDIT. Source: core/transcript-metadata.js. Regenerate: npm run sync:skills
import { readPlan } from './prompts.js'

export const TRANSCRIPT_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    interviewee_name: { type: 'string', description: '能由稿件明确确认的主要受访者规范姓名；无法确认时留空' },
    interviewee_aliases: { type: 'array', items: { type: 'string' }, description: '稿件中明确出现、且确定指向该受访者的其它姓名写法' },
    organization_name: { type: 'string', description: '采访发生时受访者明确所属的公司或机构规范名；无法确认时留空' },
    organization_aliases: { type: 'array', items: { type: 'string' }, description: '稿件中明确出现、且确定指向该机构的其它写法' },
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

export function transcriptMetadataPrompt(file, context = {}) {
  return `你是访谈转录的“目录元数据”提取代理。你的输出只用于建立转录稿目录，不参与正文改写。

源文件：${file.path}（约 ${file.lines || 0} 行）
采访主题：${context.topic || '未提供'}
采访背景：${context.background || '未提供'}

既有规范实体目录：
${compactCatalog(context.catalog)}

${readPlan(file)}

完整读完后，按 schema 返回结构化结果。规则：
1. 只依据源稿、标题和采访背景；不联网，不用外部记忆补全。
2. interviewee_name 是主要受访者的真实姓名，不是“受访者”“嘉宾”“发言人 1”，也不是记者、PR 或稿件编辑。
3. organization_name 是采访发生时受访者明确所属的公司或机构，不是访谈中讨论到的其它公司。媒体、学校、政府、基金会等也属于机构。
4. 若既有目录中已有同一实体，必须原样复用其 canonical_name；稿内其它明确写法放 aliases。不要仅因字面相近就强行合并。
5. 多位受访者时，仅在稿件明确存在主受访者时填写；主次不清则姓名留空，并在 evidence 说明“多位受访者，主次不明”。
6. 姓名、机构、人物介绍分别判断，不能确认的字段单独留空；不要为了填满字段而猜测。
7. interviewee_intro 用一到两句具体说明受访者做什么、为何与本次访谈主题相关；只写稿内可确认的信息，不写评价、宣传话术或外部常识。
8. high 仅用于标题、自我介绍、明确身份说明等直接证据；medium 用于多处一致且无冲突的稿内线索；只剩弱推断或有冲突时 confidence=low。confidence=low 时姓名、机构和人物介绍必须留空。
9. evidence 只写不超过两句的稿内依据或无法确认原因，不要长段摘录。`
}

export async function extractTranscriptMetadata(engine, file, context = {}) {
  if (!engine || typeof engine.agent !== 'function' || !file) return sanitizeTranscriptMetadata(null)
  try {
    const raw = await engine.agent(transcriptMetadataPrompt(file, context), {
      label: `metadata:${file.label || 'transcript'}`,
      phase: 'Scout',
      model: context.model || 'haiku',
      schema: TRANSCRIPT_METADATA_SCHEMA,
    })
    return sanitizeTranscriptMetadata(raw)
  } catch (error) {
    if (typeof engine.log === 'function') engine.log(`metadata extraction failed: ${error && error.message ? error.message : String(error)}`)
    return sanitizeTranscriptMetadata({ confidence: 'low', evidence: '元数据提取失败' })
  }
}
