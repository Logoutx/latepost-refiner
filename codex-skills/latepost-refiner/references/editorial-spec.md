# Editorial Spec

Use this reference when manually refining transcripts or reviewing runtime output.

## Core Rule

Refine, do not summarize. Preserve the speaker's facts, opinions, chronology, tone, and useful quotes. Remove noise and fix transcription errors without adding conclusions.

## Dialogue And Speakers

- Keep dialogue form.
- Speaker labels are plain text, not bold: `张璐：`.
- Normalize interviewer labels to the reporter/host name.
- Normalize interviewee-side asides from unnamed colleagues as `同事：`.
- For group interviews, use names when known; otherwise use role/nickname consistently.

## Remove Noise

Delete pure filler:
- 嗯、呃、啊、哦、欸
- 对对对、是是是、嗯嗯 when only confirmation noise
- empty openings like 那个、这个、就是说、然后、其实 when they carry no meaning
- empty tag tails like 对吧、是吧、对不对 when not truly asking for confirmation

Delete by meaning, not mechanically:
- Cut empty `一个/一种/一些`; keep when it means a specific one or "same principle".
- Cut empty opening `其实`; keep contrastive `其实`.
- Cut empty `然后`; keep real sequence/causation.
- Cut stalling `就是`; keep "exactly/just/is".
- Cut bare topic-marker `的话`; keep real conditionals.

Usually keep:
- `我觉得/我感觉` because it marks stance.
- `一点/一下`, `对…来说/来讲`, `包括`, `比如` when substantive.

Collapse spelling-confirmation exchanges into the corrected spelling. If the conversation clarified `吴捷`, write `吴捷` and remove the mechanical spelling exchange. If it did not clarify the name, keep `（音）`.

## Structure

- Add topic-based `##` headings.
- Do not number headings.
- Make headings descriptive but not interpretive beyond the text.
- If source already has meaningful reporter/steno headings, ask whether to keep or regenerate unless the user already decided.

## Names, Brands, Terms

- Follow `校对表.md` strictly.
- Use internal corroboration plus public sources for key entities.
- Do not fabricate uncertain names.
- Keep `（音）` or `（音，存疑）` where evidence is insufficient.
- If public evidence conflicts with a strong internal spelling clarification, report the conflict instead of silently changing the output.

## Facts

Keep all substantive details:
- numbers, amounts, dates, chronology
- product names, processes, suppliers, channels
- business model, organizational details, roles
- opinions and reasoning
- colorful quotes with research value

## Cleanup

- Delete timestamps like `（09:02）`.
- Remove unrecoverable ASR garbage.
- Replace recoverable English/brand/technical garble with the correct term.
- Keep no raw `English 34:47`-style remnants.

## Header

First line:

```markdown
# <标题>
```

Second line:

```markdown
*采访者：<names>｜时间：<date/context>*
```

Keep filename and H1 identical where practical.

## Chinese Typesetting

- Use full-width Chinese punctuation.
- Use quotes `“”` and inner quotes `‘’`; avoid ASCII straight quotes and `「」`.
- Convert exact Chinese-character numbers to Arabic numerals: `十六个部门` -> `16 个部门`; `三四百人` -> `300-400 人`.
- Keep idiomatic small colloquial counts when conversion would look unnatural: `两个人`, `一两句话`, `三五个`.
- Add one half-width space between Chinese and Latin/numbers: `用 GPT-4 做`, `16 个部门`, `2021 年底`.
- Do not add spaces inside units/symbols like `80%`, `$50`, `5G`, `A4`.

## Long Files

- Work in coherent topic blocks, usually no more than about 20 Q&A exchanges at a time.
- Do not stop mid-topic.
- Write large blocks correctly on first pass instead of many tiny edits.
- Verify the output ending matches the source ending.
