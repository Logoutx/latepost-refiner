import test from 'node:test'
import assert from 'node:assert/strict'
import { GOLDEN_FIXTURES } from '../eval/golden-fixtures.js'
import { scoreGoldenAll, scoreGoldenOne } from '../eval/golden-score.js'

test('golden scorer passes when required properties are present and forbidden text is absent', () => {
  const fx = { id: 'x', title: 'fixture', mustContain: ['吴捷'], mustNotContain: ['吴杰'] }
  assert.deepEqual(scoreGoldenOne(fx, '吴捷负责渠道运营。'), {
    id: 'x',
    title: 'fixture',
    mustContain: 1,
    containOk: 1,
    mustNotContain: 1,
    forbiddenOk: 1,
    missing: [],
    forbiddenPresent: [],
    pass: true,
  })
})

test('golden scorer reports missing and forbidden properties', () => {
  const fx = { id: 'x', title: 'fixture', mustContain: ['吴捷'], mustNotContain: ['吴杰'] }
  const row = scoreGoldenOne(fx, '吴杰负责渠道运营。')
  assert.equal(row.pass, false)
  assert.deepEqual(row.missing, ['吴捷'])
  assert.deepEqual(row.forbiddenPresent, ['吴杰'])
})

test('golden fixture set covers the high-risk transcript behaviors', () => {
  const ids = GOLDEN_FIXTURES.map((fx) => fx.id)
  assert.deepEqual(ids, ['spell-name', 'ending-anchor', 'speaker-labels', 'facts-and-typeset', 'protected-stance'])
})

test('scoreGoldenAll aggregates fixture failures', () => {
  const outputs = Object.fromEntries(GOLDEN_FIXTURES.map((fx) => [fx.id, `${(fx.mustContain || []).join(' ')} clean`]))
  const result = scoreGoldenAll(GOLDEN_FIXTURES, outputs)

  assert.equal(result.mustContain, GOLDEN_FIXTURES.reduce((n, fx) => n + fx.mustContain.length, 0))
  assert.equal(result.contain_rate, 1)
  assert.equal(result.failures.length, 0)
})
