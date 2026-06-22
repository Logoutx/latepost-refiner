#!/usr/bin/env bash
# Build two release zips from this directory (claude-code-skill/) for manual upload to claude.ai:
#   latepost-refiner.zip       —— personal build (keeps the default Obsidian output path)
#   latepost-refiner-share.zip —— share build (Obsidian path swapped for the generic ~/Documents/Research/<项目名>)
# The zip's top-level dir is named latepost-refiner/ (= the deployed name, matching ~/.claude/skills/latepost-refiner).
# Usage: claude-code-skill/build-zips.sh [output dir, default ~/Downloads]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/Downloads}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

build() {  # $1=zip name  $2=genericize? (yes/no)
  rm -rf "$TMP/latepost-refiner"
  cp -R "$HERE" "$TMP/latepost-refiner"
  rm -f "$TMP/latepost-refiner/build-zips.sh"   # don't ship the build script itself
  if [ "$2" = "yes" ]; then
    python3 - "$TMP/latepost-refiner/SKILL.md" <<'PY'
import sys
p = sys.argv[1]
c = open(p, encoding='utf-8').read()
c = c.replace(
    '~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Outer Mind/Company Research/<项目名>',
    '~/Documents/Research/<项目名>')
open(p, 'w', encoding='utf-8').write(c)
PY
  fi
  ( cd "$TMP" && rm -f "$OUT/$1" && zip -rq "$OUT/$1" latepost-refiner/ )
  echo "built $OUT/$1"
}

build latepost-refiner.zip       no
build latepost-refiner-share.zip yes
