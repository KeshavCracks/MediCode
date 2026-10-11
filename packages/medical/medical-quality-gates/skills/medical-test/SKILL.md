---
name: medical-test
description: Stress-test a clinical answer or artefact — worked cases, safety checks (dose, renal/hepatic, interactions, allergies, pregnancy), edge cases and residual risk.
whenToUse: Before a plan, dose or document is used; whenever an answer includes medicines or numeric thresholds.
---
# Clinical test gate

## Required sections (use these exact headings)
1. **Cases** — at least three worked scenarios: typical, edge (extremes of age/weight, CKD stage 4–5, pregnancy, hepatic impairment) and a red-flag presentation.
2. **Checks** — a table: check · method · result. Must cover dose range and maximum (via `clinical_calc`), renal/hepatic adjustment, interactions, allergy/cross-reactivity, pregnancy/lactation, duplication, route/formulation availability.
3. **Results** — pass / fail per check, with the corrected value when something failed.
4. **Residual risk** — what remains uncertain and what the clinician must confirm at the bedside.

## Rules
- A check that was not actually performed is reported as "not performed", never as passed.
- Re-run calculations with `clinical_calc`; do not reuse numbers from memory.
