# SPEC: Medical Harness (locked)

Status: **locked 2026-10-11**. Change it only with an entry in §6.

## 1. Goal

Clinicians get a desktop clinical decision-support assistant that:
- costs nothing to run;
- needs no Docker, terminal or cloud console;
- keeps clinical arithmetic deterministic;
- runs medical LLMs on free remote GPUs.

## 2. Fixed decisions

| # | Decision | Source |
|---|---|---|
| D1 | Fork of deepseek-ai/deepseek-harness, adapted to its plugin/profile architecture (no standalone Python app) | user |
| D2 | Reasoner **II-Medical-8B** (Qwen3-8B base, `<think>`), config value `reasonerHf` | user |
| D3 | Vision/structuring **MedGemma 1.5 4B** (`google/medgemma-1.5-4b-it`, GGUF via unsloth) | brief |
| D4 | GPU provider **Kaggle**, automated over the Kaggle API, 2× T4, one model per GPU | user |
| D5 | Groq is used only as a headless DevOps planner and never touches clinical content | brief + user |
| D6 | Clinical math never comes from the LLM | brief + user |
| D7 | Diagrams use no Mermaid or external renderer | brief + user |
| D8 | Linux-first; native packaging through the existing Electron Desktop | brief |

## 3. Requirements → implementation

| Requirement (brief) | Implementation | Verified by |
|---|---|---|
| Split brain: local harness ↔ remote GPU | llm-pi-ai `medcloud` provider → local gateway → tunnel → router | `tunnel-auth.spec.ts`, `medical.spec.ts` |
| GPTQ W4A16 + Marlin; no AWQ; no FP8 on T4 | `prepare.py` (llm-compressor GPTQModifier W4A16, `lm_head` ignored). vLLM `--dtype float16` auto-selects its Marlin W4A16 kernel for the checkpoint, and the bootstrap prints the selected kernel (`quant kernel: …`) in the boot log | kernel render tests; real run pending |
| `--enable-prefix-caching` | `cloud_bootstrap.sh` vLLM flags | kernel render tests |
| `<think>` streamed over SSE into a collapsible block | vLLM `--reasoning-parser qwen3` → `reasoning_content`. llm-pi-ai `thinkingFormat: qwen-chat-template`, and the harness UI renders reasoning collapsibly. The gateway streams without buffering. | gateway streaming test |
| `SESSION_BEARER_TOKEN` on every request | Gateway adds it; router checks with `hmac.compare_digest` on every route | 401 tests, router e2e |
| Cloudflare interstitial bypass headers | `TUNNEL_HEADERS` (`User-Agent: curl/8.0.0`, `ngrok-skip-browser-warning`). HTML answers → 503 with guidance | HTML→503 test |
| Heartbeat every 3 min | `CloudController.heartbeat`, `heartbeatSeconds: 180`; 3 misses → degraded; ended kernel → stopped | controller tests |
| cloud_bootstrap.sh | `remote/cloud_bootstrap.sh`: pinned versions, cloudflared SHA-256, log protocol, idle and session caps | `bash -n`, render tests |
| Zero setup | `/cloud setup / prepare / start / stop` in chat; credentials in the dsh store; auto-resume | controller tests |
| Deterministic math via AST/regex interception | `medical-math-engine`: extraction → calculators → pre-step injection → reply verification | `calculators.spec.ts`, `interceptor.spec.ts` |
| Quality gates: 6 commands, progressive disclosure, anti-rationalization pause | `medical-quality-gates` | `gates.spec.ts` |
| Context packing (context-mode style) | `medical-context-packer` | `pack.spec.ts` |
| Editorial diagrams: 4px grid, WCAG AA, named CSS vars | `medical-diagrams` | `diagrams.spec.ts` |
| agent-reach: read-only PubMed / WHO / CDC / transcripts | `medical-agent-reach` | `reach.spec.ts`, live smoke (2026-10-11) |
| Tests: math interceptor, context packing, tunnel auth | all three suites present | 138/138 |

## 4. Remote contract

- **Kernel log markers:** `MEDHARNESS_STAGE name=gpu|artifacts|install|reasoner|vision|router|tunnel|ready`, `MEDHARNESS_READY url=https://<x>.trycloudflare.com mode=dual|single`, `MEDHARNESS_FAILED stage= reason=`, `MEDHARNESS_STOPPED`, `MEDHARNESS_PREPARED`.
- **Router `127.0.0.1:8000`:**
  - every route requires the bearer token;
  - `/healthz` returns 503 unless both models are up;
  - `GET /v1/models`, `POST /admin/shutdown`, and `/v1/*` routed by `model` (unknown model → 404);
  - never logs bodies or tokens.
- **Remediation knobs (the only fields any planner may change):** `maxModelLen` 2048–16384, `gpuMemUtil` 0.5–0.95, `maxNumSeqs` 1–16, `visionCtx` 2048–8192, `enforceEager`, `mode`.

## 5. Acceptance criteria

1. A fresh fork plus `apply-to-fork.sh` passes `pnpm vitest run packages/medical packages/bundle/medical` and strict `tsc`. **Met.**
2. `dsh medical` boots with the clinical preset as default and `medcloud / ii-medical-8b` as the default model. **Composition verified; live boot pending a ≥ 8 GB build machine.**
3. `/cloud start` on a phone-verified Kaggle account reaches `ready`, and a chat turn streams `<think>` followed by the answer. **Pending a real account.**
4. A request such as "CrCl for 70 y male 80 kg Cr 1.4" gets a calculator result injected before the model runs, and a wrong number in the reply triggers a correction. **Met in tests.**
5. Unauthenticated, wrong-host or HTML-interstitial traffic never reaches a model. **Met in tests.**

## 6. Deviations from the brief

| Brief | Decision | Why |
|---|---|---|
| Standalone Python orchestrator | TS Cordis plugins inside the fork; Python only on the remote side | D1 |
| IQVIA Med-R1-8B | II-Medical-8B | user choice; open Apache-2.0 weights; needs a one-time quantize |
| MedGemma on vLLM | MedGemma on llama.cpp (Q8_0 + mmproj) | vLLM can't serve Gemma 3 vision on T4 (sm_75) |
| Colab / generic GPU | Kaggle | Colab ToS forbids serving; user choice |
| Separate Groq agent loop | Groq as a planner of allowlisted knob changes, with a heuristic fallback | smaller blast radius; works without a Groq key |
