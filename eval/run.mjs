// Eval runner: scores a results file ({ "<fixture id>": "<refined text>", ... }) against the fixtures.
//
// Usage:  node eval/run.mjs <results.json>
//
// Producing the results file (filler-removal is LLM-judgment, so a real eval runs the model):
//   • Today (orchestrator-driven): dispatch ONE refine agent with core/spec.js RULES + every fixture's
//     `input`, have it return/Write {id: refinedText}; point this script at that JSON.
//   • Once Universal lands: a self-contained runner can call the SDK engine directly and emit the JSON.
//
// The bar that matters: overDel MUST be empty (never over-delete a protected word). cut_recall measures
// how aggressively real filler is removed; keep_rate confirms protected words survive.
import fs from 'fs'
import { FIXTURES } from './fixtures.js'
import { scoreAll } from './score.js'

const path = process.argv[2]
if (!path) { console.error('usage: node eval/run.mjs <results.json>'); process.exit(2) }
const outputs = JSON.parse(fs.readFileSync(path, 'utf8'))
const r = scoreAll(FIXTURES, outputs)

const pct = (x) => (x * 100).toFixed(1) + '%'
console.log('id    tier      cut  cut✓ keep keep✓  flags')
for (const row of r.rows) {
  const flags = [row.overDel.length ? `⚠过删:${row.overDel.join('、')}` : '', row.wrongKept.length ? `未删:${row.wrongKept.join('、')}` : ''].filter(Boolean).join('  ')
  console.log(`${row.id.padEnd(5)} ${row.tier.padEnd(8)} ${String(row.cut).padStart(3)} ${String(row.cutOk).padStart(4)} ${String(row.keep).padStart(4)} ${String(row.keepOk).padStart(5)}  ${flags}`)
}
console.log('')
console.log(`cut_recall (该删的删掉)   : ${pct(r.cut_recall)}  (${r.cutOk}/${r.cut})`)
console.log(`keep_rate  (该留的留住)   : ${pct(r.keep_rate)}  (${r.keepOk}/${r.keep})`)
console.log(`over-deletions (过删保护词): ${r.overDel.length ? '⚠ ' + r.overDel.join(' ; ') : '0 ✓'}`)
console.log(`filler still present      : ${r.wrongKept.length ? r.wrongKept.join(' ; ') : '0'}`)
// over-deletion is the hard failure: protected words must never be removed
process.exit(r.overDel.length ? 1 : 0)
