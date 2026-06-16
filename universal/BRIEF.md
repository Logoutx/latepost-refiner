# Transcriber-Universal — 构建任务书

## 一句话目标

把现有的「访谈转录精校」harness 移植成一个**独立的、直接调用 Anthropic API 的 CLI**——任何人有一个 API key 就能在任意机器上跑，不依赖 Claude Code 的 Workflow 工具，也不依赖 claude.ai 上传 skill。这是该工具的**第三个 edition**：

| edition | 载体 | 依赖 |
|---|---|---|
| Claude Code 版 | `workflow.js`（Workflow 工具） | 必须在 Claude Code 里 |
| claude.ai 版 | `transcriber-share.zip`（手动 Step 1–4） | 必须上传到 claude.ai |
| **Universal 版（本项目）** | 独立 Python CLI + `anthropic` SDK | 只要 Python + `ANTHROPIC_API_KEY` |

## 蓝本在哪

`../claude-code-skill/` 就是**版本1（Claude Code skill）本身**——同一个仓库的兄弟目录（756 行 `workflow.js` + `SKILL.md` + `references/`），也是 `~/.claude/skills/transcriber` 符号链接指向的真身。**移植以它为真相来源**——所有编排逻辑、prompt、schema、纯函数、踩过的坑都在里面。先通读 `../claude-code-skill/workflow.js` 和 `../claude-code-skill/SKILL.md`。

## 技术栈

- **Python 3.12** + `anthropic` SDK（`AsyncAnthropic`）。
- 编排用 `asyncio`：`gather()` 做并行、`Semaphore` 做并发上限（对标 workflow.js 的 `parallel`/`pipeline` 与 `min(16, cores-2)` 上限）。
- 文档转 markdown：`markitdown`（已在用户机器上，见用户全局 CLAUDE.md 的转换规则）。
- 结构化输出：用 **tool-use**（`tools=[{...input_schema...}]` + `tool_choice` 强制）实现 workflow.js 里的 schema 校验。
- 联网核实：用 Anthropic 的 **server-side web search 工具**（核对当前工具名/版本——查 `claude-api` skill）；verify 与 timeline 阶段用。

> 动手前先调用 `claude-api` skill 拿准：最新 model id（Opus/Sonnet/Haiku）、tool-use 结构化输出写法、web search 工具名、定价。**别凭记忆**。

## 要移植的流水线（与 workflow.js 一一对应）

1. **预检**：docx/pdf → md；`wc -l`/`wc -c` 拿行数字节数（喂 `readPlan`）；grep 探测已有小标题。
2. **Scout（每文件一个，并行）**：`scoutPrompt` + `SCOUT_SCHEMA`，模型 **haiku**。
3. **纯逻辑合并（无模型）**：`clusterEntities` / `isWeakKey` / `stripDesc` / `mergeFindings` / `scoutLooksGarbled` —— 这些是**纯函数，照搬翻成 Python**。乱码侦察检测 + 自愈重试 + `scoutSuspect`。
4. **Verify（分块并行）**：`verifyChunks`（`VERIFY_CHUNK=12`）+ `verifyPrompt` + `VERIFY_SCHEMA`，模型 **sonnet**，带 web search 与**断路器**（连错 2 次即停）。
5. **Dedup（与 verify 并行）**：`dedupPrompt` + `DEDUP_SCHEMA` + `cleanSuspects`/`splitSuspects`，模型 **sonnet**。
6. **校对表渲染（无模型）**：`renderGlossary` + `applyVerified`（**人名强名守卫**别丢）。
7. **Refine（每文件，pipeline 并行）**：`refinePrompt` + `RULES` + `REFINE_REPORT_SCHEMA`，模型 **opus**；接 haiku **结尾完整性核对**（`checkPrompt` + `CHECK_SCHEMA`）。
8. **Logic（每文件，可选）**：`logicWritePrompt` + `LOGIC_REPORT_SCHEMA`，模型 **opus**；完整性靠**纯 JS 覆盖核对**（精校 headings vs `threads[].source_sections` 求差 → `missingSections`），不另起核对代理。
9. **Deliver**：`summaryPrompt` / `timelinePrompt`，模型 **opus**。
10. **返回处理**：把 glossary 落盘、surface `failed`/`incomplete`/`unchecked`/`scoutSuspect`/`headingConflicts`/`suspectedDuplicates`/`networkUnverified`/`logic.missingSections`/`openQuestions`（见 SKILL.md「返回处理」节）。

模型分层默认：scout=haiku，verify/dedup=sonnet，refine/logic/summary/timeline=opus，结尾核对=haiku。可 `--models` 覆盖。

## 与 Workflow 版的关键差异（这是「移植」而非「复制」的地方）

- **没有 `agent()`/`Read` 工具**：standalone 脚本里，**orchestrator 自己读文件**，把内容（按 `readPlan` 分页）放进 prompt 喂给 API——模型不再有 Read 工具。`readPlan` 的密度护栏（`READ_BYTES_PER_PAGE=45000`）仍要，避免单条 message 过长。
- **并行/并发**：`asyncio.gather` + `Semaphore` 复刻 `parallel`/`pipeline` 的「无 barrier、块间并发」。
- **结构化输出**：tool-use 强制；**但保留 workflow.js 的教训——schema 一律不设 `required`**（required 触发无上限重试；缺字段用 Python 默认值兜底）。
- **缓存/续跑**：可选实现 prompt caching（`cache_control`）省钱；resume 非必须。

## 必须保住的「踩坑教训」（别重新踩）

照搬 `../claude-code-skill/workflow.js` 顶部及各函数注释里的结论，重点：
1. **侦察固定 haiku**（升 sonnet 实测适得其反：更多变体串致错并）。
2. **schema 不设 required**（避免网络劣化下的无上限重试，bench4 曾空转 151 次）。
3. **聚类偏欠并**（只在共享强名时合并，弱称 X总/董事长 不当合并键）。
4. **verify 分块 = 12**（网络往返密集，小块并行摊薄延迟）。
5. **refine 大块写入、禁事后微改**（RULES 12/13）。
6. **人名强名守卫**（`applyVerified`：强名→不在条目内的另一强名不改写，防张冠李戴幻觉）。
7. **断路器**（verify 连错 2 次即停，已得照常返回）。
8. **中文排版三规范**（`TYPESET`：弯引号 / 阿拉伯数字 / 盘古空格）注入所有生成中文的 prompt（refine/logic/summary/timeline 都要）。
9. **逻辑顺序稿**：保序重排·原文照搬；**发言人标签照精校稿原样**（别加粗）；完整性靠 headings vs source_sections 求差。

## CLI 设想（最终定稿自行决定）

```bash
transcriber-universal \
  --files "a.docx" "b.docx" \
  --topic "Mixue" --date 2025-02 \
  --background "蜜雪集团各团队系列采访…" \
  --scope refine,logic,summary \      # refine / logic / summary / timeline 任选
  --verify key \                       # key / deep / none
  --out ./output \
  --models scout=haiku,refine=opus     # 可选覆盖
```

输出与 Workflow 版一致：`<out>/校对表.md`、`<out>/Transcripts/*.md`、`<out>/逻辑顺序/*.md`、`<out>/<主题>访谈总结.md`、`<out>/<主题>时间线.md`。

## 建议建造顺序

1. 读蓝本 + 调 `claude-api` skill 定 API 写法（model id / tool-use / web search）。
2. 搭骨架：配置、模型路由、`AsyncAnthropic` 封装（含 schema tool-use 调用 + 重试/断路器）、`readPlan` 分页喂文。
3. 纯函数移植（clusterEntities 等）+ 单测（对标 workflow.js 已有的免费单测思路）。
4. 逐相位接通：scout → merge → verify+dedup → glossary → refine+check → logic → deliver。
5. 端到端测：用 `~/Downloads/2025-02-21_范 大咖事业群，原料研发.txt` 等蜜雪源跑一份，对照 Claude Code 版的已知良好产出（在用户 Obsidian `Company Research/Mixue/`）。
6. 打包：`pyproject.toml` + README + `.env.example`（`ANTHROPIC_API_KEY`）。

## 参考

- `../claude-code-skill/`（移植蓝本，**真相来源**）。
- `claude-api` skill —— API/SDK 一切细节，动手前必查。
- `agents-sdk` skill —— 若要更高层的 agent 封装可参考。
- 用户全局 CLAUDE.md：模型分层路由、文档转 markdown 规则、中文排版三规范。
