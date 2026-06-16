#!/usr/bin/env node
// Bundle core/* + the Claude Code engine into a self-contained claude-code-skill/workflow.js.
// Why bundle: the Workflow tool's script sandbox forbids import/fs — it must be a single file
// using the tool's globals (agent/parallel/phase/log/args). So we strip import/export keywords
// from the ESM modules and concatenate them in dependency order; meta stays first (the tool
// requires `export const meta` to be a pure literal at the top).
// To change logic, edit core/* and re-run: node build/build-cc.mjs
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const strip = (s) => s
  .replace(/^import[^\n]*\n/gm, '')   // drop import lines
  .replace(/^export /gm, '')          // drop the export keyword (line start only)

const out = [
  read('core/meta.js').trim(),        // export const meta = {...} (not stripped; must stay first)
  '// ===== Generated from core/* by build/build-cc.mjs — do not edit by hand; edit core/ and re-run build =====',
  strip(read('core/spec.js')),
  strip(read('core/prompts.js')),
  strip(read('core/pipeline.js')),
  read('build/bootstrap-cc.js'),
].join('\n\n') + '\n'

const dest = join(root, 'claude-code-skill/workflow.js')
writeFileSync(dest, out)
console.log(`✓ generated ${dest} (${out.split('\n').length} lines)`)
