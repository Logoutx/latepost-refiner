#!/usr/bin/env node
// 把 core/* + Claude Code 引擎打包成自包含的 claude-code-skill/workflow.js。
// 为什么需要打包：Workflow 工具的脚本沙箱禁 import / fs，只能是单文件、用其全局
// （agent/parallel/phase/log/args）。所以这里把 ESM 模块去掉 import/export 关键字、
// 按依赖序拼接成一个文件；meta 保持在最前（工具要求 export const meta 是纯字面量、居首）。
// 改逻辑请改 core/*，然后重跑：node build/build-cc.mjs
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const strip = (s) => s
  .replace(/^import[^\n]*\n/gm, '')   // 去 import 行
  .replace(/^export /gm, '')          // 去 export 关键字（仅行首）

const out = [
  read('core/meta.js').trim(),        // export const meta = {...}（不剥，须居首）
  '// ===== 本文件由 build/build-cc.mjs 从 core/* 生成——请勿手改；改 core/ 后重跑 build =====',
  strip(read('core/spec.js')),
  strip(read('core/prompts.js')),
  strip(read('core/pipeline.js')),
  read('build/bootstrap-cc.js'),
].join('\n\n') + '\n'

const dest = join(root, 'claude-code-skill/workflow.js')
writeFileSync(dest, out)
console.log(`✓ 生成 ${dest}（${out.split('\n').length} 行）`)
