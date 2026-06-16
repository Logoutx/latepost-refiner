# interview-transcriber

把粗糙的访谈/采访/口述 **AI 转录**精校成可读、可信、可检索的研究稿——删口癖、理顺口语、按主题加小标题、交叉校对并修正语音转写造成的人名/品牌/术语错误、统一发言人标注；并可顺带产出**逻辑顺序重排稿**、访谈总结、时间线。核心信念：**精校（refine）不是改写、更不是摘要**——保留说话人的语气、观点和全部事实细节，只去噪音、修转写错、加结构。

本仓库收两个 edition：

| 目录 | edition | 载体 | 依赖 |
|---|---|---|---|
| [`claude-code-skill/`](claude-code-skill/) | **Claude Code 版** | 一个 skill（`SKILL.md` + `workflow.js` 编排 + `references/`） | 在 Claude Code 里跑（用 Workflow 工具并行编排）；同一个 skill 也可打包上传 claude.ai 手动跑 |
| [`universal/`](universal/) | **Universal 版** | 独立 Anthropic SDK 的 Python CLI（**待建**，见 `universal/BRIEF.md`） | 只要 Python + `ANTHROPIC_API_KEY`，任意机器可跑 |

## 流水线（两版同源）

并行侦察（haiku）→ JS 合并/泛称感知聚类 → 分块联网核实 + 语义同指去重（sonnet）→ 统一校对表 → 逐份精校 + 结尾完整性核对（opus + haiku）→ 逻辑顺序重排稿（opus，可选）→ 访谈总结 / 时间线（opus）。模型分层、断路器、人名强名守卫、中文排版三规范等设计细节见各版源码注释与 `claude-code-skill/SKILL.md`。

## claude-code-skill — 怎么装/怎么用

这份 skill 通过**符号链接**挂在 Claude Code 的技能目录下，本仓库是它的源头：

```
~/.claude/skills/transcriber  ->  <this repo>/claude-code-skill
```

- 改了 `claude-code-skill/` 里的文件，Claude Code 下个会话即生效（链接同一份真身）。
- 在新机器上启用：把本仓库 clone 下来，建同名符号链接即可：
  ```bash
  ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/transcriber
  ```
- 打 claude.ai 上传用的 zip（个人版 + 分享版）：
  ```bash
  claude-code-skill/build-zips.sh        # → ~/Downloads/transcriber.zip / transcriber-share.zip
  ```
  分享版会把 Obsidian 专属默认输出路径换成通用的 `~/Documents/Research/<项目名>`。

## universal — 现状

仅有 `BRIEF.md`（完整构建任务书），**代码待建**。它把 `claude-code-skill/` 的全部逻辑移植成独立调用 Anthropic API 的 Python CLI（orchestrator 自己读文件喂 prompt、asyncio 并行、tool-use 做结构化输出、server-side web search 做核实）。从 `universal/BRIEF.md` 起手。

## 一份正式产出长啥样

`<输出>/校对表.md`、`<输出>/Transcripts/<标题>.md`（精校稿）、`<输出>/逻辑顺序/<标题>.md`（逻辑顺序重排稿）、`<输出>/<主题>访谈总结.md`、`<输出>/<主题>时间线.md`。
