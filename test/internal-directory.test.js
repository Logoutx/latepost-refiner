import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseInternalDirectory,
  applyInternalDirectorySuspicion,
  INTERNAL_DIRECTORY_HINT,
  scanTextForDirectoryNames,
} from '../core/spec.js'
import { buildRunParams } from '../universal/cli.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- parseInternalDirectory ----------

test('parseInternalDirectory: 每行取首字段，跳过注释与空行，去重', () => {
  const names = parseInternalDirectory([
    '# 市场部',
    '沈其安 市场部 shen@example.com',
    '林川,产品部',
    '林川\t重复行',
    '  ',
    '李',   // 单字：不是完整姓名，忽略
  ].join('\n'))
  assert.deepEqual(names.sort(), ['林川', '沈其安'].sort())
})

test('parseInternalDirectory: 空输入/全注释 → 空数组', () => {
  assert.deepEqual(parseInternalDirectory(''), [])
  assert.deepEqual(parseInternalDirectory('# 只有注释\n\n'), [])
  assert.deepEqual(parseInternalDirectory(null), [])
})

// ---------- applyInternalDirectorySuspicion ----------

const person = (over = {}) => ({
  canonical: '陈默', variants: [], hint: '', files: ['a.md'],
  public_figure: false, suspect_asr: false, category: '', crossFile: false, ...over,
})

test('命中 canonical → suspect_asr=true + ⚠ 提示子句', () => {
  const merged = { people: [person()], brands: [], terms: [] }
  const matched = applyInternalDirectorySuspicion(merged, ['陈默'])
  assert.deepEqual(matched.map((m) => m.canonical), ['陈默'])
  assert.deepEqual(matched[0].writings, ['陈默'])
  assert.equal(merged.people[0].suspect_asr, true)
  assert.ok(merged.people[0].hint.includes(INTERNAL_DIRECTORY_HINT))
})

test('命中 variant 也算命中', () => {
  const merged = { people: [person({ canonical: '陈墨', variants: ['陈默'] })], brands: [], terms: [] }
  const matched = applyInternalDirectorySuspicion(merged, ['陈默'])
  assert.deepEqual(matched.map((m) => m.canonical), ['陈墨'])
  assert.equal(merged.people[0].suspect_asr, true)
})

test('locked（用户钦定）条目跳过', () => {
  const merged = { people: [person({ locked: true })], brands: [], terms: [] }
  const matched = applyInternalDirectorySuspicion(merged, ['陈默'])
  assert.deepEqual(matched, [])
  assert.equal(merged.people[0].suspect_asr, false)
})

test('未命中不动；brands/terms 永不查', () => {
  const merged = {
    people: [person({ canonical: '赵远' })],
    brands: [{ canonical: '陈默', variants: [], hint: '' }],
    terms: [],
  }
  const matched = applyInternalDirectorySuspicion(merged, ['陈默'])
  assert.deepEqual(matched, [])
  assert.equal(merged.people[0].suspect_asr, false)
  assert.equal(merged.brands[0].suspect_asr, undefined)
})

test('幂等：重复应用不膨胀 hint', () => {
  const merged = { people: [person({ hint: '受访者' })], brands: [], terms: [] }
  applyInternalDirectorySuspicion(merged, ['陈默'])
  const once = merged.people[0].hint
  applyInternalDirectorySuspicion(merged, ['陈默'])
  assert.equal(merged.people[0].hint, once)
})

test('空名单/缺 people → 安全空返回', () => {
  assert.deepEqual(applyInternalDirectorySuspicion({ people: [person()] }, []), [])
  assert.deepEqual(applyInternalDirectorySuspicion({}, ['陈默']), [])
})

// ---------- CLI wiring ----------

test('buildRunParams: --internal-directory 读取文件并解析为姓名数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refiner-dir-'))
  const p = path.join(dir, 'directory.txt')
  fs.writeFileSync(p, '# 名单\n沈其安 市场部\n林川\n')
  const params = buildRunParams({ topic: 't', internalDirectoryPath: p }, { env: { HOME: dir } })
  assert.deepEqual(params.internalDirectory.sort(), ['林川', '沈其安'].sort())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buildRunParams: 名单文件不存在/解析为空 → JobConfigError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refiner-dir-'))
  assert.throws(() => buildRunParams({ topic: 't', internalDirectoryPath: path.join(dir, 'missing.txt') }, { env: { HOME: dir } }),
    (e) => e.name === 'JobConfigError')
  const empty = path.join(dir, 'empty.txt')
  fs.writeFileSync(empty, '# 只有注释\n')
  assert.throws(() => buildRunParams({ topic: 't', internalDirectoryPath: empty }, { env: { HOME: dir } }),
    (e) => e.name === 'JobConfigError')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- 归一化匹配 & 英文名 ----------

test('归一化：全角空格/大小写/空白差异也能命中', () => {
  const merged = { people: [person({ canonical: '张　三' }), person({ canonical: 'mary jane' })], brands: [], terms: [] }
  const matched = applyInternalDirectorySuspicion(merged, ['张三', 'Mary Jane'])
  assert.deepEqual(matched.map((m) => m.canonical).sort(), ['mary jane', '张　三'].sort())
})

test('parseInternalDirectory: 英文全名不被空格腰斩；中文行空格后是部门列', () => {
  const names = parseInternalDirectory('Mary Jane\n沈其安 市场部\nWei Chen, engineering\n')
  assert.deepEqual(names.sort(), ['Mary Jane', 'Wei Chen', '沈其安'].sort())
})

test('parseInternalDirectory: 单行分号/顿号名单（飞书导出常见格式）', () => {
  const names = parseInternalDirectory('蔡梅梅; 杜静; 申远 neil；小晚、龚格')
  assert.deepEqual(names.sort(), ['小晚', '杜静', '申远', '蔡梅梅', '龚格'].sort())
})

// ---------- scanTextForDirectoryNames（侦察漏网补扫） ----------

test('scan：源文本包含名单名而侦察没抽到 → 找回；已在 people 的不重复', () => {
  const text = '主持人：请沈其安介绍一下。Mary Jane 也在场。另外 Maryland 不该误报。'
  const hits = scanTextForDirectoryNames(text, ['沈其安', 'Mary Jane', 'Maryland2号', '赵远'], ['赵远'])
  assert.deepEqual(hits.sort(), ['Mary Jane', '沈其安'].sort())
})

test('scan：拉丁名要求词边界（Mary 不命中 Maryland）', () => {
  assert.deepEqual(scanTextForDirectoryNames('talked to Maryland office', ['Mary'], []), [])
  assert.deepEqual(scanTextForDirectoryNames('talked to mary today', ['Mary'], []), ['Mary'])
})

test('scan：空文本/空名单安全返回', () => {
  assert.deepEqual(scanTextForDirectoryNames('', ['张三'], []), [])
  assert.deepEqual(scanTextForDirectoryNames('张三在', [], []), [])
})
