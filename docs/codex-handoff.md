# Handoff — build the no-key Codex skill (Phase 3b)

> **已收敛**（2026-07-14 起收敛为三 edition：Claude Code / Codex / DeepSeek API——本文其余内容为历史记录）

_For Codex. Self-contained; assumes no prior conversation. Work on a branch and coordinate before pushing `main` (the maintainer's edition shares this repo)._

## Goal

Make the **Codex skill installable in Codex and usable with NO API key** — it runs the LatePost-Refiner interview-transcript refinement pipeline entirely on the user's **ChatGPT / Codex subscription**. This is the Codex counterpart to the Claude Code edition, which already runs no-key on the Claude subscription via the Workflow tool (see `claude-code-skill/SKILL.md`).

**Success criteria:** a user installs this skill into Codex, signs in with their ChatGPT plan (no `OPENAI_API_KEY`, no `TAVILY_API_KEY`), asks to refine transcripts, and the whole flow runs to completion.

## Current state (what to change)

`codex-skills/latepost-refiner/` already exists (SKILL.md + `references/` + `agents/openai.yaml`), but its current SKILL.md **delegates to the Node CLI** (`node universal/cli.js --provider openai`), which calls the OpenAI API and **requires `OPENAI_API_KEY` (metered)**. That does not meet the no-key goal. Keep the CLI delegation only as a documented *fallback*; the **primary path must be native to the subscription.**

## Step 1 — run the capability spike first

Before building, run **`docs/codex-spike.md`** (ChatGPT login, `OPENAI_API_KEY` unset). It resolves the three unknowns and decides the design:
- **A** — can Codex spawn **parallel subagents** on the subscription (no key)?
- **B** — can Codex run our deterministic `core/` JS via **`node`** (no key)? (Almost certainly yes.)
- **C** — can a Codex subagent **web-search** on the subscription (no key)?

Design from the results:
- **All pass** → full native build (below).
- **C fails** → `verify` degrades to "unresolved" (existing circuit-breaker behavior), or that *one* stage falls back to CLI + Tavily/key.
- **A fails** → serial refine on the subscription, or CLI fallback for the heavy stages.

## Step 2 — the native design (mirror the Claude Workflow edition)

Split the pipeline by what needs a model vs. what doesn't:

- **LLM stages** (scout per file, refine per file, and verify/summary/timeline as in scope) → **Codex's own model via native parallel subagents** (subscription, no key). One subagent per file for scout and refine; keep heavy transcript text **inside the subagents**, never in the main context (this "cost lever" is core to the design).
- **Deterministic stages** (merge, honorific-aware clustering, glossary render, dedup) → run the pure functions in **`core/spec.js` via `node`** locally (free, no model, no key). This reuses the exact quality logic — weak-key clustering, the person-name guard against 张冠李戴, glossary rendering — instead of re-implementing it in prose.
- **verify** (web cross-check of names/brands against public sources) → a Codex web-search subagent if Step-1 C passed; else degrade/fallback per above.

`core/pipeline.js` (`runPipeline(A, engine)`) is the reference for stage order and the `A` args shape — mirror it. `core/prompts.js` holds the per-stage prompt builders you can reuse to prompt the subagents.

## Reuse, don't reinvent

- **Editorial rules:** `codex-skills/latepost-refiner/references/editorial-spec.md` (identical to the Claude skill's — keep them in sync, don't fork). Refine ≠ summarize; filler tiers; unnumbered `##` headings; unify names/brands/terms strictly per `校对表.md`; never fabricate names (keep `（音）`); Chinese typesetting (full-width punctuation, 弯引号 “”, Arabic numerals, Pangu spacing); large-block writes for long files.
- **Deliverable structures:** `references/deliverables.md` (logical-order rewrite / timeline / summary).
- **Glossary template:** `references/glossary-template.md`.
- **Output layout** (match the Universal runtime): `<out>/Transcripts/*.md`, `<out>/校对表.md`, optional `<out>/逻辑顺序/*.md`, `<out>/<topic>访谈总结.md`, `<out>/<topic>时间线.md`, plus the **review queue** `<out>/review.md` and **run manifest** `<out>/run.json` (see `universal/artifacts.js`).
- **Step-0 interaction** (ask up front, then run autonomously): output folder, topic/date, speakers + roles + aliases, background (domain/companies/people), scope, verify depth, heading policy. Don't interrupt with piecemeal questions; save post-reading doubts for one final handoff.

## Constraints

- **No `OPENAI_API_KEY` / no `TAVILY_API_KEY` on the primary path.** Document any per-stage key fallback explicitly so the user knows when a key would be needed.
- Keep heavy text out of the main Codex context (delegate to subagents).
- Don't drift the editorial rules from `references/editorial-spec.md`.
- Work on a branch; coordinate before pushing `main`.

## References in this repo

- `docs/dual-interface-plan.md` — Phase 3 of the overall plan (and how the two interfaces relate).
- `docs/codex-spike.md` — the capability spike (run first).
- `claude-code-skill/SKILL.md` — the Claude no-key counterpart to mirror.
- `core/` — shared pipeline, prompts, schemas, deterministic logic.
- `codex-skills/latepost-refiner/` — the skill to evolve, and its `references/`.

When the spike results are in, report them and the chosen design; then build the native path, keep CLI delegation as the documented fallback, and verify a full no-key run end-to-end.
