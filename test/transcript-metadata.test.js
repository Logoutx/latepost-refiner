import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTranscriptMetadata, sanitizeTranscriptMetadata, transcriptMetadataPrompt } from '../core/transcript-metadata.js'

const file = { path: '/tmp/source.md', label: 'source', lines: 120, bytes: 6000 }

test('low-confidence identity is forced blank at the manifest boundary', () => {
  assert.deepEqual(sanitizeTranscriptMetadata({
    interviewee_name: '猜测的人名',
    organization_name: '猜测的公司',
    role_title: 'CEO',
    interviewee_intro: '未经证实的人物介绍',
    confidence: 'low',
    evidence: '只有文件名线索',
  }), {
    interviewee_name: null,
    interviewee_aliases: [],
    organization_name: null,
    organization_aliases: [],
    role_title: null,
    interviewee_intro: null,
    confidence: 'low',
    evidence: '只有文件名线索',
  })
})

test('metadata sanitizer normalizes fields and deduplicates aliases', () => {
  assert.deepEqual(sanitizeTranscriptMetadata({
    interviewee_name: '  徐 大全  ',
    interviewee_aliases: ['徐 大全', '徐大全', '徐大全'],
    organization_name: ' 示例 公司 ',
    organization_aliases: ['示例公司', '示例公司'],
    role_title: ' 创始人 ',
    interviewee_intro: ' 示例科技创始人，访谈主要讨论智能硬件创业。 ',
    confidence: 'high',
    evidence: ' 开头明确自我介绍。 ',
  }), {
    interviewee_name: '徐 大全',
    interviewee_aliases: ['徐大全'],
    organization_name: '示例 公司',
    organization_aliases: ['示例公司'],
    role_title: '创始人',
    interviewee_intro: '示例科技创始人,访谈主要讨论智能硬件创业。',
    confidence: 'high',
    evidence: '开头明确自我介绍。',
  })
})

test('metadata extractor uses the scout model and exposes canonical catalog', async () => {
  let captured
  const refinedFile = { path: '/tmp/refined.md', label: 'source精校稿', lines: 100, bytes: 5200 }
  const engine = {
    log() {},
    agent: async (prompt, options) => {
      captured = { prompt, options }
      return {
        interviewee_name: '徐大全',
        organization_name: '示例科技',
        role_title: '创业者',
        interviewee_intro: '示例科技负责人，本次主要讨论 Agent 产品。',
        confidence: 'high',
        evidence: '标题与自我介绍均明确。',
      }
    },
  }
  const result = await extractTranscriptMetadata(engine, file, {
    topic: '对话徐大全',
    model: 'deepseek-v4-flash',
    catalog: {
      people: [{ canonical_name: '徐大全', aliases: ['徐老师'] }],
      organizations: [{ canonical_name: '示例科技', aliases: [] }],
    },
    refinedFile,
    speakerResolution: {
      mappings: [{
        sourceLabel: '说话人 1',
        outputLabel: '徐大全',
        role: '受访者',
        basis: 'scout_output_label',
      }],
      unresolved: [],
    },
  })

  assert.equal(captured.options.label, 'metadata:source')
  assert.equal(captured.options.phase, 'Deliver')
  assert.equal(captured.options.model, 'deepseek-v4-flash')
  assert.deepEqual(captured.options.filePolicy.readPaths, ['/tmp/source.md', '/tmp/refined.md'])
  assert.deepEqual(captured.options.filePolicy.writeRoots, [])
  assert.match(captured.prompt, /"canonical_name":"徐大全"/)
  assert.match(captured.prompt, /最终精校稿：\/tmp\/refined\.md/)
  assert.match(captured.prompt, /"output_label":"徐大全"/)
  assert.match(captured.prompt, /源稿是身份事实的最高依据/)
  assert.ok(captured.options.schema.properties.role_title)
  assert.equal(result.interviewee_name, '徐大全')
  assert.equal(result.organization_name, '示例科技')
  assert.equal(result.role_title, '创业者')
  assert.equal(result.interviewee_intro, '示例科技负责人,本次主要讨论 Agent 产品。')
})

test('prompt forbids filling uncertain fields', () => {
  const prompt = transcriptMetadataPrompt(file)
  assert.match(prompt, /实际表示本稿核心人物/)
  assert.match(prompt, /独白或演讲取主讲人\/作者/)
  assert.match(prompt, /不能确认的字段单独留空/)
  assert.match(prompt, /interviewee_intro 用一到两句具体说明/)
  assert.match(prompt, /confidence=low 时姓名、机构、简短身份和人物介绍必须留空/)
  assert.match(prompt, /role_title 是稿内能够确认的简短身份/)
  assert.match(prompt, /不能只复制 organization_name/)
})
