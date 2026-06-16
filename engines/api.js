// ===== API 引擎（Universal 版用，待实现）=====
// core/pipeline.js 的 runPipeline(A, engine) 面向一个 engine 接口编写；Claude Code 版
// 由 Workflow 全局直接充当 engine（见 build/bootstrap-cc.js）。Universal 版在这里用
// Anthropic SDK 实现同一个接口，于是 core/ 的 prompt / schema / 纯逻辑 / 流水线一字不改地复用。
//
// 待在 Transcriber-Universal 会话里实现（见 ../universal/BRIEF.md）。需提供 5 个原语：
//
//   agent(prompt, { label, model, schema, phase }) -> Promise<obj | string | null>
//       · 用 anthropic.messages.create；有 schema 时走 tool-use（input_schema = schema，
//         tool_choice 强制）并返回解析后的对象；无 schema 返回最终文本。
//       · 把 Read / Write / WebSearch 实现成**客户端工具**（tool-use 循环里本地执行、回灌结果），
//         于是 core 里“用 Read 分页读…”“Write 到…”“WebSearch 核实…”的 prompt 原样可用——
//         这是两版共享 ~90% 的关键。
//       · schema 失败不抛死循环（沿用 core 教训：schema 不设 required，缺字段 JS 兜底）。
//
//   parallel(thunks) -> Promise<arr>          // p-limit 限并发（min(16, cores-2) 量级）；throw 的 thunk 归 null
//   pipeline(items, ...stages) -> Promise<arr> // 每项独立流过各 stage，无 barrier；stage 抛错该项归 null
//   phase(title) -> void                       // 进度相位（打到 stderr / 进度条）
//   log(msg) -> void                           // narrator 行
//
// 用法（Universal CLI 里）：
//   import { runPipeline } from '../core/pipeline.js'
//   const engine = makeApiEngine({ apiKey: process.env.ANTHROPIC_API_KEY, models, concurrency })
//   const result = await runPipeline(A, engine)   // A 由 argv 解析，与 Claude Code 版同形

export function makeApiEngine(/* { apiKey, models, concurrency = 8, onPhase, onLog } */) {
  throw new Error('API 引擎待实现——见 universal/BRIEF.md（在 Transcriber-Universal 会话里建）')
}
