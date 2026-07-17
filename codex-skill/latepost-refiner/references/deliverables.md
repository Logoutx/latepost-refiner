# Deliverables

Read this when the user requests logical-order rewrite, timeline, or summary.

## Logical-Order Rewrite

Path:

```text
<out>/逻辑顺序/<标题>.md
```

Purpose: reorder one refined interview from recording order into narrative order. This is re-sequencing, not rewriting. Move whole Q&A blocks verbatim from the refined transcript.

Structure:

```markdown
# <标题> · 逻辑顺序稿
*基于精校稿重排为叙事顺序，内容照搬未改，仅调顺序 + 少量 [编者] 衔接；原顺序见 Transcripts/<标题>.md*

## 主线脉络（导读）
<一段话说明主线和重排逻辑>

## <线索小标题>
*〔取自精校稿：<小标题1>、<小标题2>〕*
记者：<照搬原文>
受访者：<照搬原文>
> [编者] <仅在移动打断指代/承接时加一句>
```

Rules:
- Use 3-7 narrative threads.
- Do not number headings.
- Preserve speaker-label style.
- Add `[编者]` bridges sparingly and clearly.
- No substantive exchange may be lost or duplicated.
- Check coverage against the refined transcript's headings.

## Timeline

Path:

```text
<out>/<主题>时间线.md
```

Purpose: align interview narration with public sources and mark source confidence.

Structure:

```markdown
# <主题> 时间线

> 整理依据：<时间><对象>访谈，结合公开资料交叉校对。
> 标注：【访谈】=访谈口述；【公开·待记者核实】=公开资料、须记者复核；【公开+访谈·待记者核实】=两者互证（公开部分仍待核）。每个数字/金额/规格都必须带其中一个标注。

## 一句话背景

## 时间线
### <年份/阶段>：<小标题>
- **<年月>**【访谈｜公开·待记者核实｜公开+访谈·待记者核实】<事件，含具体数字/人物/金额>〔出处：成稿标题 · 小标题〕

## <采访之后>（公开资料补充）

## 关键人物对照表（含公开资料核实的真名）
| 访谈中称呼 | 真实姓名 | 角色（采访时） | 背景 / 公开信息 |
|---|---|---|---|
```

Rules:
- Search by company/person + founding/funding/founder/product/event.
- If interview and public sources conflict, list both and note the divergence.
- Do not force a resolution without evidence.
- Mark not-found real names as `真名未公开`.
- Source-label EVERY figure. Red line: a figure tagged 【访谈】 must actually appear in the refined 成稿 — never tag a public-source, industry-common, or self-computed/converted number as 【访谈】; when unsure, tag 【公开·待记者核实】. The deterministic audit compares every 访谈-tagged magnitude figure against the 成稿 and hard-fails a fabricated one.

## Interview Summary

Path:

```text
<out>/<主题>访谈总结.md
```

Purpose: produce reusable research notes based on the refined transcript set.

Structure:

```markdown
# <主题> 访谈总结

> 基于 <时间> 对 <对象> 的访谈。

## 分类要点
### <主题分类>
- <要点，带具体事实；数字/金额标来源——【访谈】须出自成稿原文，公开资料标【公开·待记者核实】>

## 金句 Quotes
**<人名（职务）>**
- “<忠实引用，只清口癖，不改原意>”〔出处：成稿标题 · 小标题〕

## 行业与公司/人物洞察
### 关于行业
- （待补充）
### 关于这家公司 / 这个人
- （待补充）
```

Rules:
- Categorize by role/topic.
- Every key point should carry a concrete fact where possible.
- Source-label every figure: 【访谈】 (must come from the refined 成稿) or 【公开·待记者核实】 (public, reporter to verify). Never pass a public or self-computed number off as 【访谈】 — the deterministic audit checks each 访谈-tagged figure against the 成稿.
- Quotes must be faithful to the refined transcript.
- Insights should show judgment, angle, and risk; do not merely restate the transcript.
