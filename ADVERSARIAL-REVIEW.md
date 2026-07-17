# Adversarial Review

## Findings

1. HIGH, `scripts/audit_refined.mjs:2439`: `derivMagnitudeMatches` treats any same value+unit anywhere in the interview corpus as support, so a fabricated derivative 【访谈】 claim can evade the hard `derivative_attribution` gate when an unrelated corpus number happens to match.
   Concrete failing input: corpus `周砚 00:00\n公司完成融资 2 亿，账上现金够用。`; derivative `- 公司去年亏损 2 亿【访谈】。` returns `hardFail: []`, because `2|亿` is present even though “亏损 2 亿” was never said.

2. MEDIUM, `scripts/audit_refined.mjs:1195`: `checkMeaningAtoms` intentionally matches source/refined atoms by numeric value only, so a real unit mutation is invisible to `number_drift`.
   Concrete failing input: source `周砚 00:00\n项目从立项到上线只用了 3 个月，...足够长的锚定文本...`; refined `周砚：项目从立项到上线只用了 3 年，...同一锚定文本...` returns `assessed: true` with `drifted: 0`.

3. MEDIUM, `scripts/audit_refined.mjs:2324`: `checkNumericConsistency` keys the measured noun by the raw trailing Hanzi before the number, so equivalent copula wording splits one quantity into different keys and misses a same-document contradiction.
   Concrete failing input: `周砚：毛利率为 30%。\n周砚：毛利率是 45%。` returns no conflicts, because the keys become `毛利率为` and `毛利率是` instead of the shared noun `毛利率`.

4. MEDIUM, `core/spec.js:264`: parsed `〔待复核〕` glossary confidence is not re-emitted when there is no fresh verification hit, so `render -> parse -> render` drops a human recheck marker.
   Concrete failing input: `- **虚构术语** ← — ｜ 说明 〔待复核〕` parses as `confidence: "recheck"` but re-renders as `- **虚构术语** ← — ｜ 说明`, losing the marker that future runs use to force re-verification.

5. LOW, `build/sync-skills.mjs:36`: the sync manifest is not actually “every vendored copy” because byte-identical duplicate scripts remain outside `MANIFEST` and can drift without `sync:skills --check` noticing.
   Concrete scenario: `scripts/setup-converters.sh` is byte-identical to `claude-code-skill/setup-converters.sh`, and `scripts/install-converters.command` is byte-identical to `claude-code-skill/install-converters.command`, but neither pair appears in the manifest at `build/sync-skills.mjs:36-47`.

6. LOW, `README.md:16`: the merge left README Codex-runtime guidance stale and contradictory to the committed Codex skill entry point.
   Concrete scenario: README says the Codex skill delegates to the Universal CLI and needs `OPENAI_API_KEY`, while `codex-skill/latepost-refiner/SKILL.md:10-12` says the first choice is the no-key native subscription runtime now committed in this branch.

## Hunt Category Coverage

1. New audit heuristics: findings 1-3.
2. Glossary round-trip: finding 4. I found no phantom rows or note loss in the plain `- **term** ← variants ｜ note` path beyond the `〔待复核〕` marker loss.
3. Claude Code sandbox violations: nothing found. I searched `claude-code-skill/workflow.js` for `Buffer`, `process`, `require`, `globalThis`, dynamic eval/function construction, imports, `fs`, `path`, and module/export patterns; only comments and local variable names matched.
4. `build/sync-skills.mjs` drift/design gaps: finding 5. The checked manifest entries themselves pass `node build/sync-skills.mjs --check`.
5. Merge commit `98e2f74` conflict-resolution incoherence: finding 6. I did not report the known dormant `auditAndRepairRefined`.
6. Codex-native runtime breakage from generated banners: nothing found. Node can import the bannered ESM copies; shebang handling is preserved for `audit_refined.mjs`.
7. Test blind spots: findings 1-4 are behavior-level gaps not pinned by the added tests; finding 5 is not covered by the manifest check because the files are not in the manifest; finding 6 is documentation drift rather than runtime-tested behavior.

verdict FIX-FIRST (blocking finding 1)
