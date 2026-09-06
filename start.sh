#!/usr/bin/env bash
#
# Microduck AR 一键启动脚本
#
#   ./start.sh              仅本机访问 http://localhost:5173
#   ./start.sh --tunnel     额外开 cloudflared 隧道，拿到公网 HTTPS 地址（手机 AR 用）
#   ./start.sh --build      构建生产版本并用 preview 服务托管
#   ./start.sh --port 5300  指定端口
#
# 环境说明（本机实测）：
#   - vite 的文件监视需要 inotify 实例，本机配额常被 IDE 占满导致 EMFILE 崩溃。
#     脚本会先正常启动，若检测到 EMFILE 自动回退到轮询模式。
#   - 本机有 http_proxy，探活一律绕过代理，否则本地请求会被代理吞掉返回 502。

set -uo pipefail

cd "$(dirname "$(readlink -f "$0")")"

PORT=5173
USE_TUNNEL=0
DO_BUILD=0
NPM_MIRROR="https://registry.npmmirror.com"

usage() {
  cat <<'USAGE'
Microduck AR 一键启动脚本

  ./start.sh              仅本机访问 http://localhost:5173
  ./start.sh --tunnel     额外开 cloudflared 隧道，拿到公网 HTTPS 地址（手机 AR 用）
  ./start.sh --build      构建生产版本并用 preview 服务托管
  ./start.sh --port 5300  指定端口
  ./start.sh --help       显示本帮助
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel) USE_TUNNEL=1; shift ;;
    --build)  DO_BUILD=1; shift ;;
    --port)   PORT="${2:?--port 需要一个端口号}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

# ── 输出helpers ────────────────────────────────────────────────
c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
c_step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }

# 本机有 http_proxy，本地探活必须绕过代理，否则会被代理吞掉返回 502。
# 注意：写成变量 CURL="curl --noproxy *" 会让 * 被 shell 通配成文件名，必须用函数。
lcurl() { curl -s --noproxy '*' "$@"; }

# ── 退出时清理所有子进程 ───────────────────────────────────────
PIDS=()
CLEANED=0
cleanup() {
  (( CLEANED )) && return          # EXIT 与 INT/TERM 会重复触发，只清理一次
  CLEANED=1
  # If a preflight check failed, PIDS is empty and there is no child process
  # owned by this script to stop. Do not claim that an unrelated port holder
  # was terminated.
  ((${#PIDS[@]})) || return
  local p
  for p in "${PIDS[@]:-}"; do
    [[ -n "$p" ]] && pkill -P "$p" 2>/dev/null   # 先收孙进程（vite/cloudflared 有子进程）
    [[ -n "$p" ]] && kill "$p" 2>/dev/null
  done
  printf '\n'
  c_ok "已停止所有服务，端口已释放"
}
trap cleanup EXIT INT TERM

# ── 1. 前置检查 ────────────────────────────────────────────────
c_step "环境检查"

command -v node >/dev/null || { c_err "未找到 node，请先安装 Node.js 16+"; exit 1; }
command -v npm  >/dev/null || { c_err "未找到 npm"; exit 1; }

NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if (( NODE_MAJOR < 16 )); then
  c_err "Node 版本过低：$(node -v)，需要 16+"; exit 1
fi
c_ok "node $(node -v) / npm $(npm -v)"

# LFS 资源完整性：指针文件通常只有一两百字节
if [[ -d public ]]; then
  PTR=$(find public -type f \( -name '*.onnx' -o -name '*.stl' -o -name '*.glb' \) -size -1k 2>/dev/null | wc -l)
  if (( PTR > 0 )); then
    c_warn "检测到 $PTR 个 Git LFS 指针文件（模型/网格未真正下载）"
    c_warn "请执行：git lfs install && git lfs pull"
  else
    c_ok "LFS 二进制资源完整"
  fi
fi

# 端口占用
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  c_err "端口 $PORT 已被占用。换一个：./start.sh --port 5300"
  c_warn "占用端口的服务不属于本脚本，本次不会自动终止它"
  exit 1
fi
c_ok "端口 $PORT 空闲"

# ── 2. 依赖 ────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  c_step "安装依赖（首次运行，使用国内镜像）"
  npm install --registry="$NPM_MIRROR" || { c_err "依赖安装失败"; exit 1; }
  c_ok "依赖安装完成"
else
  c_ok "依赖已就绪（node_modules 存在）"
fi

# ── 3. 启动服务 ────────────────────────────────────────────────
LOG=$(mktemp -t microduck-ar.XXXXXX.log)

start_server() {
  # $1 = 1 表示启用轮询监视
  local polling="$1"
  if (( DO_BUILD )); then
    npm run preview -- --port "$PORT" --host >"$LOG" 2>&1 &
  elif (( polling )); then
    CHOKIDAR_USEPOLLING=1 npm run dev -- --port "$PORT" --host >"$LOG" 2>&1 &
  else
    npm run dev -- --port "$PORT" --host >"$LOG" 2>&1 &
  fi
  SERVER_PID=$!
  PIDS+=("$SERVER_PID")
}

wait_ready() {
  # 最多等 30 秒，服务能返回 200 即算就绪
  local code
  for _ in $(seq 1 60); do
    kill -0 "$SERVER_PID" 2>/dev/null || return 1   # 进程已死，立刻放弃
    code=$(lcurl -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$PORT/" 2>/dev/null)
    [[ "$code" == "200" ]] && return 0
    sleep 0.5
  done
  return 1
}

if (( DO_BUILD )); then
  c_step "构建生产版本"
  npm run build || { c_err "构建失败"; exit 1; }
  c_ok "构建完成 → dist/"
  c_step "启动 preview 服务"
  start_server 0
else
  c_step "启动开发服务器"
  start_server 0
fi

if ! wait_ready; then
  if grep -q "EMFILE" "$LOG" 2>/dev/null; then
    c_warn "inotify 实例配额耗尽（EMFILE），自动切换到轮询监视模式…"
    c_warn "根治方法：sudo sysctl -w fs.inotify.max_user_instances=1024"
    kill "$SERVER_PID" 2>/dev/null
    sleep 1
    start_server 1
    if ! wait_ready; then
      c_err "服务启动失败，日志如下："; cat "$LOG"; exit 1
    fi
  else
    c_err "服务启动失败，日志如下："; cat "$LOG"; exit 1
  fi
fi

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
c_ok "服务已就绪"

# ── 4. 隧道（可选） ────────────────────────────────────────────
TUNNEL_URL=""
if (( USE_TUNNEL )); then
  c_step "开启公网隧道"
  cat <<'WARN'
  ⚠️  你即将把本机的 dev server 通过 cloudflared 暴露到公网：
       · 任何拿到该 URL 的人都能访问你这台机器上的这个服务
       · URL 是随机的临时地址，关闭脚本即失效，但期间无任何鉴权
       · 若本机尚无 cloudflared，会从 GitHub 下载约 35MB 二进制到 ./.tools/
     仅在你确实需要用手机测 AR 时才继续。
WARN
  read -r -p "  确认开启公网隧道？输入 yes 继续，其它任意键跳过：" _ans
  if [[ "$_ans" != "yes" ]]; then
    c_warn "已跳过隧道，仅本地访问"
    USE_TUNNEL=0
  fi
fi

if (( USE_TUNNEL )); then
  CFD="./.tools/cloudflared"
  if command -v cloudflared >/dev/null; then
    CFD=$(command -v cloudflared)
  elif [[ ! -x "$CFD" ]]; then
    c_warn "首次使用，下载 cloudflared（约 35MB）…"
    mkdir -p .tools
    if ! curl -fL --progress-bar -o "$CFD" \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64; then
      c_err "cloudflared 下载失败，可改用：npx localtunnel --port $PORT"
      USE_TUNNEL=0
    else
      chmod +x "$CFD"
      c_ok "cloudflared 已安装到 $CFD"
    fi
  fi

  if (( USE_TUNNEL )); then
    TLOG=$(mktemp -t microduck-tunnel.XXXXXX.log)
    "$CFD" tunnel --url "http://localhost:$PORT" >"$TLOG" 2>&1 &
    PIDS+=("$!")
    for _ in $(seq 1 40); do
      TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TLOG" 2>/dev/null | head -1)
      [[ -n "$TUNNEL_URL" ]] && break
      sleep 0.5
    done
    if [[ -n "$TUNNEL_URL" ]]; then
      c_ok "隧道已建立"
    else
      c_warn "隧道地址获取超时，日志：$TLOG"
    fi
  fi
fi

# ── 5. 汇总 ────────────────────────────────────────────────────
cat <<EOF

╭──────────────────────────────────────────────────────────╮
│  🐤  Microduck AR 已启动                                  │
╰──────────────────────────────────────────────────────────╯

  本机（3D 预览）   http://localhost:$PORT/
  局域网            http://${LAN_IP:-<本机IP>}:$PORT/   ← 非 HTTPS，手机上没有 AR 按钮
EOF

if [[ -n "$TUNNEL_URL" ]]; then
  cat <<EOF
  手机 AR（HTTPS）  $TUNNEL_URL
                    ↑ Android Chrome 打开可点 START AR
EOF
else
  cat <<EOF

  想在手机上跑 AR？WebXR 必须 HTTPS，重开脚本加 --tunnel：
      ./start.sh --tunnel
EOF
fi

cat <<'EOF'

  桌面浏览器点 [3D PREVIEW]，WASD / 方向键操控（START AR 在桌面是灰的，正常）

  按 Ctrl+C 停止
EOF

wait "$SERVER_PID"
