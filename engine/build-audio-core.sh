#!/bin/bash
# build-audio-core.sh —— 构建 dsh-stage-speak 的音频内核
#
# 为什么要有独立内核：纯 Node / ffmpeg 都拿不到 macOS 的 voice processing（AEC），
# 而"AEC 可用"是外放环境同时听说的前提（实测：外放回声只比底噪高约 5.5 dB）。
#
# 用法：
#   ./build-audio-core.sh            构建到同目录 audio-core
#   ./build-audio-core.sh --force    即使已存在也重建
#
# 依赖：macOS 自带 Swift 工具链（/usr/bin/swiftc）。无需完整 Xcode，Command Line Tools 即可。
# 实测：本机 `xcode-select -p` = /Library/Developer/CommandLineTools，可正常编译。
#
# ⚠️ 踩过的坑：早期版本写成 `swiftc ... | grep -v ...`，**管道会吞掉 swiftc 的退出码**，
#    于是编译失败也照样打印"已构建"，而目录里躺着的是**上一次的旧二进制** —— 假成功，
#    会让人误以为改动生效了。现在改为：先编译到临时文件 → 检查退出码 → 成功才 mv 覆盖。

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SELF_DIR/audio-core.swift"
OUT="$SELF_DIR/audio-core"
TMP="$SELF_DIR/.audio-core.build"
LOG="$SELF_DIR/.audio-core.build.log"

if [ ! -f "$SRC" ]; then
  echo "找不到源码: $SRC" >&2
  exit 1
fi

if [ -x "$OUT" ] && [ "${1:-}" != "--force" ]; then
  # 已存在且比源码新 → 不重复编译（首次之后启动很快）
  if [ "$OUT" -nt "$SRC" ]; then
    echo "audio-core 已是最新，跳过编译"
    exit 0
  fi
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc 不可用 —— 需要 macOS Command Line Tools（xcode-select --install）" >&2
  exit 1
fi

rm -f "$TMP"
# -O 优化；框架由 swiftc 按 import 自动带上。输出先落日志，避免管道吞退出码。
if ! swiftc -O "$SRC" -o "$TMP" > "$LOG" 2>&1; then
  echo "编译失败，错误如下：" >&2
  grep -v "libSwiftScan\|nonlib-dependency-scanner" "$LOG" >&2 || cat "$LOG" >&2
  rm -f "$TMP"
  exit 1
fi

if [ ! -x "$TMP" ]; then
  echo "编译似乎成功但没有产出可执行文件：$TMP" >&2
  rm -f "$LOG"
  exit 1
fi

mv -f "$TMP" "$OUT"
rm -f "$LOG"
echo "已构建: $OUT"
