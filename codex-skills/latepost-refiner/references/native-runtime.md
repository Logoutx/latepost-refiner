# Codex Native Runtime

Use this path first in Codex. It runs on the signed-in ChatGPT/Codex subscription and does not require
`OPENAI_API_KEY` or `TAVILY_API_KEY`.

The native runtime mirrors the Claude Workflow edition:

| Stage | Runs Where | Why |
|---|---|---|
| Step 0 preflight | Local shell + deterministic helper | File stats, output paths, prior glossary loading. |
| Scout | Codex native subagents, one per file | Full-file reading stays out of the main context. |
| Merge/glossary | Local Node helper using `core/spec.js` | Reuses exact clustering, weak-name guards, glossary render. |
| Verify | Codex native web/browsing subagents | Public-source checks without Tavily/API keys. |
| Dedup | Codex native subagent | Semantic same-referent review. |
| Refine/check | Codex native subagents, one per file | Heavy transcript text stays inside file-level workers. |
| Logic/summary/timeline | Codex native subagents | Optional deliverables from refined outputs. |
| Review/manifest | Local Node helper using `universal/artifacts.js` | Same `<out>/review.md` and `<out>/run.json` contract as Universal. |

## Confirm The No-Key Path

Before a run, verify the key is absent:

```bash
printf 'OPENAI_API_KEY=[%s]\nTAVILY_API_KEY=[%s]\n' "$OPENAI_API_KEY" "$TAVILY_API_KEY"
```

Expected:

```text
OPENAI_API_KEY=[]
TAVILY_API_KEY=[]
```

Do not ask the user for API keys on the primary path. If a stage cannot use native Codex tools, degrade that stage and
record it in `review.md`; offer the Universal fallback only as an explicit opt-in.

## Document Converters

If any input is `.docx/.pptx/.xlsx/.pdf`, the Step-0 preflight converts it to Markdown first, then subagents read the
`.md` (keeps raw bytes out of the main context). This needs `markitdown` (office docs + simple PDF) and `docling`
(complex / multi-column PDF) on PATH. **If either is missing, run the installer once — it is idempotent and installs
only what is absent, via pipx:**

```bash
bash scripts/setup-converters.sh          # ensure markitdown + docling
bash scripts/setup-converters.sh --check  # report status only, install nothing
```

These run locally with no API key, so they fit the no-key path. The Universal fallback's binary can also parse `.docx`
with a built-in library, but on the native path use markitdown for consistency across all formats.

## Capability Spike Result

The June 2026 spike passed all required gates:

| Test | Result | Mechanism / notes |
|---|---|---|
| A — parallel subagents, no key | pass | Native `multi_agent_v1` subagents launched concurrently and cleaned both snippets with no API key. |
| B — `node` runs `core/` JS, no key | pass | `env -u OPENAI_API_KEY npm test` passed 30/30; direct `clusterEntities()` import printed expected output. |
| C — web search, no key | pass | Built-in Codex browsing returned sourced public facts without Tavily/API keys. |

Chosen design: use the full no-key Codex-native pipeline.

## Model Choice

Use the current Codex subscription model surface by default. Do not put API model IDs in native prompts.

If the UI allows per-agent model choice:
- Use the fastest cost-effective OpenAI/Codex model for `scout` and ending `check`.
- Use the default balanced/high-quality Codex model for `verify`, `dedup`, `refine`, `logic`, `summary`, and `timeline`.
- Use the strongest/premium model only when the user asks for a deep, high-stakes, or especially messy run.

The OpenAI API model profile in `universal-runtime.md` applies only to the Universal fallback.

## Step 0 Args

After the opening questions and cheap preflight, create a JSON args file. Keep this file small; it should contain paths
and metadata, not transcript bodies.

```json
{
  "topic": "示例公司",
  "date": "2026-06",
  "background": "访谈对象、公司、行业、关键人物、产品、事件线索。",
  "outputDir": "/absolute/path/to/output",
  "skillDir": "/absolute/path/to/codex-skills/latepost-refiner",
  "scope": ["refine", "logic", "summary", "timeline"],
  "verifyDepth": "key",
  "headingPolicy": "none",
  "files": [
    {
      "path": "/absolute/path/to/source.md",
      "label": "访谈 A",
      "speakerHints": "记者=李明；受访者=王某，时任 COO",
      "notes": "重点谈供应链和加盟。"
    }
  ]
}
```

`scope` can be trimmed to `["refine"]`. `logic`, `summary`, and `timeline` depend on this run's refined outputs, so keep
`refine` in scope when requesting any of them.

## Helper Commands

The helper only performs deterministic local work. It generates prompts, merges structured reports, writes the glossary,
and emits review/manifest files. It never calls model APIs.

Prepare normalized args and first-stage prompts:

```bash
node codex-skills/latepost-refiner/scripts/codex-native.mjs prepare --args run-args.json
```

The helper writes:

```text
<out>/_codex-native/args.json
<out>/_codex-native/prompt-manifest.json
<out>/_codex-native/prompts/*.txt
```

For a single short file, the first prompt is `single-pass`; otherwise the first prompts are `scout`.

## Scout

Spawn one native Codex subagent per generated scout prompt. The subagent must:
- Read the whole source file using the prompt's read plan.
- Keep source text inside the subagent context.
- Return only JSON matching the prompt schema.

Save the results as:

```json
{
  "访谈 A": {
    "speakers": [],
    "people": [],
    "brands": [],
    "terms": [],
    "errors": [],
    "themes": [],
    "has_existing_headings": false,
    "ending_anchor": {"line": 1200, "text": "源文件最后一句原文。"},
    "special_notes": []
  }
}
```

Then run:

```bash
node codex-skills/latepost-refiner/scripts/codex-native.mjs after-scout \
  --args <out>/_codex-native/args.json \
  --findings findings.json
```

This writes `state-after-scout.json`, verify prompts, and a dedup prompt when needed.

## Verify And Dedup

Spawn native Codex subagents for each verify prompt. Use built-in browsing/web search only; do not use Tavily.

Save verify results either as an array of prompt results:

```json
[
  {"resolved": [], "unresolved": []}
]
```

or as:

```json
{"resolved": [], "unresolved": []}
```

Run the dedup prompt in a native subagent and save:

```json
{"suspects": []}
```

Then render the glossary and next-stage prompts:

```bash
node codex-skills/latepost-refiner/scripts/codex-native.mjs after-verify \
  --args <out>/_codex-native/args.json \
  --state <out>/_codex-native/state-after-scout.json \
  --verified verified.json \
  --dedup dedup.json
```

This writes:

```text
<out>/校对表.md
<out>/_codex-native/state-after-verify.json
<out>/_codex-native/prompts/*-refine-*.txt
<out>/_codex-native/prompts/*-check-*.txt
```

If native browsing is unavailable, create `verified.json` with every target in `unresolved` and a note such as
`"native browsing unavailable"`; the helper will carry those warnings into the final review flow.

## Refine And Check

Spawn one native Codex subagent per refine prompt. Each subagent writes directly to its assigned
`<out>/Transcripts/<title>.md` and returns a compact JSON report:

```json
{
  "path": "/absolute/path/to/output/Transcripts/title.md",
  "headings": ["主题一", "主题二"],
  "key_fixes": ["统一了某人名写法"],
  "open_questions": []
}
```

Then run each check prompt against the corresponding source ending and refined output. Merge the check result into the
refine report using the same fields as Universal runtime expects:

```json
{
  "outPath": "/absolute/path/to/output/Transcripts/title.md",
  "complete": true,
  "checkNote": "",
  "headings": [],
  "key_fixes": [],
  "open_questions": []
}
```

Keep any incomplete or unchecked file in the final `result.json`.

## Optional Deliverables

After `refined` reports exist, add them to `state-after-verify.json` under `refined`, then generate optional prompts:

```bash
node codex-skills/latepost-refiner/scripts/codex-native.mjs deliver-prompts \
  --args <out>/_codex-native/args.json \
  --state <out>/_codex-native/state-after-verify.json
```

Spawn native subagents for `logic`, `summary`, and `timeline` prompts as requested. Use built-in browsing for timeline
public-source checks. Save compact reports and paths in `result.json`.

## Review Queue And Run Manifest

Assemble the final result object. Start from `state-after-verify.json`'s `resultSeed`, then fill in `refined`, `logic`,
`summary`, `timeline`, `failed`, `incomplete`, and `unchecked`.

```bash
node codex-skills/latepost-refiner/scripts/codex-native.mjs artifacts \
  --args <out>/_codex-native/args.json \
  --result result.json
```

This writes:

```text
<out>/review.md
<out>/run.json
```

Run the deterministic quality audit on the refined transcripts before handoff. The audit script is bundled inside this skill at `codex-skills/latepost-refiner/scripts/audit_refined.mjs`, so a standalone install can run it without the repo worktree. **Use the source-aware form** (one per file — pair each refined output with its source) so it catches compression, not just leftover filler:

```bash
node codex-skills/latepost-refiner/scripts/audit_refined.mjs --source <源稿.md> --refined <out>/Transcripts/<title>.md
```

`status: fail` flags a hard issue:
- `compression_risk` — refine became a summary (refined/source 汉字 ratio < 0.55). **Rerun that file from source**, don't try to recover detail from the short output.
- `under_refined` — coverage kept but filler barely removed.
- `ending_missing` — the source's last turn isn't reflected in the output.
- residual pure filler (嗯/呃, 对对对/是是是, 我我/就就) or a dialogue paragraph over ~900 characters.

啊/哦/欸 sentence-final modal particles and 那个/这个/就是说 are soft candidates — inspect context, don't blanket-delete. (Output-only form `node …/audit_refined.mjs <file.md>` still works when no source is at hand, but it cannot detect compression.)

Always read `review.md` before the final user handoff.

## Failure Policy

- If a scout result is garbled, rerun that file once. If it remains garbled, continue refine but mark the glossary risk.
- If verify search fails twice in a row, stop that verify chunk and mark unresolved; do not retry indefinitely.
- If a file's ending check is incomplete or unchecked, surface it in `review.md`.
- If native subagents are unavailable, run serially in the main Codex session for small jobs or ask before using the
  Universal API-key fallback.
- Never paste full raw transcripts or full web pages into the main chat. Keep the main context to paths, prompts,
  compact JSON reports, `校对表.md`, `review.md`, and `run.json`.
