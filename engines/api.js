// ===== API Engine (for the Universal build — not yet implemented) =====
// runPipeline(A, engine) in core/pipeline.js is written against an engine interface; the
// Claude Code build lets the global Workflow object serve directly as the engine
// (see build/bootstrap-cc.js). The Universal build implements that same interface here
// using the Anthropic SDK, so everything in core/ — prompts, schemas, pure logic,
// the pipeline — can be reused verbatim.
//
// To be implemented in the Transcriber-Universal session (see ../universal/BRIEF.md).
// Must provide 5 primitives:
//
//   agent(prompt, { label, model, schema, phase }) -> Promise<obj | string | null>
//       · Uses anthropic.messages.create; when a schema is provided, routes through
//         tool-use (input_schema = schema, tool_choice forced) and returns the parsed
//         object; without a schema, returns the final text content.
//       · Implements Read / Write / WebSearch as **client-side tools** (executed locally
//         inside the tool-use loop, results fed back), so prompts in core/ that say
//         "use Read to page through…", "Write to…", "WebSearch to verify…" work
//         unchanged — this is the key to ~90% code sharing between the two builds.
//       · Schema failures must not throw into a dead loop (lesson learned from core/:
//         do not set required fields on schemas; let JS fill in defaults for missing fields).
//
//   parallel(thunks) -> Promise<arr>          // p-limit concurrency (order of min(16, cores-2)); failing thunks resolve to null
//   pipeline(items, ...stages) -> Promise<arr> // each item flows through all stages independently, no barrier; stage errors resolve that item to null
//   phase(title) -> void                       // progress phase marker (written to stderr / progress bar)
//   log(msg) -> void                           // narrator line
//
// Usage (inside the Universal CLI):
//   import { runPipeline } from '../core/pipeline.js'
//   const engine = makeApiEngine({ apiKey: process.env.ANTHROPIC_API_KEY, models, concurrency })
//   const result = await runPipeline(A, engine)   // A is parsed from argv, same shape as the Claude Code build

export function makeApiEngine(/* { apiKey, models, concurrency = 8, onPhase, onLog } */) {
  throw new Error('API engine not yet implemented — see universal/BRIEF.md (build inside the Transcriber-Universal session)')
}
