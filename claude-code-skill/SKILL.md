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

1. **Set the output location — ask, with a default the user can change.** Ask the user where to save the output, **offer a default, and let them confirm or change it**. The default is `~/Downloads`, *unless* you remember a last-used folder: if you can run a shell, first read `~/.config/latepost-refiner/last-output` and offer that path instead. After the user settles on a folder, **remember it for next time** — `mkdir -p ~/.config/latepost-refiner && printf '%s' '<chosen folder>' > ~/.config/latepost-refiner/last-output` — and `mkdir -p` the chosen folder if it doesn't exist. (On claude.ai there's no shell: just offer `~/Downloads` and ask.) **Output rules**: refined transcripts → `<chosen folder>/Transcripts/`; logical-order rewrites → `<chosen folder>/逻辑顺序/`; timeline and summary → `<chosen folder>/` root.

2. **Have the user describe the background on the spot** (these don't require reading the full text, and they let you run to the end without interrupting):
   - **Who was interviewed**: the speaker list (including which reporter/host is who) + each interviewee's title/background at the time, even just a nickname or English name.
   - **What was discussed**: topic / industry domain; the companies, organizations, and key people involved.
   - These two drive how you later web-verify by "domain + name" and how you label speakers.
   - **Pre-fill what you can infer from filenames and have the user confirm/amend** (e.g. filename 「Retail Talk with ex-RetailCo 王某」 → first ask “采访对象是王某(ex-RetailCo)、聊零售/仓储会员店，对吗？”), to reduce typing.
   - **若某人/某公司口语写法混杂，请用户直接指定正名**（“口语 X/Y 一律写作 Z”）→ 收进 `canonicalOverrides` 结构化传入（`[{ canonical:'Z', variants:['X','Y'], category:'person'|'brand'|'term', note? }]`，`category` 默认 person），**不要只写进 background 散文**。散文里的口头指令没有结构否决权，会被 merge/verify/改名守卫悄悄绕过；`canonicalOverrides` 才有：强制 canonical、跳联网核实与改名守卫、折叠同音簇、渲染标〔用户钦定〕、保证即便侦察没抽到也一定进校对表。

3. **Pre-flight (cheap work before dispatch)**: convert `.docx/.pdf` to markdown per the global rules — this needs `markitdown` (docx/pptx/xlsx + simple pdf) and `docling` (complex pdf) on PATH; **if either is missing, run `bash <this skill dir>/setup-converters.sh` once** (idempotent — installs only what's absent, via pipx). Record each file's **正文字数** — the document-length metric, **never lines** (line count is a poor proxy: timestamp lines and short ASR turns inflate it). Count it with `grep -oE '[一-龥]|[A-Za-z0-9]+' <file> | wc -l` (汉字 + 每个英文词/数字各算 1) and pass it as `chars`. Also record line + byte count (`wc -l`/`wc -c`) — those are only for Read pagination, not size judgments. Probe for existing (reporter/steno) sub-headings with `grep -nE '^#{1,3} |^【'`. **Persistent company glossary**: if `<outputDir>/校对表.md` already exists from a prior batch for this company, just pass its path as `priorGlossaryPath` (args below) — **you no longer need to `Read` the whole file and inline it** (the workflow reads it itself: via its host fs, or a cheap Read sub-agent in the sandbox). The workflow seeds scouting from the known entities and **accumulates** this batch into it, keeping spellings consistent across the company's whole interview set and not re-verifying already-settled entities (entries marked 〔核实〕/〔用户钦定〕 are skipped; a human-written 〔待复核〕 forces a re-verify). `priorGlossaryText` still works and wins if you do pass inline text. Tell the user you're extending the existing company glossary; pass `fresh: true` only if they explicitly want a from-scratch rebuild.

4. **Use AskUserQuestion to settle the discrete choices in one shot**: ① scope (refine only / + logical-order rewrite / + summary / + timeline / full pipeline; multi-select); ② (optional, defaults to verifying key entities) web-verification depth; ③ whether to use the default title format `英文名（中文名）当时title`; ④ (only if pre-flight found existing sub-headings) ask “保留原小标题” vs “按内容重新生成”.
   - **Logical-order rewrite** = beyond the refined transcript, re-sequence one interview's Q&A from "recording order" into "narrative order", so scattered exchanges that belong to one thread come together into a complete story (order-preserving rewrite, verbatim). One per refined transcript, opt-in.

Then **tell the user**: “接下来我自己读全文、建校对表、联网核实、逐份精校，中途不打扰你——要几分钟。少数只有读完才能确定的疑点（个别真名、某段归属、某个存疑术语）攒到最后一次性问你。” Then go autonomous.

---

## Claude Code fast path (Workflow, preferred when available)

If this session has the **Workflow tool** (Claude Code), you don't have to run the pipeline by hand after Step 0: assemble the answers into args and dispatch once. Scouting, verification, the glossary, refine + the source-aware audit (completeness included), and summary/timeline all happen inside the workflow.

These Workflow sub-agents run on your **Claude Code session — no `ANTHROPIC_API_KEY` needed**; the API-key path is the separate Universal edition (`engines/api.js`). Keep this path native — don't shell out to the CLI, or it would start requiring a key.

Three things are built in: **model tiering** (scout haiku, verify sonnet, refine/summary/timeline opus, stitch-fallback haiku — completeness is now a deterministic audit gate, no check agent); a **JS merge/dedup** pass with honorific-aware clustering — it merges only on a shared real name or term, treating “X 总” / “董事长”-style honorifics as non-merge keys so two different people aren't lumped together; and a **cache**, so re-running the same input is cheap.

**Refine speed mode (opt-in, OFF by default).** Pass `chunkMode: 'speed'` to split each file over **~12000 正文字数** into up to 2 parallel refine chunks at speaker-turn boundaries (same tier as `refine`), merged into the one `outPath` — deterministically (pure `stitchParts`) when the host provides fs, or by a cheap stitch agent in the Workflow sandbox; the source-aware audit (with its `ending_missing` completeness gate) runs on the stitched result, so a bad merge / failed chunk is caught, not silent. Default (cost mode) = one refine agent per file. **When it pays off:** this is a coarse *batch-speed* lever — it helps wall-clock on **multi-file batches** (parallelism fills the pool → ~35% faster refine at equal fidelity) but costs more allowance (each chunk re-ingests the glossary); on a **single file** the win is small. **Ask the user 速度 vs 省成本 before a large batch** and set `chunkMode` accordingly. Keep **Opus** as `models.refine` for long files — it stays faithful single-agent (charRatio ~0.79) and is cheaper than chunking a single Sonnet agent up to comparable fidelity; chunking is a speed lever, not a reason to switch refine models.

```js
Workflow({ scriptPath: '<this skill dir>/workflow.js', args: {
  topic, date, background,            // topic/company; interview date; Step 0 background (domain + people + companies)
  outputDir,                          // the user's chosen output folder (absolute path)
  skillDir: '<this skill dir>',
  scope: ['refine','logic','summary','timeline'],   // trim per the Step 0 scope answer ('logic' = logical-order rewrite, depends on refine)
  verifyDepth: 'key',                 // 'key' (default) / 'deep' / 'none'
  headingPolicy: 'none',              // set 'regenerate' / 'keep' per the user's answer when pre-flight found existing sub-headings
  chunkMode: undefined,               // 'speed' to refine big files (>~12000 字) as up to 2 parallel chunks; default (cost) = one agent/file. See "speed mode" above.
  models: undefined,                  // optionally override {scout,verify,refine,stitch,summary,timeline}
  priorGlossaryPath: undefined,       // path to <outputDir>/校对表.md if it exists — the workflow reads it itself (host fs, or a Read sub-agent) to seed scouting + accumulate this batch. No need to inline. 'fresh: true' ignores it.
  priorGlossaryText: undefined,       // alternative to priorGlossaryPath: inline text (wins over the path if both given).
  canonicalOverrides: undefined,      // [{ canonical, variants:[…], category:'person'|'brand'|'term' (default person), note? }] — user-decreed 正名 with a structural veto (see Step 0): forces the canonical, skips verify + the name-guard, collapses homophone clusters, renders 〔用户钦定〕.
  files: [{ path, label, lines, bytes, title, subtitle, outPath, speakerHints, notes }],
} })
```

Each `files` item: `path` source file, `label` short name, `chars` 正文字数 (the size metric), `lines`/`bytes` from pre-flight (for Read pagination only), `title` output H1 (per the Output spec), `subtitle` the second italic line, `outPath` = `<output>/Transcripts/<title>.md`, `speakerHints/notes` carry the per-file clues from Step 0. A single file under **~4000 正文字数** automatically takes the "one-pass" shortcut branch (skip scout/glossary). Two chunkings, different purposes: an **oversized file (> ~40000 正文字数) auto-splits the *scout* into parallel sub-scouts** (always-on resilience, no flag — so a huge merged file can't stall scouting; the per-chunk findings merge back into one, and `scoutFailed` still degrades gracefully if a whole file's scout dies). **Refine** chunking is separate and opt-in — only in `chunkMode: 'speed'` (splits big files at speaker-turn boundaries — no pre-flight ranges needed). Speed mode leaves `<outPath>.partN` intermediates next to the final transcript — after the run you can `rm` any `<output>/Transcripts/*.part*` (harmless if left).

**Return handling** → see **[references/return-handling.md](references/return-handling.md)**: it opens with **partial-failure recovery** (if the run dies on a cheap agent after refine landed, resume / finish by hand — never re-refine), then walk the result fields (`glossary`, `failed`, `incomplete`, `unchecked`, `audit`/`auditFailed` (the in-pipeline source-aware gate — hard content_gap/quote_style, auto-repaired once, still-hard files listed + marked), `scoutSuspect`, `scoutFailed`, `headingConflicts`, `suspectedDuplicates`, `networkUnverified`, `openQuestions`, `logic`, `summary`/`timeline`), then go straight to Step 5.

**Workflow not available** (e.g. claude.ai) → run the by-hand pipeline in **[references/manual-steps.md](references/manual-steps.md)** (Steps 1–4), then Step 5.

---

## Step 5 — Wrap-up: one batch of follow-up questions + delivery

**On the Workflow fast path the source-aware audit already ran in-pipeline** (per file, with one auto-repair on a hard gap — see `audit`/`auditFailed` in return-handling.md); here you mainly act on `auditFailed` and re-run the audit by hand only to double-check or to cover a file the sandbox couldn't audit (`auditUnavailable`). **On the manual / claude.ai path, run the quality audit here** on each refined transcript in **pair mode** (source-aware — the output-only form can't see compression or omissions): `node "<this skill dir>/audit_refined.mjs" --source "<源文件>" --refined "<output dir>/Transcripts/<成稿>.md"`. It hard-flags leftover pure filler (嗯/呃, 对对对/是是是, 我我/就就), dialogue paragraphs over ~900 字, compression (charRatio), **and `content_gap` — a substantial source stretch that never surfaced in the 成稿 and left no fold trace (疑似被模型无声略过/审查), with source line ranges**. On `content_gap`: tell the user the line ranges, run `--annotate` to insert visible 内容缺口 markers into the 成稿 (idempotent), and offer to re-refine just those source line ranges — on a different provider if the omission looks policy-driven. 啊/哦/欸 and 这个/那个 are soft (context-dependent) — don't blanket-delete. Then add **source anchors**: `… --anchors` inserts an invisible HTML comment under each `##` heading (`<!-- 源 L25-L38 · 08:00-12:05 -->`) — the section's source line range and recording timestamps, so any quote can be jumped back to the transcript and the audio. Deterministic, idempotent, works retroactively on old 成稿 (given the source file); a section without enough matched evidence gets no anchor (they're a navigation aid — verify against the source, not a guarantee). (No shell on claude.ai — skip the scripts there; the editorial rules already cover the audit's substance.) **If a 时间线/总结 was produced, also run the derivative-attribution guard** (`--derivative <deliverable> --kind timeline|summary --corpus <源…,成稿…>`) to catch a figure tagged 【访谈】 that the interviewee never said — a `derivative_attribution` hard finding must not ship (see return-handling.md item 11).

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
