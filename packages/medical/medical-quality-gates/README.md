# @deepseek-ai/dsh-medical-quality-gates

Staged clinical reasoning with progressive disclosure and an anti-rationalization pause.

| Command | Skill | Required sections |
|---|---|---|
| `/spec` | `medical-spec` | Clinical question · Patient context · Known data · Unknowns · Goal · Constraints · Acceptance criteria |
| `/plan` | `medical-plan` | Problem list · Steps · Monitoring · Escalation · Risks |
| `/build` | `medical-build` | Deliverable · Assumptions · Verification |
| `/test` | `medical-test` | Cases · Checks · Results · Residual risk |
| `/review` | `medical-review` | Findings · Safety · Evidence · Verdict |
| `/constraints` | (none) | list / add / remove standing constraints (allergies, renal function, local formulary) |

- **Progressive disclosure**: only the invoked stage's `SKILL.md` body is loaded into context. The skills are also discoverable by the model through `dsh-tool-skill`.
- **Turn gate** (`agent/turn-stopping`): when a gated answer misses required sections, states a dose that no `clinical_calc` result backs, or rationalizes skipping steps ("for brevity", "should be fine", "not necessary to verify"…), the plugin pauses and asks the clinician (`confirmWithUser`) whether to complete it. Otherwise it steers automatically, at most `maxSteersPerTurn` times.
- Constraints persist in `storePath` (bundle default: `~/.dsh/medical/constraints.json`) and are added to the system prompt.

The medical bundle removes `dsh-plan-mode` from the clinical preset. Its per-agent `/plan` would otherwise shadow the clinical `/plan`.
