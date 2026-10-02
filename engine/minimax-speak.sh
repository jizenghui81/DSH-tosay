#!/bin/bash
# minimax-speak.sh —— dsh-stage-speak 的云端语音引擎
#
# 用途：接收一段中文，调 MiniMax T2A v2 合成，本地播放。
# 由插件以 `engine` 配置调用：<本脚本> -v <音色> "<要念的文本>"
#
# ⚠️ 关键：插件在 macOS 分支会注入 `-v <voice>` / `-r <rate>`，
#    所以**必须取最后一个 argv 当文本**，不能假定 argv[1] 是文本。
#
# ⚠️ 关键：MiniMax 出错**也返回 HTTP 200**，必须读 body 里的
#    base_resp.status_code；不校验就会写出假的空 mp3 并静默失败。
#
# 任何一步失败 → 回退系统 say，保证"必出声"。绝不向上抛错。
#
# 两种运行模式：
#   默认        —— 合成完**自己播**（afplay），保证"必出声"
#   MMX_SYNTH_ONLY=1 —— **只合成不播放**：把 mp3 的绝对路径打到 stdout 一行，交给调用方播放。
#                        半双工 barge-in 走这条：只有音频内核播出来的声音才带 AEC 参考，
#                        能被自己的 VAD 消掉回声；afplay 播的声音内核看不见，会被当成"你说话了"。
#                        该模式下失败回退**不发声**（否则 barge-in 语义自相矛盾），
#                        改为打 stderr + 非零退出码，让 Node 侧知道"没合成出来"。
#
# 配置优先级（高 → 低）：
#   1) 环境变量    MMX_MODEL / MMX_VOICE / MMX_FALLBACK_VOICE / MMX_SPEED / MMX_CACHE_MAX
#                  MMX_SYNTH_ONLY（只合成不播放）· MINIMAX_API_KEY（密钥）· MMX_CONFIG（mmx 配置文件路径）
#   2) 用户覆盖文件 ~/.dsh/tools/minimax-{model,voice}.txt
#   3) 包内默认文件 <本脚本同目录>/minimax-{model,voice}.txt   ← 随插件包分发，自包含
#   4) 内置默认
#
# 🔒 密钥来源（两种，都在仓库之外）：环境变量 MINIMAX_API_KEY，
#    或 mmx-cli 的 ~/.mmx/config.json。本仓库永不携带密钥。
#
# ⚠️ 为什么模型/音色走「配置文件」而不是环境变量：
#    插件每次播报都重新 spawn 本脚本，所以改配置文件**立即生效、不用重启 DSH**；
#    而环境变量要改 DSH 进程的环境，那必须重启。
#
# ⚠️ 「用户覆盖文件」优先于「包内默认」是刻意的：包目录会被 git pull / 重装覆盖，
#    用户的自定义不该放在那里。

set -uo pipefail

LOG="$HOME/.dsh/logs/minimax-speak.log"
CACHE="$HOME/.cache/dsh-stage-speak"
mkdir -p "$(dirname "$LOG")" "$CACHE" 2>/dev/null

# 本脚本所在目录 —— 包内自带默认配置就在旁边（随包分发，保证开箱可用）
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 取配置值：$1=环境变量值 $2=用户覆盖文件 $3=包内默认文件 $4=内置默认
read_conf() {
  if [ -n "$1" ]; then printf '%s' "$1"; return; fi
  local f
  for f in "$2" "$3"; do
    if [ -s "$f" ]; then head -1 "$f" | tr -d '\r\n'; return; fi
  done
  printf '%s' "$4"
}

MODEL=$(read_conf "${MMX_MODEL:-}" "$HOME/.dsh/tools/minimax-model.txt" "$SELF_DIR/minimax-model.txt" "speech-2.8-turbo")
VOICE=$(read_conf "${MMX_VOICE:-}" "$HOME/.dsh/tools/minimax-voice.txt" "$SELF_DIR/minimax-voice.txt" "Chinese (Mandarin)_Warm_Girl")
FALLBACK_VOICE="${MMX_FALLBACK_VOICE:-Tingting}"
SPEED="${MMX_SPEED:-1.0}"
CACHE_MAX="${MMX_CACHE_MAX:-300}"
# 「只合成不播放」开关：见文件头说明。任何非 "1" 的值都按老行为（自己播）。
SYNTH_ONLY="${MMX_SYNTH_ONLY:-0}"

log() {
  # 调用方传的是字面量 \t，printf 的 %s 不解释它 —— 这里手动换成真制表符
  local msg="${1//\\t/$'\t'}"
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >> "$LOG" 2>/dev/null
}

# ── 取最后一个 argv 作为文本（绕开插件的 -v/-r 注入）──────────────────────
TEXT="${!#}"
if [ -z "${TEXT// }" ]; then log "skip\t空文本"; exit 0; fi

# ── 本地脱敏（默认关闭；需要时在 redact 文件里一行一条 "原词=替换词"）────
REDACT_FILE="$HOME/.dsh/tools/minimax-redact.txt"
if [ -s "$REDACT_FILE" ]; then
  while IFS='=' read -r from to; do
    case "$from" in ''|\#*) continue;; esac
    [ -z "${to:-}" ] && to="某地"
    TEXT="${TEXT//$from/$to}"
  done < "$REDACT_FILE"
fi

# ── 缓存命中：直接播 ─────────────────────────────────────────────────────
HASH=$(printf '%s|%s|%s' "$MODEL" "$VOICE" "$TEXT" | shasum -a 256 | cut -c1-32)
MP3="$CACHE/$HASH.mp3"
if [ -s "$MP3" ]; then
  log "cache-hit\t${HASH}\t${MODEL}"
  # synth-only：只交路径，绝不在这里出声（出声会绕过内核 AEC 的回声参考）。
  if [ "$SYNTH_ONLY" = "1" ]; then printf '%s\n' "$MP3"; exit 0; fi
  afplay "$MP3" 2>/dev/null
  exit 0
fi

# ── 回退：系统 say（任何失败都走这里，保证必出声）───────────────────────
fallback() {
  log "fallback\t$1"
  # synth-only 下**不能**出声：调用方（音频内核路径）靠 stdout 的路径决定播什么，
  # 这里偷偷 say 一句会让"你说话时立刻停下"变成两路声音打架。
  # 于是改为 stderr + 非零码，让 Node 侧明确知道"这次没合成出来"。
  if [ "$SYNTH_ONLY" = "1" ]; then
    printf 'minimax-speak: 合成失败，synth-only 模式不出声：%s\n' "$1" >&2
    exit 1
  fi
  /usr/bin/say -v "$FALLBACK_VOICE" "$TEXT" 2>/dev/null || /usr/bin/say "$TEXT" 2>/dev/null
  exit 0
}

# ── 取 Key ──────────────────────────────────────────────────────────────
# 优先级：MINIMAX_API_KEY 环境变量 > mmx-cli 的配置文件。
# ⚠️ 两种来源都在仓库之外 —— 本仓库、以及本脚本，永远不包含任何密钥。
KEY="${MINIMAX_API_KEY:-}"
if [ -z "$KEY" ]; then
  CFG="${MMX_CONFIG:-$HOME/.mmx/config.json}"
  [ -f "$CFG" ] || fallback "无 api_key：既没设 MINIMAX_API_KEY，也没有 $CFG"
  KEY=$(/usr/bin/jq -r '.api_key // empty' "$CFG" 2>/dev/null)
fi
[ -n "$KEY" ] || fallback "api_key 为空"

# ── 调 API ──────────────────────────────────────────────────────────────
BODY=$(/usr/bin/jq -nc --arg m "$MODEL" --arg t "$TEXT" --arg v "$VOICE" --argjson s "$SPEED" \
  '{model:$m,text:$t,stream:false,
    voice_setting:{voice_id:$v,speed:$s,vol:1.0,pitch:0},
    audio_setting:{sample_rate:32000,bitrate:128000,format:"mp3"},
    output_format:"hex"}')

T0=$(date +%s%N 2>/dev/null || echo 0)
RESP=$(/usr/bin/curl -s --connect-timeout 5 --max-time 45 \
  -X POST "https://api.minimax.cn/v1/t2a_v2" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/dev/null)
[ -n "$RESP" ] || fallback "curl 空响应（网络不通？）"

CODE=$(printf '%s' "$RESP" | /usr/bin/jq -r '.base_resp.status_code // "?"' 2>/dev/null)
if [ "$CODE" != "0" ]; then
  MSG=$(printf '%s' "$RESP" | /usr/bin/jq -r '.base_resp.status_msg // "?"' 2>/dev/null)
  fallback "API 错误 code=$CODE msg=$MSG"
fi

# ── hex → mp3 ───────────────────────────────────────────────────────────
TMP="$CACHE/.$HASH.tmp"
if ! printf '%s' "$RESP" | /usr/bin/jq -r '.data.audio // empty' | /usr/bin/xxd -r -p > "$TMP" 2>/dev/null; then
  rm -f "$TMP"; fallback "hex 解码失败"
fi
if [ ! -s "$TMP" ]; then rm -f "$TMP"; fallback "音频为空"; fi
mv "$TMP" "$MP3"

T1=$(date +%s%N 2>/dev/null || echo 0)
CHARS=$(printf '%s' "$RESP" | /usr/bin/jq -r '.extra_info.usage_characters // "?"' 2>/dev/null)
MS=$(( (T1 - T0) / 1000000 ))
# 兼容 macOS 无 %N 的情况
[ "$T0" = "0" ] && MS="-"
log "ok\t${HASH}\t${MS}ms\t${CHARS}字符\t${VOICE}\t${MODEL}"

# ── 缓存修剪（防无界增长）───────────────────────────────────────────────
COUNT=$(ls -1 "$CACHE"/*.mp3 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$CACHE_MAX" ]; then
  ls -1t "$CACHE"/*.mp3 2>/dev/null | tail -n +$((CACHE_MAX + 1)) | while read -r f; do rm -f "$f"; done
  log "prune\t$COUNT -> $CACHE_MAX"
fi

# synth-only：把绝对路径交给调用方（Node 侧）去播；否则自己播。
if [ "$SYNTH_ONLY" = "1" ]; then
  printf '%s\n' "$MP3"
  exit 0
fi

afplay "$MP3" 2>/dev/null
exit 0
