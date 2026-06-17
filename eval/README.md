# Filler-removal eval

Turns "the filler rule feels right" into a measured, regression-catching number. Validates RULES #2
(the three tiers in `core/spec.js`): real filler gets cut, protected words (我觉得 / 一点 / contrastive
其实 / meaningful 一个) survive, and nothing is over-deleted.

## Files
- `fixtures.js` — annotated snippets across the three tiers. Each: `cut` (must be absent from output),
  `keep` (must survive — a protected word or content anchor).
- `score.js` — pure scorer. `cut_recall` (filler removed), `keep_rate` (protected words kept),
  `overDel` (the hard failure: protected words wrongly removed — must be empty).
- `run.mjs` — scores a results file `{ "<id>": "<refined text>" }` against the fixtures.

## Running
Filler removal is LLM judgment, so a real eval runs the model:
1. Dispatch ONE refine agent with the RULES #2 three-tier rule + every fixture's `input`; have it return
   `{id: refinedText}` and write it to a JSON file (e.g. `/tmp/eval_out.json`).
2. `node eval/run.mjs /tmp/eval_out.json`

Exit code is non-zero if any protected word was over-deleted. Once the Universal SDK engine lands, a
self-contained runner can produce the results JSON directly instead of the agent-dispatch step.

## Baseline (2026-06, opus refine)
cut_recall 100% (10/10) · keep_rate 100% (24/24) · over-deletions 0 — the rule cuts every target filler
and keeps every protected word, with no over-deletion.
