import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  afterScout,
  afterVerify,
  auditNativeResult,
  prepareNativeRun,
  writeNativeArtifacts,
} from '../codex-skills/latepost-refiner/scripts/codex-native.mjs'

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('Codex native helper prepares prompts, renders glossary, and writes artifacts without API keys', () => {
  const savedOpenAIKey = process.env.OPENAI_API_KEY
  const savedTavilyKey = process.env.TAVILY_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.TAVILY_API_KEY

  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latepost-codex-native-'))
    const sourceA = path.join(tmp, 'interview-a.md')
    const sourceB = path.join(tmp, 'interview-b.md')
    fs.writeFileSync(sourceA, '记者：嗯，我们聊供应链。\n受访者：我们 2018 年成立。\n', 'utf8')
    fs.writeFileSync(sourceB, '记者：王总后来怎么投的？\n受访者：大概 500 万。\n', 'utf8')

    const args = {
      topic: '测试公司',
      date: '2026-06',
      background: '测试公司，供应链，创始人王志远。',
      outputDir: path.join(tmp, 'out'),
      scope: ['refine'],
      verifyDepth: 'key',
      headingPolicy: 'none',
      files: [
        { path: sourceA, label: '访谈 A' },
        { path: sourceB, label: '访谈 B' },
      ],
    }

    const prepared = prepareNativeRun(args)
    assert.equal(prepared.prompts.length, 2)
    assert.ok(prepared.prompts.every((p) => p.stage === 'scout' && fs.existsSync(p.path)))

    const normalized = readJson(prepared.argsPath)
    const findings = {
      '访谈 A': {
        speakers: [{ label: '受访者', role: '创始人' }],
        people: [{ canonical: '王志远', variants: ['王总'], hint: '创始人', public_figure: true }],
        brands: [{ canonical: '测试公司', variants: [], hint: '本次访谈主体' }],
        terms: [],
        errors: [],
        themes: ['供应链'],
        has_existing_headings: false,
        ending_anchor: { line: 2, text: '受访者：我们 2018 年成立。' },
        special_notes: [],
      },
      '访谈 B': {
        speakers: [{ label: '受访者', role: '投资人' }],
        people: [{ canonical: '王志远', variants: ['王总'], hint: '被追问投资情况', public_figure: true }],
        brands: [],
        terms: [],
        errors: [],
        themes: ['融资'],
        has_existing_headings: false,
        ending_anchor: { line: 2, text: '受访者：大概 500 万。' },
        special_notes: [],
      },
    }

    const scout = afterScout(normalized, findings)
    assert.ok(fs.existsSync(scout.statePath))
    assert.ok(scout.verifyPrompts.length >= 1)

    const afterScoutState = readJson(scout.statePath)
    const verified = {
      resolved: [
        { query: '王志远', canonical: '王志远', identity: '测试身份', source: '测试来源' },
      ],
      unresolved: [],
    }
    const verifiedState = afterVerify(normalized, afterScoutState, verified, { suspects: [] })
    assert.ok(fs.existsSync(verifiedState.glossaryPath))
    assert.match(fs.readFileSync(verifiedState.glossaryPath, 'utf8'), /王志远/)
    assert.equal(verifiedState.refinePrompts.length, 2)
    assert.equal(verifiedState.checkPrompts.length, 2)

    const resultSeed = readJson(verifiedState.statePath).resultSeed
    for (const f of normalized.files) {
      fs.mkdirSync(path.dirname(f.outPath), { recursive: true })
      fs.writeFileSync(f.outPath, `# ${f.title}\n\n## 创业\n受访者：测试内容。\n`, 'utf8')
    }
    const result = {
      ...resultSeed,
      refined: normalized.files.map((f) => ({
        outPath: f.outPath,
        complete: true,
        checkNote: '',
        headings: ['创业'],
        key_fixes: [],
        open_questions: [],
      })),
    }
    const artifacts = writeNativeArtifacts(normalized, result)
    assert.ok(fs.existsSync(artifacts.reviewPath))
    assert.ok(fs.existsSync(artifacts.manifestPath))
    const manifest = readJson(artifacts.manifestPath)
    assert.equal(manifest.provider.name, 'codex-subscription')
    assert.equal(manifest.artifacts.refined.length, 2)
    assert.doesNotMatch(JSON.stringify(manifest), /OPENAI_API_KEY|TAVILY_API_KEY|sk-/)
  } finally {
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedOpenAIKey
    if (savedTavilyKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = savedTavilyKey
  }
})

test('Codex native helper applies canonicalOverrides before verify and glossary render', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latepost-codex-override-'))
  const sourceA = path.join(tmp, 'interview-a.md')
  const sourceB = path.join(tmp, 'interview-b.md')
  fs.writeFileSync(sourceA, '记者：王总怎么判断这个市场？\n受访者：王总说要先做供应链。\n', 'utf8')
  fs.writeFileSync(sourceB, '记者：后来王总怎么投？\n受访者：投了 500 万。\n', 'utf8')

  const args = {
    topic: '测试公司',
    outputDir: path.join(tmp, 'out'),
    scope: ['refine'],
    verifyDepth: 'key',
    files: [{ path: sourceA, label: 'A' }, { path: sourceB, label: 'B' }],
    canonicalOverrides: [{ canonical: '王志远', variants: ['王总'], category: 'person', note: '用户确认' }],
  }

  const prepared = prepareNativeRun(args)
  const normalized = readJson(prepared.argsPath)
  const findings = {
    A: { people: [{ canonical: '王总', variants: [], hint: '受访者称呼' }], brands: [], terms: [], themes: [], errors: [], has_existing_headings: false },
    B: { people: [{ canonical: '王总', variants: [], hint: '投资人称呼' }], brands: [], terms: [], themes: [], errors: [], has_existing_headings: false },
  }
  const scout = afterScout(normalized, findings)
  const state = readJson(scout.statePath)
  assert.equal(state.verifyPrompts.length, 0, 'locked user-decreed names skip web verification')
  assert.equal(state.mergedThisBatch.people[0].canonical, '王志远')
  assert.equal(state.mergedThisBatch.people[0].locked, true)

  const verifiedState = afterVerify(normalized, state, { resolved: [], unresolved: [] }, { suspects: [] })
  const glossary = fs.readFileSync(verifiedState.glossaryPath, 'utf8')
  assert.match(glossary, /王志远/)
  assert.match(glossary, /王总/)
  assert.match(glossary, /用户钦定/)
})

test('Codex native one-pass prompt carries canonicalOverrides and an audit glossary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latepost-codex-onepass-'))
  const source = path.join(tmp, 'short.md')
  fs.writeFileSync(source, '记者：王总怎么看？\n受访者：王总说先验证需求。\n', 'utf8')
  const args = {
    topic: '测试公司',
    outputDir: path.join(tmp, 'out'),
    files: [{ path: source, label: '短访谈' }],
    canonicalOverrides: [{ canonical: '王志远', variants: ['王总'] }],
  }
  const prepared = prepareNativeRun(args)
  assert.equal(prepared.prompts.length, 1)
  const prompt = fs.readFileSync(prepared.prompts[0].path, 'utf8')
  assert.match(prompt, /用户钦定正名/)
  assert.match(prompt, /王志远/)
  const glossary = fs.readFileSync(path.join(args.outputDir, '_codex-native', 'one-pass-glossary.md'), 'utf8')
  assert.match(glossary, /王志远/)
  assert.match(glossary, /王总/)
})

test('Codex native audit stage records auditFailed for compressed outputs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latepost-codex-audit-'))
  const source = path.join(tmp, 'interview.md')
  const sourceText = Array.from({ length: 30 }, (_, i) => `记者：第 ${i + 1} 个问题。\n受访者：这是第 ${i + 1} 段关于产品、渠道、供应链和组织变化的具体细节。`).join('\n')
  fs.writeFileSync(source, sourceText, 'utf8')
  const outDir = path.join(tmp, 'out')
  const args = { topic: '测试公司', outputDir: outDir, files: [{ path: source, label: '访谈' }] }
  const prepared = prepareNativeRun(args)
  const normalized = readJson(prepared.argsPath)
  const outPath = normalized.files[0].outPath
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, '# 访谈\n\n受访者：内容很多，略。\n', 'utf8')
  const result = { refined: [{ outPath, complete: true, checkNote: '', headings: [], key_fixes: [], open_questions: [] }] }

  const audited = auditNativeResult(normalized, result)
  assert.ok(fs.existsSync(audited.resultPath))
  assert.ok(audited.auditFailed.length >= 1)
  assert.ok(audited.auditFailed[0].findings.includes('compression_risk'))
})
