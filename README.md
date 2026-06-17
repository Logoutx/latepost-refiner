# interview-transcriber

把粗糙的访谈/采访/口述 **AI 转录**精校成可读、可信、可检索的研究稿——删口癖、理顺口语、按主题加小标题、交叉校对并修正语音转写造成的人名/品牌/术语错误、统一发言人标注；并可顺带产出**逻辑顺序重排稿**、访谈总结、时间线。核心信念：**精校（refine）不是改写、更不是摘要**——保留说话人的语气、观点和全部事实细节，只去噪音、修转写错、加结构。

## 一套核心，两个 edition

逻辑只写一遍，放在 [`core/`](core/)；两个 edition 各自只加一层薄薄的「运行时引擎」。

```
core/                唯一真相来源（两 edition 共享）
  meta.js            Workflow 元信息（相位等）
  spec.js            schemas + 编辑规范 RULES/TYPESET + 全部纯逻辑
                     （聚类/合并/校对表渲染/核实分块/人名守卫/乱码检测…）
  prompts.js         9 个 prompt builder + readPlan/headingNote
  pipeline.js        runPipeline(A, engine) —— 流水线，面向一个 engine 接口
engines/
  api.js             Universal 版引擎：用 Anthropic SDK 兑现 engine 接口
                     （Claude Code 版的引擎就是 Workflow 全局，见 build/bootstrap-cc.js）
build/
  build-cc.mjs       把 core/* + Claude Code 引擎打包成自包含的 workflow.js
  bootstrap-cc.js    Claude Code 引擎（agent/parallel/… 转给 Workflow 全局）
claude-code-skill/   ★ Claude Code / claude.ai edition（部署单元）
  workflow.js        ← 由 build 生成，请勿手改
  SKILL.md           主代理指令（手写，edition 专属）
  references/        校对表 / 交付物模板
  build-zips.sh      打 claude.ai 上传用的 zip
universal/           ★ Universal edition（独立 Anthropic SDK CLI）
  cli.js             命令行壳：argv→A、docx→md 预检、调 runPipeline、处理返回
  BRIEF.md           构建任务书
```

`runPipeline(A, engine)` 只依赖一个 engine 接口的 5 个原语：`agent / parallel / pipeline / phase / log`。
- **Claude Code 版**：这 5 个就是 Workflow 工具的全局，`build/bootstrap-cc.js` 直接转交。
- **Universal 版**：`engines/api.js` 用 Anthropic SDK 兑现它们——关键技巧是把 `Read / Write / Edit` 实现成**客户端工具**（联网核实用 Anthropic 服务端 `web_search` / `web_fetch`），于是 `core/` 里「用 Read 分页读…」「Write 到…」「用 WebSearch 核实…」的 prompt 一字不改地复用。

→ prompts / schemas / 编辑规范 / 纯逻辑 / 流水线 **~90% 写一次**；每个 edition 只维护一层引擎。

## 为什么 Claude Code 版要「生成」

Workflow 工具的脚本沙箱**禁 import / fs**，只能是单文件、用其全局。所以 `build/build-cc.mjs` 把 `core/*`（ESM 模块）去掉 import/export、按依赖序拼接、保留 `export const meta` 居首，产出自包含的 `claude-code-skill/workflow.js`。

**开发循环**：改 `core/*` → `node build/build-cc.mjs` 重新生成 `workflow.js`。**不要手改 `claude-code-skill/workflow.js`**（会被下次 build 覆盖）。

## 流水线（两版同源）

并行侦察（haiku）→ JS 合并/泛称感知聚类 → 分块联网核实 + 语义同指去重（sonnet）→ 统一校对表 → 逐份精校 + 结尾完整性核对（opus + haiku）→ 逻辑顺序重排稿（opus，可选）→ 访谈总结 / 时间线（opus）。模型分层、断路器、人名强名守卫、中文排版三规范等设计见 `core/` 源码注释与 `claude-code-skill/SKILL.md`。

## claude-code-skill — 装 / 用

通过**符号链接**挂在 Claude Code 技能目录下，本仓库是源头：
```
~/.claude/skills/transcriber  ->  <repo>/claude-code-skill
```
- 新机器启用：`git clone` 后 `ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/transcriber`。
- 改逻辑：改 `core/*` → `node build/build-cc.mjs` → skill 下个会话即生效。
- 打 claude.ai 上传 zip：`bash claude-code-skill/build-zips.sh`（个人版 + 分享版，分享版自动把 Obsidian 默认路径换成通用 `~/Documents/Research/<项目名>`）。

## universal — 装 / 用

独立的命令行版，任何有 Anthropic API key 的机器都能跑，不依赖 Claude Code 的 Workflow。

```bash
npm install                              # 装 @anthropic-ai/sdk + p-limit
cp .env.example .env && 编辑填入 ANTHROPIC_API_KEY   # 或 export ANTHROPIC_API_KEY=...
node universal/cli.js \
  --files "2025-02-21_范 大咖事业群，原料研发.txt" \
  --topic "蜜雪冰城" --date 2025-02 \
  --background-file bg.txt \
  --scope refine,summary --verify key --out ./蜜雪冰城
# 或装成命令：npm link 之后直接 transcriber --files ...
```

- docx/pptx/xlsx/pdf 自动经 `markitdown` 转 md（需 `pipx install markitdown` 在 PATH）。
- 模型分层默认 scout=haiku、verify/dedup=sonnet、refine/logic/summary/timeline=opus、结尾核对=haiku；`--models scout=haiku,refine=opus` 覆盖。
- 校对表写到 `<out>/校对表.md` 并跨次累积（持久化校对表）；`--fresh` 从零重建。
- 无参数运行打印完整用法（`node universal/cli.js`）。

实现：`engines/api.js`（用 Anthropic SDK 兑现 5 原语，Read/Write/Edit 客户端工具 + 服务端 web 工具 + StructuredOutput 强制结构化）+ `universal/cli.js`（argv→A、预检、调 `runPipeline`、处理返回）。流水线/prompts/schemas/纯逻辑全部从 `core/` 复用。

## 一份正式产出长啥样

`<输出>/校对表.md`、`<输出>/Transcripts/<标题>.md`（精校稿）、`<输出>/逻辑顺序/<标题>.md`（逻辑顺序重排稿）、`<输出>/<主题>访谈总结.md`、`<输出>/<主题>时间线.md`。
