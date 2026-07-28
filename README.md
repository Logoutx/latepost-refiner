# LatePost-Refiner

为《晚点 LatePost》日常工作需求制作，把粗糙的访谈转录稿（语音转写或人工速记）整理成可读、可信、可检索的研究稿。

原则：**精校不是改写，更不是摘要**。说话人的语气、观点、每一个事实都留着，只去噪音、修错字、补结构。

- 删口头禅、理顺口语；
- 联网核实修正音转写弄错的人名、术语；
- （可选）根据逻辑重排 QA、做访谈总结、结合公开信息生成时间线。

## 仓库与协作

`latepost-team/latepost-refiner` 是公司内部唯一权威仓库，设为 private。**禁止直接在 `main` 上 commit、push，或绕过 pull request 把改动 merge 进 `main`。**每项修改都从最新 `main` 新建分支，经过 PR、CI 和至少一位团队成员审阅后，再通过 PR 合并。公司当前 GitHub 方案无法为 private repo 强制 branch protection；这是平台限制，不代表可以跳过上述流程。

仓库不再自动跟踪或同步其他公开、个人仓库。需要吸收外部改动时，先审阅并以独立 PR 引入。真实转录稿、运行日志、API key 和私有评测结果不得提交。

### 生产支持边界

公司 mac mini 上的 `lark-refine-bot` **目前只支持 Universal 运行时**，即本仓库 `universal/` 的 DeepSeek + Serper/Jina 路径。Claude Code 与 Codex 技能仍是本仓库支持的本地/人工运行接口，但不是 mac mini 的生产后端，也不是生产故障时可直接启用的 fallback。

生产机器人不会自动跟随 refiner `main`：`lark-refine-bot` 通过 git submodule 固定到一个已验收 commit，只有在 bot 仓库显式更新 gitlink、完成集成测试与 canary，并在空闲窗口部署后，生产版本才会变化。若未来要让 mac mini 支持其他运行时，必须先单独修改并验收 bot 路由、凭证、安全和部署契约，不能只改配置或因为仓库里存在相应 skill 就视为已支持。

## 同一个逻辑，三个模型

| 模型 | 用哪个 | 订阅/API |
|---|---|---|
| Claude | Claude Code 技能 | 走 Claude 订阅 |
| Codex | Codex 技能 | 走 Codex 订阅 |
| DeepSeek | 命令行 或 本地网页版 | DeepSeek API（`DEEPSEEK_API_KEY` 必填，建议再加 `SERPER_API_KEY`；`JINA_API_KEY` 可选） |

## 安装

公司成员先取得 private repo 权限，再克隆并安装锁定依赖：

```bash
git clone https://github.com/latepost-team/latepost-refiner.git
cd latepost-refiner
npm ci
```

各运行方式：

**Claude Code 技能**
git clone 后：`ln -s "$(pwd)/claude-code-skill" ~/.claude/skills/latepost-refiner`

**Codex 技能**
技能目录 `codex-skill/latepost-refiner/`，接入方式见其 SKILL.md。

**DeepSeek 版·命令行 / 本地网页（源码跑，需 Node 20+）**
`cp .env.example .env` 填 key；`node universal/cli.js --files … --topic …` 或 `npm run web`。
docx/pdf 自动转格式；新机器先跑一次 `bash scripts/setup-converters.sh`。

## 如何工作

精校不是把全文喂给一个大模型，而是拆成几步，每步配一个够用的模型：

| 步骤 | 做什么 | Claude 版 | Codex 版 | DeepSeek 版 |
|---|---|---|---|---|
| 侦察 | 每份转录并行读一遍，抽取人名、品牌、术语、发言人与待核实项 | Haiku | gpt-5.4-mini（low） | deepseek-v4-flash |
| 合并聚类 | 纯 JS 按真名合并；“X 总”等敬称不与未经确认的同名对象乱并 | 不调模型 | 不调模型 | 不调模型 |
| 联网核实 | 分批查询公开资料，核实关键人名、公司、产品和术语的标准写法；中文人名必须有来源直接显示目标汉字，英文名/拼音只能证明身份、不能反推正字 | Sonnet | gpt-5.4（medium） | deepseek-v4-flash；Serper 搜索，Jina Reader 提取正文，失败后本地安全抓取 |
| 同指去重 | 找出写法不同但实际指向同一对象的实体，例如同音人名、简称和口号的不同转写 | Sonnet | gpt-5.4（medium） | deepseek-v4-flash |
| 精校 | 逐份精校：删除口癖和无意义重复、修复 ASR 噪声、增加小标题，并按校对表统一写法 | Opus | gpt-5.5（high） | deepseek-v4-pro；超过 10,000 字自动分块 |
| 源比对审计 | 纯 JS 比对源文与精校稿，检查压缩、内容缺口、结尾遗漏、说话人错归、残留噪音、欠精校、长段和引号排版；数字漂移等低置信度问题进入复核，不直接冒充确定错误 | 不调模型 | 不调模型 | 不调模型 |
| 审计修复 | 正文发布门禁未过时最多自动定点修复两轮，每轮后复检，只改点名位置、不重写全文；分块接缝另做确定性去重和残留复查。修不好仍交付主成稿与 review.md，但暂停基于它生成派生件 | Opus | gpt-5.5（high） | deepseek-v4-pro |
| 逻辑重排（可选） | 在不改写正文的前提下，把问答从录音顺序重排为叙事顺序；独立检查是否只是同序复制、是否漏掉精校稿来源小节 | Opus | gpt-5.5（high） | deepseek-v4-pro |
| 总结（可选） | 从精校稿生成分类要点、核心判断和金句，不以总结替代完整精校稿 | Opus | gpt-5.4（medium） | deepseek-v4-pro |
| 时间线（可选） | 结合精校稿和公开资料，整理人物、公司、产品与事件的发展时间线 | Opus | gpt-5.4（high） | deepseek-v4-pro |

可选的逻辑稿、总结和时间线只会在所有正文完成精校、定点修复并通过发布复检后生成。正文仍有硬问题时，主成稿和 `review.md` 照常交付，派生产物暂停，并在 `run.json` 的 `derivativesSkipped` 里说明原因。生成后，逻辑稿还会检查“假重排/漏来源”，总结和时间线会逐事实子句核对来源标签与数字归属；金额审计识别 `1.03 billion = 10.3 亿` 等等值量级换算，不把浮点舍入误差当成炮制。一份附件失败不会把已经通过的主成稿标成失败，`run.json.artifactQuality` 逐件记录 `ready / review_needed / blocked`。Universal 模型只能写入本次声明的主稿、它派生出的 `.part正整数` 分块、逻辑稿、总结和时间线路径，不能在输出目录另建测试或临时文件；成功拼接后删除本次实际分块，拼接失败则保留已写成的分块供诊断和定向续跑。

DeepSeek 版默认仍按上表使用 flash/pro。CLI 与 `runJob()` 只为受控测试提供显式阶段覆盖（`--models stage=model`）；未指定阶段沿用默认值，`run.json` 记录完整的实际阶段→模型路由和本次稀疏覆盖，避免配置与真实调用不一致。

Universal 把“程序是否完成”和“稿件是否可发布”分开记录：`run.json.execution` 只描述执行状态与 typed failure（例如 `TOOL_PATH_DENIED`、`OUTPUT_MISSING`，并标明是否可重试），`run.json.quality` 继续描述 `ready / review_needed / blocked`。DeepSeek 失败另带脱敏的 `providerSignal`：明确拒绝记 `MODEL_REFUSAL`，`finish_reason=content_filter` 记 `CONTENT_FILTER`，无 choice / 空内容分别记 `MODEL_EMPTY_RESPONSE` / `MODEL_EMPTY_CONTENT`，429、5xx 和网络错误记 `API_TRANSIENT`；静默空响应保持“原因不明”，不会推断成内容审查。证据只含 finish reason、是否出现 refusal、choice 数、HTTP 状态、request id，不保存响应正文。`plannedChunks` 在精校代理启动前生成，所以某个分块失败后仍能看到本次计划的全部 `.partN`。每个输出目录还会实时写权限为 `0600` 的 `run-state.json` 与 `events.jsonl`，记录阶段、15 秒心跳、分块计划、agent 和工具成败；不记录 prompt、转录正文、网页正文、provider 响应正文或 API key。

单文件 Universal 运行还会并行提取目录身份，写入 `run.json.transcriptMetadata`：主要受访者、采访时所属公司/机构、稿内别名、一到两句人物介绍、置信度和短依据。该代理只读原稿、标题和背景，不联网补全；`confidence=low` 时姓名、机构和人物介绍在 manifest 边界强制为空。`--metadata-catalog <json>` 可传既有规范名以减少跨任务写法漂移；`latepost-refiner-metadata` 提供只跑该轻量提取、不重跑正文的历史回填入口。

## 架构

逻辑只写一遍，放在 `core/`；每个版本只加一层运行时引擎。prompt、schema、编辑规范、纯逻辑、流水线约 90% 只写一次。

```
core/                所有逻辑的唯一出处
  spec.js            schema、编辑规范、全部纯逻辑（实体聚类、合并、校对表渲染、人名保护、乱码识别……）
  prompts.js         9 个 prompt builder
  pipeline.js        runPipeline(A, engine)：流水线主体，只依赖一个 engine 接口
  meta.js            Workflow 元信息
engines/             DeepSeek 版（命令行/网页/二进制）的引擎（Claude Code 版的引擎是 Workflow 全局，见 build/bootstrap-cc.js）
  deepseek.js        DeepSeek 引擎：endpoint、默认模型分层（flash/pro）、忠实处理长度与工具循环；仅 CLI/runJob 可显式覆盖阶段模型
  web.js             每任务独立的 Serper/Jina runtime：预算、缓存、URL allow-set、SSRF 防护与遥测
  fileops.js         Read/Write/Edit 工具实现，带沙箱限制
build/build-cc.mjs   把 core 和 Claude Code 引擎打包成自包含的 workflow.js
claude-code-skill/   Claude Code 版（workflow.js 是 build 产物，别手改）
codex-skill/         Codex 版（latepost-refiner/ 下自带一份 core/ 同步副本）
universal/           命令行 + 网页 + 单文件 App（DeepSeek 版）
```

**改了逻辑**：改 `core/*`，跑 `node build/build-cc.mjs`，别手改 `workflow.js`（build 产物，下次 build 会覆盖）。

DeepSeek 版每个任务最多发起 100 个去重后的搜索请求；同一查询和网页会在任务内缓存。`run.json` 记录搜索/抓取次数、缓存命中、失败、Serper 实际计费请求数，以及 Jina Reader 响应头回报的 token 总量；若某次成功响应缺少 `x-usage-tokens`，会单独计数而不静默当成零。运行日志把模型、Serper 搜索和 Jina Reader 三项估算成本分开记录；Jina 按 `$50 / 10 亿 token`（即 `$0.05 / 百万 token`）估算。

在启用 Clash fake-IP 的机器上，系统 DNS 可能只返回 `198.18.0.0/15` 的保留地址。网页抓取仅在某个主机名的全部系统 DNS 结果都落入该网段时，才会向 Google Public DNS 的 DNS-over-HTTPS 接口查询真实 A/AAAA 地址并继续 SSRF 校验；普通私网地址、私网与公网混合结果仍直接拒绝，DoH 查询失败也不会放宽校验。此兼容路径会把待抓取网页的主机名发送给 Google。

## 排查说话人问题

说话人标签出错时，加 `--dev-trace`（或设 `REFINER_DEV_TRACE=1`）重跑一次，输出目录下会多出 `.dev-trace/speaker-trace.md`：说话人从解析、侦察、映射、改写、兜底到审计的 6 个阶段逐一列出，末尾汇总“疑似问题信号”，看第一处数字对不上的阶段即可定位。只记标签文字、行号和条数，不记访谈正文。

不想跑整条流水线时，用只读小工具先看一眼源稿结构：`node scripts/speaker-inspect.mjs 访谈.md`。读某次运行的记录（含运行中途实时跟看）：`node scripts/dev-trace-view.mjs <运行输出目录> [--follow]`。

这个开关默认关闭，是开发排查工具，生产（飞书机器人）必须保持关闭。详见 [docs/dev-trace.md](docs/dev-trace.md)。

## 数据去向与信源保护

选版本就是选转录全文发给谁。

- DeepSeek 版：DeepSeek 由中国境内公司运营，全文将传输至其服务器处理，受当地法规约束（含内容审查）。审查即意味着内容被服务端读取——本工具曾实测：一段敏感内容被某境内服务商的策略层无声删除（这正是内容缺口检测存在的原因）。
- Claude / Codex 版：Anthropic、OpenAI 由美国公司运营，同样是把全文交给第三方——只是司法辖区与审查机制不同。
- 涉敏感话题或需保护信源的访谈：命令行、网页、二进制版启动时都会打出提示；拿不准就别把这份稿子交给境内服务商处理。本工具刻意不内置敏感词清单做内容预判——清单永远不全；诚实的表述是：全文都会被所选运营方读到，无论内容是什么。
