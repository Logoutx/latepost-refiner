// ===== bootstrap：Claude Code 引擎 =====
// 由 build/build-cc.mjs 追加到 bundle 末尾。运行在 Workflow 沙箱里，
// agent / parallel / pipeline / phase / log / args 都是全局——直接转给 core 的 runPipeline。
const __A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const __engine = { agent, parallel, pipeline, phase, log }
return await runPipeline(__A, __engine)
