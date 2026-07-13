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
//   jurisdiction         operating company's legal jurisdiction ('PRC' | 'US'). Source-protection
//                        surface: a PRC operator processes the FULL transcript under PRC law
//                        (including content-policy screening — observed live: a sensitive segment
//                        was silently dropped by a provider's policy layer, which means it was read
//                        and acted on server-side). Choosing an overseas endpoint (altBaseURL) does
//                        NOT change the operator. Display sites show jurisdictionNote() for PRC.
//
// anthropic is NOT here — it uses engines/api.js (native server-side web search, adaptive
// thinking). This registry is only for the OpenAI-compatible engine.

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    jurisdiction: 'PRC',
    baseURL: 'https://api.deepseek.com',
    keyEnv: ['DEEPSEEK_API_KEY'],
    maxTokensParam: 'max_tokens',
    forceStructured: true,
    jsonSchemaResponse: false, // only response_format:json_object; forcing covers structured output
    // Non-thinking tiers (thinking mode disables function calling): v4-flash for mechanical
    // stages, v4-pro for the writing stages. Validated 2026-07-07 on a real 34K-char interview:
    // the old all-deepseek-chat default failed hard gates (compression + a real dropped section);
    // the flash/pro split passed everything. deepseek-chat is deprecated 2026-07-24 anyway.
    models: { haiku: 'deepseek-v4-flash', sonnet: 'deepseek-v4-flash', opus: 'deepseek-v4-pro' },
    // Per-model faithful-refine budget, in 正文字数 (content chars). A model that silently compresses a long
    // transcript into a summary must be auto-split BELOW the length where it starts folding content — the refine
    // pipeline chunks any file whose 字数 exceeds this, at speaker-turn boundaries (see splitForRefine). Keyed by
    // model id (NOT tier) so a --models override that pins a raw id still resolves the right budget. Evidence from
    // real single-agent refine runs (retention = 成稿字数 ÷ 源正文字数; hard floor 0.55, healthy ≈ 0.79–0.83):
    //   deepseek-v4-pro — 34,769 字 → 0.827 (healthy); 53,576 字 / 4 speakers, single-shot → 0.552 (scraped the
    //     floor, ~2,665 字 folded away). A controlled chunk-size experiment on that same 53.6K file (2026-07-10):
    //     3 chunks ≈ 18K → 0.607; 6 chunks ≈ 8.9K via --chunk-size 10000 → 0.729 with only 661 字 lost and no
    //     sub-heading fragmentation. 10000 (owner-set, 2026-07-10) locks in the winning size; costs ~+31% output
    //     tokens and ~+40% wall-clock vs 3 chunks — retention is the metric this tool exists for.
    //   deepseek-v4-flash — thinner evidence: at 34,769 字 it kept only 0.714 and silently dropped a section, so a
    //     bigger safety margin → 18000. TUNABLE: raise it as clean-run data accumulates.
    // Every OTHER provider/model is intentionally unset → no cap → zero behaviour change (Anthropic Opus proved
    // faithful at 52.5K, so it needs none). Adjust these two numbers as evidence improves.
    refineCharBudget: { 'deepseek-v4-pro': 10000, 'deepseek-v4-flash': 18000 },
    note: '非思考模式分档：机械/核实档用 deepseek-v4-flash，精校/成稿档用 deepseek-v4-pro（thinking 模式不支持工具调用；旧默认 deepseek-chat 已弃用，可用 --models 覆盖）',
  },
  glm: {
    label: 'GLM (Zhipu / z.ai)',
    jurisdiction: 'PRC',
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
    jurisdiction: 'PRC',
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
    jurisdiction: 'US',
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

// Source-protection notice for PRC-jurisdiction providers, shown wherever a provider is chosen
// (CLI start banner, web UI provider note). Deliberately provider-level and always-on — we do NOT
// ship a sensitive-topic keyword list (incompleteable, and itself a liability); the honest statement
// is that the FULL transcript is processed by the operator, whatever it contains.
export function jurisdictionNote(provider) {
  const cfg = PROVIDERS[provider]
  if (!cfg || cfg.jurisdiction !== 'PRC') return ''
  return `信源保护提示：${cfg.label} 由中国境内公司运营，转录全文将传输至其服务器处理并受当地法规约束（含内容审查——审查即意味着内容被服务端读取）。涉敏感话题或需保护信源的访谈请慎用，或改用其他服务商；改用海外 endpoint 不改变运营方。`
}

// Faithful-refine budget (正文字数) for a resolved model id under a provider, or undefined when none is declared
// (every provider/model except the two DeepSeek tiers today). The refine pipeline auto-splits a file whose 字数
// exceeds this — at speaker-turn boundaries — so a weaker-but-cheaper model never silently compresses a long
// transcript. Unset ⇒ no cap ⇒ zero behaviour change. Keyed by model id so a --models override still maps.
export function refineCharBudgetFor(provider, modelId) {
  const cfg = PROVIDERS[provider]
  const b = cfg && cfg.refineCharBudget && cfg.refineCharBudget[modelId]
  return (typeof b === 'number' && b > 0) ? b : undefined
}

// First env var in keyEnv[] that is set (used by the CLI to find the key).
export function resolveKey(provider, env = process.env) {
  const cfg = PROVIDERS[provider]
  if (!cfg) return { key: undefined, varName: undefined }
  for (const name of cfg.keyEnv) if (env[name]) return { key: env[name], varName: name }
  return { key: undefined, varName: cfg.keyEnv[0] }
}
