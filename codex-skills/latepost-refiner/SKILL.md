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

Use [references/universal-runtime.md](references/universal-runtime.md) for the local web app or CLI, non-Codex users, or when the user explicitly wants CLI/web execution with a `DEEPSEEK_API_KEY`. This fallback is useful, but it is not the primary Codex path.

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

1. Prepare files: convert supported office/PDF inputs and normalize SRT subtitles to Markdown, count size, detect existing headings, and choose titles/output paths.
2. Seed from an existing `<out>/校对表.md` unless the user asks for a fresh glossary.
3. Run the Universal runtime through the web UI or CLI.
4. Inspect generated artifacts:
   - `<out>/Transcripts/*.md`
   - `<out>/校对表.md`
   - `<out>/review.md`
   - `<out>/run.json`
   - optional `<out>/逻辑顺序/*.md`, `<out>/<topic>访谈总结.md`, `<out>/<topic>时间线.md`
5. Verify refined transcripts with the source-aware audit when the runtime did not already record it:

```bash
node "<skill dir>/scripts/audit_refined.mjs" --source "<source.md>" --refined "<out>/Transcripts/<title>.md" --mode refine
```

Fix audit failures before handoff when possible. Compression or missing endings require rerunning from the source rather than trying to recover from a shortened output; local noise failures may be repaired in place. Limit automatic repair attempts to 2 rounds, then surface remaining failures in `review.md`. The audit also emits a soft `entity_merge_review` finding — a wholesale A→B name replacement where B already existed independently in the source (a possible false merge, not proven) — plus an informational 全局统一清单 (a cross-batch roll-up of every renamed entity); both require `--glossary <out>/校对表.md` on the audit call and are review-tier, not blocking.
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
8. Run the source-aware audit if available; if no shell is available, use the weaker no-shell compression checklist from `references/editorial-spec.md`.
9. Write a concise handoff listing paths, warnings, unresolved questions, and any re-verification recommendations.

## Contested Identity — Phonetically-Suspect Entities (〔同指两解〕)

When verification turns up a name that may be an ASR mishearing (spoken form doesn't resolve, or sounds like a real entity), do not accept or silently "correct" it — apply this protocol:
- Generate candidate corrections from the spoken form *before* searching, then search the literal spoken form **and** each candidate.
- Weigh evidence by tier: official domains / major media / encyclopedia entries outrank directories and SEO blogs, which outrank self-promotion.
- Coattail-inversion rule: a site named after the literal spoken string that reads "Powered by X" or resells X is evidence *for* correction X, not for the literal string as an independent entity (e.g. spoken "K Frame" surfacing `kframe.ai` labeled "Powered by Keyframe" supports Keyframe, not a separate company called K Frame).
- Context-fit test: an identity contradicted by what the transcript itself says about the entity cannot be marked verified, regardless of source tier.
- Two-key rule: writing a name different from the spoken form requires **both** a high-tier source **and** a context-fit pass. Missing either key means no silent substitution — the entity is marked `〔同指两解〕` (contested identity: literal spoken form vs. a suspected correction).
- Transcript annotation: keep the spoken written form in the body; on that entity's first occurrence per file, annotate inline: `（音，存疑：或为 <候选名>）`. Never substitute a different referent for what was actually spoken.
- Wrap-up template: each `〔同指两解〕` entity gets one line in the final question batch: `〔同指两解〕<口播形>：A=<字面假设>（证据级别）；B=<改正假设>（证据级别）——正文已保留口播形并标注，请定夺`

## Quality Bar

- Preserve all substantive facts, figures, dates, products, processes, channels, opinions, and quotes.
- Keep dialogue form and speaker labels as plain text.
- Remove口癖, filler, timestamps, repeated confirmation noises, and unrecoverable ASR garbage.
- Do not fabricate names. Keep `（音）` or `（音，存疑）` when evidence is insufficient.
- Add unnumbered `##` headings by topic; never invent conclusions in headings.
- Use full-width Chinese punctuation, Arabic numerals for exact counts, and Pangu spacing between Chinese and Latin/numbers.
- For long files, write in large coherent topic blocks and verify the ending was covered.
- Treat the final output as a research archive: trustworthy beats pretty.
