export const meta = {
  name: 'latepost-refiner',
  description: 'Scout → verify → glossary → refine+check → summary/timeline for interview transcripts',
  whenToUse: 'latepost-refiner 技能的 Claude Code 快路径：多份访谈转录并行侦察、统一校对表、并行精校与交付物生成',
  phases: [
    { title: 'Scout', detail: '每份转录一个侦察代理（超大文件自动拆段并行、防单代理卡死），返回结构化清单（默认 haiku）' },
    { title: 'Verify', detail: '关键实体联网核实（默认 sonnet）' },
    { title: 'Refine', detail: '逐份精校（大文件拆块并行 + 拼接；侦察失败也照常精校，默认 opus + 拼接 haiku）' },
    { title: 'Logic', detail: '逐份逻辑顺序重排稿（按主线把问答重排成叙事顺序，默认 opus）' },
    { title: 'Deliver', detail: '访谈总结 / 时间线（默认 opus）' },
    { title: 'Check', detail: '结尾完整性核对——最后跑、不阻塞已落盘的成稿与交付物（默认 haiku）' },
  ],
}

// args contract (assembled by the main agent after the Step 0 pre-flight):
// { topic, date, background, outputDir, skillDir,
//   scope: ['refine','logic','summary','timeline'] trimmed as needed ('logic' = logical-order rewrite, depends on refine output),
//   verifyDepth: 'key'|'deep'|'none', headingPolicy: 'none'|'regenerate'|'keep',
//   models?: {scout,verify,refine,stitch,summary,timeline},  (stitch = chunk-merge agent for large files, default haiku)
//   priorGlossaryText?: full text of an existing <outputDir>/校对表.md (per-company persistent glossary, P1) —
//     Step 0 reads it if present; the workflow parses it to seed scout and accumulates this batch into it.
//   fresh?: true to ignore any prior glossary and rebuild from scratch.
//   files: [{ path, label, lines, bytes?, chars?, title, subtitle, outPath, speakerHints?, notes? }] }
//   (chars = 正文字数 (汉字 + 每个英文词/数字各算 1); THE document-length metric — routing (one-pass / chunk) keys on it, not lines.
//    lines/bytes are for Read pagination only (readPlan). If chars is absent it's estimated from bytes, then lines.)

