// ===== Shared client-side file tools =====
// Read / Write / Edit logic shared by both engines (Anthropic + OpenAI-compatible).
// Each returns { ok: boolean, text: string }; the engine wraps that in its provider's
// tool-result shape. Read mirrors Claude Code's cat -n / offset+limit behaviour that
// core's readPlan assumes. TOOL_SPECS is the provider-agnostic schema; the engine maps
// it to Anthropic `input_schema` tools or OpenAI `function` tools.

import fs from 'node:fs'
import path from 'node:path'

const MAX_LINE = 2000 // truncate pathologically long lines in Read output

export function readFile(input = {}) {
  const fp = input.file_path
  if (!fp) return { ok: false, text: 'Read: 缺少 file_path' }
  if (!fs.existsSync(fp)) return { ok: false, text: `Read: 文件不存在: ${fp}` }
  const all = fs.readFileSync(fp, 'utf8').split('\n')
  const start = Math.max(0, Number(input.offset) || 0)
  const lim = Number(input.limit) > 0 ? Number(input.limit) : 2000
  const slice = all.slice(start, start + lim)
  if (!slice.length) return { ok: true, text: `(offset ${start} 处无内容；文件共 ${all.length} 行)` }
  const body = slice
    .map((ln, i) => `${String(start + i + 1).padStart(6)}\t${ln.length > MAX_LINE ? ln.slice(0, MAX_LINE) + '…[truncated]' : ln}`)
    .join('\n')
  return { ok: true, text: body }
}

export function writeFile(input = {}) {
  const fp = input.file_path
  if (!fp) return { ok: false, text: 'Write: 缺少 file_path' }
  const content = input.content == null ? '' : String(input.content)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content, 'utf8')
  return { ok: true, text: `已写入 ${Buffer.byteLength(content, 'utf8')} 字节 → ${fp}` }
}

export function editFile(input = {}) {
  const fp = input.file_path
  const oldStr = input.old_string
  const newStr = input.new_string == null ? '' : String(input.new_string)
  if (!fp || oldStr == null) return { ok: false, text: 'Edit: 缺少 file_path 或 old_string' }
  if (oldStr === '') return { ok: false, text: 'Edit: old_string 不能为空' }
  if (!fs.existsSync(fp)) return { ok: false, text: `Edit: 文件不存在: ${fp}` }
  let text = fs.readFileSync(fp, 'utf8')
  const count = text.split(oldStr).length - 1
  if (count === 0) return { ok: false, text: 'Edit: 文件中找不到 old_string（须精确匹配，含空白与换行）' }
  if (count > 1 && !input.replace_all) return { ok: false, text: `Edit: old_string 出现 ${count} 次——请加 replace_all:true 或提供更具体的片段` }
  text = input.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr)
  fs.writeFileSync(fp, text, 'utf8')
  return { ok: true, text: `已编辑 ${fp}（替换 ${input.replace_all ? count : 1} 处）` }
}

// Dispatch by tool name; never throws (errors → { ok:false }).
export function runFileTool(name, input) {
  try {
    if (name === 'Read') return readFile(input)
    if (name === 'Write') return writeFile(input)
    if (name === 'Edit') return editFile(input)
    return { ok: false, text: `未知工具: ${name}` }
  } catch (e) {
    return { ok: false, text: `${name} 执行出错: ${e.message}` }
  }
}

// Provider-agnostic tool specs. input_schema MAY use `required` (this rule is only for
// the model's *output* schemas). Engines map `parameters` to their tool format.
export const TOOL_SPECS = [
  {
    name: 'Read',
    description: '读取本地文件。返回带行号的内容（行号<TAB>原文，行号从 offset+1 开始）。大文件用 offset/limit 分页。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'integer', description: '起始行（0 基，即跳过前 offset 行）；默认 0' },
        limit: { type: 'integer', description: '读取行数；默认 2000' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: '把内容写入本地文件（覆盖；自动创建父目录）。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: '对已有文件做精确字符串替换（old_string 必须唯一，除非 replace_all）。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件绝对路径' },
        old_string: { type: 'string', description: '要替换的原文（须与文件内容精确匹配）' },
        new_string: { type: 'string', description: '替换为的新内容' },
        replace_all: { type: 'boolean', description: '是否替换所有出现；默认 false' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
]
