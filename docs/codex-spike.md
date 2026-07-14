# Codex subscription capability spike

> **已收敛**（2026-07-14 起收敛为三 edition：Claude Code / Codex / DeepSeek API——本文其余内容为历史记录）

**Goal:** decide whether the **Codex interface** can run the refinement pipeline on your **ChatGPT subscription with no OpenAI API key** — the prerequisite for the no-key Codex edition (Phase 3 of [dual-interface-plan.md](dual-interface-plan.md)).

**How to run:** open Codex inside this repo, **signed in with your ChatGPT plan** and with **`OPENAI_API_KEY` unset** (we're testing the subscription path, not a metered key). Paste this file, or tell Codex: "run `docs/codex-spike.md` and fill in the Results table." Have Codex attempt each test and report.

**Pre-flight** — confirm the key is empty:
```bash
echo "OPENAI_API_KEY=[$OPENAI_API_KEY]"   # expect: OPENAI_API_KEY=[]
```
If it's set, `unset OPENAI_API_KEY` for this spike.

---

## Test A — Parallel subagents on the subscription

The pipeline fans out (one scout/refine per file, concurrently). Can Codex spawn **parallel subagents** billed to the ChatGPT plan?

**Do:** using Codex's native subagent / parallel mechanism (e.g. `spawn_agents_on_csv` or the parallel-agents feature — *not* a programmatic Agents-SDK script that needs a key), spawn **2 subagents concurrently**. Give each a snippet + this rule: *"Remove filler (嗯 / 那个 / 然后 / 就是) and confirmation echoes; keep every fact; return only the cleaned text."*
- Snippet 1: `嗯，那个，我们其实是 2018 年成立的，然后呢，主要做供应链。`
- Snippet 2: `就是说，对对对，他当时投了大概，呃，差不多 500 万吧。`

**Pass if:** both ran (ideally concurrently), returned cleaned text, with **no API key**. Note the mechanism used and whether they were genuinely concurrent or queued.

## Test B — Run the deterministic `core/` JS via `node`

The no-key design runs the deterministic merge / clustering / glossary in Node locally (free, no model calls), and uses subagents only for the LLM stages. Confirm Codex can do that.

**Do:**
1. `npm test` — runs the full suite in Node, no API key.
2. Read `core/spec.js`, then write and run a tiny `node` script that imports it and calls one pure function (e.g. `clusterEntities` or `renderGlossary`) on sample data, printing the result.

**Pass if:** `npm test` passes **and** the `core/spec.js` call prints output, all with **no API key**.

## Test C — Web search on the subscription

The `verify` stage cross-checks names against public sources. Can a Codex subagent (or Codex itself) **web-search on the subscription**, with no Tavily / search-API key?

**Do:** look up a public fact — *the founder / legal name behind a well-known consumer brand of your choosing* — using Codex's own web capability (no `TAVILY_API_KEY`). Return the answer **plus a source URL**.

**Pass if:** it returns a sourced answer with **no search/API key**. Note the mechanism (built-in browsing? a tool?).

---

## Results (fill in)

| Test | Result | Mechanism / notes |
|---|---|---|
| A — parallel subagents, no key | ☐ pass ☐ fail | |
| B — `node` runs `core/` JS, no key | ☐ pass ☐ fail | |
| C — web search, no key | ☐ pass ☐ fail | |

## What each outcome means (for Phase 3b)

- **All pass** → build the full **no-key Codex-native interface**: subagents for scout/refine on the subscription, `node` for the deterministic merge/glossary, subagent web-search for `verify`. Mirrors the Claude Workflow edition.
- **C fails** → `verify` degrades to "unresolved" on the no-key path (the existing circuit-breaker behavior), or *that stage alone* falls back to the CLI + Tavily/key.
- **A fails** (no real subscription parallelism) → either serial refine on the subscription (slower) or fall back to the CLI path (`latepost-refiner --provider openai`, needs a key) for the heavy stages.
- **B fails** (unlikely — Codex runs shell) → can't run `core/` locally; rethink how the deterministic stages run.

Report the table back and I'll design Phase 3b accordingly.
