# LatePost-Refiner

把粗糙的访谈转录稿（AI 语音转写或人工速记）整理成可读、可信、可检索的研究稿。具体做这几件事：删口头禅、理顺口语、按主题加小标题、修正语音转写弄错的人名/品牌/术语、统一发言人标注；需要的话再产出逻辑顺序重排稿、访谈总结和时间线。

一条原则贯穿始终：**精校不是改写，更不是摘要**。说话人的语气、观点和每一个事实细节都保留，只去掉噪音、修掉转写错误、补上结构。

## 一套核心，两个版本

逻辑只写一遍，放在 [`core/`](core/)；两个版本各自只加薄薄一层运行时引擎。

```
core/                所有逻辑的唯一出处（两个版本共享）
  meta.js            Workflow 元信息（阶段定义等）
  spec.js            schema、编辑规范（RULES/TYPESET）和全部纯逻辑
                     （实体聚类、合并、校对表渲染、核实分批、人名保护、乱码识别……）
  prompts.js         9 个 prompt builder + readPlan/headingNote
  pipeline.js        runPipeline(A, engine)：流水线主体，只依赖一个 engine 接口
engines/             Universal 版的引擎（Claude Code 版的引擎是 Workflow 全局，见 build/bootstrap-cc.js）
  api.js             Anthropic SDK 引擎（--provider anthropic）
  openai.js          OpenAI 兼容引擎（--provider deepseek/glm/kimi/openai）
  providers.js       OpenAI 兼容的 provider 登记表（各家 endpoint、key、差异处理、模型分层）
  fileops.js         两个引擎共用的 Read/Write/Edit 客户端工具逻辑
build/
  build-cc.mjs       把 core/* 和 Claude Code 引擎打包成自包含的 workflow.js
  bootstrap-cc.js    Claude Code 版引擎（把 agent/parallel 等原语转交给 Workflow 全局）
claude-code-skill/   ★ Claude Code / claude.ai 版（部署单元）
  workflow.js        ← 由 build 自动生成，不要手改
  SKILL.md           主代理指令（手写，本版本专属）
  references/        校对表 / 交付物模板
  build-zips.sh      打包 claude.ai 上传用的 zip
universal/           ★ Universal 版（独立的 Anthropic SDK 命令行工具）
  cli.js             命令行入口：解析 argv 成 A、docx→md 预检、调 runPipeline、处理返回值
  BRIEF.md           构建任务书
```

`runPipeline(A, engine)` 只依赖一个 engine 接口的 5 个原语：`agent / parallel / pipeline / phase / log`。
- **Claude Code 版**：这 5 个原语就是 Workflow 工具的全局函数，`build/bootstrap-cc.js` 直接转交。
- **Universal 版**：`engines/api.js` 用 Anthropic SDK 实现它们。关键做法是把 `Read / Write / Edit` 实现成**客户端工具**（联网核实则用 Anthropic 服务端的 `web_search` / `web_fetch`），于是 `core/` 里那些“用 Read 分页读……”“Write 到……”“用 WebSearch 核实……”的 prompt 一字不改就能复用。

结果：prompt、schema、编辑规范、纯逻辑、流水线**约 90% 只写一次**；每个版本只维护自己那一层引擎。

## 为什么 Claude Code 版的脚本要“生成”

Workflow 工具的脚本沙箱不允许 import、也不能读写文件，脚本必须是单文件、只用 Workflow 提供的全局函数。所以 `build/build-cc.mjs` 把 `core/*`（ESM 模块）去掉 import/export、按依赖顺序拼到一起、把 `export const meta` 放在最前面，产出自包含的 `claude-code-skill/workflow.js`。

**开发流程**：改 `core/*` → 跑 `node build/build-cc.mjs` 重新生成 `workflow.js`。**不要直接改 `claude-code-skill/workflow.js`**，下次 build 会覆盖它。

## 流水线（两版同源）

并行侦察（haiku）→ 用纯 JS 合并、聚类（能识别“X 总”“董事长”这类敬称，不把不同人并成一个）→ 分批联网核实 + 语义同指去重（sonnet）→ 汇成统一校对表 → 逐份精校 + 结尾完整性核对（opus + haiku）→ 逻辑顺序重排稿（opus，可选）→ 访谈总结、时间线（opus）。

模型分层、网络熔断（连续出错即停）、人名保护（防张冠李戴）、中文排版三规范等设计，见 `core/` 源码注释和 `claude-code-skill/SKILL.md`。

## claude-code-skill — 安装与使用

通过**符号链接**挂在 Claude Code 的技能目录下，本仓库是源头：
```
~/.claude/skills/latepost-refiner  ->  <repo>/claude-code-skill
```
- 新机器启用：`git clone` 后 `ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/latepost-refiner`。
- 改逻辑：改 `core/*` → 跑 `node build/build-cc.mjs` → 技能在下个会话即生效。
- 打包 claude.ai 上传用的 zip：`bash claude-code-skill/build-zips.sh`（同时产出个人版和分享版，分享版会自动把 Obsidian 默认路径换成通用的 `~/Documents/Research/<项目名>`）。

## universal — 安装与使用

独立的命令行版，任何装了 Anthropic API key 的机器都能跑，不依赖 Claude Code 的 Workflow。

```bash
npm install                              # 需要 Node.js 20+，会装 @anthropic-ai/sdk / openai / p-limit
cp .env.example .env && 编辑填入 ANTHROPIC_API_KEY   # 命令行版和网页版都会自动读取 .env；也可以直接 export
node universal/cli.js \
  --files "2025-02-21_范 大咖事业群，原料研发.txt" \
  --topic "蜜雪冰城" --date 2025-02 \
  --background-file bg.txt \
  --scope refine,summary --verify key --out ./蜜雪冰城
# 或装成命令：npm link 之后直接 latepost-refiner --files ...
```

- docx/pptx/xlsx/pdf 会自动经 `markitdown` 转成 md（需先 `pipx install markitdown` 并在 PATH 上）。
- 模型默认分层：scout=haiku、verify/dedup=sonnet、refine/logic/summary/timeline=opus、结尾核对=haiku；用 `--models scout=haiku,refine=opus` 覆盖。
- 校对表写到 `<out>/校对表.md`，并跨批次累积（持久化校对表）；`--fresh` 从零重建。
- 每次运行还会写 `<out>/review.md`（人工收尾清单）和 `<out>/run.json`（本次运行的配置、输入哈希、产物、提醒、用量），便于交接、追踪和后续 resume。
- 不带参数运行会打印完整用法（`node universal/cli.js`）。

### 本地网页版（双击启动，免 Apple 签名）

不想用命令行、也不想为打包成 .app 去做 Apple 签名和公证，可以直接跑本地网页版：一个只用 Node 内置模块的 localhost 服务器，打开浏览器页面就能填表、看进度、取文件。

```bash
npm run web              # 或 node universal/server.js；会打印 http://127.0.0.1:8765 并自动开浏览器
# 或在 Finder 里双击 universal/launch.command（首次会自动 npm install）
```

页面里选 provider、填 API key（**只在本机内存里用，不落盘、不外传、不记录**）、拖入转录文件、填主题和背景、勾选产出范围，点“开始精校”即可。进度实时显示，完成后列出成稿、校对表和各类提醒，一键“打开输出文件夹”。docx/pdf 会自动转换（需 markitdown）。服务器只绑 `127.0.0.1`，同一时刻只跑一个任务。网页会先套用内置的“性价比默认模型”组合；点“获取模型列表”后，localhost 服务器用你本次输入的 provider key 读取账号可用模型，再把机械/核实/精校几档自动改成更合适的默认值（仍可手动覆盖）。

### 打包成单文件 App（下载即用，免装 Node）

把网页版编译成一个自带运行时的可执行文件，发给别人下载、双击就能用——不用装 Node、不用 npm，也不用把 API key 填进任何网站（key 仍然只在本机浏览器里输入）。

```bash
npm run build:binary                          # 需先 brew install bun；产出 dist/latepost-refiner-web（约 60MB，arm64）
TARGET=bun-darwin-x64 npm run build:binary    # Intel Mac
```

`web/index.html` 和 `references/*.md` 都内嵌进可执行文件；.docx 用内置的 mammoth 解析（.pptx/.xlsx/.pdf 仍需 PATH 上有 markitdown）。

下载后首次运行，macOS 会拦一次未签名程序：右键点它选“打开”（只需一次），或在终端跑 `xattr -dr com.apple.quarantine latepost-refiner-web`。之后启动，浏览器访问 http://127.0.0.1:8765。

### 切换模型 provider

`--provider` 选底层模型来源；除 anthropic 外都是 OpenAI 兼容 API，共用同一个引擎。

| `--provider` | key 环境变量 | 默认 endpoint | 联网核实 |
|---|---|---|---|
| `anthropic`（默认） | `ANTHROPIC_API_KEY` | — | 内置服务端 web search |
| `deepseek` | `DEEPSEEK_API_KEY` | `api.deepseek.com` | 需 `TAVILY_API_KEY` |
| `glm` | `ZHIPUAI_API_KEY` / `ZAI_API_KEY` | `open.bigmodel.cn/api/paas/v4`（国际站 `--base-url https://api.z.ai/api/paas/v4`） | 自带原生搜索 |
| `kimi` | `MOONSHOT_API_KEY` | `api.moonshot.ai/v1`（国内 `--base-url https://api.moonshot.cn/v1`） | 自带原生搜索 |
| `openai` | `OPENAI_API_KEY` | `api.openai.com/v1` | 需 `TAVILY_API_KEY` |

```bash
DEEPSEEK_API_KEY=sk-... node universal/cli.js --provider deepseek \
  --files "x.txt" --topic "蜜雪冰城" --scope refine --out ./out
```

- DeepSeek / OpenAI 没有内置联网搜索：设了 `TAVILY_API_KEY` 才能让 verify/timeline 联网；不设则这两步降级（查不到的实体进 unresolved）。Anthropic / GLM / Kimi 用各自的原生搜索。**精校（refine）本来就不联网，完全不受影响。**
- 模型 ID 会变动——登记表里是 2026-06 的默认值，按需用 `--models refine=<该 provider 的模型 id>` 覆盖。各家的差异都写在 `engines/providers.js` 里、引擎已分别处理：DeepSeek 思考模式下禁用工具调用、GLM 不接受 temperature:0、Kimi 不支持强制函数调用、OpenAI 用 `max_completion_tokens` 而非 `max_tokens`。

实现分工：
- `engines/api.js`——Anthropic SDK：Read/Write/Edit 客户端工具 + 服务端 web 搜索 + 强制 StructuredOutput。
- `engines/openai.js`——OpenAI 兼容：tool_calls 循环 + 客户端 web_search/web_fetch + 两种结构化输出（强制函数调用，或 json 兜底）。
- `engines/providers.js`——provider 登记表。
- `engines/fileops.js`——两个引擎共用的 Read/Write/Edit，并按“源文件 / skillDir / 输出目录”做沙箱限制。
- `universal/cli.js`——解析 argv 成 A、预检、用 `--provider` 选引擎、调 `runPipeline`、处理返回值。

流水线、prompt、schema、纯逻辑全部从 `core/` 复用。

## 一次正式产出有哪些文件

`<输出>/校对表.md`、`<输出>/Transcripts/<标题>.md`（精校稿）、`<输出>/逻辑顺序/<标题>.md`（逻辑顺序重排稿）、`<输出>/<主题>访谈总结.md`、`<输出>/<主题>时间线.md`、`<输出>/review.md`（待人工确认/补做的收尾清单）、`<输出>/run.json`（运行清单：配置、输入文件哈希、产物路径、提醒、用量）。
