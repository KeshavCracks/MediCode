---
name: medical-build
description: Produce the clinical deliverable (note, letter, order set, protocol, patient handout, diagram) from an agreed plan, with stated assumptions and a verification block.
whenToUse: When the clinician asks for a written artefact after the plan is agreed.
---
# Clinical build gate

## Required sections (use these exact headings)
1. **Deliverable** — the artefact itself, formatted for its audience (clinician: concise and structured; patient: plain language, reading age ≈ 12, local units).
2. **Assumptions** — every assumption made while drafting, so the clinician can reject it.
3. **Verification** — list each number in the deliverable with its source (`clinical_calc` result, lab value given, guideline table). Anything unverified is marked ⚠.

## Rules
- Never introduce a dose, value or claim that is not in the plan or verified in this turn.
- Use `clinical_diagram` for timelines, pathways and decision trees instead of ASCII art.
- Do not include patient identifiers; refer to "the patient".
- Patient-facing material must include when and where to seek urgent help.
