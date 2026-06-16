# Transcriber-Universal — 构建任务书

## 一句话目标

把本仓库的访谈精校流水线做成一个**独立的、直接调 Anthropic API 的 Node CLI**——有 API key 就能在任意机器跑，不依赖 Claude Code 的 Workflow 工具，也不依赖 claude.ai 上传 skill。

## 关键前提：逻辑已经共享，你只写「引擎 + CLI」

流水线、prompts、schemas、编辑规范、全部纯逻辑都在 [`../core/`](../core/)，**两个 edition 共用**。Universal 版**不重写任何业务逻辑**——只 `import { runPipeline } from '../core/pipeline.js'`，再补一层运行时引擎和命令行外壳。

`runPipeline(A, engine)` 只依赖 engine 的 5 个原语。Claude Code 版用 Workflow 全局充当；你这版用 Anthropic SDK 兑现同样 5 个：

```js
import { runPipeline } from '../core/pipeline.js'
import { makeApiEngine } from '../engines/api.js'
const engine = makeApiEngine({ apiKey: process.env.ANTHROPIC_API_KEY, models, concurrency })
const result = await runPipeline(A, engine)   // A 由 argv 解析，与 Claude Code 版同形
```

## 要建的只有三块

### 1. `../engines/api.js` —— 兑现 engine 接口（核心工作量）

```
agent(prompt, { label, model, schema, phase }) -> Promise<obj | string | null>
parallel(thunks) -> Promise<arr>
pipeline(items, ...stages) -> Promise<arr>
phase(title) -> void
log(msg) -> void
```

- **`agent`**：`anthropic.messages.create` 跑一个 **tool-use 循环**。关键技巧——把 `Read / Write / WebSearch` 实现成**客户端工具**（模型 call → 你本地执行 fs 读写 / 联网 → 把结果回灌进对话），于是 `core/` 里现成的「用 Read 分页读…」「Write 到…」「WebSearch 核实…」的 prompt **一字不改就能用**。这是省掉重写的命门。
  - 有 `schema` 时：把 schema 作为一个 `StructuredOutput` 工具的 `input_schema`，用 `tool_choice` 逼模型最后调用它；返回解析后的对象。**沿用 core 的教训：schema 不设 required**（缺字段由 core 的 JS 兜底；别让校验失败触发死循环）。无 `schema` 返回最终文本。
  - 模型名走 `models`（与 core 默认分层一致：scout=haiku，verify/dedup=sonnet，refine/logic/summary/timeline=opus，结尾核对=haiku）。
- **`parallel` / `pipeline`**：`Promise` + `p-limit` 限并发（`min(16, cores-2)` 量级）。`pipeline` 逐项独立流过各 stage、**无 barrier**；任一 thunk/stage 抛错 → 该项归 `null`（与 Workflow 语义一致，core 里有 `.filter(Boolean)`）。
- **`phase` / `log`**：打到 stderr 或进度条。

> 联网核实：优先用 Anthropic 的 server-side web search 工具；或在客户端 WebSearch 工具里接一个搜索 API。动手前查 `claude-api` skill 确认当前 web search 工具名/版本与 tool-use 写法。

### 2. `universal/cli.js` —— 命令行外壳

- 解析 argv → 组装 `A`（与 Claude Code 版 args 同形，见 `core/meta.js` 顶部契约 + `../claude-code-skill/SKILL.md` Step 0）：`{ topic, date, background, outputDir, skillDir, scope, verifyDepth, headingPolicy, models, files:[{path,label,lines,bytes,title,subtitle,outPath,...}] }`。
- **预检**：docx/pdf → md（shell 调 `markitdown`，或用 `mammoth`）；`wc -l`/`-c` 填 lines/bytes；grep 探小标题。
- `skillDir` 指向能读到 `references/` 的位置（复用 `../claude-code-skill/references/`，或在打包时拷一份）。
- 调 `runPipeline(A, engine)`，按返回处理（glossary 落盘、`failed/incomplete/unchecked/scoutSuspect/headingConflicts/suspectedDuplicates/networkUnverified/logic/openQuestions`——同 SKILL.md「返回处理」）。

### 3. 打包

`package.json`（`type: module`，`bin: transcriber`）+ `@anthropic-ai/sdk` + `p-limit`（+ `mammoth` 或依赖系统 markitdown）+ `.env.example`（`ANTHROPIC_API_KEY`）+ README。

## CLI 设想

```bash
transcriber --files "a.docx" "b.docx" --topic "Mixue" --date 2025-02 \
  --background "蜜雪集团各团队系列采访…" --scope refine,logic,summary \
  --verify key --out ./output --models scout=haiku,refine=opus
```

输出与 Claude Code 版一致：`<out>/校对表.md`、`Transcripts/*.md`、`逻辑顺序/*.md`、`<主题>访谈总结.md`、`<主题>时间线.md`。

## 建造顺序

1. 查 `claude-api` skill 定 API 写法（model id / tool-use 结构化输出 / web search 工具）。
2. 写 `engines/api.js` 的 tool-use 循环（Read/Write/WebSearch/StructuredOutput 四个客户端工具）+ `parallel`/`pipeline`（p-limit）。
3. 写 `cli.js`（argv→A、docx→md、调 runPipeline、返回处理）。
4. 端到端测：用 `~/Downloads/2025-02-21_范 大咖事业群，原料研发.txt` 跑一份，对照 Claude Code 版已知良好产出（用户 Obsidian `Company Research/Mixue/`）。
5. 打包 + README + `.env.example`。

## 别再踩的坑（都已固化在 core，引擎别破坏其前提）

schema 不设 required；侦察固定 haiku；聚类欠并（弱称不当合并键）；verify 分块 12；refine 大块写入禁微改；人名强名守卫；verify 断路器（连错 2 次即停——引擎要把检索错误如实抛给模型，让 prompt 里的断路器逻辑生效）；中文排版三规范已在 prompt 内。

## 参考

- `../core/`（真相来源：runPipeline + prompts + schemas + 纯逻辑）。
- `../claude-code-skill/SKILL.md`（Step 0 预检 + args 契约 + 返回处理，照搬到 CLI）。
- `../engines/api.js`（接口占位 + 实现说明）。
- `claude-api` skill —— API/SDK 细节，动手前必查。
