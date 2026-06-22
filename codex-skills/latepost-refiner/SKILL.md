---
name: latepost-refiner
description: Refine rough LatePost-style interview transcripts into research-grade Chinese deliverables while preserving every factual detail. Use when the user asks to clean, polish, proofread, structure, or "精校/整理/校对" interview/Q&A/oral-history transcripts; unify names, brands, products, and speaker labels; remove verbal tics and ASR noise; add topic headings; cross-check entities with public sources; produce optional logical-order rewrites, timelines, summaries, review queues, and run manifests. Not for audio transcription from media, full-document translation, or short summaries that do not preserve the complete transcript.
---

# LatePost Refiner

Use this skill to turn rough dialogue transcripts into faithful, citable research documents. The job is refinement, not summarization: keep dialogue form, preserve facts and tone, remove noise, correct transcription errors, and add structure.

**Talk to the user in Chinese.** The transcripts and every deliverable are Chinese, so write all user-facing messages — the opening questions, progress notes, and the final handoff — in Chinese too. Follow the user's typesetting: full-width curly quotes “”, Arabic numerals, and a half-width space between Chinese and Latin/numbers.

## First Choice: Use The Codex Native Runtime

When this skill is running inside Codex, use the subscription-native workflow first. It runs model stages through Codex's own subagents on the signed-in ChatGPT/Codex plan and runs deterministic stages locally through Node. It does not require `OPENAI_API_KEY` or `TAVILY_API_KEY`.

Read [references/native-runtime.md](references/native-runtime.md) before a full run. It covers:
- No-key preflight and the completed capability spike.
- How to use native subagents for scout, verify, dedup, refine, logic, summary, and timeline.
- How to use `scripts/codex-native.mjs` for deterministic prep, prompt generation, glossary rendering, and `review.md` / `run.json`.
- How to keep raw transcripts and web pages out of the main context.

Do not ask for API keys on the primary path. If native subagents or native browsing are unavailable, degrade that stage and record it in `review.md`; use the Universal runtime only after telling the user it is a metered provider/API-key fallback.

Read [references/universal-runtime.md](references/universal-runtime.md) only when:
- The user explicitly asks for the local web app or CLI.
- The native Codex path is unavailable and the user accepts an API-key fallback.
- You need to explain Universal output artifacts or resume behavior.

## Opening Questions

Ask everything answerable up front, then run autonomously. If filenames already imply the answers, propose your inferred values and ask the user to correct them.

Collect:
- Output folder — ask the user to choose it on every run and wait for the answer; never assume, reuse, or silently default to a folder.
- Topic/company/person and interview date.
- Speaker list, reporter/host names, interviewee roles, and any known aliases.
- Background: industry, companies, people, products, and events discussed.
- Scope: `refine`, optionally `logic`, `summary`, `timeline`.
- Web verification depth: `key`, `deep`, or `none`.
- Whether to keep or regenerate existing source headings if preflight detects them.

After that, do not interrupt with piecemeal questions. Save post-reading doubts for the final handoff.

## Native Runtime Workflow

1. Prepare files: convert supported office/PDF inputs to Markdown (needs `markitdown`/`docling` on PATH — if missing, run `bash scripts/setup-converters.sh` once, per [references/native-runtime.md](references/native-runtime.md)), count size, detect existing headings, and choose titles/output paths.
2. Seed from an existing `<out>/校对表.md` unless the user asks for a fresh glossary.
3. Run `scripts/codex-native.mjs prepare --args run-args.json` to normalize args and generate first-stage prompts.
4. Spawn native Codex subagents from the generated prompt files:
   - scout/refine/check: one subagent per source file.
   - verify/timeline: use built-in Codex browsing; never require Tavily on the primary path.
   - dedup/logic/summary: native model subagents.
5. Use the helper after each model-heavy stage to merge compact JSON reports, render `校对表.md`, and write artifacts.
6. Inspect generated artifacts:
   - `<out>/Transcripts/*.md`
   - `<out>/校对表.md`
   - `<out>/review.md`
   - `<out>/run.json`
   - optional `<out>/逻辑顺序/*.md`, `<out>/<topic>访谈总结.md`, `<out>/<topic>时间线.md`
7. Read `review.md` first for unresolved issues; do not dump full transcripts into the main context.
8. Ask any remaining open questions in one final batch, with exact output paths and next actions.

## Manual Fallback

Use manual mode only when the native runtime is unavailable, the user asks for a one-off hand edit, or the task is too small to justify a full run.

Before manual work, read the references relevant to the requested scope:
- [references/editorial-spec.md](references/editorial-spec.md) for transcript cleanup rules.
- [references/glossary-template.md](references/glossary-template.md) when building or updating `校对表.md`.
- [references/deliverables.md](references/deliverables.md) for logical-order rewrite, timeline, and summary structures.

Manual flow:
1. Keep heavy source text out of the main context where possible. Use file-level workers/subagents if available; otherwise read only the portions needed for the current operation.
2. Scout all files for speakers, names, brands, products, terms, and likely ASR errors.
3. Cross-validate entities internally, then verify only unresolved key entities with public sources unless the user requested `deep`.
4. Write a unified glossary before refining.
5. Refine each transcript independently against the glossary.
6. Check ending completeness and suspicious names/terms.
7. Produce optional logical-order rewrite, timeline, and summary from the refined outputs.
8. Write a concise handoff listing paths, warnings, unresolved questions, and any re-verification recommendations.

## Quality Bar

- Preserve all substantive facts, figures, dates, products, processes, channels, opinions, and quotes.
- Keep dialogue form and speaker labels as plain text.
- Remove口癖, filler, timestamps, repeated confirmation noises, and unrecoverable ASR garbage.
- Do not fabricate names. Keep `（音）` or `（音，存疑）` when evidence is insufficient.
- Add unnumbered `##` headings by topic; never invent conclusions in headings.
- Use full-width Chinese punctuation, Arabic numerals for exact counts, and Pangu spacing between Chinese and Latin/numbers.
- For long files, write in large coherent topic blocks and verify the ending was covered.
- Treat the final output as a research archive: trustworthy beats pretty.
