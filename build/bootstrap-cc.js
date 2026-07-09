// ===== bootstrap: Claude Code engine =====
// Appended to the end of the bundle by build/build-cc.mjs. Runs inside the Workflow sandbox,
// where agent / parallel / pipeline / phase / log / args are globals — hand them straight to core's runPipeline.
const __A = (typeof args === 'string') ? JSON.parse(args) : (args || {})

// M12: core hands each agent() call an opts object that MAY carry `effort` (the reasoning-effort knob, set per
// category from __A.effort — e.g. {refine:'medium'}). The Workflow tool's agent(prompt, opts) accepts an
// `effort` option, so we forward it explicitly here (rather than relying on unknown-key passthrough) — this is
// the CC-edition mapping point for M12. Every other opt (label, model, schema, phase) is passed through
// unchanged. When no effort is set the forwarded value is undefined, so behaviour is byte-identical to before.
const __agent = (prompt, opts = {}) => agent(prompt, opts.effort ? { ...opts, effort: opts.effort } : opts)

const __engine = { agent: __agent, parallel, pipeline, phase, log }
return await runPipeline(__A, __engine)
