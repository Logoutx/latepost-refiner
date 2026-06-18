// ===== Shared client-side file tools =====
// Read / Write / Edit logic shared by both engines (Anthropic + OpenAI-compatible).
// Each returns { ok: boolean, text: string }; the engine wraps that in its provider's
// tool-result shape. Read mirrors Claude Code's cat -n / offset+limit behaviour that
// core's readPlan assumes. TOOL_SPECS is the provider-agnostic schema; the engine maps
// it to Anthropic `input_schema` tools or OpenAI `function` tools.

import fs from 'node:fs'
import path from 'node:path'

const MAX_LINE = 2000 // truncate pathologically long lines in Read output
const DEFAULT_POLICY = Object.freeze({
  readRoots: [process.cwd()],
  writeRoots: [process.cwd()],
  readPaths: [],
  writePaths: [],
})

const asArray = (v) => Array.isArray(v) ? v : (v ? [v] : [])
const uniq = (xs) => Array.from(new Set(xs.filter(Boolean)))
const resolveList = (xs) => uniq(asArray(xs).map((x) => path.resolve(String(x))))

export function makeFilePolicy(policy = {}) {
  return {
    readRoots: resolveList(policy.readRoots || DEFAULT_POLICY.readRoots),
    writeRoots: resolveList(policy.writeRoots || DEFAULT_POLICY.writeRoots),
    readPaths: resolveList(policy.readPaths || DEFAULT_POLICY.readPaths),
    writePaths: resolveList(policy.writePaths || DEFAULT_POLICY.writePaths),
  }
}

function insideRoot(target, root) {
  const rel = path.relative(root, target)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function allowed(target, roots, exactPaths) {
  const abs = path.resolve(String(target || ''))
  return exactPaths.includes(abs) || roots.some((root) => insideRoot(abs, root))
}

function checkAccess(kind, filePath, policy) {
  if (!filePath) return { ok: false, text: `${kind}: 缺少 file_path` }
  const p = makeFilePolicy(policy)
  const abs = path.resolve(String(filePath))
  const roots = kind === 'Read' ? p.readRoots : p.writeRoots
  const exact = kind === 'Read'
    ? uniq([...p.readPaths, ...p.writePaths])
    : p.writePaths
  if (!allowed(abs, roots, exact)) {
    const hint = roots.concat(exact).join('；') || '（无）'
    return { ok: false, text: `${kind}: 路径不在允许范围内: ${abs}；允许范围: ${hint}` }
  }
  return { ok: true, path: abs }
}

export function readFile(input = {}, policy) {
  const access = checkAccess('Read', input.file_path, policy)
  if (!access.ok) return access
  const fp = access.path
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

export function writeFile(input = {}, policy) {
  const access = checkAccess('Write', input.file_path, policy)
  if (!access.ok) return access
  const fp = access.path
  const content = input.content == null ? '' : String(input.content)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content, 'utf8')
  return { ok: true, text: `已写入 ${Buffer.byteLength(content, 'utf8')} 字节 → ${fp}` }
}

export function editFile(input = {}, policy) {
  const access = checkAccess('Edit', input.file_path, policy)
  if (!access.ok) return access
  const fp = access.path
  const oldStr = input.old_string
  const newStr = input.new_string == null ? '' : String(input.new_string)
  if (oldStr == null) return { ok: false, text: 'Edit: 缺少 old_string' }
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
export function runFileTool(name, input, policy) {
  try {
    if (name === 'Read') return readFile(input, policy)
    if (name === 'Write') return writeFile(input, policy)
    if (name === 'Edit') return editFile(input, policy)
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
