#!/usr/bin/env bash
# Build the per-edition release zips (one download per model, macOS-only project):
#
#   latepost-refiner-claude-skill.zip    latepost-refiner/  → drag into ~/.claude/skills/
#   latepost-refiner-codex-skill.zip     latepost-refiner/  → drag into the Codex skills dir
#   latepost-refiner-deepseek-mac.zip    LatePost-Refiner DeepSeek/ → unzip & double-click 启动.command
#                                        (no Node, no Homebrew: two Bun-compiled binaries, arm64 + x64,
#                                         the launcher picks by `uname -m`)
#
# The two skill zips keep an inner latepost-refiner/ layer: the folder name IS the deployed skill
# name, so drag-and-drop needs no rename. The DeepSeek zip needs bun on PATH (builder-side only;
# recipients need nothing) and a mac host for codesign — arm64 Macs kill unsigned binaries, so the
# ad-hoc signing inside build-binary.sh is load-bearing, and this script must run on macOS.
# Usage: build/build-release-zip.sh [output dir, default ~/Downloads]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Downloads}"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) Claude Code Skill
mkdir -p "$TMP/claude"
cp -R "$ROOT/claude-code-skill" "$TMP/claude/latepost-refiner"
rm -f "$TMP/claude/latepost-refiner/build-zips.sh"
( cd "$TMP/claude" && rm -f "$OUT/latepost-refiner-claude-skill.zip" && zip -rq "$OUT/latepost-refiner-claude-skill.zip" latepost-refiner/ )

# 2) Codex Skill
mkdir -p "$TMP/codex"
cp -R "$ROOT/codex-skill/latepost-refiner" "$TMP/codex/latepost-refiner"
( cd "$TMP/codex" && rm -f "$OUT/latepost-refiner-codex-skill.zip" && zip -rq "$OUT/latepost-refiner-codex-skill.zip" latepost-refiner/ )

# 3) DeepSeek Edition — unzip-and-run mac app: both arch binaries + a double-click launcher
DS="$TMP/LatePost-Refiner DeepSeek"
mkdir -p "$DS"
( cd "$ROOT" && TARGET=bun-darwin-arm64 bash build/build-binary.sh >/dev/null )
cp "$ROOT/dist/latepost-refiner-web" "$DS/latepost-refiner-web-arm64"
( cd "$ROOT" && TARGET=bun-darwin-x64 bash build/build-binary.sh >/dev/null )
cp "$ROOT/dist/latepost-refiner-web" "$DS/latepost-refiner-web-x64"

cat > "$DS/启动.command" <<'EOF'
#!/bin/bash
# LatePost-Refiner DeepSeek 版启动器：双击运行（第一次要右键 → 打开）。
# 按芯片自选二进制、清除下载隔离标记、起本地服务、开浏览器。关闭本窗口即停止。
cd "$(dirname "$0")"
if [ "$(uname -m)" = "arm64" ]; then BIN="./latepost-refiner-web-arm64"; else BIN="./latepost-refiner-web-x64"; fi
xattr -dr com.apple.quarantine . 2>/dev/null || true
chmod +x "$BIN" 2>/dev/null || true
( sleep 1.5; open "http://127.0.0.1:8765" ) &
echo "LatePost-Refiner 本地网页版启动中——浏览器没自动打开就访问 http://127.0.0.1:8765"
echo "（用完关掉这个窗口即可停止）"
exec "$BIN"
EOF
chmod +x "$DS/启动.command"

cat > "$DS/README.md" <<'EOF'
# LatePost-Refiner · DeepSeek 版（Mac 免安装）

1. 右键点 `启动.command` → 打开（只有第一次需要右键；之后双击即可）。
2. 浏览器会自动打开本地页面；DeepSeek / Tavily 的 API key 直接填在网页里，只在内存、不落盘。
3. 用完关掉那个终端窗口就停了。

- 不用装 Node、不用装 Homebrew；Apple Silicon 和 Intel 芯片都能用（启动器自动挑）。
- .txt / .md / .srt / .docx 开箱即用；.pdf 等更多格式想自动转换，先跑一次 `安装转换器`（可选，见项目主页说明）。
- 信源提示：DeepSeek 由中国境内公司运营，转录全文会传输至其服务器处理（含内容审查）；涉敏感话题或需保护信源的访谈请改用 Claude / Codex 技能版。

项目主页：https://github.com/Logoutx/latepost-refiner
EOF

( cd "$TMP" && rm -f "$OUT/latepost-refiner-deepseek-mac.zip" && zip -rq "$OUT/latepost-refiner-deepseek-mac.zip" "LatePost-Refiner DeepSeek/" )

echo "built:"
ls -lh "$OUT"/latepost-refiner-*.zip | awk '{print "  " $9 " (" $5 ")"}'
