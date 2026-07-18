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

The default profile is fixed: mechanical stages (scout, verify, dedup) run `deepseek-v4-flash`; judgment stages (refine, repair, logic, summary, timeline) run `deepseek-v4-pro`. For controlled tests, `--models stage=model` may override individual stages with either supported DeepSeek v4 model (or the `haiku` / `sonnet` / `opus` aliases). `run.json` records the complete effective stage routing plus the sparse override, so the manifest reflects what actually ran.

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
- `--models refine=deepseek-v4-pro,repair=deepseek-v4-pro` for an explicit per-stage test override; omitted stages keep defaults
- `--allow-audit-fail` to exit 0 when the only failure is a still-hard audit gate and main transcripts were written (derivatives remain withheld)

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

The in-pipeline audit gate runs per file after refine. When a body is still **hard** (`content_gap`, `compression_risk`, `ending_missing`, high-confidence `attribution_mismatch`, or `quote_style`) after one targeted repair, it is recorded in top-level **`auditFailed`**. The main transcript and review artifacts are still written, but requested logic/summary/timeline products are withheld and listed in **`derivativesSkipped`** so no derivative can fossilize a known body defect. By default the CLI exits 1; callers should inspect both fields in `run.json` / `review.md` and retain the main transcript for targeted follow-up.

Pass **`--allow-audit-fail`** to make the CLI exit **0** when main transcripts were generated and the only problem is `auditFailed` (a pipeline error or unavailable audit still exits 1). This changes process control only; it never unblocks derivatives.

The runtime runs a source-aware quality audit for each refined transcript, then gives body-fidelity failures exactly one targeted repair and one re-audit. The repair prompt receives the audit's exact source ranges, speaker mismatch, ending/compression signal, and other named findings; it edits the existing body instead of silently replacing it with a new summary. The `repair` stage defaults to `deepseek-v4-pro` and can be overridden explicitly like other stages.

If failures remain after that pass, treat `review.md` as the handoff source of truth, retain the main body for manual correction, and do not generate or present derivatives as clean.

## Return And Handoff

In the final response to the user:
- State what was generated and where.
- Mention unresolved items from `review.md`.
- Mention whether any `networkUnverified` items should be re-checked.
- Avoid pasting long transcript content into chat.
