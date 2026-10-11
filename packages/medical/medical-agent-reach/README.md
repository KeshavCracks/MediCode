# @deepseek-ai/dsh-medical-agent-reach

Read-only access to public medical evidence. No logins, no posting, no general web browsing.

| Tool | Source |
|---|---|
| `pubmed_search` | NCBI E-utilities esearch + esummary (relevance or date) |
| `pubmed_fetch_abstract` | efetch abstracts by PMID (structured sections, MeSH, DOI) |
| `medical_feed` | WHO news, WHO Disease Outbreak News (JSON APIs), CDC MMWR / outbreaks / newsroom (RSS), with an optional keyword filter |
| `transcript_extract` | captions of a public YouTube lecture |

Safety properties (in `src/net.ts`):
- HTTPS host allowlist, re-checked on **every redirect** (redirects are followed manually).
- Response byte cap, timeout and per-host throttle (NCBI 3 req/s, 10 with `ncbiApiKey`).
- All fetched text is fenced in `<external-content>` with an instruction not to follow anything inside it.
- Outbound search queries go through a PHI scrubber (`src/scrub.ts`). Identifiers, names and dates are stripped before a query leaves the machine, because literature search never needs them.

| Key | Default |
|---|---|
| `contactEmail` | `''` (the bundle reads `MEDHARNESS_CONTACT_EMAIL`; NCBI asks for one) |
| `ncbiApiKey` | `''` (secret) |
| `transcriptLanguage` | `en` |
| `maxTranscriptChars`, `timeoutMs`, `maxBytes` | 20000, 20 s, 4 MiB |

Fragility: the WHO JSON endpoints are undocumented and YouTube may answer with a consent redirect from some regions.
