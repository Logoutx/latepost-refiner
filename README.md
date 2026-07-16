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

最简单的就是把仓库地址发给 Claude Code / Codex，说“安装这个技能”。手动方式如下。

**Claude Code 技能**（走订阅，不用 key）
git clone 后：`ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/latepost-refiner`
不想 clone：下载 [Releases](…) 的 zip 解压到 `~/.claude/skills/`。

**Codex 技能**（走 ChatGPT 订阅）：技能目录 `codex-skills/latepost-refiner/`，接入方式见其 SKILL.md。

**DeepSeek 版·命令行 / 本地网页**（要 `DEEPSEEK_API_KEY`，建议加 `TAVILY_API_KEY`）
npm install；cp .env.example .env 填 key；`node universal/cli.js --files … --topic …` 或 `npm run web`。
docx/pdf 自动转格式；新机器先跑一次 `bash scripts/setup-converters.sh`。

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

## 数据去向与信源保护

选 provider 就是选转录全文发给谁。

- DeepSeek、GLM（智谱）、Kimi（Moonshot）由中国境内公司运营：全文将传输至其服务器处理，受当地法规约束（含内容审查）。审查即意味着内容被服务端读取——本工具曾实测：一段敏感内容被某境内服务商的策略层无声删除（这正是内容缺口检测存在的原因）。改用海外 endpoint（z.ai、moonshot.ai）不改变运营方。
- Anthropic、OpenAI 由美国公司运营，同样是把全文交给第三方——只是司法辖区与审查机制不同。
