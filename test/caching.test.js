// Offline unit tests for prompt-caching helpers. NO live API calls, no API keys.
// Fictional names/data only (hard rule: no real interview subjects/companies).
import test from 'node:test'
import assert from 'node:assert/strict'
import { withCacheBreakpoints } from '../engines/api.js'
import { parseCachedTokens } from '../engines/openai.js'

const isEphemeral = (cc) => cc && cc.type === 'ephemeral'

// Count every cache_control breakpoint in a params object (system + all message blocks).
function countBreakpoints(params) {
  let n = 0
  const sys = params.system
  if (Array.isArray(sys)) for (const b of sys) if (isEphemeral(b?.cache_control)) n++
  for (const m of params.messages || []) {
    if (Array.isArray(m?.content)) for (const b of m.content) if (isEphemeral(b?.cache_control)) n++
  }
  return n
}

// ---- withCacheBreakpoints: system prompt --------------------------------------

test('string system → single text block carrying an ephemeral breakpoint', () => {
  const out = withCacheBreakpoints({
    system: '你是一个访谈精校助手。',
    messages: [{ role: 'user', content: '开始吧' }],
  })
  assert.ok(Array.isArray(out.system), 'system becomes an array')
  assert.equal(out.system.length, 1)
  assert.equal(out.system[0].type, 'text')
  assert.equal(out.system[0].text, '你是一个访谈精校助手。')
  assert.ok(isEphemeral(out.system[0].cache_control))
})

test('array system gets cache_control on its LAST block only', () => {
  const out = withCacheBreakpoints({
    system: [
      { type: 'text', text: '规则一' },
      { type: 'text', text: '规则二' },
    ],
    messages: [{ role: 'user', content: '嗨' }],
  })
  assert.equal(out.system.length, 2)
  assert.equal(out.system[0].cache_control, undefined, 'first block untouched')
  assert.ok(isEphemeral(out.system[1].cache_control), 'last block marked')
})

test('absent system stays absent (no breakpoint invented)', () => {
  const out = withCacheBreakpoints({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(out.system, undefined)
})

// ---- withCacheBreakpoints: conversation (last message) ------------------------

test('last message with STRING content is wrapped into a cached text block', () => {
  const out = withCacheBreakpoints({
    messages: [{ role: 'user', content: '请精校这段访谈' }],
  })
  const content = out.messages[0].content
  assert.ok(Array.isArray(content), 'string content wrapped to array')
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, '请精校这段访谈')
  assert.ok(isEphemeral(content[0].cache_control))
})

test('breakpoint lands on the LAST block of the LAST message', () => {
  const out = withCacheBreakpoints({
    messages: [
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '倒数第二块' },
          { type: 'text', text: '最后一块' },
        ],
      },
    ],
  })
  const last = out.messages[2].content
  assert.equal(last[0].cache_control, undefined, 'non-last block of last message untouched')
  assert.ok(isEphemeral(last[1].cache_control), 'last block of last message marked')
})

test('tool_result content: breakpoint attaches to the last tool_result block', () => {
  const out = withCacheBreakpoints({
    messages: [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: '文件内容 A' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: '文件内容 B' },
        ],
      },
    ],
  })
  const results = out.messages[2].content
  assert.equal(results[0].type, 'tool_result')
  assert.equal(results[0].cache_control, undefined, 'first tool_result untouched')
  assert.ok(isEphemeral(results[1].cache_control), 'last tool_result carries breakpoint')
})

// ---- withCacheBreakpoints: breakpoint budget (≤ 2, no accumulation) -----------

test('total breakpoints never exceed 2 (system + last message)', () => {
  const out = withCacheBreakpoints({
    system: 'S',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ],
  })
  assert.equal(countBreakpoints(out), 2)
})

test('stale breakpoints from a previous turn are stripped before re-adding (still ≤ 2)', () => {
  // Simulate turn N already carrying a breakpoint on an EARLIER message and on an
  // earlier block of the last message — turn N+1 must not accumulate them.
  const priorTurn = {
    system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }, // stale, not the last block
          { type: 'text', text: 'd' },
        ],
      },
    ],
  }
  const out = withCacheBreakpoints(priorTurn)
  assert.equal(countBreakpoints(out), 2, 'exactly 2 after re-marking')
  // The stale breakpoint on message[0] must be gone.
  assert.equal(out.messages[0].content[0].cache_control, undefined)
  // The stale breakpoint on the non-last block of the last message must be gone.
  assert.equal(out.messages[2].content[0].cache_control, undefined)
  // The breakpoint must now sit on the genuine last block.
  assert.ok(isEphemeral(out.messages[2].content[1].cache_control))
})

test('repeated application is idempotent — count stays at 2', () => {
  let p = {
    system: 'S',
    messages: [{ role: 'user', content: 'hi' }],
  }
  for (let i = 0; i < 5; i++) p = withCacheBreakpoints(p)
  assert.equal(countBreakpoints(p), 2)
})

// ---- withCacheBreakpoints: purity (input not mutated) -------------------------

test('input params object and its nested content are NOT mutated', () => {
  const input = {
    system: '不要改我',
    messages: [{ role: 'user', content: [{ type: 'text', text: '原始' }] }],
  }
  const snapshot = JSON.parse(JSON.stringify(input))
  const out = withCacheBreakpoints(input)

  // Deep-equal to the pre-call snapshot → nothing on the input changed.
  assert.deepEqual(input, snapshot, 'input params unchanged')
  // And the returned object is a different reference with the breakpoints applied.
  assert.notEqual(out, input)
  assert.notEqual(out.messages, input.messages)
  assert.notEqual(out.messages[0].content, input.messages[0].content)
  assert.ok(isEphemeral(out.messages[0].content[0].cache_control))
  assert.equal(input.messages[0].content[0].cache_control, undefined)
})

test('unrelated params (model, max_tokens, tools, thinking) pass through untouched', () => {
  const tools = [{ name: 'Read', input_schema: { type: 'object' } }]
  const out = withCacheBreakpoints({
    model: 'claude-opus-4-8',
    max_tokens: 96000,
    thinking: { type: 'adaptive' },
    tools,
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(out.model, 'claude-opus-4-8')
  assert.equal(out.max_tokens, 96000)
  assert.deepEqual(out.thinking, { type: 'adaptive' })
  assert.equal(out.tools, tools, 'tools reference passed through (not deep-cloned)')
})

test('empty messages array does not throw and adds no message breakpoint', () => {
  const out = withCacheBreakpoints({ system: 'S', messages: [] })
  assert.deepEqual(out.messages, [])
  assert.equal(countBreakpoints(out), 1) // just the system breakpoint
})

// ---- parseCachedTokens: provider dialects -------------------------------------

test('parseCachedTokens: OpenAI shape (prompt_tokens_details.cached_tokens)', () => {
  const usage = {
    prompt_tokens: 1024,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 768 },
  }
  assert.equal(parseCachedTokens(usage), 768)
})

test('parseCachedTokens: DeepSeek shape (prompt_cache_hit_tokens)', () => {
  const usage = {
    prompt_tokens: 1024,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 512,
    prompt_cache_miss_tokens: 512, // just input; must be ignored
  }
  assert.equal(parseCachedTokens(usage), 512)
})

test('parseCachedTokens: absent fields → 0', () => {
  assert.equal(parseCachedTokens({ prompt_tokens: 300, completion_tokens: 50 }), 0)
  assert.equal(parseCachedTokens({ prompt_tokens_details: {} }), 0)
})

test('parseCachedTokens: null/undefined/non-object → 0, never throws', () => {
  assert.equal(parseCachedTokens(undefined), 0)
  assert.equal(parseCachedTokens(null), 0)
  assert.equal(parseCachedTokens(42), 0)
  assert.equal(parseCachedTokens('nope'), 0)
})

test('parseCachedTokens: OpenAI shape wins when both dialects present', () => {
  const usage = {
    prompt_tokens_details: { cached_tokens: 900 },
    prompt_cache_hit_tokens: 100,
  }
  assert.equal(parseCachedTokens(usage), 900)
})

test('parseCachedTokens: zero cached tokens returns 0 (not NaN)', () => {
  assert.equal(parseCachedTokens({ prompt_tokens_details: { cached_tokens: 0 } }), 0)
  assert.equal(parseCachedTokens({ prompt_cache_hit_tokens: 0 }), 0)
})
