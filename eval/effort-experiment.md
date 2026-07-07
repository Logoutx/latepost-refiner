# M12 effort experiment — should refine drop to a lower reasoning effort?

## Question

The M12 knob lets us set `output_config.effort` per smart-tier category (default is `high`). Lowering `refine` to
`medium` would cut reasoning tokens (the dominant cost on the opus refine path). **Adopt it only if quality holds.**
This is the cheap, scoreable experiment that answers it before we touch any default.

## Design — two arms, one probe

The harness is `eval/effort-probe.workflow.js`: a Workflow-sandbox script that fans the fixture INPUTS through
refine-style agents at a given effort and RETURNS `{ id → refinedText }` (no fs — it returns, the orchestrator
scores). Both arms run the **same** probe; only `args.effort` differs, so the comparison isolates the knob.

- **Arm A (control):** `effort` omitted → the current default (`high`).
- **Arm B (candidate):** `effort: "medium"`.

Fixtures are the two existing suites, both **fictional by construction** (no real subjects — hard rule):
- golden property fixtures — `eval/golden-fixtures.js` (5 fixtures: spelling-confirmation collapse, ending anchor,
  speaker/dialogue shape, facts + number/spacing typeset, protected stance markers).
- filler-removal fixtures — `eval/fixtures.js` (13 fixtures across 径删 / 看义删 / 基本别动).

Run each arm **3 times** (same fixtures) to see run-to-run variance — a single run of a stochastic model is not
enough to trust a small quality delta.

## Running it (orchestrator, subscription-billed via the Workflow tool)

For each arm, invoke the probe with the fixture inputs and collect the returned `outputs`:

- Build `args.fixtures` from the suite: `GOLDEN_FIXTURES.map(({id,input})=>({id,input}))` and
  `FIXTURES.map(({id,input})=>({id,input}))` (concatenate both suites into one probe call, or run one call per
  suite — the ids are unique across suites).
- Arm A: `args = { fixtures, model: "opus" }`  (no effort).
- Arm B: `args = { fixtures, model: "opus", effort: "medium" }`.

The probe returns `{ effort, model, outputs: { <id>: <text> } }`. Save each arm's `outputs` to a JSON file.

## Scoring (offline, deterministic, zero model cost)

The returned `outputs` is exactly the `{ id → text }` shape both scorers consume:

```
node eval/golden-run.mjs <arm-outputs.json>   # golden: contain_rate, forbidden_rate, fixture_pass
node eval/run.mjs        <arm-outputs.json>    # filler: cut_recall, keep_rate, over-deletions
```

(Or call `scoreGoldenAll(GOLDEN_FIXTURES, outputs)` / `scoreAll(FIXTURES, outputs)` directly.) Score all 3 runs of
each arm; compare Arm B against Arm A on the metrics below.

## Decision rule — adopt `medium` for refine ONLY IF all three hold

1. **Golden pass-rate stays 100%** on Arm B across all 3 runs (`fixture_pass == 1.0`, i.e. `failures == []`). The
   golden suite encodes the non-negotiables (facts, ending, dialogue shape, stance, typeset) — any regression is a veto.
2. **Filler metrics hold:** Arm B's `cut_recall` is within noise of Arm A (no worse than ~2 pp below the Arm-A mean)
   AND `keep_rate` does not drop, AND `over-deletions` (protected words wrongly removed) stays **empty** on every run.
   Over-deletion is the hard failure — a single non-empty `overDel` on any Arm-B run is a veto.
3. **Real-pair spot check:** run one real fixed transcript through the full pipeline at `--effort refine=medium` and
   diff the 成稿 against the default; confirm the source-aware audit surfaces **no new hard gates** (no new
   `content_gap` / `quote_style` / `ending_missing` / `compression_risk`). The scorers cover micro-properties; this
   catches a whole-document compression the tiny fixtures can't.

If any of the three fails → keep `high` (do not change the default; the knob still exists for opt-in use).

## Cost estimate per arm

Per arm = 18 fixtures × 3 runs = 54 refine agents, each on a short (≤ ~120-字) fixture. Refined output is tiny; the
spend is dominated by reasoning tokens. Rough order: an opus refine agent on a fixture is a few thousand tokens
in/out including thinking → on the order of a few US cents per agent, so **~$1–3 per arm** at `high`, and **less at
`medium`** (fewer reasoning tokens — that saving is the whole point). Two arms ≈ **$2–6 total**. Scoring is free
(deterministic JS). The real-pair spot check adds one full-pipeline run at each effort on one transcript.

## What "adopt" would mean

If the rule passes, set the refine default effort to `medium` in the run assembly (or document `--effort
refine=medium` as the recommended flag for archival bulk). The knob plumbing (api.js `output_config.effort`, CLI
`--effort`, CC bootstrap passthrough) is already in place; adoption is a one-line default change, gated on this
experiment's green result.
