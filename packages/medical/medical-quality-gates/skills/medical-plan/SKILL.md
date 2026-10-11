---
name: medical-plan
description: Turn a clinical spec into a prioritised, safe management or work-up plan with monitoring, escalation criteria and risks.
whenToUse: After the clinical question is clear and before drafting orders, prescriptions, protocols or patient documents.
---
# Clinical plan gate

## Required sections (use these exact headings)
1. **Problem list** — prioritised; acute/life-threatening first.
2. **Steps** — numbered, each with the action, the reason, and the source (guideline name + year, or "expert opinion").
3. **Monitoring** — what to measure, how often, target ranges, and who acts on results.
4. **Escalation** — explicit red flags and thresholds that trigger senior review, transfer or emergency care.
5. **Risks** — adverse effects, interactions, contraindications and how each is mitigated; note pregnancy/renal/hepatic adjustments.

## Rules
- Separate what is evidence-based from what is pragmatic or local practice.
- All doses: name the drug, route, frequency, duration and the *verified* calculation (call `clinical_calc`).
- Prefer locally available, essential-medicine-list options when the setting is resource-limited.
- State when a plan step needs a clinician's examination or a test result before it is safe to proceed.
