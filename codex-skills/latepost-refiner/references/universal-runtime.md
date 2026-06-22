# Universal Runtime API-Key Fallback

Use this runtime when the user explicitly wants the local web app/CLI or accepts a metered provider fallback. It shares
the same `core/` pipeline, but it calls provider APIs and therefore requires provider keys.

For the no-key Codex subscription path, use [native-runtime.md](native-runtime.md) instead.

## Locate And Verify

From the repository root:

```bash
npm install
npm test
```

The repo may still live in a local folder named `interview-transcriber` even after the GitHub rename to `latepost-refiner`.

## Web UI

```bash
npm run web
```

Open the printed `http://127.0.0.1:<port>` URL. The UI supports:
- Provider selection: Anthropic, DeepSeek, GLM, Kimi, OpenAI.
- Model list fetch and cost-aware defaults.
- Single-provider mode or per-category routing.
- File upload for `.txt`, `.md`, `.docx`, `.pptx`, `.xlsx`, `.pdf`.
- Scope selection: refined transcript, logical-order rewrite, summary, timeline.
- Resume via "跳过已完成文件", backed by `<out>/run.json`.
- Stop button. Cancellation is cooperative and exits after the current model call returns.

API keys are required for real provider calls and are used in memory for the local run; do not write them to output
files, logs, manifests, or review notes.

## CLI

When the user opts into this fallback from Codex, default to OpenAI:

```bash
node universal/cli.js \
  --provider openai \
  --files "a.txt" "b.docx" \
  --topic "<主题>" \
  --date "2026-06" \
  --background "<访谈背景、人物、公司、领域>" \
  --scope refine,logic,summary,timeline \
  --verify key \
  --models scout=gpt-5.4-mini,verify=gpt-5.4,dedup=gpt-5.4,refine=gpt-5.4,logic=gpt-5.4,summary=gpt-5.4,timeline=gpt-5.4 \
  --out "<输出目录>"
```

Default OpenAI profile:

| Stage | Model | Why |
|---|---|---|
| `scout` | `gpt-5.4-mini` | Cheap extraction of speakers/entities/errors. |
| ending `check` | `gpt-5.4-mini` | Cheap completeness check. |
| `verify` | `gpt-5.4` | Better judgment for public-source entity verification. |
| `dedup` | `gpt-5.4` | Better semantic same-referent decisions. |
| `refine` | `gpt-5.4` | Main quality/cost balance for faithful transcript cleanup. |
| `logic` | `gpt-5.4` | Good enough for reorder-without-rewrite discipline. |
| `summary` | `gpt-5.4` | Strong synthesis without premium default cost. |
| `timeline` | `gpt-5.4` | Needs source-aware judgment and chronology. |

Premium profile for especially messy, long, or high-stakes runs:

```bash
--models scout=gpt-5.4-mini,verify=gpt-5.4,dedup=gpt-5.4,refine=gpt-5.5,logic=gpt-5.5,summary=gpt-5.5,timeline=gpt-5.5
```

Useful flags:
- `--provider anthropic|deepseek|glm|kimi|openai`
- `--base-url <URL>`
- `--models scout=<id>,verify=<id>,dedup=<id>,refine=<id>,logic=<id>,summary=<id>,timeline=<id>`
- `--fresh` to ignore existing `校对表.md`
- `--resume` to read `<out>/run.json` and skip completed refined transcripts
- `--resume-from <path/to/run.json>` to resume from a specific manifest
- `--heading-policy none|keep|regenerate`
- `--verify key|deep|none`

## Environment

Provider keys:
- Anthropic: `ANTHROPIC_API_KEY`
- DeepSeek: `DEEPSEEK_API_KEY`
- GLM/Z.ai: `ZHIPUAI_API_KEY`, `ZAI_API_KEY`, or `GLM_API_KEY`
- Kimi: `MOONSHOT_API_KEY`
- OpenAI: `OPENAI_API_KEY`

DeepSeek and OpenAI need `TAVILY_API_KEY` for client-side web verification. Anthropic, GLM, and Kimi use provider-native
search where supported. This is why the Codex-native path should use built-in browsing instead of this fallback when
the user wants a no-key run.

## Output Contract

The runtime writes:
- `<out>/Transcripts/<title>.md`
- `<out>/校对表.md`
- `<out>/review.md`
- `<out>/run.json`
- `<out>/逻辑顺序/<title>.md` when `logic` is in scope
- `<out>/<topic>访谈总结.md` when `summary` is in scope
- `<out>/<topic>时间线.md` when `timeline` is in scope

Read `review.md` before reporting completion. It consolidates failed files, incomplete endings, unverified network items, suspected duplicate names, source-heading conflicts, and open questions.

Read `run.json` when auditing a run, resuming a run, or explaining exactly what files, models, provider, scope, hashes, artifacts, and usage were recorded.

## Return And Handoff

In the final response to the user:
- State what was generated and where.
- Mention unresolved items from `review.md`.
- Mention whether any `networkUnverified` items should be re-checked.
- Mention whether resume skipped files.
- Avoid pasting long transcript content into chat.
