# Transcriber-Universal — Build Brief

## One-line goal

Turn this repo's interview-transcript refinement pipeline into a **standalone Node CLI that calls the Anthropic API directly** — anyone with an API key can run it on any machine, with no dependency on Claude Code's Workflow tooling and no need to upload a skill to claude.ai.

## Key premise: the logic is already shared — you only write the "engine + CLI"

The pipeline, prompts, schemas, editorial rules, and all pure business logic live in [`../core/`](../core/) and are **shared by both editions**. The Universal edition **does not rewrite any business logic** — it simply does `import { runPipeline } from '../core/pipeline.js'` and adds a runtime engine layer plus a command-line shell.

`runPipeline(A, engine)` depends only on 5 primitives that the engine must provide. The Claude Code edition satisfies them via the Workflow global; this edition satisfies the same 5 using the Anthropic SDK:

```js
import { runPipeline } from '../core/pipeline.js'
import { makeApiEngine } from '../engines/api.js'
const engine = makeApiEngine({ apiKey: process.env.ANTHROPIC_API_KEY, models, concurrency })
const result = await runPipeline(A, engine)   // A is parsed from argv, same shape as the Claude Code edition
```

## Only three things to build

### 1. `../engines/api.js` — implement the engine interface (core work)

```
agent(prompt, { label, model, schema, phase }) -> Promise<obj | string | null>
parallel(thunks) -> Promise<arr>
pipeline(items, ...stages) -> Promise<arr>
phase(title) -> void
log(msg) -> void
```

- **`agent`**: Run a **tool-use loop** via `anthropic.messages.create`. The key technique — implement `Read / Write / WebSearch` as **client-side tools** (model calls → you execute locally: fs read/write / network fetch → feed results back into the conversation). This way the existing `core/` prompts — "use Read to page through...", "Write to...", "WebSearch to verify..." — **work without any modification**. This is what makes rewriting unnecessary.
  - When `schema` is provided: pass the schema as the `input_schema` of a `StructuredOutput` tool, use `tool_choice` to force the model to call it at the end, and return the parsed object. **Carry over the lesson from core: do not set `required` in schemas** (missing fields are caught by core's JS fallbacks; do not let validation failures trigger infinite retry loops). When no `schema` is provided, return the final text.
  - Model names come from `models` (consistent with core's default tiers: scout=haiku, verify/dedup=sonnet, refine/logic/summary/timeline=opus, final check=haiku).
- **`parallel` / `pipeline`**: Use `Promise` + `p-limit` to cap concurrency (on the order of `min(16, cores-2)`). `pipeline` passes each item independently through all stages with **no barrier**; if any thunk/stage throws, that item becomes `null` (consistent with Workflow semantics — core has `.filter(Boolean)` throughout).
- **`phase` / `log`**: Write to stderr or a progress bar.

> Web verification: prefer Anthropic's server-side web search tool; alternatively, implement a WebSearch client tool backed by a search API. **Check the `claude-api` skill before starting** to confirm the current web search tool name/version and the correct tool-use syntax.

### 2. `universal/cli.js` — command-line shell

- Parse argv → assemble `A` (same shape as the Claude Code edition's args — see the contract at the top of `core/meta.js` and `../claude-code-skill/SKILL.md` Step 0): `{ topic, date, background, outputDir, skillDir, scope, verifyDepth, headingPolicy, models, files:[{path,label,lines,bytes,title,subtitle,outPath,...}] }`.
- **Pre-flight checks**: convert docx/pdf → md (shell out to `markitdown`, or use `mammoth`); fill in `lines`/`bytes` via `wc -l`/`-c`; grep for sub-headings.
- `skillDir` points to a location where `references/` is readable (reuse `../claude-code-skill/references/`, or copy it in during packaging).
- Call `runPipeline(A, engine)` and handle the return value (write glossary to disk; handle `failed/incomplete/unchecked/scoutSuspect/headingConflicts/suspectedDuplicates/networkUnverified/logic/openQuestions` — same as "return handling" in SKILL.md).

### 3. Packaging

`package.json` (`type: module`, `bin: transcriber`) + `@anthropic-ai/sdk` + `p-limit` (+ `mammoth` or system `markitdown` dependency) + `.env.example` (`ANTHROPIC_API_KEY`) + README.

## CLI sketch

```bash
transcriber --files "a.docx" "b.docx" --topic "Mixue" --date 2025-02 \
  --background "Mixue Group cross-team interview series..." --scope refine,logic,summary \
  --verify key --out ./output --models scout=haiku,refine=opus
```

Output is identical to the Claude Code edition: `<out>/校对表.md`, `Transcripts/*.md`, `逻辑顺序/*.md`, `<topic>访谈总结.md`, `<topic>时间线.md`.

## Build order

1. Check the `claude-api` skill to lock down the API syntax (model id / tool-use structured output / web search tool).
2. Write the tool-use loop in `engines/api.js` (four client tools: Read / Write / WebSearch / StructuredOutput) + `parallel`/`pipeline` (p-limit).
3. Write `cli.js` (argv → A, docx → md, call runPipeline, handle return value).
4. End-to-end test: run a single file through using `~/Downloads/2025-02-21_范 大咖事业群，原料研发.txt`, compare against the known-good Claude Code edition output (user's Obsidian `Company Research/Mixue/`).
5. Packaging + README + `.env.example`.

## Pitfalls already fixed in core — do not break their assumptions in the engine

Do not set `required` in schemas; scout is always haiku; clustering deliberately under-merges (weak labels must not be merged); verify splits into chunks of 12; large-block refine writes must not silently apply micro-edits; person-name guard is active; verify circuit-breaker (2 consecutive errors → stop — the engine must surface retrieval errors honestly so the circuit-breaker logic in the prompt can trigger); the three Chinese typesetting rules are already embedded in the prompts.

## References

- `../core/` (source of truth: runPipeline + prompts + schemas + pure logic).
- `../claude-code-skill/SKILL.md` (Step 0 pre-flight + args contract + return handling — copy directly into CLI).
- `../engines/api.js` (interface placeholder + implementation notes).
- `claude-api` skill — API/SDK details; consult before starting.
