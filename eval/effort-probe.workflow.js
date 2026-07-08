// ===== M12 effort probe — Workflow-sandbox script =====
// Runs inside the Workflow tool's script sandbox (globals: agent / parallel / phase / log / args; NO import,
// NO fs — you RETURN a value, you do not write files). It fans a set of refine fixtures through refine-style
// agents at a GIVEN reasoning effort and returns { id → refinedText }, which the orchestrator scores OFFLINE
// with the existing golden/filler scorers (eval/golden-score.js, eval/score.js). Two runs of this same script
// — one with no effort (default 'high'), one with effort:'medium' — are the two arms of the experiment
// (eval/effort-experiment.md). Holding the script constant and varying only `args.effort` isolates the effect
// of the knob.
//
// args contract: { fixtures: [{ id, input }], effort?: 'low'|'medium'|'high'|'xhigh'|'max', model? }
//   · fixtures: FICTIONAL by construction — pass the golden/filler fixtures' {id, input} (the orchestrator
//     builds these from eval/golden-fixtures.js + eval/fixtures.js; both are invented placeholders, no real
//     subjects). The probe NEVER reads a source file — it only ever sees the inlined fixture inputs.
//   · effort: forwarded straight to the Workflow agent() opts.effort (the M12 knob). Omit for the default arm.
//   · model: agent model (default 'opus' — the refine tier). The knob only affects opus/sonnet/fable.
//
// Return: { effort, model, outputs: { <id>: <refinedText> } } — outputs is exactly the {id → text} shape both
// scorers consume. One agent per fixture (parallel), each returns just its refined text; a failed fixture maps
// to '' so scoring still runs (a blank output scores as missing/over-deleted, i.e. a loud failure, never a
// silent pass).

export const meta = {
  name: 'effort-probe',
  description: 'M12 reasoning-effort probe: refine golden/filler fixtures at a given effort, return {id → text} for offline scoring',
  whenToUse: 'Run twice (default vs effort:medium) to measure whether a lower reasoning effort holds refine quality; score the returned outputs with eval/golden-score.js + eval/score.js',
  phases: [{ title: 'Probe', detail: 'One refine agent per fixture at args.effort; returns refined text per id' }],
}

// Compact refine instruction — the measurement harness's own copy (the sandbox can't import core/spec.js RULES).
// It is IDENTICAL across both arms, so the two-arm comparison isolates `effort`; it is intentionally a faithful
// digest of the production rules that the golden/filler fixtures probe (collapse spelling confirmations; keep
// facts / stance markers / the ending; delete pure filler but keep meaning-changing 保护词; Arabic numerals +
// 盘古 spacing + full-width quotes; stay a dialogue, never summarize).
const REFINE_BRIEF = [
  '你是访谈转录精校助手。按下列规范精校给定的对话片段，只返回精校后的文本本身（不要解释、不要加代码围栏）。',
  '硬性约束：输出里只许有精校后的正文，一个字的旁白都不要——不要 “Wait”、不要自我纠正过程、不要复述规则；想重写就直接给最终版，绝不保留草稿。',
  '1. 保持对话体、保留发言人标签，绝不摘要或改写成叙述。',
  '2. 删纯口癖/垫词（嗯、呃、对对对、那个、就是说、句首的然后/其实/就是），但保留会改变含义的保护词（我觉得、但其实、一点、对我来说、一个道理 等有义表达）。',
  '3. 口头拼字确认（“哪个杰？捷报的捷”）折叠成澄清后的写法本身，删掉问字过程。',
  '4. 保留全部事实/数字/立场；覆盖到片段结尾，不中途断。',
  '5. 数字用阿拉伯数字（十六→16、百分之八十→80%、六七十 B→60-70B）；中文与英文/数字间加半角空格；引号用全角 “”。',
].join('\n')

const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const fixtures = Array.isArray(A.fixtures) ? A.fixtures : []
const effort = A.effort || undefined            // omit → default arm
const model = A.model || 'opus'

phase('Probe')
log(`effort probe：${fixtures.length} 个 fixture，effort=${effort || '默认(high)'}，model=${model}`)

// One agent per fixture, in parallel. The agent returns ONLY the refined text (no schema — plain-text turn).
// opts.effort is the M12 knob (undefined on the default arm). A null/failed agent → '' so scoring still runs.
const results = await parallel(fixtures.map((fx) => async () => {
  const prompt = `${REFINE_BRIEF}\n\n【待精校片段（id=${fx.id}）】\n${fx.input}`
  const out = await agent(prompt, { label: `effort-probe:${fx.id}`, model, ...(effort ? { effort } : {}) })
  return { id: fx.id, text: typeof out === 'string' ? out : (out && (out.text || out.refined)) || '' }
}))

const outputs = {}
for (const r of results) if (r && r.id != null) outputs[r.id] = r.text || ''
return { effort: effort || null, model, outputs }
