#!/usr/bin/env bash
# Build the standalone, no-install macOS web app:
#   1. embed web/index.html + references/*.md into universal/embedded-assets.js
#   2. bun build --compile → one self-contained executable (the Bun runtime is baked in)
# End users just download dist/latepost-refiner-web and double-click — no Node, no npm, no Python
# (.docx is handled in-process by mammoth; .pptx/.xlsx/.pdf still want markitdown on PATH).
#
# Usage: bash build/build-binary.sh                          # arm64 (Apple Silicon)
#        TARGET=bun-darwin-x64 bash build/build-binary.sh    # Intel Macs
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
export PATH="/opt/homebrew/bin:$PATH"

command -v bun >/dev/null || { echo "需要 bun：brew install bun"; exit 1; }

TARGET="${TARGET:-bun-darwin-arm64}"
OUT="dist/latepost-refiner-web"
mkdir -p dist

echo "→ 内嵌静态资源（index.html + references）…"
node build/embed-assets.mjs

echo "→ 编译单文件可执行（$TARGET）…"
bun build universal/bin-web.js --compile --target="$TARGET" --outfile "$OUT"

rm -f .*.bun-build 2>/dev/null || true   # tidy Bun's compile intermediates

# Ad-hoc sign so macOS doesn't kill the unsigned arm64 binary on first launch.
codesign --force --sign - "$OUT" 2>/dev/null || true

SIZE="$(du -h "$OUT" | cut -f1)"
echo ""
echo "✓ 完成：$HERE/$OUT（$SIZE）"
echo ""
echo "分发说明（下载后首次运行，macOS 会拦一次未签名程序）："
echo "  · 右键点它 → 打开（只需一次），或"
echo "  · 终端跑：xattr -dr com.apple.quarantine \"$OUT\""
echo "  启动后浏览器访问 http://127.0.0.1:8765"
