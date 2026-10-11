# @deepseek-ai/dsh-medical-context-packer

Shrinks long pasted clinical documents (discharge summaries, lab exports, EHR printouts) before they reach the remote GPU, in the spirit of mksglu/context-mode.

Runs on `agent/pre-step` for user messages of at least `minChars`:

1. **Redaction** (on by default): MRN/UHID/ABHA and other hospital numbers, phone, e-mail, Aadhaar, PAN, and labelled name/DOB/address are replaced with typed placeholders (`MRN: [ID]`, `Name: [NAME]`, `[EMAIL]`…). The model is told which kinds were replaced and to refer to the patient generically.
2. **Boilerplate and furniture**: known boilerplate and long lines repeated `repeatThreshold`+ times (page headers, footers, disclaimers) are removed.
3. **Deduplication**: exact-duplicate paragraphs are kept once. Short lines (lab values, vitals) are never deduplicated, so trends survive.
4. **Section labels**: recognised headings (Chief complaint, HPI, PMH, Medications, Allergies, Examination, Investigations, Imaging, Assessment, Plan, Hospital course) become `## ` sections, and a header reports original vs. packed size and the token estimate.

The packed text **replaces** the user message in the model request. The original stays in the local session log.

| Key | Default |
|---|---|
| `minChars` | `1500` |
| `redactIdentifiers` | `true` |
| `furnitureMinLength` | `25` |
| `repeatThreshold` | `3` |

Redaction is heuristic: it lowers exposure but is not certified de-identification.
