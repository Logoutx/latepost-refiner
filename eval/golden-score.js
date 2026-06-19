export function outputText(output) {
  if (output == null) return ''
  if (typeof output === 'string') return output
  return output.text || output.refined || output.output || ''
}

export function scoreGoldenOne(fixture, output) {
  const text = outputText(output)
  const missing = (fixture.mustContain || []).filter((term) => !text.includes(term))
  const forbiddenPresent = (fixture.mustNotContain || []).filter((term) => text.includes(term))
  return {
    id: fixture.id,
    title: fixture.title,
    mustContain: (fixture.mustContain || []).length,
    containOk: (fixture.mustContain || []).length - missing.length,
    mustNotContain: (fixture.mustNotContain || []).length,
    forbiddenOk: (fixture.mustNotContain || []).length - forbiddenPresent.length,
    missing,
    forbiddenPresent,
    pass: missing.length === 0 && forbiddenPresent.length === 0,
  }
}

export function scoreGoldenAll(fixtures, outputs) {
  const rows = fixtures.map((fx) => scoreGoldenOne(fx, outputs[fx.id]))
  const totals = rows.reduce((acc, row) => {
    acc.mustContain += row.mustContain
    acc.containOk += row.containOk
    acc.mustNotContain += row.mustNotContain
    acc.forbiddenOk += row.forbiddenOk
    if (!row.pass) acc.failures.push(`${row.id}${row.missing.length ? ` missing:${row.missing.join('、')}` : ''}${row.forbiddenPresent.length ? ` forbidden:${row.forbiddenPresent.join('、')}` : ''}`)
    return acc
  }, { mustContain: 0, containOk: 0, mustNotContain: 0, forbiddenOk: 0, failures: [] })
  return {
    rows,
    contain_rate: totals.mustContain ? totals.containOk / totals.mustContain : 1,
    forbidden_rate: totals.mustNotContain ? totals.forbiddenOk / totals.mustNotContain : 1,
    pass_rate: rows.length ? rows.filter((r) => r.pass).length / rows.length : 1,
    ...totals,
  }
}
