# LatePost-Refiner — Development Plan: two subscription-native interfaces (Claude + Codex) over one core

> **已收敛**（2026-07-14 起收敛为三 edition：Claude Code / Codex / DeepSeek API——本文其余内容为历史记录）

_Drafted 2026-06-22. Companion to `docs/streamlining-proposal.md` (the collaborator's structure proposal). This is the agreed execution plan._

## Context

LatePost-Refiner (renamed from interview-transcriber; repo `Logoutx/latepost-refiner`, local `~/Projects/latepost-refiner`) is an interview-transcript **refinement** pipeline: one shared `core/` (prompts, schemas, editorial RULES, deterministic JS for clustering/merge/glossary) consumed by several editions.

**Goal:** run the tool as **two agentic interfaces, each on its own subscription with no API key** — Claude Code (Anthropic models) and OpenAI Codex (OpenAI models) — plus the standalone Node runtime (CLI / web / binary) for any-provider, API-key use.

**Research findings:**
- **Claude no-key already works.** The Claude Code skill's `workflow.js` runs inside the Workflow tool; its `agent/parallel/pipeline/phase/log` are the Workflow globals (`build/bootstrap-cc.js`), billed to the Claude Code session — no `ANTHROPIC_API_KEY`. The key-requiring path (`engines/api.js`) is a separate edition.
- **Codex no-key is feasible but unproven.** Codex runs on a ChatGPT plan (OAuth, no key) and has a subscription-billed parallel sub-agent primitive (`spawn_agents_on_csv`, ~6 concurrent). Unconfirmed in OpenAI docs: (1) whether Codex subagents can **web-search on the subscription** (needed by `verify`); (2) whether that batch-oriented primitive (and Agents-SDK fan-out) is flexible/subscription-billable enough for the multi-stage pipeline. Codex *can* run `node` locally (free) to execute the deterministic `core/` JS.
- **The collaborator's current Codex build does NOT meet the no-key goal:** their `codex-skill/latepost-refiner/SKILL.md` has Codex **delegate to the Node CLI** (`node universal/cli.js --provider openai`) → needs `OPENAI_API_KEY` (metered). Their checkout also diverges (keeps `transcriber` bin aliases vs our clean rename; adds `codex-skill/`, `engines/model-profiles.js`, `universal/artifacts.js`, plus resume/cancel/pricing-default features) and they **force-push `main`**.

**Direction (agreed):** one `core/`, one canonical Node runtime, thin interfaces, model defaults in a single source. **Keep both subscription-native paths (Claude Workflow, Codex subagents) first-class** — do NOT collapse them into CLI shell-outs (that reintroduces API keys). Node runtime stays canonical for CLI/web/binary and as the API-key fallback.

## Plan (phased by risk / leverage)

### Phase 0 — Reconcile with the collaborator's branch  *(prerequisite — don't build on a fork)*
- `git fetch` first (collaborator force-pushes), then diff their checkout and `origin/main` against local.
- Both sides currently have **uncommitted** work touching the **same files** (`README`, `package.json`, `universal/{cli,jobs,server}.js`, `universal/web/index.html`, `test/server.test.js`). Resolution path: each side commits to its own branch first, then a real 3-way merge — not a working-tree fix.
- Decide the rename strategy (recommend keeping `transcriber` aliases for a deprecation window), fold in our binary + de-jargon and their `codex-skill/` + `model-profiles.js` + `artifacts.js` + resume/cancel/pricing work.
- Land ONE canonical `main`; coordinate push timing so neither side clobbers.

### Phase 1 — `engines/model-profiles.js` (single source of model defaults, both providers)  *(highest leverage, lowest risk — first)*
- `MODEL_PROFILES` with symmetric `anthropicDefault`/`anthropicPremium` AND `openaiDefault`/`openaiPremium` (optionally `deepseekCheap`), each a tier map `{scout,verify,dedup,refine,logic,summary,timeline}`.
- Make it source-of-truth; refactor `engines/providers.js` (per-provider `models`), `universal/server.js` `providerMeta`, web UI suggestions, `universal/cli.js --models` help, and skill references to read from it. Add a profile-selection test.

### Phase 2 — Protect/clarify the Claude no-key interface  *(tiny)*
- Keep the Workflow fast-path (no CLI shell-out). One line in `claude-code-skill/SKILL.md` + README making the contract explicit: "Claude Code edition = runs on your Claude subscription, no API key (Workflow tool); `engines/api.js` is the separate API-key path."

### Phase 3 — Codex no-key interface  *(new build; de-risked by a spike)*
- **3a — Spike (runs in the user's Codex; the agent cannot drive Codex).** A minimal Codex skill + pass/fail checklist proving, on the ChatGPT plan with no key: (a) Codex spawns parallel subagents to refine one file; (b) Codex runs `node` to call `core/spec.js` (e.g. `clusterEntities`, `renderGlossary`); (c) whether a subagent can web-search (verify).
- **3b — Build (shape depends on 3a).** Codex-native skill mirroring the Claude Workflow edition via Codex's own model access:
  - Codex main agent: Step-0 interaction + pre-flight (docx→md via `node`+mammoth or markitdown; line/byte counts).
  - Per-file **scout** + **refine** → Codex subagents (subscription); deterministic **merge/dedup/glossary** → run via `node` against `core/` (free, keeps honorific-aware clustering + person-guard quality); **verify** → subagent web-search if 3a confirms, else degrade (existing circuit-breaker → "unresolved").
  - Same `<out>/` layout + glossary/review artifacts; same RULES + templates from shared references.
- **Fallback (documented):** if 3a shows the subscription can't carry a stage (esp. web-search), that stage falls back to the CLI path (`--provider openai`, `OPENAI_API_KEY`) for that stage only. Subscription-first, key as backstop.

### Phase 4 — Shared references (de-dupe Claude/Codex instruction text)  *(after both interfaces exist)*
- Lift canonical editorial RULES + deliverable templates into one shared place (`interfaces/shared/` or `docs/reference/`); keep each platform `SKILL.md` thin (invocation differences only); generate/sync packaged references. (RULES already live in `core/spec.js`/`prompts.js`; this is the human-readable skill docs.)

### Phase 5 — Cosmetic folder moves (OPTIONAL, last)
- `universal/`→`runtime/`, group skills under `interfaces/` per the streamlining proposal. One coordinated commit, after Phase 0, only if still wanted. Must update the `~/.claude/skills/latepost-refiner` symlink target, `package.json` `files`/bins, the home + repo `launch.json` absolute paths, and the `build:cc`/CI drift checks.

## Risks
- **Codex subscription unknowns** (web-search, subagent flexibility/billing) — mitigated by the 3a spike before committing to 3b.
- **Collaborator force-pushes `main`** — Phase 0 first; `git fetch` before every commit/push; coordinate via branches, not racing force-pushes.
- **Folder moves** break the skill symlink + `launch.json` absolute paths — deferred to Phase 5, done deliberately.
- **Cannot drive Codex from this agent** — the spike and the Codex-native runs require running inside Codex and reporting back.
- On subscription paths you get the harness's model (Claude Code's / Codex's), not a per-stage tier pick; explicit model selection lives on the API-key paths.

## Verification
- **model-profiles:** `npm test` (profile selection) + CLI/web defaults render the right tier maps + `node --check`.
- **Claude no-key:** skill path still dispatches `Workflow({scriptPath})` and imports no `engines/api.js`; a Claude Code run with `ANTHROPIC_API_KEY` unset completes.
- **Codex no-key:** 3a checklist passes; a real Codex run on the subscription (no key) yields a refined transcript + glossary; diff vs a Node-run baseline for parity.
- **No Node-runtime regression:** existing `node --test` security tests, `build:cc` drift check, and the Bun binary boot stay green.

## Suggested order
Phase 0 (reconcile) → 1 (model-profiles) → 2 (protect Claude) → 3a (Codex spike) → 3b (Codex build) → 4 (shared refs) → 5 (moves, optional).
