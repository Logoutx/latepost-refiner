#!/usr/bin/env bash
# setup-converters.sh — install the local document→Markdown converters that
# LatePost-Refiner's Step-0 preflight uses, so .docx/.pptx/.xlsx/.pdf inputs
# can be turned into Markdown before refining. Both the Claude Code skill and
# the Codex skill shell out to these on the user's machine.
#
#   markitdown  — .docx / .pptx / .xlsx / simple .pdf   (the workhorse)
#   docling     — complex / multi-column / table-heavy .pdf
#
# Idempotent: whatever is already on PATH is left untouched, so it is safe to
# run on every machine and safe to re-run. Installs via pipx (isolated venvs).
#
# Usage:
#   bash setup-converters.sh                # ensure markitdown + docling
#   bash setup-converters.sh --no-docling   # markitdown only (skip the heavy PDF-layout model)
#   bash setup-converters.sh --check        # report status only, install nothing
#
# Needs Python 3.10+ and one of: Homebrew / apt-get / pip (to bootstrap pipx).
set -euo pipefail

WANT_DOCLING=1
CHECK_ONLY=0

usage() {
  cat <<'EOF'
setup-converters.sh — install local document→Markdown converters (idempotent)

  markitdown   .docx / .pptx / .xlsx + simple .pdf
  docling      complex / multi-column / table-heavy .pdf

Usage:
  bash setup-converters.sh               ensure markitdown + docling
  bash setup-converters.sh --no-docling  markitdown only (skip the heavy PDF model)
  bash setup-converters.sh --check       report status, install nothing
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-docling) WANT_DOCLING=0 ;;
    --check)      CHECK_ONLY=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

report() {
  if have markitdown; then echo "  markitdown  [ok]  $(command -v markitdown)"; else echo "  markitdown  [--]  not installed"; fi
  if [ "$WANT_DOCLING" -eq 1 ]; then
    if have docling; then echo "  docling     [ok]  $(command -v docling)"; else echo "  docling     [--]  not installed"; fi
  fi
}

echo "LatePost-Refiner — document to Markdown converters"
report

if [ "$CHECK_ONLY" -eq 1 ]; then exit 0; fi

need_markitdown=0
have markitdown || need_markitdown=1
need_docling=0
if [ "$WANT_DOCLING" -eq 1 ] && ! have docling; then need_docling=1; fi

if [ "$need_markitdown" -eq 0 ] && [ "$need_docling" -eq 0 ]; then
  echo "Already installed — nothing to do."
  exit 0
fi

# --- bootstrap pipx if missing ---
if ! have pipx; then
  echo "-> pipx not found; installing it..."
  if   have brew;    then brew install pipx
  elif have apt-get; then sudo apt-get update -qq && sudo apt-get install -y pipx
  elif have python3; then python3 -m pip install --user pipx
  else echo "ERROR: need Homebrew, apt-get, or python3+pip to install pipx." >&2; exit 1
  fi
  ( python3 -m pipx ensurepath >/dev/null 2>&1 || pipx ensurepath >/dev/null 2>&1 || true )
fi
export PATH="$HOME/.local/bin:$PATH"   # pipx puts shims here; reach them in THIS shell too

# prefer Python 3.12 (matches the standard setup) when available
PYFLAG=""
have python3.12 && PYFLAG="--python python3.12"

if [ "$need_markitdown" -eq 1 ]; then
  echo "-> installing markitdown (docx / pptx / xlsx + simple pdf)..."
  pipx install $PYFLAG 'markitdown[all]'
fi
if [ "$need_docling" -eq 1 ]; then
  echo "-> installing docling (complex pdf; pulls ML layout models, hundreds of MB, slow first run)..."
  pipx install $PYFLAG docling
fi

echo
echo "Result:"
report
echo
if have markitdown; then
  echo "Done. A new terminal picks these up automatically; if a fresh shell still can't"
  echo "find them, run 'pipx ensurepath' and reopen the terminal."
else
  echo "markitdown still not on PATH — open a new terminal (pipx installs to ~/.local/bin)"
  echo "or run: pipx ensurepath"
fi
