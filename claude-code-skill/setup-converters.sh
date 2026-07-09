#!/usr/bin/env bash
# GENERATED FILE — DO NOT EDIT. Source: scripts/setup-converters.sh. Regenerate: npm run sync:skills
# setup-converters.sh — install the local document→Markdown converters that
# LatePost-Refiner's Step-0 preflight uses, so .docx/.pptx/.xlsx/.pdf inputs
# can be turned into Markdown before refining. Both the Claude Code skill and
# the Codex skill shell out to these on the user's machine.
#
#   markitdown  — .docx / .pptx / .xlsx / simple .pdf   (the workhorse)
#   docling     — complex / multi-column / table-heavy .pdf
#
# Idempotent: whatever is already on PATH is left untouched, so it is safe to
# run on every machine and safe to re-run. Installs into isolated, per-tool
# environments via uv (preferred) or pipx.
#
# Usage:
#   bash setup-converters.sh                # ensure markitdown + docling
#   bash setup-converters.sh --no-docling   # markitdown only (skip the heavy PDF-layout model)
#   bash setup-converters.sh --check        # report status only, install nothing
#
# On a bare Mac it needs only curl (built in): it fetches uv, which brings its
# own Python — no Homebrew, no system Python, no Xcode tools. If uv or pipx is
# already installed, it uses that instead.
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

# --- choose an installer; bootstrap one if the machine has none ---
# Preference: an existing uv or pipx (respect what's there) -> bootstrap uv (one
# download via curl, brings its own Python) -> pipx via brew/pip. uv is the kind
# path for a bare Mac: no Homebrew, no system Python, no Xcode tools required.
INSTALLER=""
if   have uv;   then INSTALLER=uv
elif have pipx; then INSTALLER=pipx
fi
if [ -z "$INSTALLER" ] && have curl; then
  echo "-> no installer found; fetching uv (self-contained, needs no Python)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh || true
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if have uv; then INSTALLER=uv; fi
fi
if [ -z "$INSTALLER" ]; then
  echo "-> falling back to pipx..."
  if   have brew;    then brew install pipx
  elif have apt-get; then sudo apt-get update -qq && sudo apt-get install -y pipx
  elif have python3; then python3 -m pip install --user pipx
  else echo "ERROR: could not bootstrap an installer (need curl, Homebrew, or python3)." >&2; exit 1
  fi
  ( python3 -m pipx ensurepath >/dev/null 2>&1 || pipx ensurepath >/dev/null 2>&1 || true )
  INSTALLER=pipx
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"   # reach freshly-installed shims in THIS shell

PYFLAG=""
if [ "$INSTALLER" = pipx ] && have python3.12; then PYFLAG="--python python3.12"; fi

install_tool() {   # $1 = package spec
  case "$INSTALLER" in
    # pin 3.12: markitdown[all]/docling need Python >=3.10, and a bare Mac's
    # system python is often 3.9 — uv fetches a managed 3.12 if none is present.
    uv)   uv tool install --python 3.12 "$1" ;;
    pipx) pipx install $PYFLAG "$1" ;;
  esac
}

if [ "$need_markitdown" -eq 1 ]; then
  echo "-> installing markitdown via $INSTALLER (docx / pptx / xlsx + simple pdf)..."
  install_tool 'markitdown[all]'
fi
if [ "$need_docling" -eq 1 ]; then
  echo "-> installing docling via $INSTALLER (complex pdf; ML models, hundreds of MB, slow first run)..."
  install_tool docling
fi
if [ "$INSTALLER" = uv ]; then uv tool update-shell >/dev/null 2>&1 || true; fi

echo
echo "Result:"
report
echo
if have markitdown; then
  echo "Done. A new terminal will pick these up automatically. If a fresh shell still"
  echo "can't find them, close and reopen the terminal (the tools live in ~/.local/bin)."
else
  echo "markitdown still not on PATH — close and reopen the terminal, or add ~/.local/bin"
  echo "to your PATH (that is where the installer placed the tools)."
fi
