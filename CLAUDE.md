# latepost-refiner

把粗糙的访谈转录稿整理成忠实、可读、可检索的研究稿。共享逻辑以 `core/` 为源，生成到 Claude Code、Codex 与 Universal 三个接口。

## 接手先读

- `README.md`：产品、运行方式、架构与数据边界。
- `CONTRIBUTING.md`：分支、测试、隐私与发布流程。
- 修改生成链路前先理解 `build/sync-skills.mjs` 和 `build/build-cc.mjs`；不要直接编辑生成文件。

## 仓库与分支

- `latepost-team/latepost-refiner` 是公司 private 权威源，`main` 是唯一权威主干。
- **禁止直接在 `main` 上 commit、push、force push，或绕过 pull request 把改动 merge 进 `main`。**
- 每项修改从最新 `main` 新建分支，CI 通过后只通过 PR 合并。人工 reviewer 不是合并前置条件，默认不主动请求；只有用户明确要求时才发起 review 请求。
- 公司当前 GitHub 方案不能为 private repo 强制 branch protection；平台没有拦截不代表允许跳过分支、CI 和 PR 流程。
- 原始公开仓库和旧个人镜像不是当前构建、部署或日常协作依赖；外部改动须审阅后以独立 PR 引入。

## mac mini 生产边界

- 公司 mac mini 上的 `lark-refine-bot` **目前只支持 Universal 运行时**：本仓库 `universal/` 的 DeepSeek + Serper/Jina 路径。
- Claude Code 与 Codex 技能是本地/人工运行接口，不是 mac mini 的生产后端，也不是可直接启用的生产 fallback。
- refiner PR 合并不会自动上线。生产只消费 bot submodule 固定的精确 commit；须另在 `lark-refine-bot` 更新 gitlink、完成集成测试和 canary，并在空闲窗口部署。
- 若未来增加其他生产运行时，必须先修改并验收 bot 路由、凭证、安全和部署契约；不能只改环境变量或因为相应 skill 存在就视为支持。

## 修改与验证

- **全链路先于局部补丁**：排查质量或结构故障时，先追踪同一事实在输入解析、模型编辑、分块、拼接、修复、审计和交付各阶段如何产生、传递与丢失；已有的结构化事实不得先降成自由文本，再由下游用关键词、正则或 LLM 猜回。禁止为单个样本继续堆格式特例、词表或互相补洞的规则；同类故障反复出现时，停止加补丁，重划数据契约与所有权边界。确需新增规则时，必须说明它保护的上位不变量、适用边界、反例，以及替代或删除了哪些旧判断，并用跨样本回归证明没有把风险转移到下游。
- 核心逻辑优先修改 `core/`、`scripts/` 与 `universal/` 的权威源。
- 不直接编辑 `claude-code-skill/workflow.js` 或带 `GENERATED FILE` 标记的副本。
- 共享逻辑改变后运行：

```bash
npm ci
npm run sync:skills
npm test
npm run build:cc
git diff --check
git diff --exit-code
```

- 说话人、内容保真、模型路由、分块或检索链路等高风险修改，还须用固定真实样本做前后对照；真实稿件和结果不入库。

## 隐私

禁止提交真实转录稿、私有评测样本、运行日志、模型响应、API key、个人路径或其他未公开业务信息。private repo 不是敏感数据归档区。
