# @deepseek-ai/dsh-medical

The clinical profile bundle. It is a patch-only layer, and the `medical` profile stacks it as **dsh-base → dsh-web-app → dsh-medical**:

```
dsh medical            # web UI on :3080
```

The Desktop app composes this profile by default.

## What the patch changes

| Row | Change |
|---|---|
| `agent-default-model` | `medcloud / ii-medical-8b` |
| `llm-pi-ai` | adds the `medcloud` provider (`http://127.0.0.1:47800/v1`, key `MEDCLOUD_GATEWAY_KEY`): **II-Medical-8B** (text, `<think>` via `qwen-chat-template`, 16k) and **MedGemma 1.5 4B** (text + image, 8k) |
| `agent-preset-registry` | default preset `medical` |
| `preset-standard/ptc/minimal/cordis` | disabled |
| `preset-medical` (insert) | clinical persona with hard rules (calculators for every number, cite retrieved evidence, red flags, no identifiers), plus fs read/search, skills (stage skills bundled), ask-user, todo and present. **No shell, no general web fetch, no plan-mode.** |
| host inserts | `medical-math-engine`, `medical-context-packer`, `medical-quality-gates`, `medical-diagrams`, `medical-agent-reach`, `medical-cloud` |
| `system-prompt` | clinical host persona |

Per-user state lives under the Harness home (`~/.dsh/medical/constraints.json`, `~/.dsh/medical/cloud-session.json`). Set `MEDHARNESS_CONTACT_EMAIL` to give NCBI a contact address.

Everything is ordinary profile configuration, so any row can be overridden by id from the profile patch or the Web editor. To bring back a coding preset, for example, add `- id: preset-standard` with `disabled: false`. In that preset, plan-mode's `/plan` shadows the clinical `/plan`.

## Tests

`tests/medical.spec.ts` checks:
- the patch parses;
- every named plugin is a declared dependency;
- **every row's config passes that plugin's real schema**;
- the stage skills resolve from the installed package;
- the provider model ids and context lengths match `dsh-medical-cloud`'s served names and knobs;
- the clinical preset contains no shell or plan-mode.
