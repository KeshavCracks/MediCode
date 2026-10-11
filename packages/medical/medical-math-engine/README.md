# @deepseek-ai/dsh-medical-math-engine

Deterministic clinical calculators for dsh. **Clinical numbers never come from the language model.**

## What it does

| Layer | Mechanism |
|---|---|
| Tool | `clinical_calc`, 16 calculators: `crcl` (Cockcroft–Gault, chooses actual/ideal/adjusted weight automatically), `egfr` (CKD-EPI 2021, race-free), `egfr_peds` (bedside Schwartz), `bsa`, `bmi`, `ibw`, `abw`, `weight_dose` (mg/kg, per dose or per day, max caps, liquid volume), `infusion_volume` (mL/h, gtt/min), `infusion_dose` (mcg/kg/min → mL/h), `maintenance_fluids` (4-2-1), `corrected_calcium`, `anion_gap`, `corrected_sodium`, `map`, `qtc` |
| Interception (`agent/pre-step`) | Regex/AST extraction finds calculation requests and their variables in the user message (explicit units only: mg/dL ↔ µmol/L, kg/lb, cm/in/ft-in; anything ambiguous is left for the model to ask about). It runs the calculator **before** the model and injects the verified result. Missing inputs are named, never guessed. |
| Verification (`agent/turn-stopping`) | Numbers in the final reply are checked against the computed values. A mismatch, or a calculated claim with no calculator behind it, steers the model to correct itself (bounded by `maxCorrectionsPerTurn`). |

Every result carries the formula, the inputs after unit conversion, and warnings (e.g. CKD-EPI used under 18, dose capped at max).

## Config

| Key | Default | |
|---|---|---|
| `intercept` | `true` | pre-compute calculation requests found in user messages |
| `verify` | `true` | check the final reply's numbers |
| `requireToolForClaims` | `true` | steer when a calculated value has no calculator behind it |
| `maxCorrectionsPerTurn` | `1` | loop guard |

## Tests

`tests/` covers the calculator reference values, unit conversion, extraction, the interceptor end-to-end on a Cordis context, and reply verification.
