#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org/"
  read -p "按回车关闭..." _
  exit 1
fi
node install-scene-editor.mjs
echo
read -p "按回车关闭..." _
