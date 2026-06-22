---
name: latepost-refiner
description: Refine rough LatePost-style interview transcripts into research-grade Chinese deliverables while preserving every factual detail. Use when the user asks to clean, polish, proofread, structure, or "精校/整理/校对" interview/Q&A/oral-history transcripts; unify names, brands, products, and speaker labels; remove verbal tics and ASR noise; add topic headings; cross-check entities with public sources; produce optional logical-order rewrites, timelines, summaries, review queues, and run manifests. Not for audio transcription from media, full-document translation, or short summaries that do not preserve the complete transcript.
---

# LatePost Refiner

Use this skill to turn rough dialogue transcripts into faithful, citable research documents. The job is refinement, not summarization: keep dialogue form, preserve facts and tone, remove noise, correct transcription errors, and add structure.

## First Choice: Use The Universal Runtime

When this repo is available locally, prefer the Node Universal runtime over manual execution. It provides the closest Codex equivalent to the Claude Workflow edition: shared prompts, schemas, provider routing, persistent glossary, review queue, run manifest, resume, and local web UI.

Read [references/universal-runtime.md](references/universal-runtime.md) when:
- Running the local web app or CLI.
- Choosing provider/model settings.
- Resuming a prior run from `run.json`.
- Explaining output artifacts or verification behavior.

For Codex-triggered runs, default to OpenAI unless the user asks for another provider or lacks an OpenAI key. Use the OpenAI model profile in `references/universal-runtime.md`: `gpt-5.4-mini` for mechanical scout/check work and `gpt-5.4` for verification, dedup, refinement, logical rewrite, summary, and timeline. Reserve `gpt-5.5` for an explicit premium/deep run.

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
5. Run `scripts/audit_refined.mjs <out>/Transcripts/*.md` before handoff. Treat leftover pure filler, stutter repeats, and paragraphs over about 900 characters as quality failures to fix or explicitly surface.
6. Read `review.md` first for unresolved issues; do not dump full transcripts into the main context.
7. Ask any remaining open questions in one final batch, with exact output paths and next actions.

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
9. For any manual fallback output, run `scripts/audit_refined.mjs` before handoff. Do not mark the file clean while the audit reports leftover pure口癖 or overlong combined paragraphs.

## Quality Bar

- Preserve all substantive facts, figures, dates, products, processes, channels, opinions, and quotes.
- Keep dialogue form and speaker labels as plain text.
- Remove口癖, filler, timestamps, repeated confirmation noises, and unrecoverable ASR garbage.
- Preserve readable dialogue boundaries. Do not collapse many source turns into one giant paragraph; long monologues should be split into coherent 200-600 字 paragraphs, and any single dialogue paragraph over about 900 字 needs review.
- Do not fabricate names. Keep `（音）` or `（音，存疑）` when evidence is insufficient.
- Add unnumbered `##` headings by topic; never invent conclusions in headings.
- Use full-width Chinese punctuation, Arabic numerals for exact counts, and Pangu spacing between Chinese and Latin/numbers.
- For long files, write in large coherent topic blocks and verify the ending was covered.
- Treat the final output as a research archive: trustworthy beats pretty.
