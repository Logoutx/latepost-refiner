#!/usr/bin/env bash
# Build the all-in-one release zip: one download, three ready-to-place folders.
#
#   latepost-refiner/
#     README.md                            one page: where each folder goes
#     Claude Code Skill/latepost-refiner/  drag into ~/.claude/skills/
#     Codex Skill/latepost-refiner/        drag into the Codex skills dir
#     DeepSeek Edition/                    self-contained: npm install, then CLI or npm run web
#
# The inner latepost-refiner/ layer under the two skill folders matters: the folder name IS the
# deployed skill name, so a drag-and-drop needs no rename. DeepSeek Edition mirrors the repo-root
# layout (universal/ resolves core/, engines/ and claude-code-skill/references relative to its
# parent), so it ships that subset including a claude-code-skill/ copy — duplication inside a build
# artifact is fine; the single source of truth stays in the repo.
# Usage: build/build-release-zip.sh [output dir, default ~/Downloads]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Downloads}"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STAGE="$TMP/latepost-refiner"
mkdir -p "$STAGE"

# 1) Claude Code Skill
mkdir -p "$STAGE/Claude Code Skill"
cp -R "$ROOT/claude-code-skill" "$STAGE/Claude Code Skill/latepost-refiner"
rm -f "$STAGE/Claude Code Skill/latepost-refiner/build-zips.sh"

# 2) Codex Skill
mkdir -p "$STAGE/Codex Skill"
cp -R "$ROOT/codex-skill/latepost-refiner" "$STAGE/Codex Skill/latepost-refiner"

# 3) DeepSeek Edition — repo-root subset, self-contained after `npm install`
DS="$STAGE/DeepSeek Edition"
mkdir -p "$DS"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.env.example" "$DS/"
cp -R "$ROOT/core" "$ROOT/engines" "$ROOT/universal" "$ROOT/scripts" "$DS/"
cp -R "$ROOT/claude-code-skill" "$DS/claude-code-skill"   # references/ + audit live here (resolved via repo-root layout)
rm -f "$DS/claude-code-skill/build-zips.sh"

# 4) One-page guide at the zip root
cat > "$STAGE/README.md" <<'EOF'
# LatePost-Refiner — 一包三版

| 文件夹 | 放哪 / 怎么用 | 需要什么 |
|---|---|---|
| Claude Code Skill/latepost-refiner | 整个文件夹拖进 `~/.claude/skills/` | Claude 订阅，不用 API key |
| Codex Skill/latepost-refiner | 整个文件夹拖进 Codex 的 skills 目录（见其 SKILL.md） | ChatGPT 订阅，不用 API key |
| DeepSeek Edition | 放任意位置；进目录跑 `npm install`，然后 `npm run web`（本地网页）或 `node universal/cli.js`（命令行） | Node.js 20+；`DEEPSEEK_API_KEY` 必填、`TAVILY_API_KEY` 建议（填进 `.env`，参考 `.env.example`） |

- 两个技能文件夹拖进去后，下个会话直接说“精校这份转录”即可触发。
- DeepSeek Edition 首次在新机器用 docx/pdf 转换，先跑一次 `bash scripts/setup-converters.sh`。
- 信源提示：DeepSeek 由中国境内公司运营，转录全文会传输至其服务器处理（含内容审查）；涉敏感话题或需保护信源的访谈请改用两个订阅版。

项目主页：https://github.com/Logoutx/latepost-refiner
EOF

( cd "$TMP" && rm -f "$OUT/latepost-refiner.zip" && zip -rq "$OUT/latepost-refiner.zip" latepost-refiner/ )
echo "built $OUT/latepost-refiner.zip"
unzip -l "$OUT/latepost-refiner.zip" | awk 'NR<=2 || /\/$/ {print}' | head -12
