import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  afterScout,
  afterVerify,
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
    fs.writeFileSync(sourceB, '记者：张总后来怎么投的？\n受访者：大概 500 万。\n', 'utf8')

    const args = {
      topic: '测试公司',
      date: '2026-06',
      background: '测试公司，供应链，创始人张红超。',
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
        people: [{ canonical: '张红超', variants: ['张总'], hint: '创始人', public_figure: true }],
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
        people: [{ canonical: '张红超', variants: ['张总'], hint: '被追问投资情况', public_figure: true }],
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
        { query: '张红超', canonical: '张红超', identity: '测试身份', source: '测试来源' },
      ],
      unresolved: [],
    }
    const verifiedState = afterVerify(normalized, afterScoutState, verified, { suspects: [] })
    assert.ok(fs.existsSync(verifiedState.glossaryPath))
    assert.match(fs.readFileSync(verifiedState.glossaryPath, 'utf8'), /张红超/)
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
