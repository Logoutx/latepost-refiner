#!/usr/bin/env bash
# Build the release zip from this directory (claude-code-skill/) — a no-clone install path
# for the Claude Code skill: download from GitHub Releases (or build this locally) and unzip
# into ~/.claude/skills/, no `git clone` required. The zip's top-level dir is named
# latepost-refiner/ (= the deployed name, matching ~/.claude/skills/latepost-refiner).
# The skill now asks the user for the output folder on every run, so there is no
# longer a personal-vs-share path variant — just one zip.
# Usage: claude-code-skill/build-zips.sh [output dir, default ~/Downloads]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/Downloads}"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$TMP/latepost-refiner"
cp -R "$HERE" "$TMP/latepost-refiner"
rm -f "$TMP/latepost-refiner/build-zips.sh"   # don't ship the build script itself
( cd "$TMP" && rm -f "$OUT/latepost-refiner.zip" && zip -rq "$OUT/latepost-refiner.zip" latepost-refiner/ )
echo "built $OUT/latepost-refiner.zip"
