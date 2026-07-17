// Offline unit tests for the DeepSeek engine's cache-observability helper. NO live API calls, no API keys.
// Fictional names/data only (hard rule: no real interview subjects/companies).
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCachedTokens } from '../engines/deepseek.js'

// ---- parseCachedTokens: cache-hit accounting ---------------------------------
// DeepSeek's usage.prompt_tokens INCLUDES cached tokens as a subset; parseCachedTokens reads how many were
// served from cache so the engine can fold them into cacheRead. It accepts the DeepSeek dialect
// (prompt_cache_hit_tokens) and the OpenAI-compatible dialect (prompt_tokens_details.cached_tokens) so the
// accounting is robust, and degrades to 0 on any missing/garbage input without throwing.

test('parseCachedTokens: DeepSeek shape (prompt_cache_hit_tokens)', () => {
  const usage = {
    prompt_tokens: 1024,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 512,
    prompt_cache_miss_tokens: 512, // just input; must be ignored
  }
  assert.equal(parseCachedTokens(usage), 512)
})

test('parseCachedTokens: OpenAI-compatible shape (prompt_tokens_details.cached_tokens)', () => {
  const usage = {
    prompt_tokens: 1024,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 768 },
  }
  assert.equal(parseCachedTokens(usage), 768)
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

test('parseCachedTokens: OpenAI-compatible shape wins when both dialects present', () => {
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
