// Filler-removal eval fixtures. Each snippet is raw-ish ASR-style Chinese; `cut` = tokens the refine
// rule SHOULD remove (must be ABSENT from the refined output), `keep` = tokens/phrases that MUST survive
// (a protected word or a content anchor — its absence means over-deletion or summarization).
// Mirrors the three RULES #2 tiers; see docs and core/spec.js RULES.
export const FIXTURES = [
  // ── 径删（纯垫词，无语义） ──
  { id: 'jd1', tier: '径删', input: '嗯，对对对，那个，我们当时是这么想的。', cut: ['嗯', '对对对', '那个'], keep: ['我们当时', '这么想的'] },
  { id: 'jd2', tier: '径删', input: '然后呢，这个、这个，就是说，先把产品做出来。', cut: ['然后呢', '就是说'], keep: ['先把产品做出来'] },
  { id: 'jd3', tier: '径删', input: '对吧，你知道，先把渠道铺开再说。', cut: ['对吧', '你知道'], keep: ['先把渠道铺开'] },

  // ── 看义删（有义则留，纯垫才删） ──
  { id: 'ky1', tier: '看义删', input: '为了让它有一个统一口感，我们换了料。', cut: ['一个'], keep: ['统一口感', '换了料'] },
  { id: 'ky2', tier: '看义删', input: '这跟咖啡豆拼配是一个道理。', cut: [], keep: ['一个道理', '咖啡豆拼配'] },
  { id: 'ky3', tier: '看义删', input: '其实市场挺大的，大家都想进来。', cut: ['其实'], keep: ['市场挺大的', '大家都想进来'] },
  { id: 'ky4', tier: '看义删', input: '你以为很简单，但其实没那么容易。', cut: [], keep: ['但其实', '没那么容易'] },
  { id: 'ky5', tier: '看义删', input: '做手工的话，完全靠手感。', cut: ['的话'], keep: ['做手工', '完全靠手感'] },
  { id: 'ky6', tier: '看义删', input: '需要的话我可以发给你。', cut: [], keep: ['需要的话', '发给你'] },

  // ── 基本别动（多为实义，硬删反而改义） ──
  { id: 'bd1', tier: '基本别动', input: '我觉得这事能成。', cut: [], keep: ['我觉得', '这事能成'] },
  { id: 'bd2', tier: '基本别动', input: '量做得多一点，慢一点更舒服。', cut: [], keep: ['一点', '更舒服'] },
  { id: 'bd3', tier: '基本别动', input: '对我来说，这是一种延续。', cut: [], keep: ['对我来说', '延续'] },
  { id: 'bd4', tier: '基本别动', input: '我们先了解一下大家的需求。', cut: [], keep: ['了解', '大家的需求'] },
]
