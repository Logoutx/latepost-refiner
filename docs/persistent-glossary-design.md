# Design: persistent per-company glossary + speaker registry

Status: P1–P4 implemented and verified — 82 free unit assertions (incl. a byte-exact
parse→render→parse idempotency) + one live seeded-scout test. Author note: drawn from the
2026-06 competitive landscape scan — this is the Obsidian-native realization of the
"热词-with-weights + 声纹记忆 + RAG-glossary" pattern that 通义听悟 / 讯飞 / Dovetail / Otter each do partially.

## The core inversion

Today `校对表.md` is per-batch **output** — rebuilt from zero every run, then overwritten.
Make it per-company **memory** — read at the start of every run to seed the pipeline,
extended (not replaced) at the end. The output dir already *is* the company folder
(`ExampleCo/`, `ExampleCo-B/`…), so the existing `校对表.md` files become the seed for free.
Batch 1 is unchanged; batches 2+ get spelling-consistent, cheaper, and faster.

## Why

- **Spelling consistency across a company's whole interview set** — the scout no longer
  re-derives a name from scratch each batch and risks a different 写法.
- **Removes run-to-run verify/dedup variance** — entities verified once are carried forward,
  not re-checked.
- **Unifies the recurring interviewer** (黄俊杰 appears in every interview) and core team
  across files via a speaker registry.
- **Cheaper** — verify runs only on this batch's *new* findings, not the cumulative set.

## File format (decision)

The rendered `校对表.md` stays the **source of truth**; `parseGlossary(md)` is the exact
inverse of `renderGlossary`. The user already edits this file in Obsidian as research
material, so the human artifact *is* the data. The render format is regular and stable;
anything the parser can't match is preserved verbatim so user free-text notes are never
clobbered. (Rejected alternative: a `校对表.json` sidecar as machine-truth — more robust
parse, but two files drift and YAML/JSON is ugly to hand-edit. Fallback only if round-trip
tests prove flaky.)

## Read side (seed)

Step 0 reads `<outputDir>/校对表.md` if present and passes the raw text as
`args.priorGlossaryText` (workflow parses it — no FS in the sandbox). Then:

- **scout** — prompt gains a `已知实体 / 已知发言人` block → reuse known 写法, spend the
  budget discovering *new* entities.
- **merge** — `mergeIntoPrior` folds this batch's clusters into the prior entries
  (prior canonical wins; union variants; carry forward unmatched prior).
- **verify** — runs on *this batch's* findings only; prior verified conclusions are carried
  forward, not re-verified.
- **dedup** — runs on this batch; prior flags carried forward. (P4: feed 勿合并 back in.)
- **refine** — receives the *cumulative* glossary → consistent 写法 across all interviews.

## Write side (extend)

After the run, `mergeIntoPrior` + carried-forward verify/dedup are rendered back to
`<company>/校对表.md` — cumulative, lossless. Prior entries are never silently overwritten;
a conflicting canonical surfaces as an `openQuestion` (P4).

## Code touch-points

- **`core/spec.js`** — `parseGlossary(md)` (inverse of `renderGlossary`); `mergeIntoPrior`,
  `mergeVerified`, `mergeDedup` (cumulative merges); render unchanged. All pure, all
  unit-testable.
- **`core/prompts.js`** — `scoutPrompt` known-entities/speakers block (reads `a.prior`).
- **`core/pipeline.js`** — parse `A.priorGlossaryText` (unless `A.fresh`); seed scout;
  verify/dedup on this batch; render + refine on the cumulative merge.
- **`core/meta.js`** — args contract += `priorGlossaryText?`, `fresh?`.
- **`SKILL.md`** — Step 0 detect+read; Step 5 write the cumulative glossary back.

## Backward compatibility & safety

- **Zero migration.** No prior file → identical to today; the output it writes becomes
  batch 2's seed. `args.fresh=true` opts out and rebuilds from scratch.
- The `applyVerified` person-guard still holds — verify can't rewrite one person into
  another, prior or not.
- Registry / glossary is strictly per-company-folder; never global.

## Verification (mostly free)

- Round-trip: `parseGlossary(renderGlossary(x)) ≈ x` on the **real ExampleCo 校对表**.
- `mergeIntoPrior`: 王总→王志远 folds as variant (no dup); a new entity is added; a
  conflicting canonical surfaces, doesn't overwrite.
- Regression suite stays green; first-run (no prior) byte-identical to today.
- One live re-run: a ExampleCo file seeded with the existing 校对表 → verify does less, 写法 hold.

## Phasing

- **P1** (this pass) — parser + cumulative merge of people/brands/terms + carry-forward of
  verified/errors/notes/dedup + scout seeding + write-back. Lossless + spelling-consistent.
- **P2** — verify-cache exclusion: skip entities already in the carried-forward verified set.
- **P3** — promote 发言人统一标注 to a cross-interview `发言人登记` registry.
- **P4** — `确认不同指（勿合并）` section fed back into dedup; `glossaryConflicts` surfaces
  verify-vs-glossary disagreements; `weakDupFlags` surfaces cross-batch weak-honorific
  ambiguities (王总) for human disambiguation — all into openQuestions, never auto-merged.
