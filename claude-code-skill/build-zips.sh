#!/usr/bin/env bash
# 从本目录（claude-code-skill/）打两个发布 zip，供上传 claude.ai 手动跑：
#   transcriber.zip       —— 个人版（保留 Obsidian 默认输出路径）
#   transcriber-share.zip —— 分享版（Obsidian 路径换成通用 ~/Documents/Research/<项目名>）
# zip 内顶层目录名为 transcriber/（= 部署名，对应 ~/.claude/skills/transcriber）。
# 用法：claude-code-skill/build-zips.sh [输出目录，默认 ~/Downloads]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/Downloads}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

build() {  # $1=zip 名  $2=是否泛化(yes/no)
  rm -rf "$TMP/transcriber"
  cp -R "$HERE" "$TMP/transcriber"
  rm -f "$TMP/transcriber/build-zips.sh"   # 不把构建脚本打进去
  if [ "$2" = "yes" ]; then
    python3 - "$TMP/transcriber/SKILL.md" <<'PY'
import sys
p = sys.argv[1]
c = open(p, encoding='utf-8').read()
c = c.replace(
    '~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Outer Mind/Company Research/<项目名>',
    '~/Documents/Research/<项目名>')
open(p, 'w', encoding='utf-8').write(c)
PY
  fi
  ( cd "$TMP" && rm -f "$OUT/$1" && zip -rq "$OUT/$1" transcriber/ )
  echo "built $OUT/$1"
}

build transcriber.zip       no
build transcriber-share.zip yes
