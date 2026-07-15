import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareFile, buildFilePolicy } from '../universal/jobs.js'
import { runPipeline } from '../core/pipeline.js'
import { makeDeepSeekEngine } from '../engines/deepseek.js'

// The search-api bench's Level-2 verify replay (bench/search-api/run-verify-replay.mjs) drives the REAL
// pipeline with scope=['verify'] and an alternative search adapter injected via makeDeepSeekEngine({ searchFn }).
// This test pins that seam end-to-end without a network or a real model: a fake OpenAI-style client walks
// scout→verify, and we assert the injected searchFn (not Tavily) is what the verify stage calls, that its
// result reaches the rendered glossary, and that refine is skipped because scope excludes it.
// All fixture names are fictional (repo placeholders 云洲仪器/沈其安).

const SUPERSET = {
  // one structured payload that satisfies every offline/online stage — each stage reads only its own fields
  speakers: [{ label: '记者', role: '记者', identity: '主持' }, { label: '沈其安', role: '受访者', identity: '云洲仪器 创始人' }],
  people: [{ canonical: '沈其安', variants: ['沈奇安'], hint: '云洲仪器 创始人' }],
  brands: [{ canonical: '云洲仪器', variants: ['云州仪器'], hint: '受访公司' }],
  terms: [],
  resolved: [{ query: '沈其安', canonical: '沈其安', identity: '云洲仪器 创始人', source: 'example.com 官网团队页' }],
  unresolved: [],
  suspects: [],
}

const toolNames = (params) => (params.tools || []).map((t) => t.function?.name || t.type)
const rid = () => Math.random().toString(36).slice(2)
const soCall = (obj) => ({ id: 'so' + rid(), type: 'function', function: { name: 'structured_output', arguments: JSON.stringify(obj) } })
const wsCall = (q) => ({ id: 'ws' + rid(), type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: q }) } })

// Fake client: an online (verify) call carries a web_search tool → first search, then structured output.
// An offline call (scout/dedup) → structured output straight away. Deterministic, no network.
function makeFakeClient() {
  return {
    chat: { completions: { create: async (params) => {
      const names = toolNames(params)
      const online = names.includes('web_search')
      const searched = (params.messages || []).some((m) => m.role === 'tool' && /example\.com|沈其安|无结果/.test(String(m.content || '')))
      const message = (online && !searched)
        ? { content: '', tool_calls: [wsCall('沈其安 云洲仪器 创始人')] }
        : { content: '', tool_calls: [soCall(SUPERSET)] }
      return { choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    } } },
  }
}

test('verify replay seam: scope=[verify] drives scout→verify against the injected searchFn, not Tavily', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-inject-'))
  // A real-sized transcript (≥ ONE_PASS_CHARS) so the pipeline takes the scout+verify branch, not one-pass.
  const turns = []
  for (let i = 0; i < 70; i += 1) {
    turns.push(`记者：第 ${i} 个问题，关于云洲仪器早期做水质监测设备的判断，你们当时怎么取舍？请具体讲讲。`)
    turns.push(`沈其安：这个问题很好。云洲仪器早期是我沈其安负责产品，当时判断行业数字化刚起步，机会在这。`)
  }
  const src = path.join(dir, 'transcript.txt')
  fs.writeFileSync(src, turns.join('\n') + '\n', 'utf8')

  const { entry } = await prepareFile(src, { topic: '云洲仪器', date: '2025-07', headingPolicy: 'none', outputDir: dir, workDir: path.join(dir, '.work') })
  assert.ok(entry.chars >= 4000, `fixture transcript is real-sized (${entry.chars} 字, ≥ 4000)`)

  const searchCalls = []
  const searchFn = async (query, opts) => { searchCalls.push({ query, opts }); return [{ title: '云洲仪器官网', url: 'https://example.com/team', snippet: '创始人 沈其安' }] }

  const engine = makeDeepSeekEngine({
    client: makeFakeClient(), concurrency: 2, searchK: 5, searchFn,
    filePolicy: buildFilePolicy({ outputDir: dir, files: [entry] }),
    onPhase: () => {}, onLog: () => {},
  })

  const A = {
    topic: '云洲仪器', date: '2025-07', background: '一次关于云洲仪器早期发展的访谈。',
    outputDir: dir, scope: ['verify'], verifyDepth: 'deep', headingPolicy: 'none', files: [entry], fresh: true,
  }
  const r = await runPipeline(A, engine)

  assert.equal(r.error, undefined, 'pipeline completed without error')
  assert.ok(searchCalls.length >= 1, `the injected searchFn was called during verify (${searchCalls.length}×)`)
  assert.deepEqual(searchCalls[0].opts, { k: 5 }, 'searchFn received the {k} option')
  assert.match(r.glossary, /沈其安/, 'the verified entity is in the rendered glossary')
  assert.match(r.glossary, /〔核实/, 'the glossary carries a 〔核实〕 marker (verify actually ran)')
  assert.match(r.glossary, /example\.com/, 'the injected adapter\'s source flowed into the verify conclusion')
  assert.deepEqual(r.refined, [], 'refine was skipped — scope=[verify] has no refine stage')
  assert.deepEqual(r.failed, [], 'nothing failed')

  fs.rmSync(dir, { recursive: true, force: true })
})
