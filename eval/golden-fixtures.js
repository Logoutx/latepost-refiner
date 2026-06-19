// Golden transcript-property evals. These are not exact snapshots: each fixture checks
// high-value properties that should survive model/provider wording differences.
export const GOLDEN_FIXTURES = [
  {
    id: 'spell-name',
    title: 'collapse spelling confirmation into the clarified name',
    input: '记者：你刚才说吴杰？\n受访者：吴，哪个杰？不是杰出的杰，是捷报的捷，提手旁那个。吴捷负责原料研发。',
    mustContain: ['吴捷', '原料研发'],
    mustNotContain: ['吴杰', '哪个杰', '杰出的杰', '捷报的捷'],
  },
  {
    id: 'ending-anchor',
    title: 'keep the source ending',
    input: '记者：我们聊一下渠道。\n受访者：前面主要是华东。\n记者：最后一个问题，明年重点是什么？\n受访者：明年重点是把冷链仓配补齐，这句话是结尾锚点。',
    mustContain: ['明年重点', '冷链仓配补齐', '结尾锚点'],
    mustNotContain: [],
  },
  {
    id: 'speaker-labels',
    title: 'preserve dialogue shape and speaker labels',
    input: 'Q：你怎么看新品？\nA：我觉得新品先小范围试。\nQ：为什么？\nA：因为渠道反馈还没跑完。',
    mustContain: ['我觉得新品', '渠道反馈'],
    mustNotContain: ['摘要', '受访者认为'],
  },
  {
    id: 'facts-and-typeset',
    title: 'retain facts while normalising Chinese number/Latin spacing',
    input: '受访者：我们有十六个部门，覆盖百分之八十用户，内部试过GPT-4，也看过六七十B的大模型。',
    mustContain: ['16 个部门', '80% 用户', 'GPT-4', '60-70B'],
    mustNotContain: ['十六个部门', '百分之八十', '六七十B'],
  },
  {
    id: 'protected-stance',
    title: 'do not delete stance markers that change meaning',
    input: '受访者：我觉得这件事能成，但其实没那么容易，需要一点耐心。',
    mustContain: ['我觉得', '但其实', '没那么容易', '一点耐心'],
    mustNotContain: [],
  },
]
