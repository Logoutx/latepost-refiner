# Universal Runtime

Use the repo runtime when available. It is the Codex-friendly equivalent of the Claude Workflow edition and shares the same `core/` pipeline.

## Locate And Verify

From the repository root:

```bash
npm install
npm test
```

The repo may still live in a local folder named `interview-transcriber` even after the GitHub rename to `latepost-refiner`.

## Web UI

```bash
npm run web
```

Open the printed `http://127.0.0.1:<port>` URL. The UI supports:
- Provider selection: Anthropic, DeepSeek, GLM, Kimi, OpenAI.
- Model list fetch and cost-aware defaults.
- Single-provider mode or per-category routing.
- File upload for `.txt`, `.md`, `.docx`, `.pptx`, `.xlsx`, `.pdf`.
- Scope selection: refined transcript, logical-order rewrite, summary, timeline.

API keys are used in memory for the local run; do not write them to output files, logs, manifests, or review notes.

## CLI

For Codex use, default to OpenAI:

```bash
node universal/cli.js \
  --provider openai \
  --files "a.txt" "b.docx" \
  --topic "<主题>" \
  --date "2026-06" \
  --background "<访谈背景、人物、公司、领域>" \
  --scope refine,logic,summary,timeline \
  --verify key \
  --models scout=gpt-5.4-mini,verify=gpt-5.4,dedup=gpt-5.4,refine=gpt-5.5,logic=gpt-5.5,summary=gpt-5.4,timeline=gpt-5.4 \
  --out "<输出目录>"
```

Default OpenAI profile:

| Stage | Model | Why |
|---|---|---|
| `scout` | `gpt-5.4-mini` | Cheap extraction of speakers/entities/errors. |
| local audit | no model | Deterministic completeness/content-gap/compression checks after refine. |
| `verify` | `gpt-5.4` | Better judgment for public-source entity verification. |
| `dedup` | `gpt-5.4` | Better semantic same-referent decisions. |
| `refine` | `gpt-5.5` | Quality-critical transcript cleanup. Cheap refine is where over-compression usually starts. |
| `logic` | `gpt-5.5` | Quality-critical reorder-without-rewrite discipline. |
| `summary` | `gpt-5.4` | Strong synthesis without premium default cost. |
| `timeline` | `gpt-5.4` | Needs source-aware judgment and chronology. |

Cost-saving profile for low-stakes archive batches, only after audit/evals prove it is safe for that corpus:

```bash
--models scout=gpt-5.4-mini,verify=gpt-5.4,dedup=gpt-5.4,refine=gpt-5.4,logic=gpt-5.5,summary=gpt-5.4,timeline=gpt-5.4
```

Useful flags:
- `--provider anthropic|deepseek|glm|kimi|openai`
- `--base-url <URL>`
- `--models scout=<id>,verify=<id>,dedup=<id>,refine=<id>,logic=<id>,summary=<id>,timeline=<id>`
- `--fresh` to ignore existing `校对表.md`
- `--prior-glossary <path>` to seed from an external `校对表.md` (accumulation still writes back to `<out>/校对表.md`)
- `--heading-policy none|keep|regenerate`
- `--verify key|deep|none`
- `--chunk speed|cost` (default `cost`; `speed` splits big files into parallel refine chunks)
- `--allow-audit-fail` to exit 0 when the only failure is `auditFailed` and products were written (see below)
- `--no-annotate` / `--no-anchors` to skip inserting 内容缺口 markers / source anchors into the 成稿
- `--concurrency <N>` to cap parallel model calls

> **Resume is not implemented yet.** There is currently no `--resume` / `--resume-from` flag and no "skip completed files" control — a re-run reprocesses every file. `run.json` records enough (input hashes, artifacts, config) to build resume later, but nothing reads it back to skip work today. Planned, not shipped.

## Environment

Provider keys:
- Anthropic: `ANTHROPIC_API_KEY`
- DeepSeek: `DEEPSEEK_API_KEY`
- GLM/Z.ai: `ZHIPUAI_API_KEY`, `ZAI_API_KEY`, or `GLM_API_KEY`
- Kimi: `MOONSHOT_API_KEY`
- OpenAI: `OPENAI_API_KEY`

DeepSeek and OpenAI need `TAVILY_API_KEY` for client-side web verification. Anthropic, GLM, and Kimi use provider-native search where supported.

## Output Contract

The runtime writes:
- `<out>/Transcripts/<title>.md`
- `<out>/校对表.md`
- `<out>/review.md`
- `<out>/run.json`
- `<out>/逻辑顺序/<title>.md` when `logic` is in scope
- `<out>/<topic>访谈总结.md` when `summary` is in scope
- `<out>/<topic>时间线.md` when `timeline` is in scope

Read `review.md` before reporting completion. It consolidates failed files, incomplete endings, audit-gate failures, a thin-校对表 warning, unverified network items, suspected duplicate names, source-heading conflicts, and open questions.

Read `run.json` when auditing a run or explaining exactly what files, models, provider, scope, hashes, artifacts, and usage were recorded.

## Exit Code And `auditFailed`

The in-pipeline audit gate runs per file after refine. When a file is still **hard** (`content_gap` / `quote_style`) after one auto-repair, it is recorded in the run's top-level **`auditFailed`** (`[{ path, findings }]`, mirrored in `review.md` and `run.json`). By default the CLI then **exits 1** — but the 成稿 and every other product are **already written to disk**; the non-zero code flags "one or more files need a manual look", not "the run failed". A calling script must therefore check the **`auditFailed` field in `run.json` / `review.md`** to decide per-file follow-up, rather than treating a non-zero exit as a whole-run failure and discarding the output.

Pass **`--allow-audit-fail`** to make the CLI exit **0** when products were generated and the only problem is `auditFailed` (a pipeline error still exits 1). Use it in CI/batch drivers that want to consume the produced transcripts and act on `auditFailed` out-of-band instead of gating on the exit code.

## Return And Handoff

In the final response to the user:
- State what was generated and where.
- Mention unresolved items from `review.md`.
- Mention whether any `networkUnverified` items should be re-checked.
- Avoid pasting long transcript content into chat.
