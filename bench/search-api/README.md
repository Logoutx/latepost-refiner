# 搜索 API 评测（search-api bench）

要回答一个问题：精校流水线的联网核实（verify）阶段，现在只用 Tavily 一家搜索源，它是不是最合适的？还是别家更好？

核实阶段的活儿很具体：用中文查询，去百科／官网／新闻里确认一个人名／公司／产品／职衔的正确写法，答案基本能从前几条搜索结果的标题和摘要里读出来。所以这套评测就针对这一类活儿，把几家搜索源摆在同一把尺子下比。

分两层：

- 第一层（不带模型，可复现）：`run-retrieval.mjs`。把每道题直接丢给各家搜索源，只看它返回的前 k 条结果，按固定规则打分。不经过大模型，所以每次跑分数一样，适合快速横评。
- 第二层（端到端复现）：`run-verify-replay.mjs`。把选定的搜索源接进真实的精校流水线，只跑到核实这一步，产出这家搜索源下的统一校对表（含核实结论），供事后逐家对比。

真实题库不入库。仓库里只放 5 条虚构样例 `cases.sample.json`（沿用仓库既有虚构名，不涉及任何真实受访者／公司）。真实用例文件放在研究库中的真实用例文件（不入库），跑的时候用 `--cases` 指过去。

---

## 环境变量（API key）

每家搜索源读自己的环境变量，可写进仓库根目录的 `.env`（`run-retrieval.mjs` 会自动读根目录和当前目录的 `.env`）：

| 搜索源 | 环境变量 | 形状可信度 |
|---|---|---|
| tavily | `TAVILY_API_KEY` | 已验证（与产品里正在用的调用完全一致） |
| serper | `SERPER_API_KEY` | 依据知识，较有把握（google.serper.dev） |
| brave | `BRAVE_API_KEY` | 依据知识，较有把握（Brave Search API） |
| bocha | `BOCHA_API_KEY` | 形状未证实——首次实跑需按真实响应校正 |
| jina | `JINA_API_KEY` | 形状未证实——首次实跑需按真实响应校正 |
| exa | `EXA_API_KEY` | 形状未证实——首次实跑需按真实响应校正；exa 偏语义检索，中文实体核实可能偏弱 |

只填了部分 key 也能跑：缺 key 的搜索源会被跳过并在汇总里标注，不会让整轮崩掉。

「形状未证实」的意思：这三家的请求／响应字段是凭知识推断写的，没在本次实跑里对过。它们内置了失败即软降级：一旦拿到 HTTP 200 但响应结构对不上，就返回空结果并带一条醒目的 `SHAPE_MISMATCH` 说明；`run-retrieval.mjs` 会在跑完时把这些「首次接触形状不符」的搜索源单独列出来，告诉你该去 `adapters.js` 里按真实响应改哪几家。

第二层复现还需要 `DEEPSEEK_API_KEY`（精校流水线只用 DeepSeek）。

### 用 `--keys-file` 从密钥文件读 key（推荐）

为了让 key 的值不经过对话，把各家 key 写进研究库里的一份 `keys.env`（不入库），跑的时候用 `--keys-file` 指过去。两个 runner 都支持：

```
node bench/search-api/run-retrieval.mjs --cases <题库.json> --keys-file ~/研究库/keys.env --providers tavily,bocha,brave --k 5 --out <输出目录>
```

`keys.env` 格式就是一行一个 `KEY=VALUE`（`#` 开头的行和空行忽略；值两边的引号可留可不留）：

```
TAVILY_API_KEY=tvly-xxxx
BOCHA_API_KEY="bo-cha-xxxx"
BRAVE_API_KEY=brv-xxxx
```

规则：只给「当前还没设」的变量赋值（shell 里已导出的同名变量优先，不覆盖），且在读到各家 key 之前就载入好。runner 只会打印「载入了几个变量」这样的计数；哪一行解析不了，只报行号，绝不打印任何 key 值。

> 为什么是 `--keys-file` 而不是 `--env-file`：`--env-file` 是 Node.js 自带的启动选项，Node 会抢先处理它（文件不存在时，Node 会在脚本跑起来前就用自己的报错退出），所以这里换了个不冲突的名字。`--env-file` 仍作为别名接受，但请以 `--keys-file` 为准。

---

## 第一层：检索评测

```
node bench/search-api/run-retrieval.mjs \
  --cases <题库.json> \
  --keys-file <keys.env> \
  --providers tavily,serper,brave \
  --k 5 \
  --out <输出目录>
```

- `--cases`：题库文件路径（schema 见下）。样例用 `bench/search-api/cases.sample.json`，真实题库指向研究库里那份不入库的文件。
- `--keys-file`：密钥文件路径（可选，见上）。
- `--providers`：逗号分隔的搜索源名；不填则跑全部六家。
- `--k`：每题取前几条结果，默认 5。
- `--out`：输出目录（自动创建）。

各搜索源一家一家顺序跑；同一家内部，多道题并行、最多 3 道同时进行。

输出到 `--out`：

- `<搜索源>.raw.jsonl`：每家一份，一行一道题，含原始返回结果、延迟、错误、打分、所属分组。
- `summary.md`：分组对比表（headline：每个分组一张「各家一行」的表）、全部用例汇总表、逐题明细。

### 打分规则（都在前 k 条的标题＋摘要拼起来的文本上判定）

判定前先做一步归一化：全角转半角（NFKC）、去掉所有空格（包括盘古空格和转录残留的空格）、英文转小写。然后按题型判：

- 期望题（`expect`）：这道题列出的所有「期望写法」都在文本里出现，才算命中。汇总里的「期望命中率」= 命中的期望题占全部期望题的比例，越高越好。
- 陷阱题（`trap`）：这道题列出的任一「误写／陷阱写法」在文本里出现，就算陷阱命中（我们不判断上下文是不是否定语气，出现即计入，宁可高估）。「陷阱命中率」越低越好。明细里还会标出现次数。
- 查不到题（`unverifiable`）：这类题问的是查不到、不该有答案的细节。诚实=要么返回空结果，要么前 k 条里不出现任何「线索词（hints）」（即没有硬凑出一个像模像样的答案）。「保持诚实率」越高越好。

另外每家还报：平均延迟（毫秒）、失败次数（HTTP 错误／超时／形状不符／缺 key）。

### 分组对比（headline）

题库里每道题可带一个可选的 `group` 字段（字符串，缺省算 `default`）。汇总里除了「全部用例」的总表，还会按分组再出一组表：每个分组一张「各家一行」的表，列还是那五项（期望命中、陷阱命中、诚实、延迟、失败）。这组分组表是这套评测最想看的东西——比如一组「敏感词」用例，重点就是看各家在这一组上的差别。分组表放在汇总最前面。

---

## 题库文件 schema

```jsonc
{
  "cases": [
    {
      "id": "唯一编号",
      "query": "实际发给搜索源的中文查询",
      "kind": "expect | trap | unverifiable",   // 题型
      "group": "分组名",                          // 可选：把用例分组横比，缺省为 default
      "expect": ["期望出现的写法", "..."],        // expect 题用：这些必须全部出现
      "traps":  ["不该被当正名的误写", "..."],    // trap 题用：任一出现即陷阱命中
      "hints":  ["会暴露编造答案的线索词", "..."], // unverifiable 题用：出现即视为不诚实
      "note": "给人看的备注（可选）"
    }
  ]
}
```

三个数组按题型各取所需，用不到的留空数组即可。样例见 `cases.sample.json`（用 `names_brands` 与 `traps_unfindable` 两组演示分组表）。

---

## 第二层：核实复现

把某一家搜索源接进真实流水线，只跑到核实这一步，产出这家搜索源下的校对表。

```
node bench/search-api/run-verify-replay.mjs \
  --source <访谈转录.md/.txt/.docx…> \
  --background-file <背景.md> \
  --keys-file <keys.env> \
  --provider tavily \
  --k 5 \
  --verify-depth key \
  --out <输出目录>
```

- `--source`：一份真实访谈转录（支持 `.md/.txt/.docx/.pdf/.pptx/.xlsx/.srt`，非文本格式会先转成 markdown，和产品里一致）。
- `--background-file`：一份背景说明 markdown（公司／人物背景，给核实阶段当上下文）；可选。
- `--keys-file`：密钥文件路径（可选，见上；可同时带 `DEEPSEEK_API_KEY` 和这家搜索源的 key）。
- `--provider`：用哪家搜索源（六家之一）。
- `--k`：每次搜索取前几条，默认 5，和第一层对齐才好比。
- `--verify-depth`：`key`（只核关键实体，默认）或 `deep`（全核）。
- `--out`：输出目录。

### 它到底跑了什么

它直接调用真实的 `core/pipeline.js` 里的 `runPipeline`，把 scope 设为 `['verify']`：

1. 侦察（Scout）：从转录里抽取人名／品牌／术语／发言人。
2. 核实（Verify）：把关键实体拿去联网核实——这一步的联网搜索走的就是你 `--provider` 选的那家搜索源（通过 `engines/deepseek.js` 新增的 `searchFn` 注入口替换掉默认的 Tavily）。
3. 渲染统一校对表。

精校（refine）和总结／时间线／逻辑稿都不跑（scope 里没有它们，`runPipeline` 会跳过）。文件预处理沿用 `universal/jobs.js` 的 `prepareFile` 和 `buildFilePolicy`，和产品里完全一样，保证复现忠实。

输出到 `--out`：

- `校对表.<搜索源>.md`：这家搜索源下产出的统一校对表。里面 `〔核实·日期〕` 标记的条目就是这一轮核实确认的实体——这是逐家对比的主要材料。
- `verify-replay.<搜索源>.json`：本轮的元信息（未联网核实项、待人工确认项、用量、耗时等）。

### 一个限制

`runPipeline` 对「单份、且正文不足 4000 字」的文件会走一遍过精校的快路径，那条路径不做侦察和核实。所以核实复现需要一份真实体量的访谈转录（正文 ≥ 4000 字）；源文件太小时脚本会直接报错提示，而不是悄悄跳过核实。要复现多份合并的场景，请分别跑或扩展脚本。

---

## 文件一览

- `adapters.js`：六家搜索源的归一化适配器。统一契约 `search(query, { k }) → [{ title, url, snippet }]`；失败返回空数组，并在数组上挂 `.latencyMs / .status / .error / .shapeError`（不影响 JSON 序列化）。仅供评测用，不进产品路径。
- `env-file.js`：`--keys-file` 的密钥文件加载器（只给未设变量赋值；只报计数和坏行行号，绝不打印 key 值）。
- `run-retrieval.mjs`：第一层，检索评测。
- `run-verify-replay.mjs`：第二层，核实复现。
- `cases.sample.json`：5 条虚构样例题（两组）。

## 第一轮结论（2026-07-15，owner 拍板）

47 题三组实测（常规中文 / 敏感词 / 英文 AI）：Tavily 纯检索综合最高（86%，常规中文满分、延迟 508ms、无失败），**继续作为 DeepSeek 版的默认搜索**。博查 81% 且最快（105ms），敏感词组无过滤迹象，可作后备；Brave 83%。Claude 会话搜索合计 93%（敏感词组 88% 领先 25 个百分点），但单次约 17-19 秒、每次约 6,000 tokens 订阅额度——留在 Claude Code 版自用，不引入 API 版。完整数据在研究库 `_search-bench/round1/summary.md`。
