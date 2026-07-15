# LatePost-Refiner

把粗糙的访谈转录稿（语音转写或人工速记）整理成可读、可信、可检索的研究稿。它删口头禅、理顺口语、按主题加小标题、修语音转写弄错的人名和术语、统一发言人标注；要的话再产出逻辑重排稿、访谈总结和时间线。

一条原则贯穿始终：**精校不是改写，更不是摘要**。说话人的语气、观点、每一个事实都留着，只去噪音、修错字、补结构。

## 同一个逻辑，三个模型

| 模型 | 用哪个 | 订阅/API |
|---|---|---|
| Claude | Claude Code 技能 | 走 Claude 订阅 |
| Codex | Codex 技能 | 走 Codex 订阅 |
| DeepSeek | 命令行 或 本地网页版 | DeepSeek API |
| 发给不写代码的人 | 单文件 App，双击即用 | 要，填在本机浏览器里 |

> Codex 技能首选原生订阅运行时（见 `codex-skills/latepost-refiner/SKILL.md` 的 “First Choice In Codex: Native Subscription Runtime”）：走已登录的 Codex 订阅、不要 key，用原生子代理加本地 Node 脚本（`codex-native.mjs`：确定性地按步产出 prompt，交给 Codex 子代理跑）。只有在要用 Anthropic / DeepSeek / GLM / Kimi / OpenAI 的 API key 执行时，才回退到命令行运行时（SKILL.md 的 “Universal Runtime Fallback”），那时填对应的 key。

## 安装

### Claude Code 技能

本仓库是源头，用符号链接挂到技能目录：

```
~/.claude/skills/latepost-refiner  ->  <repo>/claude-code-skill
```

- 新机器：`git clone` 后 `ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/latepost-refiner`。
- 不想 clone：从 [Releases](https://github.com/Logoutx/latepost-refiner/releases/latest) 下载 `latepost-refiner.zip`（或自己跑 `bash claude-code-skill/build-zips.sh` 打一个），解压到 `~/.claude/skills/` 即可。
- 改了逻辑：改 `core/*`，跑 `node build/build-cc.mjs`，下个会话生效。

### 命令行 / 本地网页版

任何装了 API key 的机器都能跑，不依赖 Claude Code。

```bash
npm install                          # 需要 Node.js 20+
cp .env.example .env                 # 填入 ANTHROPIC_API_KEY；命令行和网页都自动读
node universal/cli.js \
  --files "访谈A.txt" "访谈B.txt" \
  --topic "示例公司" --date 2025-02 \
  --scope refine,summary --verify key --out ./示例公司
```

- 不想敲命令：`npm run web`，浏览器里填表、看进度、取文件。服务器只绑 `127.0.0.1`，key 只在内存里、不落盘。
- docx/pptx/xlsx/pdf 自动转 md（复杂 PDF 走 docling）。换台机器第一次用，先跑一次 `bash scripts/setup-converters.sh`——幂等，只装缺的。
- 每次都要用 `--out` 指定输出目录，不再默认。
- 校对表写到 `<out>/校对表.md`，跨批次累积；`--fresh` 从零重建。
- 每次还写 `<out>/review.md`（人工收尾清单）和 `<out>/run.json`（配置、输入哈希、产物、用量），便于交接和 resume。
- 不带参数跑会打印完整用法。

### 单文件 App（发给别人，免装 Node）

```bash
npm run build:binary                       # 需先 brew install bun；产出 dist/latepost-refiner-web（约 60MB，arm64）
TARGET=bun-darwin-x64 npm run build:binary # Intel Mac
```

网页和模板都内嵌进可执行文件。对方下载后右键“打开”过一次签名拦截，浏览器访问 `http://127.0.0.1:8765`。docx 用内置 mammoth 解析；pptx/xlsx/pdf 仍需 markitdown（用 `scripts/setup-converters.sh` 装）。

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

这是默认分层。谁来跑这些子代理，看版本：Claude 版跑在你的 Claude 会话上，用 haiku/sonnet/opus；命令行和网页版按 provider 把这三档映射到对应模型；Codex 版跑在 ChatGPT 订阅上，用 OpenAI 对应档。三档都能用 `--models scout=haiku,refine=opus` 覆盖。

## 架构

逻辑只写一遍，放在 `core/`；每个版本只加一层运行时引擎。prompt、schema、编辑规范、纯逻辑、流水线约 90% 只写一次。

```
core/                所有逻辑的唯一出处
  spec.js            schema、编辑规范、全部纯逻辑（实体聚类、合并、校对表渲染、人名保护、乱码识别……）
  prompts.js         9 个 prompt builder
  pipeline.js        runPipeline(A, engine)：流水线主体，只依赖一个 engine 接口
  meta.js            Workflow 元信息
engines/             命令行版的引擎（Claude Code 版的引擎是 Workflow 全局，见 build/bootstrap-cc.js）
  api.js             Anthropic SDK 引擎
  openai.js          OpenAI 兼容引擎（DeepSeek / GLM / Kimi / OpenAI 共用）
  providers.js       各家 provider 的 endpoint、key、差异、模型分层
  fileops.js         两引擎共用的 Read/Write/Edit，带沙箱限制
build/build-cc.mjs   把 core 和 Claude Code 引擎打包成自包含的 workflow.js
claude-code-skill/   Claude Code 版（workflow.js 是 build 产物，别手改）
universal/           命令行 + 网页 + 单文件 App
```

`runPipeline(A, engine)` 只依赖一个 engine 接口的 5 个原语：`agent / parallel / pipeline / phase / log`。

- **Claude Code 版**：这 5 个原语就是 Workflow 工具的全局函数。子代理跑在你的 Claude Code 会话上，不要 API key，也不碰 `engines/`。
- **命令行版**：`engines/api.js` 用 Anthropic SDK 实现它们，把 `Read/Write/Edit` 做成客户端工具、联网核实用 Anthropic 服务端的 `web_search`——于是 `core/` 里的 prompt 一字不改就能复用。

**为什么 Claude Code 版的脚本要“生成”**：Workflow 沙箱不许 import、不能读写文件，脚本得是单文件、只用全局函数。所以 `build-cc.mjs` 把 `core/*` 去掉 import/export、按依赖拼成一个自包含的 `workflow.js`。**改 `core/*` 后重跑 build，别手改 `workflow.js`，下次 build 会覆盖。**

**流水线**：并行侦察 → 纯 JS 合并聚类 → 分批联网核实 + 同指去重 → 汇成校对表 → 逐份精校 + 源比对审计（完整性由审计的结尾缺失门判定）→ 逻辑重排、总结、时间线（可选）。模型分层、网络熔断（连续出错即停）、人名保护（防张冠李戴）、中文排版三规范的设计，见 `core/` 注释和 `claude-code-skill/SKILL.md`。

### 切换 provider（命令行版）

`--provider` 选模型来源；除 anthropic 外都是 OpenAI 兼容 API，共用一个引擎。

| `--provider` | key 环境变量 | 默认 endpoint | 联网核实 |
|---|---|---|---|
| `anthropic`（默认） | `ANTHROPIC_API_KEY` | — | 内置服务端搜索 |
| `deepseek` | `DEEPSEEK_API_KEY` | `api.deepseek.com` | 需 `TAVILY_API_KEY` |
| `glm` | `ZHIPUAI_API_KEY` / `ZAI_API_KEY` | `open.bigmodel.cn/api/paas/v4`（国际站 `--base-url https://api.z.ai/api/paas/v4`） | 自带搜索 |
| `kimi` | `MOONSHOT_API_KEY` | `api.moonshot.ai/v1`（国内 `--base-url https://api.moonshot.cn/v1`） | 自带搜索 |
| `openai` | `OPENAI_API_KEY` | `api.openai.com/v1` | 需 `TAVILY_API_KEY` |

DeepSeek 和 OpenAI 没有内置搜索：设了 `TAVILY_API_KEY` 才能让标准/深度核实和时间线联网。核实结论会在精校前进入校对表，用来校正人名、公司、产品、日期和疑似 ASR 错词；不设 Tavily 时精校仍会运行，但少用联网校正。

模型特点——DeepSeek 思考模式禁工具调用、GLM 不收 `temperature:0`、Kimi 不支持强制函数调用、OpenAI 用 `max_completion_tokens`——都在 `engines/providers.js` 里处理。

**自动分段精校（防弱模型把长稿压成摘要）**：偏弱但便宜的模型在正常长度的访谈上没问题，但稿子一长就会开始「无声压缩」——为塞进篇幅悄悄折掉真实细节。所以每个模型可以在 `engines/providers.js` 里声明一个「忠实处理长度」（以正文字数计）；当某份转录超过这个长度时，命令行/网页版会**自动**沿发言轮边界把它切成几段大小均衡的块、并行精校、再拼回，让每一段都落在该模型的忠实区间内，不丢内容。切块尽量切大（一次切太碎会打散小标题），段数不设上限。只有声明了上限的模型才受影响——默认的 Anthropic 模型在长稿上本就忠实，行为完全不变。目前只有 DeepSeek 的两个精校档声明了上限（`deepseek-v4-pro` → 25000 字、`deepseek-v4-flash` → 18000 字，均可调）。每次自动分段都会在 `review.md` 里写一行说明、在 `run.json` 的 `autoChunk` 里留结构化记录。想彻底关掉一切分块（含这项自动分段），用 `--chunk off`。

### 便宜档优先 + 升级重跑（`--escalate`，可选）

常规访谈用便宜 provider 精校，靠现有的确定性审计门禁（charRatio 压缩、内容缺口、结尾缺失、引号等）逐份判决；**未过审的文件自动用高档 provider 从源文件重跑精校、再复审**。质量由门禁保证，不靠对某个 provider 的信任。

```sh
node universal/cli.js --files 访谈.md --topic 试跑 \
  --provider deepseek --escalate anthropic --verify none
```

- `--provider` 是第一遍（便宜）档；`--escalate <名>` 指定高档 provider。给了 `--escalate` 才启用；不给则与既有行为逐字节等价。
- `--escalate-base-url` / `--escalate-models`（如 `refine=claude-opus-4-8`）覆盖高档 provider 的 endpoint / 模型（只用 refine 档）。
- 结果落盘：`review.md` 有「升级重跑」小节逐份说明（首档失败项 → 升级是否过审）；`run.json` 的 `escalation` 块记录每份的便宜档审计、高档审计、保留了哪一档；两档都没过的文件会**显式标注「两档均未过审」**并保留过审项更少的那一档（持平取高档）。
- 退出码反映**最终**状态：若升级后不再有 hard 内容门禁失败（内容缺口/引号），即退出 0。
- 重跑**只从原始源文件**做，绝不拿可能被压缩的便宜档成稿去“恢复”细节。
- ⚠ **信源提醒**：升级会把**源文件原文**也发送给高档 provider。所以两个 provider 都要有意识地选——尤其当便宜档或高档任一为境内运营方时（见下一节）。本工具不做“敏感话题自动识别”（那是不可靠的承诺），用不用升级由你判断。

（v1 仅命令行支持；网页版参数通道已能透传 `escalate` 对象，但界面暂无对应字段。）

### 精校模式：agentic（默认）与 single-shot

- **agentic（默认）**：精校子代理用 Read/Write/Edit 工具循环，边读边写、可分块并行——大文件、要最稳的场景用它。
- **single-shot**（`--refine-mode single-shot`）：每份文件**只发一个请求**——把源文整篇塞进 prompt，模型一次返回成稿，脚本落盘。更省更快，适合归档批量。**仅限 ≤45000 字**的文件（响应封顶，再大会截断），超限会被拒并提示改用 agentic。single-shot 历史上的坑是「无声压缩成摘要」，所以精校后**确定性源比对审计门禁照跑**——兜住这个失败。仅 opus/sonnet/fable，且宿主有 fs 时可用（Claude Code 沙箱无 fs，会自动回退 agentic）。

### 批处理归档精校（Anthropic Batch API，5 折价格）

给「没人等、纯归档」的大批量转录用：`scripts/batch_refine.mjs`，两步（因为批处理是异步、可断点续跑的）。**Batch 价格是即时接口的 50%，结果通常 1 小时内就绪。**

```sh
# 1) 提交：现在跑侦察/核实/校对表（即时计费），把 refine 投成批处理后退出
ANTHROPIC_API_KEY=... node scripts/batch_refine.mjs submit \
  --files a.txt b.txt c.txt --topic 某公司 --out ~/Downloads/某公司 \
  --background "背景…" [--effort refine=medium]
#   → 打印 batchId，写 <out>/batch-state.json；--dry-run 仍跑侦察/核实、但只打印请求负载、不投批处理

# 2) 续跑：读状态、轮询到结束、取回结果、写成稿、跑完整审计门禁 + 源锚点 + review.md/run.json
ANTHROPIC_API_KEY=... node scripts/batch_refine.mjs resume --dir ~/Downloads/某公司 \
  [--max-wait-min 90 --poll-sec 30]
#   → resume 幂等：批处理没结束就再等，某份出错就留着不精校、列进 review.md，可对该份改用 agentic 重跑
```

**成本估算**：Batch 把 refine 的输入/输出/思考 token 全部按 5 折计费；侦察/核实在 submit 阶段仍走即时接口（正常价，但这部分本来就便宜）。一份 2 小时访谈（约 20-40K 字）单请求精校的 refine 输出约 40-80K token，Batch 折后通常几毛到一两块钱人民币一份；批量越大越划算。审计是本地确定性脚本，零模型成本。

### 推理力度（effort，M12）

`--effort refine=medium` 给精校/交付调**推理力度**（`output_config.effort`：low|medium|high|xhigh|max，默认 high）。仅 `refine/logic/summary/timeline` 生效、仅 opus/sonnet/fable 支持（haiku 会报错，自动跳过）。要不要把默认降到 medium，先按 `eval/effort-experiment.md` 的两臂实验跑分定夺——金标通过率 100%、filler 指标不退、真稿抽查无新硬门禁，才采纳。


### 数据去向与信源保护

选 provider 就是选**转录全文发给谁**。这对访谈工具不是普通的隐私条款问题：转录里常有信源身份、未公开信息、offrecord 闲聊。

- DeepSeek、GLM（智谱）、Kimi（Moonshot）由**中国境内公司运营**：全文将传输至其服务器处理，受当地法规约束（含内容审查）。审查即意味着内容被服务端读取——本工具曾实测：一段敏感内容被某境内服务商的策略层**无声删除**（这正是内容缺口检测存在的原因）。改用海外 endpoint（z.ai、moonshot.ai）不改变运营方。
- Anthropic、OpenAI 由美国公司运营，同样是把全文交给第三方——只是司法辖区与审查机制不同。
- 涉敏感话题或需保护信源的访谈：命令行与网页版会在选中境内服务商时显示提示；拿不准就别把这份稿子交给该服务商。
- 本工具刻意**不内置敏感词清单**做内容预判——清单永远不全，且清单本身就是负担。诚实的表述是：全文都会被所选运营方读到，无论内容是什么。
- 用 `--escalate` 时要多想一层：**源文件原文会同时发给便宜档和升级档两个 provider**。若其一是境内运营方，全文就经过了那一方。请对两个 provider 都做同样的辖区判断——升级不改变“全文交给谁”的性质，只是多交给了一方。
