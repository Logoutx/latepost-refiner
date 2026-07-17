# Universal Runtime

Use the repo runtime when available. It is the Codex-friendly equivalent of the Claude Workflow edition and shares the same `core/` pipeline. This is the DeepSeek API edition — the key-requiring fallback for when Codex's native subscription runtime isn't available, or the user explicitly wants CLI/web execution.

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

Open the printed `http://127.0.0.1:<port>` URL. The UI has:
- Two key fields: `DEEPSEEK_API_KEY` and (optional) `TAVILY_API_KEY`.
- File upload for `.txt`, `.md`, `.docx`, `.pptx`, `.xlsx`, `.pdf`.
- Scope checkboxes: `refine` (always on), plus `logic` / `summary` / `timeline`.
- Verify depth: `key` (default) / `deep` / `none`.
- Heading policy: `none` / `keep` / `regenerate`.

API keys are used in memory for the local run; do not write them to output files, logs, manifests, or review notes.

## CLI

Models are fixed — there is no selection. Mechanical stages (scout, verify, dedup) run `deepseek-v4-flash`; judgment stages (refine, logic, summary, timeline) run `deepseek-v4-pro`.

```bash
node universal/cli.js \
  --files "a.txt" "b.docx" \
  --topic "<主题>" \
  --date "2026-06" \
  --background "<访谈背景、人物、公司、领域>" \
  --scope refine,logic,summary,timeline \
  --verify key \
  --out "<输出目录>"
```

Useful flags:
- `--background-file <路径>` to read a long background from a file instead of inline text
- `--heading-policy none|keep|regenerate` (default `none`)
- `--verify key|deep|none` (default `key`) — use `none` to skip web verification, e.g. when `TAVILY_API_KEY` isn't set
- `--chunk speed|cost|off` (default `cost`) — long files auto-chunk at speaker-turn boundaries regardless, to stop the DeepSeek models from silently compressing them; `speed` additionally parallelizes big files for faster multi-file batches; `off` disables all chunking, including the automatic kind
- `--chunk-size <N>` — explicit chunk target in 正文字数 (≥2000), overrides the automatic budget
- `--fresh` to ignore an existing `校对表.md` and rebuild from zero
- `--prior-glossary <path>` to seed from an external `校对表.md`
- `--concurrency <N>` to cap parallel model calls
- `--allow-audit-fail` to exit 0 when the only failure is a still-hard audit gate and products were already written

Run `node universal/cli.js --help` for the complete, current flag list — treat it as the source of truth over this doc.

> **Resume is not implemented yet.** There is currently no `--resume` / `--resume-from` flag and no "skip completed files" control — a re-run reprocesses every file. `run.json` records enough (input hashes, artifacts, config) to build resume later, but nothing reads it back to skip work today. Planned, not shipped.

## Environment

- `DEEPSEEK_API_KEY` — required. DeepSeek's API key; used for every stage.
- `TAVILY_API_KEY` — advised, not required. Used for standard/deep web verification and the timeline stage. Without it, verify/timeline degrade automatically to no-verify (refine itself never goes online, so it is unaffected); pass `--verify none` to skip web verification explicitly instead of relying on the degrade.

⚠ DeepSeek is operated by a China-based company: full transcript text is transmitted to its servers and subject to local regulation, including content review. Avoid this edition for sensitive-topic interviews or ones needing source protection.

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

The runtime now runs a source-aware quality audit for refined transcripts. It records compression risk, under-refinement, ending coverage, hard residual noise, phrase repeats, ASR glue, broken fragment starts, and long paragraphs. When a refined file fails, the runtime can retry up to 2 repair rounds:
- compression or missing ending -> rerun that file from the source;
- under-refined output -> full cleanup against source plus current output;
- local residual noise -> targeted repair of flagged spans.
Full-file repair uses the same fixed `refine` model as the original refine (`deepseek-v4-pro`) — there is no separate repair model to configure.

If failures remain after the repair loop, treat `review.md` as the handoff source of truth and do not present the run as clean.

## Return And Handoff

In the final response to the user:
- State what was generated and where.
- Mention unresolved items from `review.md`.
- Mention whether any `networkUnverified` items should be re-checked.
- Avoid pasting long transcript content into chat.
