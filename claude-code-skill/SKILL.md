---
name: transcriber
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

# Transcriber — Interview transcript refinement & cleanup

Turn rough spoken transcripts (ASR output, manual stenography) into **readable, trustworthy, searchable** interview
documents, and optionally go on to produce a timeline and a summary. Core belief: this is **refine, not rewrite, and
definitely not summarization** — preserve the speaker's tone, opinions, and every factual detail; only remove noise,
fix transcription errors, and add structure.

## When to use / not use
- **Use**: you have dialogue-style transcripts and need cleanup + structure + name/term fixes; you want to turn several
  related interviews into one searchable research set; you want a timeline/summary built on top of the refined text.
- **Don't use**: audio-to-text (ASR — this skill assumes you already have text); full-document translation; you only
  want a short summary and don't care about the full text.

## Core principle: save tokens, save time while providing a human-quality transcript
**Heavy text (raw transcripts, web pages) stays only in subagent contexts and is discarded after use; the main agent's
(orchestrator's) context holds only the distilled small artifacts — the glossary, the file list, the output paths.**
The main agent must never read a whole transcript or a full page of search results into its own context: delegate
source-file reading and web verification to subagents that report back only compressed conclusions. This is the cost
lever for the whole skill, and every step below follows it.

## Workflow overview
0. **Ask everything up front** (output location + who/what/the domain-companies-people + scope), then run autonomously without interrupting.
1. **Parallel scouting → build a unified glossary** (one scout subagent per file reporting only a compressed list; the main agent merges, cross-validates across files, batch-verifies the residue).
2. **Refine each file** (parallel refine subagents sharing one glossary).
2.5 **Logical-order rewrite** (optional): re-sequence each file's Q&A from recording order into narrative order (order-preserving rewrite, verbatim).
3. **Timeline** (against public sources).
4. **Interview summary** (key points / quotes / insights).
5. **Wrap-up**: ask the user, in one batch, the few open questions that could only be settled after reading; deliver the outputs and the verification conclusions.

> **Key rhythm**: ask everything askable up front (Step 0) **in one round**, then run autonomously and **don't keep coming back with piecemeal questions**; only the few doubts that "can only be settled after reading" get saved up for Step 5.
> Scope is trimmable: refine-only stops at Step 2; the full pipeline goes through Step 4. Confirm in Step 0 how far this run goes.

---

## Step 0 — Ask everything up front (pre-interview)

Concentrate interaction **in one opening round**: ask everything the user "can answer from memory on the spot", then run autonomously without interrupting. Do four things up front, ideally in one or two exchanges:

1. **Set the output location.** Ask the user for the absolute path of the output folder right in the conversation — **offer a sensible default to confirm or change**, don't make them type a full path from scratch. This user keeps research notes in the Obsidian `Company Research` vault, so the **default suggestion** is:
   `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Outer Mind/Company Research/<项目名>`
   (pick a `<项目名>` from this run's topic/company, e.g. `Mixue`, `Xige`). Use a different path if the user gives one; `mkdir -p` if it doesn't exist. **Output rules**: refined transcripts → `<chosen folder>/Transcripts/`; timeline and summary → `<chosen folder>/` root.

2. **Have the user describe the background on the spot** (these don't require reading the full text, and they let you run to the end without interrupting):
   - **Who was interviewed**: the speaker list (including which reporter/host is who) + each interviewee's title/background at the time, even just a nickname or English name.
   - **What was discussed**: topic / industry domain; the companies, organizations, and key people involved.
   - These two drive how you later web-verify by "domain + name" and how you label speakers.
   - **Pre-fill what you can infer from filenames and have the user confirm/amend** (e.g. filename 「Retail Talk with ex-FUDI 顾隽华」 → first ask “采访对象是顾隽华(ex-FUDI)、聊零售/仓储会员店，对吗？”), to reduce typing.

3. **Pre-flight (cheap work before dispatch)**: convert `.docx/.pdf` to markdown per the global rules; record each file's line and byte count with `wc -l`/`wc -c`; probe for existing (reporter/steno) sub-headings with `grep -nE '^#{1,3} |^【'`. **Persistent company glossary**: if `<outputDir>/校对表.md` already exists from a prior batch for this company, `Read` it in full and carry its text into `priorGlossaryText` (args below) — the workflow seeds scouting from the known entities and **accumulates** this batch into it, keeping spellings consistent across the company's whole interview set and not re-verifying already-confirmed entities. Tell the user you're extending the existing company glossary; pass `fresh: true` only if they explicitly want a from-scratch rebuild.

4. **Use AskUserQuestion to settle the discrete choices in one shot**: ① scope (refine only / + logical-order rewrite / + summary / + timeline / full pipeline; multi-select); ② (optional, defaults to verifying key entities) web-verification depth; ③ whether to use the default title format `英文名（中文名）当时title`; ④ (only if pre-flight found existing sub-headings) ask “保留原小标题” vs “按内容重新生成”.
   - **Logical-order rewrite** = beyond the refined transcript, re-sequence one interview's Q&A from "recording order" into "narrative order", so scattered exchanges that belong to one thread come together into a complete story (order-preserving rewrite, verbatim, no rewriting or summarizing). One per refined transcript, opt-in.

Then **tell the user**: “接下来我自己读全文、建校对表、联网核实、逐份精校，中途不打扰你——要几分钟。少数只有读完才能确定的疑点（个别真名、某段归属、某个存疑术语）攒到最后一次性问你。” Then go autonomous.

---

## Claude Code fast path (Workflow, preferred when available)

If this session has the **Workflow tool** (Claude Code), you don't have to run Steps 1–4 by hand after Step 0: assemble the answers into args and dispatch once. Scouting, verification, the glossary, refine + ending-check, and summary/timeline all happen inside the workflow.

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

Each `files` item: `path` source file, `label` short name, `lines` line count and `bytes` byte count (from pre-flight), `title` output H1 (per the output spec), `subtitle` the second italic line, `outPath` = `<output>/Transcripts/<title>.md`, `speakerHints/notes` carry the per-file clues from Step 0. A single file < 400 lines automatically takes the "one-pass" shortcut branch.

**Return handling**: the workflow returns a result object; walk these fields.

1. **`glossary`** — `Write` it in full to `<output dir>/校对表.md` to archive. It is **cumulative** (it already incorporates any `priorGlossaryText` you passed), so writing it back simply supersedes the old file — no manual merge. Before writing, glance over the typesetting: verification sources, same-referent reasons, and other full-sentence Chinese notes should use Arabic numerals, Pangu spacing, and full-width curly quotes. Subagents mostly get this right; fix any stragglers.
2. **`failed`** — these files weren't produced. Do them by hand per Steps 1–2.
3. **`incomplete`** — the output didn't reach the ending. Dispatch a refine subagent to continue to the end.
4. **`unchecked`** — the ending-completeness check agent itself failed. Don't treat the file as passed; self-check against the source ending with `tail`.
5. **`scoutSuspect`** (non-empty) — scouting returned garbled content and was still broken after a retry, usually a network-corrupted generation stream. The outputs are unaffected (refine reads the source file), but **those files' glossary entries are untrustworthy**. Tell the user and suggest re-running scouting on those files alone once the network is stable.
6. **`headingConflicts`** — these files already had sub-headings but ran under 'none'. Fold into the Step 5 questions (keep / redo), re-running that file alone if needed.
7. **`suspectedDuplicates`** — groups written differently but suspected of being the same referent that the script did not auto-merge (e.g. 周勇 / 尹勇). Already folded into `openQuestions`; ask the user in Step 5 whether they're the same.
8. **`networkUnverified`** (non-empty) — items the verify agent **skipped via the circuit breaker, never actually verified** (as opposed to "checked but not found"). In the Step 5 batch, offer a **re-verify option** (“网络恢复了吗？要不要把这 N 项补查一遍”). On confirmation, dispatch **one** sonnet subagent to verify just those via WebSearch — same discipline: only resolved with cited evidence, never fabricate, stop on consecutive errors — and append the conclusions to a 「## 补核结论」 section at the end of `<output dir>/校对表.md`. If a re-verify **corrects a name/term spelling already used in the outputs**, tell the user and propose one targeted replacement. Names follow the same strong-name guard: when a re-verify conclusion conflicts with an output's strong name, only report it, don't silently change it.
9. **`openQuestions`** — fold into the single Step 5 batch.
10. **`logic`** (the logical-order rewrites) — already written by the workflow to `<output>/逻辑顺序/`. If any item's `missingSections` is non-empty, the per-section coverage check suspects that section was dropped from the rewrite; spot-check it and re-run that file alone if needed.
11. **`summary` / `timeline`** — already written to disk by the workflow.

Then go straight to Step 5.

Workflow not available (e.g. claude.ai) → run Steps 1–4 by hand below.

---

## Step 1 — Parallel scouting, build the unified glossary

**Why**: ASR loves to get names/brands/proper-nouns wrong, and the same person/brand often appears written several different ways across files (transliteration, English name, nicknames mixed). You have to read everything and cross-corroborate before you can fix a **unified** glossary that makes all files consistent — that's "cross-validation". **But the main agent does not read the full text itself**: per the core principle, delegate reading to subagents and the main agent receives only compressed lists.

1. **Parallel scout subagents**: use the Agent tool to spin up a lightweight subagent for **each** transcript (can run in parallel in the background). Each subagent `Read`s its own source file (**once only**), does **no web access, no refining**, and reports only a **compressed list**:
   - what speaker labels appear and who each maps to;
   - the recurring names/brands/terms and their various spellings (with a one-line locating clue, to align across files);
   - obvious transcription errors (homophones, English mishearings, `（音）`, timestamps/English garble embedded in the text).
   The raw transcript stays in the subagent's context, **never enters the main context**.
2. **Main agent merges + internally corroborates**: merge the lists; whatever can be corroborated within the transcripts (file A gives the full name, file B only the nickname) gets unified directly; flag the "residue" — the names/brands/companies/products that can't be determined internally and need public-source verification.
3. **Batch-verify the residue (dispatch a subagent)**: hand the residue list to **one verify subagent** that uses WebSearch/WebFetch to **batch**-look up public sources / news / business-registry info by "domain + name", keeping the pages in its own context and reporting back only "confirmed spelling/identity + source". By default **verify only key entities** (founders/companies/main brands), don't look up every minor term. Fix and drop the `（音）` for what's verified; keep `（音）` or `（音，存疑）` for what can't be found or is uncertain — **never fabricate**.
4. **Produce the glossary** (template in `references/glossary-template.md`): interview background, unified speaker labels, "various spellings → unified as" for names/brands/terms, transcription errors needing special handling, refinement-spec key points. `Write` it to `<output dir>/校对表.md` (archived alongside the outputs — the real-name verification conclusions are themselves research material), shared by all subsequent refining.

> If there is only one short file: no need to split scouting/refining into two stages — just dispatch one subagent to "read once → build a mini glossary → refine" in a single pass (the main agent still doesn't read the full text).

---

## Step 2 — Refine each file (parallel + spec)

The transcripts are independent of each other, so **use parallel refine subagents**, one per file: `Read` the shared glossary (`<output dir>/校对表.md`) → `Read` the source file → refine per the spec below → `Write` to `<output>/Transcripts/<title>.md` → report the sub-headings and key fixes. Each subagent's prompt must be self-contained: glossary path, source path, output path, that file's speaker mapping and special notes, the full spec below, the title format; for long files remind it to "write in multiple passes, cover to the end". When done, **spot-check**: verify the longest file's ending completeness and randomly read 1–2 sub-heading sections (**don't read a whole output back into the main context**; dispatch another subagent to check thoroughly). With only one or two files the main agent may also do it itself.

Refinement spec (apply to each file; understand the "why" rather than memorizing):
1. **Keep the dialogue form**, don't rewrite into a narrative article; preserve speaker labels as **plain text, never bold or otherwise styled** — write `张璐：`, not `**张璐：**` — and keep the style identical throughout the file.
2. **Remove verbal tics, padding words, and spoken repetition**, merge semantically repeated sentences — judged by "reads smoothly, loses no information": **don't change tone/style/meaning, don't add opinions they didn't express; when unsure keep it, better to under-delete than to delete into ambiguity.**
   - **Delete outright (pure padding, zero meaning)**: filler/hesitation sounds (嗯、呃、啊、哦、欸); confirmation echoes (对对对、是是是、嗯嗯); stalling “那个…这个…就是说…”; habitual sentence-opening “然后/其实/就是”; empty tag-question tails (对吧、是吧、对不对、你知道 — keep when genuinely seeking the other party's confirmation).
   - **Delete by meaning (keep if it carries sense, cut only the empty ones)**: “一个/一种/一些” as a throwaway measure word → cut, but keep when it means "one / the same / a specific one" (“为了让它有一个统一口感”→“为了有统一口感” cut; “跟咖啡豆拼配是一个道理” keep, = the same principle; 摆在一个角落、同一个时间、给他一个机会 keep); “其实” as a sentence-opening tic → cut, contrastive “其实” (本以为…其实…) keep; “然后” as an empty connector → cut, real sequence/causation keep; “就是” as a stall → cut, "exactly/just/is" keep; “的话” as a bare topic-marker → cut (“做手工的话”→“做手工”), real conditional (“需要的话”) keep.
   - **Mostly leave alone (usually substantive — over-cutting changes meaning)**: “我觉得/我感觉” marks the speaker's stance — deleting it reads opinion as fact, so only merge back-to-back repeats; “一点/一下” (degree / brief action), “对…来说/来讲”“包括”“比如” (framing & examples) — generally keep.
   **Collapse pure spelling-confirmation exchanges into the result**: oral spelling-out (“吴，哪个杰？”“捷报的捷——提手旁那个”“哦，口天的吴”) has no residual value in the written document — writing the correct character IS the answer. Write the **clarified spelling** directly at the name's first appearance (e.g. “吴捷”) and delete the whole spelling-out exchange. Three boundaries: ① use the **clarified** character (捷, not the first-heard 杰); ② if the exchange contains informative content (the name's origin, a joke), keep that content and only delete the mechanical confirmation; ③ if no result was clarified, keep `（音）`, don't fabricate. Such spelling clarifications are also the **strongest internal evidence** for that spelling — the glossary and the whole text unify on it.
3. **Smooth readability**: tidy broken speech, fix word-order inversions and redundant particles; **keep informative/characterful quotable lines** (e.g. “不喜欢就拉倒”“每个环节掉链子就去死”, don't flatten them).
4. **Add `##` sub-headings by topic**: accurately summarize the section, **don't distort the meaning or add conclusions not in the original**, **never number them** (self-describing phrases, no `1.`/`一、`; usually 6–20 per file). If the source file **already has (reporter/steno) sub-headings** — uncommon — **ask the user first** whether to keep them or redo by content; don't decide on your own by default.
5. **Fix transcription errors**: unify names/brands/terms strictly per the glossary; delete timestamps (e.g. `（09:02）`) and English-mishearing garble — replace with the correct Chinese/English where the meaning is recoverable, smooth it away where not, leave no garble.
6. **Keep every factual detail** (numbers/amounts/dates/product names/processes/channels/opinions) — **this is refine, not summarization**; don't cut substantive content.
7. **Standardize speaker labels**: interviewer follow-ups all go to the corresponding reporter's name; interviewee-side asides/colleague additions are labeled “同事”; group interviews with multiple speakers are labeled by identity/role (use nickname/role when unsure).
8. **File header**: first line `# 标题` (format in "Output spec"), second line an italic note, e.g. `*采访者：XXX、YYY｜时间：2021 年底*`.
9. **Chinese punctuation: quotes always full-width `“”` (inner `‘’`)** — no ASCII straight quotes `"`/`'`, no `「」`/`『』`. ASR often outputs straight quotes; convert them all to full-width curly quotes; other Chinese punctuation (，。；：？！) is full-width too. Leave ASCII quotes inside code / English proper nouns / paths.
10. **Use Arabic numerals**: convert spoken/transcribed Chinese-character numbers to Arabic numerals (“十六个部门”→“16 个部门”, “六七十 B 大模型”→“60-70B 大模型”, “三四百人”→“300-400 人”, ranges with a hyphen). **Exception — keep Chinese characters for very short colloquial small counts**: idiomatic expressions like “两个人”“三五个”“一两次”“七八年”“一两句话” need not convert. Exact counts with a measure word (16 个、3 轮、5 家) always use Arabic numerals. Don't touch idioms/set phrases (“三心二意”“五花八门”“一五一十”).
11. **One half-width space between Chinese and Latin letters/numerals** (Pangu spacing): insert a space where a Han character is adjacent to a Latin letter or Arabic numeral (“用 GPT-4 做”“16 个部门”“覆盖 80% 用户”“A 轮融资”“2021 年底”). **No space when**: ① a number is adjacent to its unit/symbol (`60-70B`、`80%`、`3.5 倍` where 倍 is a Chinese measure word so a space IS needed, `$50`、`5G`、`A4`); ② adjacent to full-width punctuation (“他说：GPT 很强。” — no extra space after the colon); ③ between English/numerals and ASCII punctuation. Don't double up spaces that are already correctly paired.

**Chunking & long files**: process one continuous topic at a time (about ≤20 Q&A), **don't break in the middle of a topic**, and stitch into one complete piece at the end. For long files (thousands of lines): first `Write` the header + opening sections, then `Edit` to **append in a relay** anchored on "the last sentence already written", in multiple passes until the end; after writing, check the ending section matches the source ending — **don't drop the second half**. **Each write should write the largest whole block that fits (a full topic section, thousands of characters), getting names/terms right on first writing per the glossary — don't go back afterward and make a pile of tiny "change-a-character" `Edit`s (each tiny edit reprocesses the whole transcript and glossary; a dozen tiny edits multiply the slowdown).**

---

## Step 2.5 — Logical-order rewrite (only when in scope)

Beyond the refined transcript, produce one **logical-order rewrite** per interview: re-sequence the Q&A from "recording order" into "narrative order", so exchanges scattered across the interview that actually belong to one thread come together and read as a complete story. **This is re-sequencing, not rewriting or summarizing** — copy Q&A blocks verbatim from the refined transcript, not a character changed, nothing dropped, only repositioned.

Parallel subagents, one per file: `Read` that **refined transcript** (not the source — names/terms are already unified) → work out this interview's main threads (3–7 narrative threads, each with an unnumbered `##` sub-heading) → pick an internal ordering for each thread (history by time; decisions by problem→insight→decision→result; a product/event by cause→process→result) → move the exchanges belonging to each thread over verbatim and arrange them. Only when moving a section breaks a reference/connective, add one `> [编者] …` bridge or fill a bare “他” with the name; **never rewrite the original wording, never add what the interviewee didn't say, never draw conclusions**. Add a `## 主线脉络（导读）` section at the top: one paragraph stating the main thread and your re-sequencing logic. **No loss, no dup**: every substantive exchange in the refined transcript appears once and only once. Structure template in `references/deliverables.md`. `Write` to `<output>/逻辑顺序/<title>.md` (**leave the refined transcript untouched** — it stays the faithful, recording-order, citable archive). When done, spot-check: does the rewrite cover all of the refined transcript's sub-headings (check against the sub-heading list, don't read the whole thing back into the main context).

---

## Step 3 — Timeline (only when in scope)

Cross-reference the interview narration with **public sources**, lay out the company's/person's development line by year/phase; tag each entry as 【访谈】/【公开】/【公开+访谈】, with a key-people reference table appended. Structure template in `references/deliverables.md`. **Web verification is likewise batched to a subagent** (look up news, business registry, funding databases by "company + funding/founding/founder"), keeping pages in the subagent's context, not the main context. When interview and public sources conflict, list both and note the divergence; don't force a pick. Write to `<output>/<主题>时间线.md`.

## Step 4 — Interview summary (only when in scope)

Based on the refined content, give ① categorized key points (by role/topic, each with a concrete fact); ② quotes (by person, faithful, only verbal tics removed, meaning unchanged); ③ industry and company/person insights (point out the angle and the risk, show judgment rather than restatement). Structure template in `references/deliverables.md`. Write to `<output>/<主题>访谈总结.md`.

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
  - Both an English name and a Chinese real name: `Allan（刘晛）CFO·合伙人`, `Joey（邢夏淳）合伙人·CEO`.
  - Only a Chinese name (no English name): `胡欢 酵色合伙人` (name + title, no parentheses).
  - Real name not found, only a nickname/English name: keep the nickname + title, e.g. `Sherrie 酵色·负责投放`, **don't fabricate a Chinese name**.
  - Group interview with multiple people: name it as `团队/角色（各花名+分工）`.
  - Keep the filename and the in-file H1 title identical.
- **Real-name verification conclusions** go in the timeline's "关键人物对照表": verified ones tagged with the real name + source, ones not found tagged “真名未公开”.

## A few easy places to trip up
- **The main agent must not read full text/web pages** — delegate source reading and web access to subagents; the main context receives only compressed conclusions (the cost lever).
- Don't build the glossary from fragments — cross-validation relies on each scout subagent reading its own full file, then merging and corroborating.
- Don't turn refining into summarizing — the factual detail is where the research value is.
- Don't force-change uncertain names — keeping `（音）` beats getting it wrong.
- Don't stop a long file halfway — relay to the end and check.
- Don't keep interrupting the user — ask once in Step 0, save piecemeal doubts for Step 5 (see "Key rhythm").
