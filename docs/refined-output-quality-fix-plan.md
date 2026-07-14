# Refined Output Quality Fix Plan

> **已收敛**（2026-07-14 起收敛为三 edition：Claude Code / Codex / DeepSeek API——本文其余内容为历史记录）

Date: 2026-06-23

Status note: this plan was written from the pre-`7519636` audit state. Phase 1 landed on `main` with `speakerTurnRatio` intentionally changed to a confirming/reporting signal only, never an independent failure gate. This follow-up branch implements the Phase 2 hard detectors, Phase 5 repair loop, and no-shell checklist while preserving that metric behavior.

## Commits Reviewed

- `442500f` `feat: refined-transcript quality audit, fully integrated across editions`
- `506b46b` `docs(codex): wire the refined-output audit into the native skill`

Claude Code's new work is directionally right: it adds a deterministic audit script, tests it, integrates audit results into `review.md`, updates editorial rules, and tells Claude/Codex workflows to audit before handoff.

It is not yet sufficient for the two observed failures:

- Codex-style failure: output preserves coverage but remains barely refined.
- Claude.ai-style failure: output looks polished but compresses the interview into an article/summary.

## Current State

### What Is Already Useful

- `scripts/audit_refined.mjs` is a reusable, importable deterministic checker.
- `test/audit.test.js` gives a starting regression harness.
- `universal/jobs.js` runs audit after pipeline output and passes it to artifacts.
- `universal/artifacts.js` surfaces failed audits in `review.md`.
- `core/spec.js` now clarifies that pure noise must be removed and paragraph boundaries must remain readable.
- `core/prompts.js` asks the ending-check agent to also report obvious quality issues.
- `claude-code-skill/audit_refined.mjs` is bundled for Claude Code / zip builds.
- Codex docs mention running the audit before handoff.

### Gaps

1. **Output-only audit cannot detect compression.**
   It cannot compare the refined file against the source, so it cannot catch a Claude.ai output that preserves the ending but drops most speaker turns and details.

2. **Soft filler is too soft.**
   `这个` / `那个` / `就是说` remain soft-only. That avoids false positives, but it false-passes the Codex failure where empty-word density barely improves.

3. **Phrase repeats are under-detected.**
   The current regex catches single-character stutters such as `我我`, but misses phrases like `因为因为`, `本身本身`, `涂鸦涂鸦智能`, and `2021 年，2021 年`.

4. **Universal CLI does not appear to run audit.**
   `universal/jobs.js` audits web/server runs, but `universal/cli.js` still writes artifacts directly after `runPipeline()`.

5. **Codex standalone install path is inconsistent.**
   `506b46b` tells Codex to run `node scripts/audit_refined.mjs`, but the installed Codex skill folder only contains `codex-skills/latepost-refiner/`. The shared audit lives at repo root `scripts/audit_refined.mjs`, so a pinned standalone skill copy cannot run it unless the whole repo is present.

6. **No repair loop exists yet.**
   Audit failures are surfaced, but the system does not automatically repair failed spans or rerun the audit before delivery.

## Target Quality Contract

For `refine` scope, the system should fail closed:

- Keep dialogue form.
- Preserve source coverage.
- Remove pure oral noise.
- Keep all facts, numbers, dates, products, chronology, and opinions.
- Preserve readable speaker-turn boundaries.
- Never call a file clean if source coverage or cleanup gates fail.

For `summary`, `timeline`, and `logic`, use separate contracts. Do not apply `refine` coverage thresholds to summary outputs.

## Implementation Plan

### Phase 1 — Source-Aware Audit v2

Extend `scripts/audit_refined.mjs` to support paired source/refined checks:

```bash
node scripts/audit_refined.mjs --source source.md --refined out/Transcripts/title.md
```

Add exported APIs:

- `auditText(text, file)` — keep current output-only behavior.
- `auditPair({ sourceText, refinedText, sourceFile, refinedFile, mode })`.
- `auditPairs([{ source, refined, mode }])`.

Metrics:

- `sourceChars`, `refinedChars`, `charRatio`.
- `sourceSpeakerTurns`, `refinedSpeakerTurns`, `speakerTurnRatio`.
- `sourceParagraphs`, `refinedParagraphs`.
- source ending anchor and whether the refined output appears to cover it.
- hard residual noise count.
- soft filler density before/after.
- phrase-repeat findings.
- suspicious fragment starts.

Suggested `refine` thresholds:

- `charRatio < 0.55` => fail as probable compression.
- `speakerTurnRatio` => report only as a confirming signal. Do not fail independently because faithful refines may merge consecutive same-speaker fragments.
- `emptyPhraseReduction < 0.25` when source has many candidates => fail as probable under-refinement.
- any phrase-repeat finding => fail.
- ending not covered => fail.

Thresholds should be configurable in code constants and conservative enough to avoid blocking good outputs that are naturally shorter.

### Phase 2 — Better Deterministic Detectors

Add hard detectors:

- phrase repeats: `因为因为`, `本身本身`, `然后，然后`, `2021 年，2021 年`, `21 年、21 年`.
- duplicated entity runs: `涂鸦涂鸦`, `钉钉钉`, repeated Latin/model tokens.
- broken fragment starts after speaker label: `^[^：]{1,8}：呢，`, `^[^：]{1,8}：那个全国`, `^[^：]{1,8}：你说那个是`.
- unresolved ASR glue: `20182018`, `一 20182018`, repeated year patterns.

Keep context-dependent terms as density checks rather than absolute bans:

- `这个`, `那个`, `就是说`, `然后`, `其实`, `对吧`.
- Fail only when they remain near source density or appear in obvious filler positions.

### Phase 3 — Regression Fixtures From Real Failures

Add fixtures under `test/fixtures/audit/`:

- `laoxia-source-excerpt.md`
- `laoxia-codex-underrefined.md`
- `laoxia-claude-compressed.md`
- `clean-refined.md`

Tests:

- Codex-style under-refined output must fail.
- Claude-style compressed output must fail.
- Legitimate uses of `这个/那个` must pass.
- Existing hard-noise tests continue to pass.
- Summary-like output should pass only under `mode: "summary"`, not `mode: "refine"`.

Use anonymized excerpts if privacy is a concern.

### Phase 4 — Integrate Audit Everywhere

Universal web/server:

- Upgrade `universal/jobs.js` from `auditFiles(paths)` to source-aware `auditPairs()`.
- Pair each refined output with `A.files[i].path`.
- Include pair metrics in `run.json`.
- Include failed files in `review.md`.

Universal CLI:

- Run the same source-aware audit before `writeRunArtifacts()`.
- Print high-signal audit failures in CLI stderr.

Codex native skill:

- Put an audit entrypoint inside `codex-skills/latepost-refiner/scripts/`, or add `codex-native.mjs audit`.
- Do not reference repo-root `scripts/audit_refined.mjs` from a standalone installed skill unless the skill installation also includes that script.
- Update `native-runtime.md` to call the bundled/pinned path.

Claude Code:

- Keep `claude-code-skill/audit_refined.mjs` bundled.
- If possible, pass source/refined pairs to the script.
- On claude.ai, where shell scripts cannot run, add a model-side checklist that explicitly checks source/refined compression and speaker-turn collapse. Mark this as weaker than deterministic audit.

Review artifacts:

- Add audit summaries to `review.md`:
  - `compression_risk`
  - `under_refined`
  - `phrase_repeats`
  - `ending_missing`
  - `long_paragraphs`
- Add detailed metrics to `run.json`.

### Phase 5 — Repair Loop

Do not hand off a failed file as clean.

Recommended loop:

1. Run initial refine.
2. Run source-aware audit.
3. If audit fails:
   - for local residual noise / phrase repeats: repair only flagged paragraphs.
   - for source compression / speaker-turn collapse: rerun the file from source, not from the compressed output.
   - for ending missing: rerun tail section with source ending anchor.
4. Re-audit.
5. Retry at most 2 times.
6. If still failing, write to `review.md` and final handoff as unresolved.

This loop should be explicit in prompts and runtime logs.

## Performance Impact

### Deterministic Audit

Expected runtime:

- Small/medium transcript: sub-second to a few seconds.
- Large transcript: still linear in text size, usually negligible compared with model calls.

Memory:

- Reads source and refined text into memory.
- Acceptable for normal transcript sizes.

No network and no model call.

### Source-Aware Pairing

Additional work:

- Needs access to source paths and refined output paths.
- No meaningful runtime cost.
- Slightly larger `run.json` if storing metrics and samples.

### Repair Loop

Runtime depends on failure rate:

- Clean output: no additional model runtime.
- Minor local cleanup: one small repair call per flagged span or per file.
- Severe under-refinement: likely one additional full-file refine pass.
- Severe compression: full rerun from source; do not try to recover missing details from the compressed output.

## Cost Impact

### Deterministic Audit

Model/API cost: zero.

This is the highest-leverage fix because it prevents expensive bad handoffs without adding model calls.

### Repair Calls

Estimated model-token overhead:

| Case | Extra Cost | Notes |
|---|---:|---|
| Clean output | 0% | Audit only. |
| Few flagged paragraphs | +5-15% | Targeted repair. |
| Many residual filler spans | +15-40% | Batch repair by section. |
| Whole-file under-refined | +30-80% | Usually requires a second pass. |
| Compressed/article output | +100% for that file | Must rerun from source. |

The repair loop raises worst-case cost but should lower real project cost by avoiding unusable outputs and manual reruns.

### Model Selection

Do not spend premium models on deterministic audit.

Suggested model policy:

- Scout/check/audit planning: cheapest fast model or deterministic Node.
- Repair of small spans: cheaper capable model.
- Full-file rerun after compression/under-refinement: same model as original refine, or one tier stronger if the same failure repeats.
- Summary/timeline: unchanged.

## Priority

1. Source-aware audit v2 with regression fixtures. Done in `7519636`.
2. Universal CLI + web integration. Done in `7519636`.
3. Codex standalone audit entrypoint. Bundled in this follow-up branch.
4. Review/run manifest metrics. Started in `7519636`, extended here with repair attempts.
5. Repair loop. Implemented in this follow-up branch.
6. claude.ai no-shell checklist. Documented in this follow-up branch.

## Acceptance Criteria

- The known Codex under-refined output fails audit.
- The known Claude compressed output fails audit in `mode: "refine"`.
- A clean refined transcript passes.
- `npm test` covers all three cases.
- `universal/jobs.js` and `universal/cli.js` both write audit results to `review.md` and `run.json`.
- Codex installed skill can run its audit without relying on the repo worktree branch.
- Final handoff cannot say “clean” while audit has `status: fail`.
