#!/bin/bash
# Double-click this file in Finder to launch the local web app (no .app, no Apple cert).
# It starts the localhost server and opens your browser. Close the Terminal window to quit.
cd "$(dirname "$0")/.." || exit 1
if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖（npm install）…"
  npm install || { echo "依赖安装失败——请确认已装 Node.js（node -v）。"; exit 1; }
fi
echo "启动本地网页版…（浏览器会自动打开；按 Ctrl-C 退出）"
exec node universal/server.js
