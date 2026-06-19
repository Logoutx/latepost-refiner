// Scores golden transcript-property outputs.
//
// Usage: node eval/golden-run.mjs <results.json>
//
// Results JSON shape:
//   { "<fixture id>": "<refined text>" }
// or
//   { "<fixture id>": { "text": "<refined text>" } }
import fs from 'fs'
import { GOLDEN_FIXTURES } from './golden-fixtures.js'
import { scoreGoldenAll } from './golden-score.js'

const path = process.argv[2]
if (!path) { console.error('usage: node eval/golden-run.mjs <results.json>'); process.exit(2) }

const outputs = JSON.parse(fs.readFileSync(path, 'utf8'))
const r = scoreGoldenAll(GOLDEN_FIXTURES, outputs)
const pct = (x) => (x * 100).toFixed(1) + '%'

console.log('id             contain contain✓ forbid forbid✓ pass flags')
for (const row of r.rows) {
  const flags = [
    row.missing.length ? `missing:${row.missing.join('、')}` : '',
    row.forbiddenPresent.length ? `forbidden:${row.forbiddenPresent.join('、')}` : '',
  ].filter(Boolean).join('  ')
  console.log(`${row.id.padEnd(14)} ${String(row.mustContain).padStart(7)} ${String(row.containOk).padStart(8)} ${String(row.mustNotContain).padStart(6)} ${String(row.forbiddenOk).padStart(7)} ${row.pass ? '✓' : '✗'}   ${flags}`)
}

console.log('')
console.log(`contain_rate   : ${pct(r.contain_rate)} (${r.containOk}/${r.mustContain})`)
console.log(`forbidden_rate : ${pct(r.forbidden_rate)} (${r.forbiddenOk}/${r.mustNotContain})`)
console.log(`fixture_pass   : ${pct(r.pass_rate)} (${r.rows.filter((row) => row.pass).length}/${r.rows.length})`)
console.log(`failures       : ${r.failures.length ? '⚠ ' + r.failures.join(' ; ') : '0 ✓'}`)

process.exit(r.failures.length ? 1 : 0)
