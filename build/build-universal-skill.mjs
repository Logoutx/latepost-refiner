#!/usr/bin/env node
// Build the one-folder skill package that can be installed in both Claude Code and Codex.
// The package is generated from the two native skill sources so runtime files do not drift.
import { cpSync, mkdirSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = resolve(root, process.argv[2] || 'universal-skill/latepost-refiner')

const copy = (from, to = from) => {
  cpSync(join(root, from), join(dest, to), { recursive: true })
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

copy('build/universal-skill/SKILL.md', 'SKILL.md')
copy('codex-skills/latepost-refiner/agents', 'agents')

mkdirSync(join(dest, 'scripts'), { recursive: true })
copy('claude-code-skill/scripts/claude-native.js', 'scripts/claude-native.js')
copy('codex-skills/latepost-refiner/scripts/codex-native.mjs', 'scripts/codex-native.mjs')
copy('scripts/audit_refined.mjs', 'scripts/audit_refined.mjs')
copy('scripts/setup-converters.sh', 'scripts/setup-converters.sh')
copy('scripts/install-converters.command', 'scripts/install-converters.command')

mkdirSync(join(dest, 'core'), { recursive: true })
copy('core/spec.js', 'core/spec.js')
copy('core/prompts.js', 'core/prompts.js')

mkdirSync(join(dest, 'universal'), { recursive: true })
copy('universal/artifacts.js', 'universal/artifacts.js')

mkdirSync(join(dest, 'references'), { recursive: true })
copy('codex-skills/latepost-refiner/references/native-runtime.md', 'references/codex-native-runtime.md')
copy('codex-skills/latepost-refiner/references/universal-runtime.md', 'references/universal-runtime.md')
copy('claude-code-skill/references/return-handling.md', 'references/claude-return-handling.md')
copy('claude-code-skill/references/manual-steps.md', 'references/claude-manual-steps.md')
copy('claude-code-skill/references/deliverables.md', 'references/deliverables.md')
copy('claude-code-skill/references/glossary-template.md', 'references/glossary-template.md')
copy('claude-code-skill/references/editorial-spec.md', 'references/editorial-spec.md')

console.log(`✓ generated ${dest}`)
