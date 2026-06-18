// ===== Provider registry (OpenAI-compatible) =====
// DeepSeek, GLM (Zhipu / z.ai), Kimi (Moonshot), and OpenAI all expose an
// OpenAI-compatible Chat Completions API, so one engine (engines/openai.js) serves all
// four — this table holds the per-provider deltas. Config verified June 2026; model IDs
// churn, so every tier is overridable via the CLI's --models (and --base-url for region).
//
// Fields:
//   baseURL              default OpenAI-compatible endpoint
//   altBaseURL           alternate region/brand endpoint (informational; use --base-url to pick)
//   keyEnv               API key env var names, in priority order
//   maxTokensParam       'max_tokens' | 'max_completion_tokens' (newer OpenAI/Kimi want the latter)
//   forceStructured      can force a specific function via tool_choice? (Kimi cannot)
//   jsonSchemaResponse   supports response_format:{type:'json_schema'} (structured-output fallback)
//   models               haiku/sonnet/opus tier → model id (core passes these tier words)
//   note                 quirks worth surfacing to the user
//
// anthropic is NOT here — it uses engines/api.js (native server-side web search, adaptive
// thinking). This registry is only for the OpenAI-compatible engine.

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    keyEnv: ['DEEPSEEK_API_KEY'],
    maxTokensParam: 'max_tokens',
    forceStructured: true,
    jsonSchemaResponse: false, // only response_format:json_object; forcing covers structured output
    // deepseek-chat = non-thinking, tool-capable (thinking mode disables function calling).
    // NOTE: deepseek-chat is slated for deprecation 2026-07-24 — override with --models if needed.
    models: { haiku: 'deepseek-chat', sonnet: 'deepseek-chat', opus: 'deepseek-chat' },
    note: '推理(thinking)模式不支持工具调用，故全档用非思考的 deepseek-chat（2026-07-24 后将弃用，可用 --models 覆盖为 deepseek-v4-flash/pro 的非思考模式）',
  },
  glm: {
    label: 'GLM (Zhipu / z.ai)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    altBaseURL: 'https://api.z.ai/api/paas/v4', // international (z.ai); pick via --base-url
    keyEnv: ['ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY'],
    maxTokensParam: 'max_tokens',
    forceStructured: true,
    jsonSchemaResponse: false, // json_schema honoured inconsistently; forcing the tool is reliable
    // GLM/Zhipu native web search: a server-side tool entry (Zhipu shape, not OpenAI's). The
    // model searches autonomously; no client execution. Shape may need tuning per Zhipu version.
    nativeSearch: { tool: { type: 'web_search', web_search: { enable: true, search_result: true } } },
    models: { haiku: 'glm-4.7-flash', sonnet: 'glm-4.7-flashx', opus: 'glm-5.2' },
    note: 'temperature 区间为开区间 (0,1)，temperature:0 会被拒——本引擎一律不发 temperature；国际站用 --base-url https://api.z.ai/api/paas/v4',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    baseURL: 'https://api.moonshot.ai/v1',
    altBaseURL: 'https://api.moonshot.cn/v1', // China platform; keys are region-bound
    keyEnv: ['MOONSHOT_API_KEY'],
    maxTokensParam: 'max_completion_tokens',
    forceStructured: false, // tool_choice:'required'/specific-function NOT supported
    jsonSchemaResponse: true, // structured-output fallback path for the schema agents
    // Kimi native web search: a server-side builtin tool. The model emits a $web_search
    // tool_call; the client must ECHO the arguments back as the tool result to trigger
    // Moonshot's server-side execution (then the model continues with results).
    nativeSearch: { tool: { type: 'builtin_function', function: { name: '$web_search' } }, echo: '$web_search' },
    models: { haiku: 'kimi-k2.5', sonnet: 'kimi-k2.5', opus: 'kimi-k2.6' },
    note: '不支持强制指定函数调用——结构化输出靠提示 + response_format:json_schema 兜底；密钥分区域（.ai 与 .cn 不互通），国内用 --base-url https://api.moonshot.cn/v1',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    maxTokensParam: 'max_completion_tokens',
    forceStructured: true,
    jsonSchemaResponse: true,
    models: { haiku: 'gpt-5.4-mini', sonnet: 'gpt-5.4-mini', opus: 'gpt-5.5' },
    note: 'max_tokens 已弃用→max_completion_tokens；推理模型拒收 temperature（本引擎不发）',
  },
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS)

// First env var in keyEnv[] that is set (used by the CLI to find the key).
export function resolveKey(provider, env = process.env) {
  const cfg = PROVIDERS[provider]
  if (!cfg) return { key: undefined, varName: undefined }
  for (const name of cfg.keyEnv) if (env[name]) return { key: env[name], varName: name }
  return { key: undefined, varName: cfg.keyEnv[0] }
}
