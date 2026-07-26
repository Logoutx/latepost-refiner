import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTranscriptMetadata, sanitizeTranscriptMetadata, transcriptMetadataPrompt } from '../core/transcript-metadata.js'

const file = { path: '/tmp/source.md', label: 'source', lines: 120, bytes: 6000 }

test('low-confidence identity is forced blank at the manifest boundary', () => {
  assert.deepEqual(sanitizeTranscriptMetadata({
    interviewee_name: '猜测的人名',
    organization_name: '猜测的公司',
    role_title: 'CEO',
    confidence: 'low',
    evidence: '只有文件名线索',
  }), {
    interviewee_name: null,
    interviewee_aliases: [],
    organization_name: null,
    organization_aliases: [],
    role_title: null,
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
    confidence: 'high',
    evidence: ' 开头明确自我介绍。 ',
  }), {
    interviewee_name: '徐 大全',
    interviewee_aliases: ['徐大全'],
    organization_name: '示例 公司',
    organization_aliases: ['示例公司'],
    role_title: '创始人',
    confidence: 'high',
    evidence: '开头明确自我介绍。',
  })
})

test('metadata extractor uses the scout model and exposes canonical catalog', async () => {
  let captured
  const engine = {
    log() {},
    agent: async (prompt, options) => {
      captured = { prompt, options }
      return {
        interviewee_name: '徐大全',
        organization_name: '示例科技',
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
  })

  assert.equal(captured.options.label, 'metadata:source')
  assert.equal(captured.options.phase, 'Scout')
  assert.equal(captured.options.model, 'deepseek-v4-flash')
  assert.match(captured.prompt, /"canonical_name":"徐大全"/)
  assert.equal(result.interviewee_name, '徐大全')
  assert.equal(result.organization_name, '示例科技')
})

test('prompt forbids filling uncertain fields', () => {
  const prompt = transcriptMetadataPrompt(file)
  assert.match(prompt, /不能确认的字段单独留空/)
  assert.match(prompt, /confidence=low 时所有实体字段必须留空/)
})
