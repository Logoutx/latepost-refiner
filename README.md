# LatePost-Refiner

把粗糙的访谈转录稿（语音转写或人工速记）整理成可读、可信、可检索的研究稿。它删口头禅、理顺口语、按主题加小标题、修语音转写弄错的人名和术语、统一发言人标注；要的话再产出逻辑重排稿、访谈总结和时间线。

一条原则贯穿始终：**精校不是改写，更不是摘要**。说话人的语气、观点、每一个事实都留着，只去噪音、修错字、补结构。

## 同一个逻辑，三个模型

| 模型 | 用哪个 | 订阅/API |
|---|---|---|
| Claude | Claude Code 技能 | 走 Claude 订阅 |
| Codex | Codex 技能 | 走 Codex 订阅 |
| DeepSeek | 命令行 或 本地网页版 | DeepSeek API（`DEEPSEEK_API_KEY`，建议再加 `TAVILY_API_KEY`） |
| 发给不写代码的人 | 单文件 App，双击即用（[安装指南](docs/install-for-non-coders.md)） | 要 DeepSeek API key，填在本机浏览器里 |

> Codex 技能首选原生订阅运行时（见 `codex-skill/latepost-refiner/SKILL.md` 的 “First Choice In Codex: Native Subscription Runtime”）：走已登录的 Codex 订阅、不要 key，用原生子代理加本地 Node 脚本（`codex-native.mjs`：确定性地按步产出 prompt，交给 Codex 子代理跑）。只有要用 DeepSeek 的 API key 执行时，才回退到命令行运行时（SKILL.md 的 “Universal Runtime Fallback”）。

## 安装

### Claude Code 技能

订阅计费，不用填 API key——由 Claude Code 的 Workflow 工具驱动，子代理跑在你自己的 Claude 会话里。质量审计、源锚点、校对表都打包在技能目录里，装好就有，不用另外配。

本仓库是源头，用符号链接挂到技能目录：

```
~/.claude/skills/latepost-refiner  ->  <repo>/claude-code-skill
```

- 新机器：`git clone` 后 `ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/latepost-refiner`。
- 不想 clone：从 [Releases](https://github.com/Logoutx/latepost-refiner/releases/latest) 下载 `latepost-refiner.zip`（或自己跑 `bash claude-code-skill/build-zips.sh` 打一个），解压到 `~/.claude/skills/` 即可。
- 改了逻辑：改 `core/*`，跑 `node build/build-cc.mjs`，下个会话生效。

### Codex 技能

走 ChatGPT 订阅，不用填 API key。核心是“确定性胶水 + Codex 子代理”：本地 Node 脚本（`codex-native.mjs`）按流水线步骤把 prompt 确定性地拼好，交给 Codex 的原生子代理去跑——脚本管流程和拼装，模型只管每一步该做的判断，长文本留在子代理里，不进主上下文。

技能目录在 `codex-skill/latepost-refiner/`，具体接入方式以你的 Codex 客户端为准；行为细节见该目录下的 `SKILL.md`。命令行 / DeepSeek 版只作为需要用 API key 执行时的回退。

### DeepSeek API（命令行 / 本地网页 / 单文件 App）

任何装了 `DEEPSEEK_API_KEY` 的机器都能跑，不依赖 Claude Code 或 Codex。模型是固定的，不能选：机械环节（侦察、核实、去重等）用 `deepseek-v4-flash`，精校成稿（精校、逻辑重排、总结、时间线）用 `deepseek-v4-pro`。

**命令行**：

```bash
npm install                          # 需要 Node.js 20+
cp .env.example .env                 # 填入 DEEPSEEK_API_KEY（建议再填 TAVILY_API_KEY）；命令行和网页都自动读
node universal/cli.js \
  --files "访谈A.txt" "访谈B.txt" \
  --topic "示例公司" --date 2025-02 \
  --scope refine,summary --verify key --out ./示例公司
```

- `DEEPSEEK_API_KEY` 必填；`TAVILY_API_KEY` 建议填——没有的话，标准/深度核实会自动降级为不联网（精校本身不受影响），也可以直接显式加 `--verify none` 跳过。
- `--out` 不填时默认写到 `~/Downloads/<主题>`。
- 校对表写到 `<out>/校对表.md`，跨批次累积；`--fresh` 从零重建。
- 每次还写 `<out>/review.md`（人工收尾清单）和 `<out>/run.json`（配置、输入哈希、产物、用量），便于交接和 resume。
- 不带参数跑会打印完整用法。

**本地网页**：不想敲命令就用 `npm run web`，浏览器里填表、看进度、取文件。服务器只绑 `127.0.0.1`，两个 key 都只存在内存里、不落盘。

docx/pptx/xlsx/pdf 自动转 md（复杂 PDF 走 docling）。换台机器第一次用，先跑一次 `bash scripts/setup-converters.sh`——幂等，只装缺的。

**单文件 App（发给别人，免装 Node）**：

```bash
npm run build:binary                       # 需先 brew install bun；产出 dist/latepost-refiner-web（约 60MB，arm64）
TARGET=bun-darwin-x64 npm run build:binary # Intel Mac
```

网页和模板都内嵌进可执行文件。对方下载后右键“打开”过一次签名拦截，浏览器访问 `http://127.0.0.1:8765`；两个 key 在网页里填，同样不落盘。docx 用内置 mammoth 解析；pptx/xlsx/pdf 仍需 markitdown（用 `scripts/setup-converters.sh` 装）。

## 跑完得到什么

一次正式产出，都在你 `--out` 指定的目录下：

- `校对表.md`——人名、品牌、术语的统一写法 + 联网核实结论
- `Transcripts/<标题>.md`——精校稿
- `逻辑顺序/<标题>.md`——逻辑重排稿（可选）
- `<主题>访谈总结.md`、`<主题>时间线.md`（可选）
- `review.md`——待人工确认、补做的收尾清单
- `run.json`——本次运行清单：配置、输入哈希、产物路径、提醒、用量

## 如何工作

精校不是把全文喂给一个大模型，而是拆成几步，每步配一个够用的模型：

| 步骤 | 做什么 | 默认模型 |
|---|---|---|
| 侦察 | 每份转录并行读一遍，抽人名、品牌、术语、发言人 | haiku |
| 合并聚类 | 纯 JS——按真名合并，“X 总”这类敬称不乱并 | 不调模型 |
| 联网核实 | 分批查公开资料，定关键人名和公司的写法 | sonnet |
| 同指去重 | 找写法不同、其实指同一个的（同音人名、口号的不同转写） | sonnet |
| 精校 | 逐份精校：删口癖、加小标题、按校对表统一写法 | opus |
| 源比对审计 | 纯 JS 比对源文与成稿：查压缩、内容缺口、结尾是否漏（完整性即由此判定，不再单跑核对代理） | 不调模型 |
| 逻辑重排（可选） | 把问答从录音顺序重排成叙事顺序，一字不改 | opus |
| 总结 / 时间线（可选） | 分类要点、金句、判断；对公开资料拉发展线 | opus |

这是默认分层，haiku/sonnet/opus 是抽象档位名，谁来跑子代理看版本：Claude Code 版直接用你会话里的 haiku/sonnet/opus；DeepSeek 版把三档固定映射到 `deepseek-v4-flash`（侦察/核实/同指去重）和 `deepseek-v4-pro`（精校/逻辑重排/总结/时间线），模型不可选；Codex 版跑在 ChatGPT 订阅上，用 GPT-5.4 系列对应档位。

## 架构

逻辑只写一遍，放在 `core/`；每个版本只加一层运行时引擎。prompt、schema、编辑规范、纯逻辑、流水线约 90% 只写一次。

```
core/                所有逻辑的唯一出处
  spec.js            schema、编辑规范、全部纯逻辑（实体聚类、合并、校对表渲染、人名保护、乱码识别……）
  prompts.js         9 个 prompt builder
  pipeline.js        runPipeline(A, engine)：流水线主体，只依赖一个 engine 接口
  meta.js            Workflow 元信息
engines/             DeepSeek 版（命令行/网页/二进制）的引擎（Claude Code 版的引擎是 Workflow 全局，见 build/bootstrap-cc.js）
  deepseek.js        DeepSeek 引擎：endpoint、模型分层（flash/pro）、忠实处理长度都写死在这一个文件里，没有可选项
  fileops.js         Read/Write/Edit 工具实现，带沙箱限制
build/build-cc.mjs   把 core 和 Claude Code 引擎打包成自包含的 workflow.js
claude-code-skill/   Claude Code 版（workflow.js 是 build 产物，别手改）
codex-skill/         Codex 版（latepost-refiner/ 下自带一份 core/ 同步副本）
universal/           命令行 + 网页 + 单文件 App（DeepSeek 版）
```

`runPipeline(A, engine)` 只依赖一个 engine 接口的 5 个原语：`agent / parallel / pipeline / phase / log`。

- **Claude Code 版**：这 5 个原语就是 Workflow 工具的全局函数。子代理跑在你的 Claude Code 会话上，不要 API key，也不碰 `engines/`。
- **DeepSeek 版**：`engines/deepseek.js` 用 DeepSeek 的 OpenAI 兼容接口实现它们，把 `Read/Write/Edit` 做成客户端工具、联网核实用 Tavily 的 `web_search`/`web_fetch`——于是 `core/` 里的 prompt 一字不改就能复用。

**为什么 Claude Code 版的脚本要“生成”**：Workflow 沙箱不许 import、不能读写文件，脚本得是单文件、只用全局函数。所以 `build-cc.mjs` 把 `core/*` 去掉 import/export、按依赖拼成一个自包含的 `workflow.js`。**改 `core/*` 后重跑 build，别手改 `workflow.js`，下次 build 会覆盖。**

**流水线**：并行侦察 → 纯 JS 合并聚类 → 分批联网核实 + 同指去重 → 汇成校对表 → 逐份精校 + 源比对审计（完整性由审计的结尾缺失门判定）→ 逻辑重排、总结、时间线（可选）。模型分层、网络熔断（连续出错即停）、人名保护（防张冠李戴）、中文排版三规范的设计，见 `core/` 注释和 `claude-code-skill/SKILL.md`。

### DeepSeek 版细节

**自动分段精校（防弱模型把长稿压成摘要）**：偏弱但便宜的模型在正常长度的访谈上没问题，但稿子一长就会开始「无声压缩」——为塞进篇幅悄悄折掉真实细节。DeepSeek 精校用的两个模型各有一个写死的「忠实处理长度」（以正文字数计，是引擎里的固定常量，不能调）：`deepseek-v4-pro`（精校成稿）→ 10000 字，`deepseek-v4-flash`（机械环节）→ 18000 字。当某份转录超过对应模型的长度，命令行/网页/二进制版会**自动**沿发言轮边界把它切成几段大小均衡的块、并行精校、再拼回，让每一段都落在忠实区间内，不丢内容。切块尽量切大（一次切太碎会打散小标题），段数不设上限。每次自动分段都会在 `review.md` 里写一行说明、在 `run.json` 的 `autoChunk` 里留结构化记录。想做分块大小实验，用 `--chunk-size <N>` 显式指定每块目标字数（块数＝ceil(全文字数/N)，覆盖上面的忠实处理长度与 speed 档的块数，N 须为 ≥2000 的整数）；不论哪种分块，都不会把一段问句切在块尾——问句和它的回答始终留在同一块。想彻底关掉一切分块（含这项自动分段），用 `--chunk off`。

**数据去向与信源保护**：DeepSeek 由中国境内公司运营，转录全文会传输至其服务器处理，受当地法规约束（含内容审查）。审查即意味着内容被服务端读取——本工具曾实测：一段敏感内容被某境内服务商的策略层**无声删除**（这正是内容缺口检测存在的原因）。涉敏感话题或需保护信源的访谈：命令行、网页、二进制版启动时都会打出这条提示；拿不准就别把这份稿子交给 DeepSeek 处理。本工具刻意**不内置敏感词清单**做内容预判——清单永远不全，且清单本身就是负担。诚实的表述是：全文都会被 DeepSeek 读到，无论内容是什么。
