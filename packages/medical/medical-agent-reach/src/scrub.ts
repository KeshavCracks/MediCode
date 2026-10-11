/**
 * Outbound PHI scrubber for search queries. Literature search never needs a
 * patient's identity, so identifiers are removed before anything leaves the
 * machine. Heuristic by nature — a backstop, not a guarantee.
 *
 * @module @deepseek-ai/dsh-medical-agent-reach/scrub
 */

export interface ScrubResult {
  query: string
  /** Kinds of identifier removed (e.g. `email`, `phone`, `id-number`). */
  removed: string[]
}

const RULES: readonly (readonly [kind: string, re: RegExp, replacement: string])[] = [
  ['email', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, ''],
  ['url-with-query', /\bhttps?:\/\/\S*[?#]\S*/gi, ''],
  // 10–13 digits with single space/hyphen/bracket separators (Indian 5+5, US 3-3-4, +CC forms), plus any label.
  ['phone', /(?:\b(?:ph(?:one)?|tel|mob(?:ile)?|cell|contact)\.?\s*(?:no\.?)?\s*[:#-]?\s*)?(?<![\w/.])\+?\(?\d(?:[\s\-()]{0,2}\d){9,12}(?![\w/]|\.\d)/gi, ''],
  ['id-number', /\b(?:MRN|UHID|IP|OP|CR|ABHA|Aadhaar|SSN|NHS)\s*(?:no\.?|number|#|:)?\s*[\w-]*\d[\w-]*/gi, ''],
  ['id-number', /\b\d{6,}\b/g, ''],
  ['date', /(?:\b(?:DOB|D\.O\.B\.?|born(?:\s+on)?|date of birth)\s*[:-]?\s*)?\b\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}\b/gi, ''],
  ['date', /(?:\b(?:DOB|D\.O\.B\.?|born(?:\s+on)?|date of birth)\s*[:-]?\s*)?\b(?:19|20)\d{2}-\d{2}-\d{2}\b/gi, ''],
  ['name', /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Shri|Smt|Kumari|Master|Baby of)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g, ''],
  ['name', /\b(?:patient|pt|named|name)\s*[:-]?\s+(?=[A-Z][a-z]+)[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g, 'patient'],
  // HIPAA Safe Harbor: ages over 89 are identifying.
  ['age-over-89', /\b(?:9\d|1[0-2]\d)[\s-]?(?:years?|yrs?|y)[\s-]?(?:old|o)?\b/gi, 'aged 90+'],
]

export function scrubQuery(input: string, maxLength = 300): ScrubResult {
  let query = input
  const removed = new Set<string>()
  for (const [kind, re, replacement] of RULES) {
    const next = query.replace(re, replacement)
    if (next !== query) removed.add(kind)
    query = next
  }
  query = query.replace(/\s+/g, ' ').replace(/\s+([,;:)])/g, '$1').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim()
  if (query.length > maxLength) {
    query = query.slice(0, maxLength).replace(/\s+\S*$/, '')
    removed.add('truncated')
  }
  return { query, removed: [...removed] }
}
