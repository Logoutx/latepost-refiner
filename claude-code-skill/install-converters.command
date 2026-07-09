#!/bin/bash
# GENERATED FILE — DO NOT EDIT. Source: scripts/install-converters.command. Regenerate: npm run sync:skills
# ── Double-click this file in Finder to install the document converter. ──
# First time only: macOS may say it is from an "unidentified developer".
# Right-click (or Control-click) this file → Open → Open. After that, a normal
# double-click works. This installs markitdown so the tool can read .docx /
# .pptx / .xlsx and simple PDFs. It is safe to run again any time.
cd "$(dirname "$0")" || exit 1

echo "================================================================"
echo "  LatePost-Refiner — installing the document → Markdown converter"
echo "================================================================"
echo
echo "This only installs what is missing, and is safe to run more than once."
echo "It may take a few minutes the first time. Please leave this window open."
echo

# markitdown only by default — covers Word/PowerPoint/Excel + simple PDFs and is
# a small, fast install. (docling, for complex/multi-column PDFs, is large; see
# the note at the end.)
bash "./setup-converters.sh" --no-docling
code=$?

echo
if [ "$code" -eq 0 ]; then
  echo "✅  All set. You can close this window now."
  echo
  echo "Need complex/scanned/multi-column PDF support too? (large download, optional)"
  echo "    run:  bash \"$(pwd)/setup-converters.sh\""
else
  echo "⚠️  Something went wrong (exit $code). Check your internet connection and"
  echo "    try again, or send this window's text to whoever shared the tool with you."
fi
echo
read -r -p "Press Return to close this window… " _ || true
