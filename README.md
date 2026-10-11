# MediCode

A zero-cost, split-brain clinical decision-support assistant. MediCode is a fork of [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) at upstream commit `d743267` (v0.2.1-alpha.2). It uses DSH's own architecture (Cordis plugins, profile bundles, llm-pi-ai providers, Electron Desktop) rather than a separate app.

MediCode is an independent community project, not affiliated with or endorsed by DeepSeek. The upstream README is kept as [README.dsh.md](README.dsh.md). The licence is MIT, inherited from upstream (see [LICENSE](LICENSE)).

> **Not a medical device.** It supports a licensed clinician's judgement and does not replace it. Read [Limitations](#limitations) before using it with real patient data.

```
┌──────────── clinician's laptop (Desktop app, no terminal) ───────────┐
│ dsh profile "medical" = dsh-base → dsh-web-app → dsh-medical         │
│                                                                      │
│  user msg ─► context-packer (redact + pack) ─► math-engine intercept │
│            (deterministic GFR/CrCl/BSA/mg-kg/drip, before the LLM)   │
│  model  ◄─► tools: clinical_calc · pubmed_* · medical_feed ·         │
│             transcript_extract · clinical_diagram · skills           │
│  reply  ─► math verify + quality gates (steer / pause & ask)         │
│                                                                      │
│  llm-pi-ai "medcloud" ─► 127.0.0.1:47800 gateway (local key)         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS · SESSION_BEARER_TOKEN · curl/8.0.0 UA
                                ▼  heartbeat every 3 min
   Cloudflare quick tunnel ─► Kaggle private kernel, 2× T4
                               GPU0 vLLM: II-Medical-8B GPTQ-W4A16 (Marlin), <think>
                               GPU1 llama.cpp: MedGemma 1.5 4B (vision)
   Groq (optional): only plans boot retries from scrubbed logs, never clinical text
```

## Packages

| Package | Role |
|---|---|
| [`medical-math-engine`](packages/medical/medical-math-engine) | 16 deterministic calculators, pre-LLM interception, reply verification |
| [`medical-context-packer`](packages/medical/medical-context-packer) | identifier redaction and packing of long pasted records |
| [`medical-quality-gates`](packages/medical/medical-quality-gates) | `/spec /plan /build /test /review /constraints`, progressive-disclosure skills, pause-for-confirmation gate |
| [`medical-diagrams`](packages/medical/medical-diagrams) | `clinical_diagram`: editorial HTML+SVG, 4px grid, WCAG AA, no Mermaid |
| [`medical-agent-reach`](packages/medical/medical-agent-reach) | read-only PubMed, WHO, CDC and transcripts over an HTTPS allowlist |
| [`medical-cloud`](packages/medical/medical-cloud) | Kaggle provisioning (`/cloud`), tunnel gateway, heartbeat, remediation, remote scripts |
| [`bundle/medical`](packages/bundle/medical) | the profile layer that wires it all together |

Rendered diagram samples are in [`medicode/examples/`](medicode/examples).

## For clinicians

1. Build and run MediCode (see below; there is no prebuilt installer yet). It opens in the clinical preset.
2. In the chat, run `/cloud setup <kaggle-username> <kaggle-api-token>`. Get the token from kaggle.com → Settings → API. The Kaggle account must be phone-verified.
3. Run `/cloud prepare` once (about 2 h, runs on Kaggle, the laptop can sleep).
4. Run `/cloud start` at the start of a session (about 10 min) and `/cloud stop` at the end. The node also shuts itself down after 20 min idle.

## For developers

Requirements: Node `^22.19` or `>=24`, pnpm 11, Python 3 (only for the remote-script tests), and about 8 GB of RAM for the full build.

```bash
git clone https://github.com/KeshavCracks/MediCode.git
cd MediCode
pnpm install
pnpm vitest run packages/medical packages/bundle/medical   # 145 tests
pnpm run build                                             # full monorepo build
node apps/cli/lib/bin.js medical                           # web UI on http://localhost:3080
```

You can also run it from source without the full library build: `node --import tsx/esm apps/cli/src/bin.ts medical`. The web UI still needs its client bundles, which `pnpm run build` produces.

### What the fork changes

| Path | Change |
|---|---|
| `packages/medical/*` | 6 new plugin packages |
| `packages/bundle/medical` | the `dsh-medical` profile bundle |
| `packages/boot/app-boot/src/profile.ts` | adds the `medical` profile template |
| `apps/desktop/src/project-manager.ts` | Desktop composes `medical` instead of `web` |
| `apps/cli/package.json` | depends on `@deepseek-ai/dsh-medical` |
| `tsconfig.host.json`, `tsconfig.base.json`, `pnpm-lock.yaml` | project references, path aliases, lockfile |
| `.github/workflows/` | **removed**; upstream CI targets DeepSeek's own runners and secrets |

To move to a newer upstream, download `medicode-overlay-*.zip` from the [Releases](https://github.com/KeshavCracks/MediCode/releases) page, then run `./scripts/apply-to-fork.sh <fresh-upstream-clone>`. The script is idempotent and only touches the files listed above.

### Desktop installers

None are published yet. The Desktop app installs its runtime from npm at the release version. A MediCode installer therefore needs the medical packages published under a scope you own (rename them out of `@deepseek-ai` first) before it can be packaged. Until then, use the CLI and web UI above.

## Verification status

| Check | Result |
|---|---|
| Medical plugin suites (math, packing, gates, diagrams, reach, cloud incl. tunnel auth and real `router.py` e2e) | 138 / 138 |
| Bundle suite (patch parse, deps, **every row's config against the plugin's real schema**, skills path, provider ↔ cloud names) | 7 / 7 |
| Upstream checks touched by the fork (app-boot, desktop project-manager, reference/catalog/alias scripts) | 5718 passed, 1 skipped (upstream) |
| `tsc` strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes) on all medical packages | clean |
| `dsh medical --dump-config` | composes base → web-app → medical as intended |
| Fresh clone of upstream `d743267` → `apply-to-fork.sh` → tests + strict `tsc` | 29 files / 5755 tests pass, tsc clean |
| This repository's tree (medical + bundle suites) | 145 / 145 |
| Full build + live boot + real Kaggle GPU run | **not done here**: the build sandbox had 2 GB RAM, and the monorepo build OOMs. Run it on a dev machine. |

## Limitations

- **Models.** II-Medical-8B replaces the brief's Med-R1-8B. It ships BF16, so `/cloud prepare` quantizes it once. MedGemma runs through llama.cpp because vLLM can't serve it on T4, and it is under Google's Health AI Developer Foundations terms, which you must accept.
- **Kaggle.** About 30 GPU-hours a week, 12 h sessions, possible queues. Prompts and images are processed on Kaggle (Google) infrastructure, so check that your governance allows it. The session token sits in the private kernel source and rotates on every start.
- **Heuristic components.** Identifier redaction, the outbound query scrubber, calculation-request extraction, gate checks and the remediation heuristics are pattern-based. They reduce risk but are not certified. The deterministic calculators are the only "exact" part.
- **Packing** replaces the pasted text the model sees with the packed version. The original stays in the local session log.
- **External sources.** The WHO JSON endpoints are undocumented, and YouTube may answer with a consent redirect in some regions. All fetched content is fenced as untrusted.
- **Groq** is optional and only ever sees scrubbed boot logs and knob values, never clinical content.

See [SPEC.md](SPEC.md) for the locked specification and the full requirement → implementation map.
