// Pure scorer for the filler-removal eval. Engine-agnostic: feed it {id: refinedText} produced by any
// runner (the Agent-tool driver today, or the SDK engine once Universal lands) and it scores against
// the fixtures' cut/keep annotations.
//
//   cut_recall  = fraction of `cut` tokens correctly removed (absent from output)   — higher = cleaner
//   keep_rate   = fraction of `keep` tokens correctly preserved (present in output) — higher = safer
//   overDel     = protected tokens wrongly removed (over-deletion / summarization)  — should be empty
//   wrongKept   = filler tokens that should have been cut but survived              — informational
export function scoreOne(fx, output) {
  const out = output || ''
  const has = (t) => out.includes(t)
  return {
    id: fx.id,
    tier: fx.tier,
    cut: fx.cut.length,
    cutOk: fx.cut.filter((t) => !has(t)).length,
    keep: fx.keep.length,
    keepOk: fx.keep.filter((t) => has(t)).length,
    overDel: fx.keep.filter((t) => !has(t)),
    wrongKept: fx.cut.filter((t) => has(t)),
  }
}

export function scoreAll(fixtures, outputs) {
  const rows = fixtures.map((fx) => scoreOne(fx, outputs[fx.id]))
  let cut = 0, cutOk = 0, keep = 0, keepOk = 0
  const overDel = [], wrongKept = []
  for (const r of rows) {
    cut += r.cut; cutOk += r.cutOk; keep += r.keep; keepOk += r.keepOk
    if (r.overDel.length) overDel.push(`${r.id}:${r.overDel.join('、')}`)
    if (r.wrongKept.length) wrongKept.push(`${r.id}:${r.wrongKept.join('、')}`)
  }
  return {
    rows,
    cut_recall: cut ? cutOk / cut : 1,
    keep_rate: keep ? keepOk / keep : 1,
    cut, cutOk, keep, keepOk,
    overDel,      // the metric that matters most: over-deletion of protected words (should be empty)
    wrongKept,
  }
}
