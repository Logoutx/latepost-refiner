export const meta = {
  name: 'transcriber',
  description: 'Scout → verify → glossary → refine+check → summary/timeline for interview transcripts',
  whenToUse: 'transcriber 技能的 Claude Code 快路径：多份访谈转录并行侦察、统一校对表、并行精校与交付物生成',
  phases: [
    { title: 'Scout', detail: '每份转录一个侦察代理，返回结构化清单（默认 haiku）' },
    { title: 'Verify', detail: '关键实体联网核实（默认 sonnet）' },
    { title: 'Refine', detail: '逐份精校 + 结尾完整性核对（默认 opus + haiku）' },
    { title: 'Logic', detail: '逐份逻辑顺序重排稿（按主线把问答重排成叙事顺序，默认 opus）' },
    { title: 'Deliver', detail: '访谈总结 / 时间线（默认 opus）' },
  ],
}

// args 契约（主代理在 Step 0 预检后组装）：
// { topic, date, background, outputDir, skillDir,
//   scope: ['refine','logic','summary','timeline'] 按需裁剪（'logic'=逻辑顺序重排稿，依赖 refine 产物）,
//   verifyDepth: 'key'|'deep'|'none', headingPolicy: 'none'|'regenerate'|'keep',
//   models?: {scout,verify,refine,summary,timeline},
//   files: [{ path, label, lines, bytes?, title, subtitle, outPath, speakerHints?, notes? }] }
//   （bytes 可选：预检 wc -c 所得，用于按密度收紧读取分页，防超限截断）

