#!/usr/bin/env bash
# =============================================================================
# medharness cloud_bootstrap.sh — runs INSIDE the private Kaggle kernel.
#
# Brings up the split-brain inference node on Kaggle's 2× Tesla T4:
#   GPU0  vLLM        reasoner  (II-Medical-8B, GPTQ W4A16 → Marlin kernel,
#                                prefix caching, qwen3 reasoning parser)
#   GPU1  llama.cpp   vision    (MedGemma 1.5 4B Q8_0 + F16 mmproj)
#   CPU   router.py   bearer-auth gateway + idle watchdog      127.0.0.1:8000
#   CPU   cloudflared quick tunnel → https://<random>.trycloudflare.com
#
# The desktop harness never sees a shell: it pushes this kernel through the
# Kaggle API and reads the log for machine-readable lines:
#   MEDHARNESS_STAGE name=<stage>
#   MEDHARNESS_READY url=<https://…trycloudflare.com>
#   MEDHARNESS_FAILED stage=<stage> reason=<text>
#   MEDHARNESS_STOPPED reason=<text>
#
# Tunables (environment; the remediation planner may only change these):
#   MEDHARNESS_MODE=dual|single   MAX_MODEL_LEN   GPU_MEM_UTIL   MAX_NUM_SEQS
#   VISION_CTX   ENFORCE_EAGER=0|1
# Never logs request bodies, the bearer token, or anything clinical.
# =============================================================================
set -Eeuo pipefail

: "${SESSION_BEARER_TOKEN:?SESSION_BEARER_TOKEN is required}"
REASONER_NAME="${REASONER_NAME:-ii-medical-8b}"
VISION_NAME="${VISION_NAME:-medgemma-1.5-4b}"
VLLM_VERSION="${VLLM_VERSION:-0.31.0}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.10.0}"
CLOUDFLARED_SHA256="${CLOUDFLARED_SHA256:-d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db}"
VISION_GGUF_URL="${VISION_GGUF_URL:-https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/medgemma-1.5-4b-it-Q8_0.gguf}"
VISION_MMPROJ_URL="${VISION_MMPROJ_URL:-https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/mmproj-F16.gguf}"
MEDHARNESS_MODE="${MEDHARNESS_MODE:-auto}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-16384}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.92}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-8}"
VISION_CTX="${VISION_CTX:-8192}"
ENFORCE_EAGER="${ENFORCE_EAGER:-0}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-1200}"
MAX_SESSION="${MAX_SESSION:-41400}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-2400}"
WORK="${MEDHARNESS_WORK:-/tmp/medharness}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STAGE="init"
PIDS=()
mkdir -p "$WORK/logs"

stage() { STAGE="$1"; echo "MEDHARNESS_STAGE name=$1 t=$SECONDS"; }
fail() {
  echo "MEDHARNESS_FAILED stage=$STAGE reason=$1"
  for f in "$WORK"/logs/*.log; do
    [ -f "$f" ] || continue
    echo "----- tail $(basename "$f") -----"
    # Boot logs only (no traffic has been served yet); scrub the token defensively.
    tail -n 60 "$f" | sed "s/${SESSION_BEARER_TOKEN}/[token]/g"
  done
  exit 1
}
cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  sleep 2
  for pid in "${PIDS[@]:-}"; do kill -9 "$pid" 2>/dev/null || true; done
  [ "$code" -eq 0 ] && echo "MEDHARNESS_STOPPED reason=${STOP_REASON:-router exited}"
}
trap 'fail "command failed at line $LINENO"' ERR
trap cleanup EXIT

wait_http() { # url timeout_s pid label
  local url="$1" timeout="$2" pid="$3" label="$4" start=$SECONDS
  until curl -fsS -o /dev/null --max-time 5 "$url"; do
    kill -0 "$pid" 2>/dev/null || fail "$label process exited during start-up"
    (( SECONDS - start > timeout )) && fail "$label not healthy after ${timeout}s"
    sleep 5
  done
}

# --- 1. GPUs -----------------------------------------------------------------
stage gpu
command -v nvidia-smi >/dev/null || fail "no NVIDIA driver — enable the GPU accelerator (T4 x2)"
GPU_COUNT="$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)"
nvidia-smi --query-gpu=index,name,memory.total,compute_cap --format=csv,noheader
if [ "$MEDHARNESS_MODE" = auto ]; then
  if [ "$GPU_COUNT" -ge 2 ]; then MEDHARNESS_MODE=dual; else MEDHARNESS_MODE=single; fi
fi
if [ "$MEDHARNESS_MODE" = single ]; then
  # One 16 GB card: share it. W4A16 8B ≈ 5.7 GB + KV; MedGemma Q8_0 + mmproj ≈ 5.2 GB.
  REASONER_GPU=0; VISION_GPU=0
  GPU_MEM_UTIL="$(python3 -c "print(min(float('$GPU_MEM_UTIL'), 0.55))")"
  (( MAX_MODEL_LEN > 8192 )) && MAX_MODEL_LEN=8192
  (( VISION_CTX > 4096 )) && VISION_CTX=4096
else
  [ "$GPU_COUNT" -ge 2 ] || fail "dual mode needs 2 GPUs, found $GPU_COUNT"
  REASONER_GPU=0; VISION_GPU=1
fi
echo "mode=$MEDHARNESS_MODE gpus=$GPU_COUNT max_model_len=$MAX_MODEL_LEN gpu_mem=$GPU_MEM_UTIL vision_ctx=$VISION_CTX"

# --- 2. Artifacts from the one-time "prepare" kernel ---------------------------
stage artifacts
MARKER="$(find /kaggle/input -maxdepth 6 -name MEDHARNESS_ARTIFACTS.json 2>/dev/null | head -n 1 || true)"
[ -n "$MARKER" ] || fail "prepared artifacts not attached — run /cloud prepare once, then /cloud start"
ART="$(dirname "$MARKER")"
REASONER_DIR="$ART/reasoner"
LLAMA_SERVER="$ART/bin/llama-server"
[ -f "$REASONER_DIR/config.json" ] || fail "quantized reasoner missing in $ART"
[ -f "$LLAMA_SERVER" ] || fail "llama-server binary missing in $ART"
cp "$LLAMA_SERVER" "$WORK/llama-server" && chmod +x "$WORK/llama-server"   # inputs are read-only/noexec
if [ -f "$ART/vision/model.gguf" ] && [ -f "$ART/vision/mmproj.gguf" ]; then
  VISION_GGUF="$ART/vision/model.gguf"; VISION_MMPROJ="$ART/vision/mmproj.gguf"
else
  VISION_GGUF="$WORK/model.gguf"; VISION_MMPROJ="$WORK/mmproj.gguf"
  curl -fL --retry 3 -o "$VISION_GGUF" "$VISION_GGUF_URL"
  curl -fL --retry 3 -o "$VISION_MMPROJ" "$VISION_MMPROJ_URL"
fi

# --- 3. Runtime packages ------------------------------------------------------
stage install
python3 -m pip install --quiet --disable-pip-version-check --no-warn-conflicts \
  "vllm==${VLLM_VERSION}" "aiohttp>=3.9" > "$WORK/logs/pip.log" 2>&1 || fail "pip install vllm==${VLLM_VERSION} failed"
curl -fsSL --retry 3 -o "$WORK/cloudflared" \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64"
echo "${CLOUDFLARED_SHA256}  $WORK/cloudflared" | sha256sum -c --quiet - || fail "cloudflared checksum mismatch"
chmod +x "$WORK/cloudflared"

# --- 4. Reasoner: vLLM on GPU0 -------------------------------------------------
stage reasoner
VLLM_ARGS=(
  serve "$REASONER_DIR"
  --served-model-name "$REASONER_NAME"
  --host 127.0.0.1 --port 8001
  --dtype float16                       # T4 has no bf16
  --max-model-len "$MAX_MODEL_LEN"
  --gpu-memory-utilization "$GPU_MEM_UTIL"
  --max-num-seqs "$MAX_NUM_SEQS"
  --enable-prefix-caching
  --reasoning-parser qwen3              # <think>…</think> → reasoning_content deltas
  --generation-config vllm
)
[ "$ENFORCE_EAGER" = 1 ] && VLLM_ARGS+=(--enforce-eager)
CUDA_VISIBLE_DEVICES="$REASONER_GPU" VLLM_API_KEY="$SESSION_BEARER_TOKEN" \
  nohup vllm "${VLLM_ARGS[@]}" > "$WORK/logs/vllm.log" 2>&1 &
VLLM_PID=$!; PIDS+=("$VLLM_PID")

# In single mode the vision server must start after vLLM has claimed its share.
if [ "$MEDHARNESS_MODE" = single ]; then wait_http http://127.0.0.1:8001/health "$BOOT_TIMEOUT" "$VLLM_PID" vLLM; fi

# --- 5. Vision: llama.cpp on GPU1 -----------------------------------------------
stage vision
CUDA_VISIBLE_DEVICES="$VISION_GPU" LLAMA_API_KEY="$SESSION_BEARER_TOKEN" \
  nohup "$WORK/llama-server" -m "$VISION_GGUF" --mmproj "$VISION_MMPROJ" \
    -ngl 999 -c "$VISION_CTX" -np 2 --jinja \
    --host 127.0.0.1 --port 8002 --alias "$VISION_NAME" > "$WORK/logs/llama.log" 2>&1 &
LLAMA_PID=$!; PIDS+=("$LLAMA_PID")

wait_http http://127.0.0.1:8001/health "$BOOT_TIMEOUT" "$VLLM_PID" vLLM
wait_http http://127.0.0.1:8002/health 900 "$LLAMA_PID" llama-server
grep -m1 -oiE "(marlin[a-z_]*kernel|using [a-z_]*marlin[a-z_]*)" "$WORK/logs/vllm.log" | sed 's/^/quant kernel: /' || echo "quant kernel: (not reported)"

# --- 6. Router ---------------------------------------------------------------------
stage router
SESSION_BEARER_TOKEN="$SESSION_BEARER_TOKEN" REASONER_NAME="$REASONER_NAME" VISION_NAME="$VISION_NAME" \
  IDLE_TIMEOUT="$IDLE_TIMEOUT" MAX_SESSION="$MAX_SESSION" \
  nohup python3 "$HERE/router.py" > "$WORK/logs/router.log" 2>&1 &
ROUTER_PID=$!; PIDS+=("$ROUTER_PID")
start=$SECONDS
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8000/healthz || true)" = 401 ]; do
  kill -0 "$ROUTER_PID" 2>/dev/null || fail "router exited"
  (( SECONDS - start > 60 )) && fail "router did not start"
  sleep 1
done

# --- 7. Tunnel -------------------------------------------------------------------------
stage tunnel
nohup "$WORK/cloudflared" tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:8000 \
  > "$WORK/logs/cloudflared.log" 2>&1 &
CF_PID=$!; PIDS+=("$CF_PID")
URL=""
for _ in $(seq 1 90); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$WORK/logs/cloudflared.log" | head -n 1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$CF_PID" 2>/dev/null || fail "cloudflared exited"
  sleep 1
done
[ -n "$URL" ] || fail "no tunnel URL after 90s"

stage ready
echo "MEDHARNESS_READY url=$URL mode=$MEDHARNESS_MODE reasoner=$REASONER_NAME vision=$VISION_NAME"

# --- 8. Serve until the router stops (idle / max session / /admin/shutdown) ---------------
set +e
trap - ERR
while kill -0 "$ROUTER_PID" 2>/dev/null; do
  if ! kill -0 "$VLLM_PID" 2>/dev/null || ! kill -0 "$LLAMA_PID" 2>/dev/null; then
    STOP_REASON="model server crashed"; echo "MEDHARNESS_FAILED stage=serve reason=$STOP_REASON"
    tail -n 40 "$WORK/logs/vllm.log" "$WORK/logs/llama.log" | sed "s/${SESSION_BEARER_TOKEN}/[token]/g"
    break
  fi
  kill -0 "$CF_PID" 2>/dev/null || { STOP_REASON="tunnel exited"; break; }
  sleep 10
done
STOP_REASON="${STOP_REASON:-$(grep -o '"reason": "[^"]*"' "$WORK/logs/router.log" | tail -n 1 | cut -d'"' -f4)}"
exit 0
