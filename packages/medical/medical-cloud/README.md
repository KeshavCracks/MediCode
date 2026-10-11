# @deepseek-ai/dsh-medical-cloud

medCloud is the remote half of the split-brain harness. It runs a private Kaggle kernel on **2× T4** that serves two models behind a Cloudflare quick tunnel. The harness reaches it through an authenticated local gateway, so the clinician never touches a terminal, Docker or a cloud console.

```
dsh (llm-pi-ai "medcloud")                 Kaggle kernel (private, GPU T4×2, internet on)
  │  Authorization: Bearer <gateway key>     ┌──────────────────────────────────────────┐
  ▼                                          │ GPU0  vLLM  II-Medical-8B  GPTQ W4A16    │
127.0.0.1:47800  Gateway ── HTTPS ──► *.trycloudflare.com ─► router :8000 (bearer, hmac)│
  · Host check (421)   SESSION_BEARER_TOKEN  │        Marlin, fp16, prefix caching, qwen3 │
  · local key (401)    User-Agent curl/8.0.0 │        reasoning parser → <think> stream   │
  · streams SSE        ngrok-skip header     │ GPU1  llama.cpp  MedGemma 1.5 4B Q8 +mmproj│
  · HTML → 503                               │ idle watchdog · 11.5 h cap · /admin/shutdown│
                                             └──────────────────────────────────────────┘
```

## Clinician flow (all inside the chat)

| Command | What happens |
|---|---|
| `/cloud setup <kaggle-username> <kaggle-api-token>` | Stores credentials in the dsh credential store. The account must be phone-verified (Kaggle requires that for GPU and internet). |
| `/cloud setup groq <key>` | Optional. Lets Groq plan boot retries (see below). |
| `/cloud prepare` | One time, about 1.5–3 h on Kaggle. Quantizes II-Medical-8B to GPTQ W4A16 (llm-compressor, `lm_head` kept), builds llama.cpp for sm_75, caches MedGemma GGUF + mmproj, and saves everything as kernel output for later boots. |
| `/cloud start` | Boots the serving kernel (about 6–15 min). Progress streams from the kernel log protocol. When ready, the gateway attaches automatically. |
| `/cloud status` · `/cloud logs` · `/cloud stop` | Status shows stage, URL, heartbeat health, uptime against the session cap and the idle-shutdown timer. `stop` shuts down the router and cancels the Kaggle session so no GPU quota burns. |
| `/cloud attach <url> <token>` | Uses a node started outside the app. |

The serving session is persisted (`sessionFile`, mode 0600; the token goes to the credential store when available). After an app restart it resumes automatically when the kernel is still running.

## Reliability

- **Heartbeat** every 180 s through the tunnel (`/healthz`, authenticated). Three misses mark the node degraded. If the kernel has ended, the node is marked stopped and the session is cleared.
- **Log protocol**: `MEDHARNESS_STAGE name=…`, `MEDHARNESS_READY url=… mode=…`, `MEDHARNESS_FAILED stage=… reason=…`, `MEDHARNESS_STOPPED`, `MEDHARNESS_PREPARED`. Only `https://<x>.trycloudflare.com` URLs are accepted.
- **Remediation**: when a boot fails, a planner may change **only** `maxModelLen`, `gpuMemUtil`, `maxNumSeqs`, `visionCtx`, `enforceEager` or `mode` within `KNOB_LIMITS`, and the harness retries up to `maxRetries` times. With `GROQ_API_KEY` set, Groq plans from a **scrubbed** log tail (no request bodies, keys or tokens). Otherwise deterministic heuristics run (OOM → halve context, batch and vision context; graph-capture/compile errors → eager mode; one GPU → `single`; network timeouts → plain retry). Non-retryable failures (missing artifacts or driver, checksum mismatch, unauthorized, phone verification) abort immediately. **Groq never receives clinical content and is never used for inference.**
- **Self-shutdown**: the router stops the kernel after `idleTimeoutMinutes` without traffic and before Kaggle's 12 h limit.

## Configuration (selected)

| Key | Default |
|---|---|
| `reasonerHf` / `reasonerName` | `Intelligent-Internet/II-Medical-8B` / `ii-medical-8b` |
| `visionName`, `visionGgufUrl`, `visionMmprojUrl` | `medgemma-1.5-4b`, unsloth Q8_0 GGUF + mmproj-F16 |
| `vllmVersion` · `llamaCppRef` · `cloudflaredVersion` | `0.31.0` · `v0.6.0` · `2026.10.0` (SHA-256 pinned) |
| `mode` | `auto` (2 GPUs → `dual`, one model per GPU; 1 GPU → `single`) |
| `maxModelLen` · `gpuMemUtil` · `maxNumSeqs` · `visionCtx` | 16384 · 0.92 · 8 · 8192 |
| `idleTimeoutMinutes` · `maxSessionHours` · `bootTimeoutMinutes` | 20 · 11.5 · 40 |
| `heartbeatSeconds` · `gatewayPort` | 180 · 47800 |
| `groqModel` · `maxRetries` | `openai/gpt-oss-120b` · 2 |

The reasoner name must match the `medcloud` model id in the `llm-pi-ai` row; the bundle test enforces this.

## Files

- `remote/cloud_bootstrap.sh`: GPU detection, artifact discovery, pinned installs, vLLM + llama-server + router + cloudflared startup, and the log protocol.
- `remote/router.py`: aiohttp bearer router (constant-time compare, never logs bodies or tokens) with model routing, `/healthz`, `/admin/shutdown` and the idle watchdog.
- `remote/prepare.py`: the one-time GPTQ quantization and llama.cpp build.
- `src/kernels.ts`: renders the kernel source (files embedded as base64, env block).
- `src/kaggle.ts`: Kaggle API client (`SaveKernel`, session status, SSE logs, cancel).
- `src/gateway.ts`, `src/controller.ts`, `src/remediation.ts`, `src/index.ts`: gateway, lifecycle, remediation planners and the plugin with `/cloud`.

## Caveats

- Kaggle GPU quota is about 30 h/week, and sessions last at most 12 h. Queues can delay `start`.
- Patient data sent to the models is processed on Kaggle (Google) infrastructure. Use it only where your governance allows.
- The session token is embedded in the **private** kernel's source (Kaggle has no secret injection over the API). It rotates on every `start`.
- `machineShape: NvidiaTeslaT4` and the artifact data-source field follow the current Kaggle API. Check them if Kaggle renames accelerators.
- Tests cover gateway auth (401/421/503/404/405) and an end-to-end run of the real `router.py` against a fake vLLM, including shutdown and the idle watchdog. Tests can't exercise real Kaggle GPU boots.
