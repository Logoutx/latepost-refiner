---
name: latepost-refiner
description: >-
  Refine and clean up rough interview / Q&A / oral-history transcripts (rough interview transcript cleanup & refine),
  and optionally produce a timeline and an interview summary. Use when the user has one or more dialogue-style
  interview transcripts (common in company research, profiles, podcasts, user interviews, documentary interviews)
  and wants to — remove verbal tics and spoken repetition, smooth out broken speech, add topic sub-headings,
  cross-check and fix ASR-induced name/brand/term errors, unify speaker labels and file titles — while keeping
  every factual detail (this is NOT summarization).
  Trigger whenever the user says things like “精校/整理/校对 转录或访谈稿”, “把录音转的文字整理成能读的”,
  “clean up this interview transcript”, “这几份采访/访谈转录帮我处理一下”, “加小标题、改错别字、统一人名” —
  use this skill proactively even if they don't say the word “skill”.
  Not for: audio-to-text (ASR), full-document translation, or one-line summaries that don't need the full text preserved.
---

# LatePost-Refiner — Interview transcript refinement & cleanup

Turn rough spoken transcripts (ASR output, manual stenography) into **readable, trustworthy, searchable** interview
documents, and optionally go on to produce a timeline and a summary. Core belief: this is **refine, not rewrite, and
definitely not summarization** — preserve the speaker's tone, opinions, and every factual detail; only remove noise,
fix transcription errors, and add structure.

> **Talk to the user in Chinese.** Every user-facing message — the Step 0 questions, progress notes, the Step 5 wrap-up — is written in Chinese (the transcripts and deliverables are Chinese anyway). Follow the user's Chinese typesetting rules: 全角弯引号 “”, Arabic numerals, and a half-width space between Chinese and Latin/numbers.

## When to use / not use
- **Use**: dialogue-style transcripts needing cleanup + structure + name/term fixes; turning several related
  interviews into one searchable research set; a timeline/summary built on top of the refined text.
- **Don't use**: audio-to-text (ASR — this skill assumes you already have text); full-document translation; a short
  summary where you don't care about the full text.

## Core principle: keep heavy text out of the main context
**Raw transcripts and web pages stay only in subagent contexts and are discarded after use; the main agent
(orchestrator) holds only the distilled small artifacts — the glossary, the file list, the output paths.** Never read
a whole transcript or a full page of search results into the main context: delegate source-file reading and web
verification to subagents that report back only compressed conclusions. This is the cost lever for the whole skill,
and every step follows it.

## Workflow overview
0. **Ask everything up front** (output location + who/what/the domain-companies-people + scope), then run autonomously.
1. **Parallel scouting → unified glossary** (one scout subagent per file reporting a compressed list; the main agent merges, cross-validates across files, batch-verifies the residue).
2. **Refine each file** (parallel refine subagents sharing one glossary).
2.5 **Logical-order rewrite** (optional): re-sequence each file's Q&A from recording order into narrative order (verbatim).
3. **Timeline** (against public sources).
4. **Interview summary** (key points / quotes / insights).
5. **Wrap-up**: one batch of the few questions that could only be settled after reading; deliver outputs + verification conclusions.

> **Key rhythm**: ask everything askable in **one** opening round (Step 0), then run autonomously — **don't keep coming back with piecemeal questions**; only doubts that "can only be settled after reading" get saved for Step 5. Scope is trimmable: refine-only stops at Step 2; the full pipeline goes through Step 4 — confirm in Step 0 how far this run goes.

---

## Step 0 — Ask everything up front (pre-interview)

Concentrate interaction **in one opening round**: ask everything the user "can answer from memory on the spot", then run autonomously without interrupting. Do four things up front, ideally in one or two exchanges:

1. **Set the output location — ask every run.** Always ask the user where to save the output and **wait for their answer**; never assume, reuse, or silently default to a folder. Accept an absolute path (they can paste one or drag a folder into the terminal); `mkdir -p` if it doesn't exist. **Output rules**: refined transcripts → `<chosen folder>/Transcripts/`; logical-order rewrites → `<chosen folder>/逻辑顺序/`; timeline and summary → `<chosen folder>/` root.

2. **Have the user describe the background on the spot** (these don't require reading the full text, and they let you run to the end without interrupting):
   - **Who was interviewed**: the speaker list (including which reporter/host is who) + each interviewee's title/background at the time, even just a nickname or English name.
   - **What was discussed**: topic / industry domain; the companies, organizations, and key people involved.
   - These two drive how you later web-verify by "domain + name" and how you label speakers.
   - **Pre-fill what you can infer from filenames and have the user confirm/amend** (e.g. filename 「Retail Talk with ex-RetailCo 王某」 → first ask “采访对象是王某(ex-RetailCo)、聊零售/仓储会员店，对吗？”), to reduce typing.

3. **Pre-flight (cheap work before dispatch)**: convert `.docx/.pdf` to markdown per the global rules — this needs `markitdown` (docx/pptx/xlsx + simple pdf) and `docling` (complex pdf) on PATH; **if either is missing, run `bash <this skill dir>/setup-converters.sh` once** (idempotent — installs only what's absent, via pipx). Record each file's line and byte count with `wc -l`/`wc -c`; probe for existing (reporter/steno) sub-headings with `grep -nE '^#{1,3} |^【'`. **Persistent company glossary**: if `<outputDir>/校对表.md` already exists from a prior batch for this company, `Read` it in full and carry its text into `priorGlossaryText` (args below) — the workflow seeds scouting from the known entities and **accumulates** this batch into it, keeping spellings consistent across the company's whole interview set and not re-verifying already-confirmed entities. Tell the user you're extending the existing company glossary; pass `fresh: true` only if they explicitly want a from-scratch rebuild.

4. **Use AskUserQuestion to settle the discrete choices in one shot**: ① scope (refine only / + logical-order rewrite / + summary / + timeline / full pipeline; multi-select); ② (optional, defaults to verifying key entities) web-verification depth; ③ whether to use the default title format `英文名（中文名）当时title`; ④ (only if pre-flight found existing sub-headings) ask “保留原小标题” vs “按内容重新生成”.
   - **Logical-order rewrite** = beyond the refined transcript, re-sequence one interview's Q&A from "recording order" into "narrative order", so scattered exchanges that belong to one thread come together into a complete story (order-preserving rewrite, verbatim). One per refined transcript, opt-in.

Then **tell the user**: “接下来我自己读全文、建校对表、联网核实、逐份精校，中途不打扰你——要几分钟。少数只有读完才能确定的疑点（个别真名、某段归属、某个存疑术语）攒到最后一次性问你。” Then go autonomous.

---

## Claude Code fast path (Workflow, preferred when available)

If this session has the **Workflow tool** (Claude Code), you don't have to run the pipeline by hand after Step 0: assemble the answers into args and dispatch once. Scouting, verification, the glossary, refine + ending-check, and summary/timeline all happen inside the workflow.

These Workflow sub-agents run on your **Claude Code session — no `ANTHROPIC_API_KEY` needed**; the API-key path is the separate Universal edition (`engines/api.js`). Keep this path native — don't shell out to the CLI, or it would start requiring a key.

Three things are built in: **model tiering** (scout haiku, verify sonnet, refine/summary/timeline opus, ending-check haiku); a **JS merge/dedup** pass with honorific-aware clustering — it merges only on a shared real name or term, treating “X 总” / “董事长”-style honorifics as non-merge keys so two different people aren't lumped together; and a **cache**, so re-running the same input is cheap.

```js
Workflow({ scriptPath: '<this skill dir>/workflow.js', args: {
  topic, date, background,            // topic/company; interview date; Step 0 background (domain + people + companies)
  outputDir,                          // the user's chosen output folder (absolute path)
  skillDir: '<this skill dir>',
  scope: ['refine','logic','summary','timeline'],   // trim per the Step 0 scope answer ('logic' = logical-order rewrite, depends on refine)
  verifyDepth: 'key',                 // 'key' (default) / 'deep' / 'none'
  headingPolicy: 'none',              // set 'regenerate' / 'keep' per the user's answer when pre-flight found existing sub-headings
  models: undefined,                  // optionally override {scout,verify,refine,summary,timeline}
  priorGlossaryText: undefined,       // if <outputDir>/校对表.md exists, Read it and pass its full text here — the workflow parses it to seed scouting + accumulate this batch into it (per-company persistent glossary). 'fresh: true' ignores it and rebuilds from scratch.
  files: [{ path, label, lines, bytes, title, subtitle, outPath, speakerHints, notes }],
} })
```

Each `files` item: `path` source file, `label` short name, `lines`/`bytes` from pre-flight, `title` output H1 (per the Output spec), `subtitle` the second italic line, `outPath` = `<output>/Transcripts/<title>.md`, `speakerHints/notes` carry the per-file clues from Step 0. A single file < 400 lines automatically takes the "one-pass" shortcut branch.

**Return handling** → see **[references/return-handling.md](references/return-handling.md)**: walk the result fields (`glossary`, `failed`, `incomplete`, `unchecked`, `scoutSuspect`, `headingConflicts`, `suspectedDuplicates`, `networkUnverified`, `openQuestions`, `logic`, `summary`/`timeline`), then go straight to Step 5.

**Workflow not available** (e.g. claude.ai) → run the by-hand pipeline in **[references/manual-steps.md](references/manual-steps.md)** (Steps 1–4), then Step 5.

---

## Step 5 — Wrap-up: one batch of follow-up questions + delivery

The few questions that came up during autonomous execution that "can only be settled after reading/verifying, yet need the user to decide" — **note them down and ask in one batch here** (don't interrupt every time one comes up). Typical deferrable items:
- **Real names/identities** that web search couldn't find and internal corroboration couldn't settle (list them and ask if the user knows).
- A passage whose **attribution is unclear** (genuinely can't tell who said it).
- A **doubtful term / product name** with insufficient context to judge.
- Whether to **keep an obviously off-topic** chat passage (offer “保留 / 删 / 折叠成一句”).

Gather these into **one** AskUserQuestion or one message. Deliver at the same time: output paths, each file's sub-headings and key fixes, the real-name verification conclusions (verified vs. not public). If there's nothing to ask, just deliver — don't manufacture questions.

---

## Output spec (shared conventions)

- **Location**: refined transcripts → `<chosen folder>/Transcripts/`; logical-order rewrites → `<chosen folder>/逻辑顺序/`; timeline and summary → `<chosen folder>/`.
- **File title format**: `英文名（中文名）当时的title`.
  - Both an English name and a Chinese real name: `Allan（王哲）CFO·合伙人`, `Joey（李航）合伙人·CEO`.
  - Only a Chinese name (no English name): `陈悦 示例品牌合伙人` (name + title, no parentheses).
  - Real name not found, only a nickname/English name: keep the nickname + title, e.g. `Sherrie 示例品牌·负责投放`, **don't fabricate a Chinese name**.
  - Group interview with multiple people: name it as `团队/角色（各花名+分工）`.
  - Keep the filename and the in-file H1 title identical.
- **Real-name verification conclusions** go in the timeline's "关键人物对照表": verified ones tagged with the real name + source, ones not found tagged “真名未公开”.

## Quality bar (full rules in [references/editorial-spec.md](references/editorial-spec.md))

Read `references/editorial-spec.md` before refining (or assembling a refine subagent prompt). The essence:
- **Refine ≠ summarize** — keep every substantive fact, figure, date, product, process, opinion, and characterful quote.
- **Dialogue form**; speaker labels are **plain text** (`李明：`, never `**李明：**`).
- Remove 口癖 / filler / confirmation noises / timestamps / unrecoverable ASR garbage — by meaning, not mechanically (when unsure, keep).
- **Never fabricate names**; keep `（音）` / `（音，存疑）` when evidence is insufficient; follow `校对表.md` strictly.
- Add **unnumbered** `##` topic headings; don't invent conclusions in headings.
- **Chinese typesetting**: full-width punctuation, 弯引号 “” (no `「」`/ASCII), Arabic numerals for exact counts, Pangu spacing between Chinese and Latin/numbers.
- **Long files**: write large coherent topic blocks (no mid-topic stop, no pile of tiny edits); verify the ending was covered.

## Common trip-ups
- **Main agent must not read full text/web pages** — delegate to subagents; the main context receives only compressed conclusions (the cost lever).
- Don't build the glossary from fragments — cross-validation relies on each scout reading its own full file, then merging.
- Don't turn refining into summarizing — the factual detail is the research value.
- Don't force-change uncertain names — `（音）` beats getting it wrong.
- Don't stop a long file halfway — relay to the end and check.
- Don't keep interrupting — ask once in Step 0, save piecemeal doubts for Step 5.
