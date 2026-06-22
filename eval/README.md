# Eval harness

The eval harness turns "the prompt feels right" into measured regression checks. It has two suites:

- **Filler-removal eval**: validates RULES #2 (the three tiers in `core/spec.js`). Real filler gets cut, protected words (我觉得 / 一点 / contrastive 其实 / meaningful 一个) survive, and nothing is over-deleted.
- **Golden transcript-property eval**: checks high-risk transcript properties without brittle exact snapshots: clarified spelling, ending coverage, dialogue shape, factual retention / Chinese typesetting, and protected stance markers.

## Files

- `fixtures.js` — filler-removal snippets. Each fixture has `cut` (must be absent from output) and `keep` (must survive).
- `score.js` — filler pure scorer: `cut_recall`, `keep_rate`, `overDel`.
- `run.mjs` — scores a filler results file `{ "<id>": "<refined text>" }`.
- `golden-fixtures.js` — golden property fixtures with `mustContain` and `mustNotContain`.
- `golden-score.js` — golden pure scorer: containment, forbidden-text absence, fixture pass rate.
- `golden-run.mjs` — scores a golden results file `{ "<id>": "<refined text>" }`.
- `produce.mjs` — optional model-backed producer using the Universal engine. It spends tokens and requires provider credentials.

## Running

Scoring an existing results file:

```bash
node eval/run.mjs /tmp/filler.json
node eval/golden-run.mjs /tmp/golden.json
```

Producing outputs with the Universal engine:

```bash
ANTHROPIC_API_KEY=... node eval/produce.mjs --suite filler --out /tmp/filler.json
ANTHROPIC_API_KEY=... node eval/produce.mjs --suite golden --out /tmp/golden.json
```

Then score:

```bash
npm run eval:filler -- /tmp/filler.json
npm run eval:golden -- /tmp/golden.json
```

Exit code is non-zero if protected words are over-deleted in the filler suite or any golden property fails.

## Periodic evals

`.github/workflows/evals.yml` runs weekly and on manual dispatch. It skips safely when `ANTHROPIC_API_KEY` is not configured as a repository secret. When the secret exists, it produces and scores both filler and golden outputs, then uploads the JSON outputs as a workflow artifact.

## Baseline (2026-06, opus refine)

Filler suite: cut_recall 100% (10/10) · keep_rate 100% (24/24) · over-deletions 0 — the rule cuts every target filler and keeps every protected word, with no over-deletion.

Golden suite: expected pass rate 100% for clarified spelling, ending anchor, dialogue shape, factual/typesetting normalization, and protected stance markers.
