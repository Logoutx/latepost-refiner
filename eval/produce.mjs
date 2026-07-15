// Produces eval result JSON with the Universal engine (DeepSeek). This is intentionally optional:
// local/CI scorer tests are deterministic, while this script spends model tokens.
//
// Usage:
//   DEEPSEEK_API_KEY=... node eval/produce.mjs --suite golden --out /tmp/golden.json
//   DEEPSEEK_API_KEY=... node eval/produce.mjs --suite filler --out /tmp/filler.json
import fs from 'fs'
import path from 'path'
import { RULES } from '../core/spec.js'
import { selectEngine } from '../universal/jobs.js'
import { FIXTURES } from './fixtures.js'
import { GOLDEN_FIXTURES } from './golden-fixtures.js'

function parseArgs(argv) {
  const out = { suite: 'golden', model: 'opus', out: '' }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--suite') out.suite = argv[++i]
    else if (tok === '--model') out.model = argv[++i]
    else if (tok === '--out') out.out = argv[++i]
  }
  return out
}

function fixturesFor(suite) {
  if (suite === 'filler') return FIXTURES.map(({ id, input }) => ({ id, input }))
  if (suite === 'golden') return GOLDEN_FIXTURES.map(({ id, title, input, mustContain, mustNotContain }) => ({ id, title, input, mustContain, mustNotContain }))
  throw new Error(`unknown suite: ${suite}`)
}

function promptFor(suite, fixtures) {
  return `你是访谈转录精校评测 runner。请按下面的精校规范处理每个 fixture 的 input，返回 JSON 对象 outputs，其中 key 是 fixture id，value 是精校后的文本。

不要解释，不要输出 markdown。不要合并不同 fixture。每个输出都应保持对话体，不要摘要。

【精校规范】
${RULES}

【评测重点】
${suite === 'golden'
    ? '这些是 golden property fixtures：必须保留事实、说话立场、结尾锚点、发言人结构；必须折叠纯拼字确认；必须按中文数字/空格规则规范化。'
    : '这些是 filler-removal fixtures：删除纯垫词，但保留会改变含义的保护词。'}

【fixtures】
${JSON.stringify(fixtures, null, 2)}`
}

const args = parseArgs(process.argv.slice(2))
if (!args.out) { console.error('usage: node eval/produce.mjs --suite golden|filler --out <results.json> [--model opus]'); process.exit(2) }

const fixtures = fixturesFor(args.suite)
const schema = {
  type: 'object',
  properties: {
    outputs: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
}

const sel = selectEngine({ concurrency: 1 })
const result = await sel.engine.agent(promptFor(args.suite, fixtures), { label: `eval:${args.suite}`, model: args.model, schema })
const outputs = result && result.outputs ? result.outputs : result
if (!outputs || typeof outputs !== 'object') throw new Error('eval model did not return an outputs object')

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
fs.writeFileSync(args.out, `${JSON.stringify(outputs, null, 2)}\n`, 'utf8')
console.error(`wrote ${args.suite} eval outputs to ${args.out}`)
