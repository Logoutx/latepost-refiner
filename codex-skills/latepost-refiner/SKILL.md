---
name: latepost-refiner
description: Refine rough LatePost-style interview transcripts into research-grade Chinese deliverables while preserving every factual detail. Use when the user asks to clean, polish, proofread, structure, or "精校/整理/校对" interview/Q&A/oral-history transcripts; unify names, brands, products, and speaker labels; remove verbal tics and ASR noise; add topic headings; cross-check entities with public sources; produce optional logical-order rewrites, timelines, summaries, review queues, and run manifests. Not for audio transcription from media, full-document translation, or short summaries that do not preserve the complete transcript.
---

# LatePost Refiner

Use this skill to turn rough dialogue transcripts into faithful, citable research documents. The job is refinement, not summarization: keep dialogue form, preserve facts and tone, remove noise, correct transcription errors, and add structure.

## First Choice In Codex: Native Subscription Runtime

When running inside Codex, prefer the Codex native runtime in [references/native-runtime.md](references/native-runtime.md). It runs on the signed-in ChatGPT/Codex subscription through native subagents and deterministic local Node helpers. It does **not** require `OPENAI_API_KEY` or `TAVILY_API_KEY` on the primary path.

Read [references/native-runtime.md](references/native-runtime.md) when:
- Running from Codex or installing this skill for Codex.
- Using no-key scout, verify, refine, logic, summary, or timeline stages.
- Explaining the generated prompt manifests, local audit, quality scorecard, `review.md`, or `run.json`.

Codex-native model policy: use `gpt-5.4-mini` for mechanical scout/check/stitch work, `gpt-5.4` for verify/dedup/summary, and `gpt-5.5` for quality-critical refine, logic planning, and logic writing. `verifyDepth: deep` should keep web verification on the native browsing path and surface unresolved items rather than asking for a Tavily key.

## Universal Runtime Fallback

Use [references/universal-runtime.md](references/universal-runtime.md) for the local web app or CLI, non-Codex users, provider/API-key routing, or when the user explicitly wants Anthropic/DeepSeek/GLM/Kimi/OpenAI API execution. This fallback is useful, but it is not the primary Codex path.

## Opening Questions

Ask everything answerable up front, then run autonomously. If filenames already imply the answers, propose your inferred values and ask the user to correct them.

Collect:
- Output folder. Default to a project folder under the user's research notes when no path is provided.
- Topic/company/person and interview date.
- Speaker list, reporter/host names, interviewee roles, and any known aliases.
- Background: industry, companies, people, products, and events discussed.
- Scope: `refine`, optionally `logic`, `summary`, `timeline`.
- Web verification depth: `key`, `deep`, or `none`.
- Whether to keep or regenerate existing source headings if preflight detects them.

After that, do not interrupt with piecemeal questions. Save post-reading doubts for the final handoff.

## Runtime Workflow

1. Prepare files: convert supported office/PDF inputs to Markdown, count size, detect existing headings, and choose titles/output paths.
2. Seed from an existing `<out>/校对表.md` unless the user asks for a fresh glossary.
3. Run the Universal runtime through the web UI or CLI.
4. Inspect generated artifacts:
   - `<out>/Transcripts/*.md`
   - `<out>/校对表.md`
   - `<out>/review.md`
   - `<out>/run.json`
   - optional `<out>/逻辑顺序/*.md`, `<out>/<topic>访谈总结.md`, `<out>/<topic>时间线.md`
5. Read `review.md` first for unresolved issues; do not dump full transcripts into the main context.
6. Ask any remaining open questions in one final batch, with exact output paths and next actions.

## Manual Fallback

Use manual mode only when the runtime is unavailable, the user asks for a one-off hand edit, or the task is too small to justify a full run.

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
