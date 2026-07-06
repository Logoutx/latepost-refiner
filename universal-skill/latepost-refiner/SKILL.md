---
name: latepost-refiner
description: >-
  Refine rough LatePost-style interview transcripts into research-grade Chinese deliverables while preserving every factual detail.
  Use in Claude Code, Codex, or compatible chat/code agents when the user asks to clean, polish, proofread, structure, or
  "精校/整理/校对" interview/Q&A/oral-history transcripts; unify names, brands, products, and speaker labels; remove verbal
  tics and ASR noise; add topic headings; cross-check entities with public sources; produce optional logical-order rewrites,
  timelines, summaries, review queues, and run manifests. Prefer the host-native subscription runtime: Claude Code uses
  Workflow with no Anthropic API key, Codex uses native subagents with no OpenAI API key. Not for audio transcription from media,
  full-document translation, or short summaries that do not preserve the complete transcript.
---

# LatePost Refiner

Use this skill to turn rough dialogue transcripts into faithful, citable research documents. The job is refinement, not summarization: keep dialogue form, preserve facts and tone, remove noise, correct transcription errors, and add structure.

**Talk to the user in Chinese.** The transcripts and every deliverable are Chinese, so write all user-facing messages — opening questions, progress notes, and the final handoff — in Chinese too. Follow the user's typesetting rules: full-width curly quotes “”, Arabic numerals, and a half-width space between Chinese and Latin/numbers.

## Pick The Native Runtime First

This package supports both Claude Code and Codex. Pick exactly one primary path based on the host you are running in:

- **Codex**: use the Codex native runtime. Read [references/codex-native-runtime.md](references/codex-native-runtime.md). It runs model-heavy stages through Codex native subagents on the signed-in ChatGPT/Codex subscription and deterministic stages through local Node. Do not ask for `OPENAI_API_KEY` or `TAVILY_API_KEY` on this path.
- **Claude Code with Workflow**: use the Claude native runtime. Dispatch `Workflow({ scriptPath: '<this skill dir>/scripts/claude-native.js', args: { ... } })`. It runs subagents on the Claude Code subscription and does not require `ANTHROPIC_API_KEY`. After it returns, read [references/claude-return-handling.md](references/claude-return-handling.md).
- **Claude.ai / no Workflow / no shell**: use the manual path in [references/claude-manual-steps.md](references/claude-manual-steps.md). Skip local scripts that the host cannot run.
- **API-key Universal runtime**: read [references/universal-runtime.md](references/universal-runtime.md) only when the user explicitly asks for the local CLI/web app or accepts a metered provider fallback.

Do not shell out from a subscription-native host into the API-key runtime unless the user opted into that fallback. That would turn a no-key skill into a metered API workflow.

## Opening Questions

Ask everything answerable up front, then run autonomously. If filenames imply answers, propose inferred values and ask the user to correct them.

Collect:

- Output folder. Default to `~/Downloads`, or to the remembered last-used folder if available at `~/.config/latepost-refiner/last-output`; after the user confirms, remember the folder there.
- Topic/company/person and interview date.
- Speaker list, reporter/host names, interviewee roles, and known aliases.
- User-decreed canonical names. If the user says “口语 X/Y 一律写作 Z”, record it structurally as `canonicalOverrides` (`[{ canonical, variants, category: 'person'|'brand'|'term', note? }]`) instead of only in background prose.
- Background: industry, companies, people, products, and events discussed.
- Scope: `refine`, optionally `logic`, `summary`, `timeline`.
- Web verification depth: `key`, `deep`, or `none`.
- Whether to keep or regenerate existing source headings if preflight detects them.

Then tell the user in Chinese that you will read, scout, verify, refine, and produce the requested deliverables without interrupting; save post-reading doubts for one final batch.

## Preflight

Prepare source files before dispatch:

1. Convert supported office/PDF inputs to Markdown. If converters are missing and the host has shell access, run `bash "<this skill dir>/scripts/setup-converters.sh"` once.
2. Count document size by 正文字数, not line count: `grep -oE '[一-龥]|[A-Za-z0-9]+' <file> | wc -l`. Also record line and byte counts for read pagination only.
3. Detect existing headings with `grep -nE '^#{1,3} |^【'`.
4. If `<outputDir>/校对表.md` exists, pass it as the prior glossary unless the user asked for a fresh run.

## Codex Native Summary

For Codex, follow [references/codex-native-runtime.md](references/codex-native-runtime.md). The core local commands use this installed skill directory:

```bash
node "<this skill dir>/scripts/codex-native.mjs" prepare --args run-args.json
node "<this skill dir>/scripts/codex-native.mjs" after-scout --args <out>/_codex-native/args.json --findings findings.json
node "<this skill dir>/scripts/codex-native.mjs" after-verify --args <out>/_codex-native/args.json --state <out>/_codex-native/state-after-scout.json --verified verified.json --dedup dedup.json
node "<this skill dir>/scripts/codex-native.mjs" audit --args <out>/_codex-native/args.json --result result.json
node "<this skill dir>/scripts/codex-native.mjs" artifacts --args <out>/_codex-native/args.json --result <out>/_codex-native/result-audited.json
```

Use native Codex subagents for scout, verify, dedup, refine, logic, summary, and timeline. Keep raw transcripts and full web pages out of the main context; subagents return compact JSON reports and write outputs by path.

## Claude Code Native Summary

For Claude Code, after Step 0 assemble the Workflow args and dispatch:

```js
Workflow({ scriptPath: '<this skill dir>/scripts/claude-native.js', args: {
  topic,
  date,
  background,
  outputDir,
  skillDir: '<this skill dir>',
  scope: ['refine', 'logic', 'summary', 'timeline'],
  verifyDepth: 'key',
  headingPolicy: 'none',
  chunkMode: undefined,
  models: undefined,
  priorGlossaryPath: undefined,
  priorGlossaryText: undefined,
  canonicalOverrides: undefined,
  files: [{ path, label, chars, lines, bytes, title, subtitle, outPath, speakerHints, notes }],
} })
```

Then walk the result using [references/claude-return-handling.md](references/claude-return-handling.md). If Workflow is unavailable, use [references/claude-manual-steps.md](references/claude-manual-steps.md).

## Manual References

Read only what the current path needs:

- [references/editorial-spec.md](references/editorial-spec.md) before refining or assembling prompts.
- [references/glossary-template.md](references/glossary-template.md) when creating or updating `校对表.md`.
- [references/deliverables.md](references/deliverables.md) for logical-order rewrite, timeline, and summary structures.

## Quality Bar

- Preserve all substantive facts, figures, dates, products, processes, channels, opinions, and quotes.
- Keep dialogue form and speaker labels as plain text.
- Remove 口癖, filler, timestamps, repeated confirmation noises, and unrecoverable ASR garbage by meaning, not mechanically.
- Do not fabricate names. Keep `（音）` or `（音，存疑）` when evidence is insufficient.
- Add unnumbered `##` headings by topic; never invent conclusions in headings.
- Use full-width Chinese punctuation, Arabic numerals for exact counts, and Pangu spacing between Chinese and Latin/numbers.
- For long files, write large coherent topic blocks and verify the ending was covered.
- Always run or account for the source-aware audit before final handoff.

## Final Handoff

Read `review.md` first when the native helper produced one. Ask any remaining open questions in one final batch, then provide exact output paths, verification status, unresolved risks, and suggested next actions.
