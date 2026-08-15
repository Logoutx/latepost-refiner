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
    speaker_assignments: [],
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
    speaker_assignments: [],
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
        speaker_assignments: [{
          speaker_track_id: 'S000002',
          canonical_name: '徐大全',
          role: '受访者',
          confidence: 'high',
          evidence: '该轨道开场直接自我介绍。',
        }],
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
    speakerRegistry: [{
      id: 'S000002',
      sourceLabels: ['说话人 1'],
      canonicalLabel: '徐大全',
      role: '受访者',
      identityStatus: 'scout_confirmed',
      confidence: 'high',
    }],
  })

  assert.equal(captured.options.label, 'metadata:source')
  assert.equal(captured.options.phase, 'Deliver')
  assert.equal(captured.options.model, 'deepseek-v4-flash')
  assert.deepEqual(captured.options.filePolicy.readPaths, ['/tmp/source.md', '/tmp/refined.md'])
  assert.deepEqual(captured.options.filePolicy.writeRoots, [])
  assert.match(captured.prompt, /"canonical_name":"徐大全"/)
  assert.match(captured.prompt, /最终精校稿：\/tmp\/refined\.md/)
  assert.match(captured.prompt, /"output_label":"徐大全"/)
  assert.match(captured.prompt, /"speaker_track_id":"S000002"/)
  assert.match(captured.prompt, /源稿是身份事实的最高依据/)
  assert.ok(captured.options.schema.properties.role_title)
  assert.ok(captured.options.schema.properties.speaker_assignments)
  assert.equal(result.interviewee_name, '徐大全')
  assert.equal(result.organization_name, '示例科技')
  assert.equal(result.role_title, '创业者')
  assert.equal(result.interviewee_intro, '示例科技负责人,本次主要讨论 Agent 产品。')
  assert.deepEqual(result.speaker_assignments, [{
    speaker_track_id: 'S000002',
    canonical_name: '徐大全',
    role: '受访者',
    confidence: 'high',
    evidence: '该轨道开场直接自我介绍。',
  }])
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
  assert.match(prompt, /只能引用注册表已有 speaker_track_id/)
  assert.match(prompt, /不得从最终 Markdown 的标签文字反推或新造轨道/)
})
