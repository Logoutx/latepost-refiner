# Adversarial review — API-edition collapse to DeepSeek-only + Tavily

Worktree: `/Users/logoutx/Downloads/latepost-refiner-test/phase0` · branch `phase0-merge-sync` · HEAD `4714880`
Commits under review: `d145257`, `b256105`, `847fa69`, `4714880`.
Method: greps + `node --check` on every live file + full `node --test` run + read of the wiring paths. Evidence quoted inline.

Bottom line up front: the **code** is a clean prune — no dangling runtime references, correct engine wiring, 413/413 tests green, deps exactly cover live imports, build/binary/web entries coherent. The defects are all **documentation-truth drift**, one of which affects a shipping edition (Codex) and will actively misdirect a user. Verdict at the end.

---

## Findings (numbered)

### 1. HIGH-for-docs / MEDIUM — Codex edition's fallback runtime doc still sells 5 providers and removed flags
`codex-skill/latepost-refiner/references/universal-runtime.md` (whole file) + `codex-skill/latepost-refiner/SKILL.md:23`

The Codex-native edition is one of the three shipping editions. Its `SKILL.md:23` routes users to this doc for the CLI/web fallback:
> "Use references/universal-runtime.md … or when the user explicitly wants **Anthropic/DeepSeek/GLM/Kimi/OpenAI API execution**."

The doc then instructs, as current usage:
- `universal-runtime.md:23` — "Provider selection: Anthropic, DeepSeek, GLM, Kimi, OpenAI." (web UI now has only a DeepSeek key + Tavily key field.)
- `universal-runtime.md:36-46` — a CLI example built on `--provider openai … --models scout=gpt-5.4-mini,verify=gpt-5.4,…`
- `universal-runtime.md:68-70` — "`--provider anthropic|deepseek|glm|kimi|openai`", "`--base-url <URL>`", "`--models scout=<id>,…`"
- `universal-runtime.md:85-89` — env keys `ANTHROPIC_API_KEY`, `ZHIPUAI/ZAI/GLM_API_KEY`, `MOONSHOT_API_KEY`, `OPENAI_API_KEY`

Concrete failure scenario: a Codex user follows the fallback doc and runs `node universal/cli.js --provider openai --models scout=gpt-5.4-mini,… --files … --topic …` with `OPENAI_API_KEY` set. `parseArgs` has no aliases for those flags, so `--provider`/`--models`/`--base-url` are silently swallowed (catch-all at `cli.js:80-82` writes dead keys `out.provider`/`out.models` that `buildRunParams` never reads). `selectEngine` then requires `DEEPSEEK_API_KEY` (`jobs.js:124-125`) → the run dies with `未设 DEEPSEEK_API_KEY（DeepSeek 的 API key）` despite the user having done exactly what the doc said. This doc was NOT rewritten with the collapse (only the top-level `README.md` was, in `4714880`), and `build/sync-skills.mjs` cannot catch it — the MANIFEST vendors `core/`, `scripts/audit`, `artifacts.js`, `editorial-spec.md` but NOT `universal-runtime.md` (it's hand-authored per edition), so `sync:skills --check` passes while the doc rots.

This is the single worst finding: a shipping edition's primary fallback documentation contradicts the entire post-collapse interface.

### 2. MEDIUM — `eval/produce.mjs` advertises `--provider anthropic` (and defaults to it) but silently runs DeepSeek
`eval/produce.mjs:15` (`provider: 'anthropic'` default), `:19` (`--provider` parse), `:50` (usage `[--provider anthropic] [--model opus]`), `:68` (call site), `:6` (header `ANTHROPIC_API_KEY=… --provider anthropic`)

`eval/` is shipped (listed in `package.json` `files` + `scripts.eval*`). The call site is:
> `const sel = selectEngine({ provider: args.provider, modelOverride: args.model, concurrency: 1 })`

Post-collapse `selectEngine({ concurrency, apiKey, filePolicy, env, onPhase, onLog })` (`jobs.js:123`) does not destructure `provider` or `modelOverride` — both are silently dropped. So `node eval/produce.mjs --suite golden --out x.json` (defaults provider=anthropic, model=opus): needs `DEEPSEEK_API_KEY` (not `ANTHROPIC_API_KEY`), and if set, runs `deepseek-v4-pro` while labeling itself an anthropic/opus baseline. Not a crash and not a dangling import (`selectEngine` exists), but a shipped script whose interface lies. A dev running the golden eval to compare against an Anthropic reference gets DeepSeek output, or a confusing `未设 DEEPSEEK_API_KEY` while `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set. (Note: bare `npm run eval:produce` with no `--out` just prints usage and `exit(2)`, so it never reaches `selectEngine` — the trap only springs when a dev supplies `--out`.)

### 3. LOW — `claude-code-skill/SKILL.md:77` cites deleted `engines/api.js`
> "the API-key path is the separate Universal edition (`engines/api.js`)."

`engines/api.js` was deleted; the module is now `engines/deepseek.js`. The surrounding claim ("API-key path is a separate edition, keep the CC path native") is still true — only the filename is stale. Cosmetic, but it is a factual error in a shipping SKILL.md.

### 4. LOW — user-facing messages reference the removed `--refine-mode` flag (dead-path)
`core/pipeline.js:32` and `:35` (mirrored verbatim in the generated `claude-code-skill/workflow.js:1969-1972`):
> "…请对该份改用 agentic 模式（**--refine-mode agentic**）"
> "…请改用 agentic 模式（**--refine-mode agentic**）重跑"

`--refine-mode` was removed from the CLI. These messages fire only on the single-shot over-length rejection, which requires `refineMode==='single-shot'` (`jobs.js:477`). No shipping edition sets that: the CLI has no flag, the web GUI never posts it, and `claude-code-skill/SKILL.md`/`references/` never mention `refineMode`/`single-shot` (grep: no hits). So the path is unreachable and the stale hint can never actually be shown to a user — hence LOW, not MEDIUM. Still worth deleting the dead branch or fixing the copy.

### 5. LOW — stale `--effort` references in a dev doc + internal comments
`eval/effort-experiment.md:57,74,76` and `core/spec.js:148,161,164` reference the removed `--effort` flag. These are a dev experiment note and internal comments (not user-facing help). The effort mechanism itself still lives (`effortFor` in core; forwarded by `build/bootstrap-cc.js` for the CC edition), so the comments aren't wrong about the *mechanism* — only about the CLI surface. `engines/deepseek.js` ignores `effort` entirely, so it is dead for the Universal edition.

### 6. LOW — harmless dead plumbing of `refineMode`/`effort` through `jobs.js`
`jobs.js:355` destructures `refineMode, effort` from params and `:477-478` forwards them into `A`. No shipping edition sets either for the DeepSeek path, and the DeepSeek engine reads neither. Inert, but it's leftover surface from the multi-provider era that a future reader will mistake for a live knob.

### Noted, but honoring the exclusion list (not re-reported as new)
`claude-code-skill/workflow.js:532,2014` and `codex-skill/latepost-refiner/core/spec.js:505` contain the same `engines/providers.js` comment leftovers the task pre-flagged in `core/spec.js`/`core/pipeline.js`. They are the **generated/vendored mirrors** of those exact comments (`build-cc.mjs` bundles `core/*`; `sync-skills` vendors `core/spec.js` into codex-skill), kept byte-identical by the sync gate. Same root cause; fixing the three source comments clears all mirrors.

---

## Per-category verdicts (hunt list)

**1. Runtime dangling references — CLEAN.**
No live `import`/`require` of any deleted module (`engines/api|openai|providers|router|batch`, `universal/escalate`, `scripts/batch_refine`) — the only textual hits are the pre-flagged comments (#exclusion) plus docs (#1). `package.json` bin (`universal/cli.js`, `universal/server.js`), exports (`./core/pipeline.js`, `./engines/deepseek.js`), and every script target exist. Web GUI posts only `{apiKey, tavilyKey, files, topic, date, background, scope, verifyDepth, headingPolicy, outputDir, fresh, chunkMode, concurrency}` to `/api/run` + `/api/open`; no `/api/providers` or `/api/models` (removed). `server.js` is a pure passthrough (`sanitizeRunParams` only strips `__engine`/`skillDir`); it reads no removed field. Only dynamic import is `universal/assets.js:20 await import('./embedded-assets.js')` — a build-time artifact, wrapped in try/catch, by-design.

**2. `engines/deepseek.js` wiring — CLEAN.**
Tier map `{ haiku:'deepseek-v4-flash', sonnet:'deepseek-v4-flash', opus:'deepseek-v4-pro' }` (`:29`). Web tools gated to `ONLINE_LABEL=/^(verify|timeline)/` (`:59,:184`); `webSearch` degrades to a message string when `TAVILY_API_KEY` absent (`:95-96`) — never throws. The web-typed Tavily key reaches the module-scope reader: `jobs.js:396 process.env.TAVILY_API_KEY = webTavily`, restored in `finally` (`:554`); user is warned at `jobs.js:409-411`. Forced structured output via `tool_choice` after 2 nudges (`:221-226,:163-179`). `refineBudget` resolves `M.refine='opus'` → `{model:'deepseek-v4-pro', budget:10000}` and is consumed at `core/pipeline.js:78`; flash=18000 (`:43`). `pLimit(concurrency)` wraps every agent (`:134,:234`). Errors swallowed to `null` at agent/parallel/pipeline layers (existing fault-tolerant design). Caveat (LOW/SPECULATIVE): "mark unverified" on absent Tavily is best-effort — the model simply sees a "not available" string; per-entity `networkUnverified` tagging relies on unchanged core logic, not a hard signal. This is inherited behavior, not a collapse regression; the hard requirements (no crash, user warned) hold.

**3. Binary/web entries — CLEAN.**
`universal/bin-web.js` → `import { listen } from './server.js'` (exists). `launch.command` → `node universal/server.js`. `build/embed-assets.mjs` reads `universal/web/index.html` + `claude-code-skill/references/*.md` (all present). `build/build-cc.mjs` bundles `core/meta|spec|prompts|pipeline.js` + `build/bootstrap-cc.js` with imports stripped — no engine pull-in, and its sandbox guard (`/\bprocess\.env\b/`, `/\bBuffer\./`, `/\brequire\(/`) still holds. `build-binary.sh` compiles `bin-web.js`. All `node --check` pass except `build/bootstrap-cc.js` — expected: it's an embedded snippet with a top-level `return await runPipeline(...)`, appended into the Workflow async scope, untouched by the collapse (last commit `54af7a2`). Not a regression.

**4. Test-suite honesty — CLEAN (no weakened kept-feature coverage found).**
Ran `node --test`: **tests 413, pass 413, fail 0** (matches the claimed 463→413). Deletions were correctly scoped: `escalation.test.js` (feature gone), `singleshot-batch.test.js` (batch client + `batch_refine.mjs` gone), and the provider/model-endpoint half of `server.test.js`/`provider-contract.test.js`. Named kept-features remain covered:
- `parseCachedTokens` — 6 assertions retained (`caching.test.js:13-54`; both DeepSeek + OpenAI dialects, null/precedence/zero).
- budget auto-chunk + `>`-not-`≥` boundary + `--chunk-size` override + question-boundary — `refine-split.test.js:79-163`.
- Tavily online-only gating + forced structured output + tier resolution + cache accounting — rewritten `provider-contract.test.js:54-188` (stronger, not weaker).
- audit gates — `audit.test.js` present and green; anthropic-pricing removal explicitly pinned (`runlog.test.js` "unknown provider → null").
- server security contract (token/origin/content-type, `sanitizeRunParams`) — retained and green.
Pretest gate `node build/sync-skills.mjs --check` → "all 8 vendored copies in sync" (exit 0), so `npm test` runs end-to-end.

**5. Fresh-install failure — CLEAN.**
Every third-party import in live code is exactly one of `mammoth`, `openai`, `p-limit` (enumerated: `grep from '[^.]'` yields only those three plus node builtins). `package.json` dependencies = `{mammoth, openai, p-limit}` — exact match, no gaps, no extras. `@anthropic-ai/sdk` appears in **zero** live imports (only in the stale `node_modules` superset, which nothing references). `openai` is retained solely as the DeepSeek OpenAI-compatible transport (`deepseek.js:19,:133`). All 17 files in `engines/`+`universal/` (plus `core/`, `build/`, `scripts/`, vendored codex copies) pass `node --check`.

**6. Docs/help truth — FINDINGS #1-#5.**
`README.md` (rewritten) and `cli.js` `HELP_TEXT` are accurate: three editions, fixed flash/pro models, `DEEPSEEK_API_KEY`+`TAVILY_API_KEY` only, no removed flags. `.env.example` correct (DeepSeek required, Tavily optional-with-degrade). The failures are the Codex fallback doc (#1), the eval harness (#2), and the SKILL.md filename/flag stragglers (#3-#5).

---

## Verdict

**FIX-FIRST** — blocking: **#1** (Codex `universal-runtime.md` + `SKILL.md:23` will make a user of a shipping edition run removed flags and hit a wrong-key error). Strong should-fix before ship: **#2** (shipped eval harness with a lying `--provider` interface). #3-#6 are non-blocking cleanup.

Scope note for the caller: the **code/runtime is SHIP-clean** — I tried to break it (dangling refs, wiring, deps, tests, build entries) and could not. The block is purely documentation truth for the three-edition story, which hunt-item 6 makes a correctness criterion for this specific change. If your bar allows code-now / docs-fast-follow, #1 is a ~15-line doc rewrite, not a code change.
