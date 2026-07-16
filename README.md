# LatePost-Refiner

为《晚点 LatePost》日常工作需求制作，把粗糙的访谈转录稿（语音转写或人工速记）整理成可读、可信、可检索的研究稿。

原则：**精校不是改写，更不是摘要**。说话人的语气、观点、每一个事实都留着，只去噪音、修错字、补结构。

- 删口头禅、理顺口语；
- 联网核实修正音转写弄错的人名、术语；
- （可选）根据逻辑重排 QA、做访谈总结、结合公开信息生成时间线。

## 同一个逻辑，三个模型

| 模型 | 用哪个 | 订阅/API |
|---|---|---|
| Claude | Claude Code 技能 | 走 Claude 订阅 |
| Codex | Codex 技能 | 走 Codex 订阅 |
| DeepSeek | 命令行 或 本地网页版 | DeepSeek API |


## 安装

最简单的就是让 Claude Code 和 Codex 直接访问项目网页安装。

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

### 单文件

```bash
npm run build:binary                       # 需先 brew install bun；产出 dist/latepost-refiner-web（约 60MB，arm64）
TARGET=bun-darwin-x64 npm run build:binary # Intel Mac
```

网页和模板都内嵌进可执行文件。下载后右键“打开”过一次签名拦截，浏览器访问 `http://127.0.0.1:8765`。docx 用内置 mammoth 解析；pptx/xlsx/pdf 仍需 markitdown（用 `scripts/setup-converters.sh` 装）。


## 如何工作

精校不是把全文喂给一个大模型，而是拆成几步，每步配一个够用的模型：

| 步骤 | 做什么 | Claude 版 | Codex 版 | DeepSeek 版 |
|---|---|---|---|---|
| 侦察 | 每份转录并行读一遍，抽取人名、品牌、术语、发言人与待核实项 | Haiku | gpt-5.6-luna（low） | deepseek-v4-flash |
| 合并聚类 | 纯 JS 按真名合并；“X 总”等敬称不与未经确认的同名对象乱并 | 不调模型 | 不调模型 | 不调模型 |
| 联网核实 | 分批查询公开资料，核实关键人名、公司、产品和术语的标准写法 | Sonnet | gpt-5.6-luna（low）检索，gpt-5.6-terra（medium）裁定 | deepseek-v4-flash，搜索走 Tavily |
| 同指去重 | 找出写法不同但实际指向同一对象的实体，例如同音人名、简称和口号的不同转写 | Sonnet | gpt-5.6-terra（medium） | deepseek-v4-flash |
| 精校 | 逐份精校：删除口癖和无意义重复、修复 ASR 噪声、增加小标题，并按校对表统一写法 | Opus | gpt-5.6-sol（high） | deepseek-v4-pro；超过 10,000 字自动分块 |
| 源比对审计 | 纯 JS 比对源文与精校稿，检查压缩、内容缺口、数字漂移和结尾遗漏；完整性由此判定 | 不调模型 | 不调模型 | 不调模型 |
| 局部修复 | 针对审计标出的重复、断句、残留噪声和局部缺口进行定点修复，不改动未标记内容 | Sonnet | gpt-5.6-terra（medium） | deepseek-v4-flash |
| 完整性重跑 | 出现压缩风险、结尾遗漏或大段内容缺失时，重新从源稿生成，最多重试 2 次 | Opus | gpt-5.6-sol（high） | deepseek-v4-pro |
| 逻辑重排（可选） | 在不改写正文的前提下，把问答从录音顺序重排为叙事顺序，并通过逐段对应审计 | Opus | gpt-5.6-sol（high） | deepseek-v4-pro |
| 总结（可选） | 从精校稿生成分类要点、核心判断和金句，不以总结替代完整精校稿 | Opus | gpt-5.6-terra（medium）；Deep 使用 gpt-5.6-sol（high） | deepseek-v4-pro |
| 时间线（可选） | 结合精校稿和公开资料，整理人物、公司、产品与事件的发展时间线 | Opus | gpt-5.6-luna（low）检索，gpt-5.6-terra（medium）整理与裁定 | deepseek-v4-pro |


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

DeepSeek 没有内置搜索，经过测试选择 TAVILY 联网核实信息、生成时间线，需要填写 TAVILY API（每月有免费额度）。

**自动分段精校（防弱模型把长稿压成摘要）**：偏弱但便宜的模型在正常长度的访谈上没问题，但稿子一长就会开始「无声压缩」——为塞进篇幅悄悄折掉真实细节。所以每个模型可以在 `engines/providers.js` 里声明一个「忠实处理长度」（以正文字数计）；当某份转录超过这个长度时，命令行/网页版会**自动**沿发言轮边界把它切成几段大小均衡的块、并行精校、再拼回，让每一段都落在该模型的忠实区间内，不丢内容。切块尽量切大（一次切太碎会打散小标题），段数不设上限。只有声明了上限的模型才受影响——默认的 Anthropic 模型在长稿上本就忠实，行为完全不变。目前只有 DeepSeek 的两个精校档声明了上限（deepseek-v4-pro → 25000 字、deepseek-v4-flash → 18000 字，均可调）。每次自动分段都会在 `review.md` 里写一行说明、在 `run.json` 的 `autoChunk` 里留结构化记录。想彻底关掉一切分块（含这项自动分段），用 `--chunk off`。

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
