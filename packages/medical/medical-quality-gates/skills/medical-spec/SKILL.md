---
name: medical-spec
description: Pin down a clinical question before answering — patient context, known data, unknowns, goal, constraints and acceptance criteria.
whenToUse: At the start of any non-trivial clinical task (a case work-up, a dosing question, a protocol, a document to draft) or when the request is ambiguous.
---
# Clinical spec gate

Produce a short, decision-ready specification. Do **not** answer the clinical question yet.

## Required sections (use these exact headings)
1. **Clinical question** — one sentence; PICO form when it is a therapy/diagnosis question (Population, Intervention/Index test, Comparator, Outcome).
2. **Patient context** — age, sex, weight/height if dosing may follow, pregnancy/lactation, renal and hepatic function, allergies, relevant comorbidities and current medicines. Write `not provided` rather than inventing.
3. **Known data** — findings, vitals, labs with units and dates, imaging. Keep units exactly as given.
4. **Unknowns** — information that would change management. Rank by impact; mark which are blocking.
5. **Goal** — what the clinician needs as output (differential, plan, dose, letter, handout, protocol) and for whom.
6. **Constraints** — setting (OPD/ward/ICU/rural PHC), formulary or local guideline, resource limits, active `/constraints`.
7. **Acceptance criteria** — checkable statements that a correct final answer must satisfy (e.g. "dose verified by clinical_calc", "red flags listed", "cites guideline year").

## Rules
- Ask for blocking unknowns instead of assuming them. Never fabricate a value to make a calculation possible.
- Any number derived from inputs (CrCl, BSA, mg/kg, rates) must come from `clinical_calc` or a `medical-math` block.
- Keep it under ~250 words unless the case is complex.
