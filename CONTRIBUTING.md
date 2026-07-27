# 协作约定

## 分支与合并

`main` 是公司内部唯一权威主干。禁止直接在 `main` 上 commit、push、force push，或绕过 pull request 把改动 merge 进 `main`。每项修改都从最新 `main` 新建功能或修复分支，经过 CI 和至少一位团队成员审阅后，只通过 PR 合并。

公司当前 GitHub 方案无法为 private repo 强制 branch protection；这是平台限制，不是流程豁免。无论使用者还是自动化 Agent，都不得因此直接修改或合并 `main`。

每个 PR 应说明问题、根因、改动范围、关联影响和验证证据。说话人、内容保真、模型路由、分块或检索链路等高风险修改，除单元测试外还要用固定真实样本做前后对照，但真实稿件和结果不进入仓库。

## 修改源头

- 核心逻辑优先修改 `core/`、`scripts/` 和 `universal/` 的权威源文件。
- 不直接编辑 `claude-code-skill/workflow.js` 或带 `GENERATED FILE` 标记的副本。
- 修改共享逻辑后运行 `npm run sync:skills` 和 `npm run build:cc`，提交相应生成文件。

## 提交前检查

```bash
npm ci
npm run sync:skills
npm test
npm run build:cc
git diff --check
git diff --exit-code
```

最后一条应在重新生成后确认工作区没有漏提交的派生变化。

## 数据与凭证

禁止提交真实转录稿、私有评测样本、运行日志、模型响应、API key、个人路径或其他未公开业务信息。测试优先使用合成 fixture；真实样本只在受控环境中运行并保存审计摘要。

## 生产发布

公司 mac mini 当前只支持 `lark-refine-bot` 的 Universal 运行时，即本仓库 `universal/` 的 DeepSeek + Serper/Jina 路径。Claude Code 与 Codex 技能属于本地/人工接口，不是 mac mini 的生产后端或可直接启用的 fallback。

PR 合并只代表 refiner 主干更新，不代表生产发布。发布时由 `lark-refine-bot` 单独更新 submodule gitlink，完成集成测试和 canary 后再在空闲窗口部署。若未来增加其他生产运行时，须另行修改并验收 bot 路由、凭证、安全和部署契约。
