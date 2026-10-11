/**
 * Deterministic context packing for long pasted clinical documents
 * (discharge summaries, lab dumps, referral letters, EHR exports).
 *
 * Packing is lossless for clinical content by construction: it only removes
 * whitespace noise, known boilerplate, exact duplicates, and repeated page
 * furniture, and it replaces direct identifiers with typed placeholders.
 * Short lines (lab values, vitals) are never deduplicated, so trends survive.
 *
 * @module @deepseek-ai/dsh-medical-context-packer/pack
 */

export interface PackOptions {
  /** Replace direct identifiers (MRN/UHID, phone, e-mail, Aadhaar, PAN, labelled name/DOB/address). */
  redactIdentifiers?: boolean
  /** Lines at least this long that repeat ≥ `repeatThreshold` times are treated as page furniture. */
  furnitureMinLength?: number
  repeatThreshold?: number
  /** Minimum paragraph length for exact-duplicate paragraph removal. */
  paragraphMinLength?: number
}

export interface PackStats {
  originalChars: number
  packedChars: number
  originalTokens: number
  packedTokens: number
  boilerplateLines: number
  furnitureLines: number
  duplicateParagraphs: number
  redactions: Record<string, number>
  sections: string[]
}

export interface PackResult {
  text: string
  stats: PackStats
}

/** Rough model-token estimate (≈ 4 characters per token for English clinical prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const BOILERPLATE: readonly RegExp[] = [
  /^page\s+\d+(?:\s*(?:of|\/)\s*\d+)?$/i,
  /^-?\s*\d+\s*-?$/, // bare page numbers
  /^[-=_*~.]{3,}$/, // rules
  /^(?:this\s+(?:e-?mail|message|document|report|communication)[^.]{0,80}(?:confidential|privileged|intended\s+(?:solely|only)))/i,
  /^confidential(?:ity)?(?:\s+(?:notice|statement|information))?\s*[:.-]?/i,
  /^(?:if\s+you\s+(?:are\s+not|have\s+received)\s+(?:the\s+intended|this\s+(?:e-?mail|message)\s+in\s+error))/i,
  /^(?:electronically|digitally)\s+(?:signed|verified|authenticated)\b/i,
  /^(?:e-?signed|signed\s+electronically)\b/i,
  /^(?:printed|generated|exported)\s+(?:on|by|at)\b/i,
  /^(?:this\s+is\s+a\s+(?:computer|system)[-\s]generated\s+(?:report|document))/i,
  /^(?:\*{0,2}\s*)?end\s+of\s+(?:report|document)(?:\s*\*{0,2})?$/i,
  /^(?:disclaimer)\s*[:.-]/i,
  /^(?:please\s+consider\s+the\s+environment\s+before\s+printing)/i,
  /^(?:sent\s+from\s+my\s+(?:iphone|android|mobile))/i,
]

interface Redactor { readonly kind: string; readonly re: RegExp; readonly replace: (match: string, ...groups: string[]) => string }

const REDACTORS: readonly Redactor[] = [
  { kind: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replace: () => '[EMAIL]' },
  // Labelled identifiers first so their digits are not double-counted as phones.
  { kind: 'mrn', re: /\b(MRN|UHID|CR\s*No|IP\s*No|OP\s*No|IPD\s*No|OPD\s*No|Reg(?:istration)?\.?\s*No|Patient\s*ID|Hospital\s*No|Case\s*No|ABHA(?:\s*(?:No|Number|ID))?)\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{3,})/gi, replace: (_m, label) => `${label}: [ID]` },
  { kind: 'name', re: /\b((?:patient(?:'s)?\s+)?name|pt\.?\s*name|mother'?s\s+name|father'?s\s+name|husband'?s\s+name|guardian)\s*[:-]\s*(?:(?:mr|mrs|ms|miss|master|baby|dr|smt|shri|kum)\.?\s+)?(?!(?:age|sex|gender|dob|mrn|uhid|ip|reg|date|ward|bed|unit|dept|[sdw]\/o)\b)[A-Z][A-Za-z'.-]+(?:[ \t]+(?!(?:age|sex|gender|dob|mrn|uhid|ip|reg|date|ward|bed|unit|dept|[sdw]\/o)\b)[A-Z][A-Za-z'.-]+){0,3}/gi, replace: (_m, label) => `${label}: [NAME]` },
  { kind: 'dob', re: /\b(DOB|D\.O\.B\.?|date\s+of\s+birth)\s*[:-]?\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/gi, replace: (_m, label) => `${label}: [DOB]` },
  { kind: 'address', re: /\b(address|addr\.?|residence)\s*[:-]\s*[^\n]{4,120}/gi, replace: (_m, label) => `${label}: [ADDRESS]` },
  { kind: 'aadhaar', re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, replace: () => '[AADHAAR]' },
  { kind: 'pan', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replace: () => '[PAN]' },
  { kind: 'phone', re: /(?<![\w/.])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\w/]|\.\d)|(?<![\w/.])\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?![\w/]|\.\d)/g, replace: () => '[PHONE]' },
]

const SECTION_HEADINGS: readonly [RegExp, string][] = [
  [/^(?:chief\s+complaints?|c\/o|presenting\s+complaints?)$/i, 'Chief complaint'],
  [/^(?:history\s+of\s+present(?:ing)?\s+illness|hpi|hopi|history)$/i, 'History of present illness'],
  [/^(?:past\s+(?:medical\s+)?history|pmh|pmhx|co-?morbidities)$/i, 'Past medical history'],
  [/^(?:(?:current\s+|home\s+|discharge\s+)?medications?|drug\s+history|rx|treatment\s+given|meds)$/i, 'Medications'],
  [/^(?:allerg(?:y|ies)|drug\s+allerg(?:y|ies))$/i, 'Allergies'],
  [/^(?:vitals?|vital\s+signs|general\s+examination|on\s+examination|o\/e|examination|physical\s+exam(?:ination)?)$/i, 'Examination'],
  [/^(?:lab(?:oratory)?\s*(?:results|investigations|data|values)?|investigations?|labs|blood\s+(?:tests|work))$/i, 'Investigations'],
  [/^(?:imaging|radiology|x-?ray|ct|mri|usg|ultrasound|echo(?:cardiography)?)$/i, 'Imaging'],
  [/^(?:assessment|impression|clinical\s+impression|diagnos(?:is|es)|final\s+diagnosis|provisional\s+diagnosis|differential(?:\s+diagnosis)?)$/i, 'Assessment'],
  [/^(?:plan|management|advice|recommendations?|follow[-\s]?up|discharge\s+advice)$/i, 'Plan'],
  [/^(?:hospital\s+course|course\s+in\s+(?:the\s+)?hospital|summary)$/i, 'Hospital course'],
]

function normaliseKey(line: string): string {
  return line.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim()
}

/** Pack one document. Pure; same input → same output. */
export function packDocument(input: string, options: PackOptions = {}): PackResult {
  const redact = options.redactIdentifiers ?? true
  const furnitureMin = options.furnitureMinLength ?? 25
  const repeatThreshold = options.repeatThreshold ?? 3
  const paragraphMin = options.paragraphMinLength ?? 40

  // 1. Whitespace normalisation.
  let text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\t/g, '  ')
  let lines = text.split('\n').map(line => line.replace(/[ ]{2,}/g, '  ').trimEnd())

  // 2. Boilerplate lines.
  let boilerplateLines = 0
  lines = lines.filter(line => {
    const t = line.trim()
    if (t === '') return true
    if (BOILERPLATE.some(re => re.test(t))) { boilerplateLines++; return false }
    return true
  })

  // 3. Repeated page furniture (headers/footers): long lines repeated many times.
  const counts = new Map<string, number>()
  for (const line of lines) {
    const t = line.trim()
    if (t.length >= furnitureMin) counts.set(normaliseKey(t), (counts.get(normaliseKey(t)) ?? 0) + 1)
  }
  const seenFurniture = new Set<string>()
  let furnitureLines = 0
  lines = lines.filter(line => {
    const t = line.trim()
    if (t.length < furnitureMin) return true
    const key = normaliseKey(t)
    if ((counts.get(key) ?? 0) < repeatThreshold) return true
    if (seenFurniture.has(key)) { furnitureLines++; return false }
    seenFurniture.add(key)
    return true
  })

  // 4. Section labelling (a heading line, optionally with a trailing colon).
  const sections: string[] = []
  lines = lines.map(line => {
    const t = line.trim().replace(/[:\-–]+$/, '').trim()
    if (t.length === 0 || t.length > 48) return line
    for (const [re, label] of SECTION_HEADINGS) {
      if (re.test(t)) { sections.push(label); return `## ${label}${t.toLowerCase() === label.toLowerCase() ? '' : ` (${t})`}` }
    }
    return line
  })

  // 5. Paragraph-level exact dedupe and blank-line collapse.
  text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const paragraphs = text.split(/\n{2,}/)
  const seenParagraphs = new Set<string>()
  let duplicateParagraphs = 0
  const kept: string[] = []
  for (const paragraph of paragraphs) {
    const key = normaliseKey(paragraph)
    if (paragraph.length >= paragraphMin && seenParagraphs.has(key)) { duplicateParagraphs++; continue }
    seenParagraphs.add(key)
    kept.push(paragraph)
  }
  text = kept.join('\n\n')

  // 6. Identifier redaction.
  const redactions: Record<string, number> = {}
  if (redact) {
    for (const r of REDACTORS) {
      text = text.replace(r.re, (...args: unknown[]) => {
        redactions[r.kind] = (redactions[r.kind] ?? 0) + 1
        const groups = args.slice(1, -2).map(g => (typeof g === 'string' ? g : ''))
        return r.replace(String(args[0]), ...groups)
      })
    }
  }

  return {
    text,
    stats: {
      originalChars: input.length,
      packedChars: text.length,
      originalTokens: estimateTokens(input),
      packedTokens: estimateTokens(text),
      boilerplateLines, furnitureLines, duplicateParagraphs,
      redactions,
      sections: [...new Set(sections)],
    },
  }
}

/** One-paragraph header describing what packing did, prepended to the packed text. */
export function packHeader(stats: PackStats): string {
  const saved = stats.originalChars === 0 ? 0 : Math.round((1 - stats.packedChars / stats.originalChars) * 100)
  const removed = [
    stats.boilerplateLines ? `${stats.boilerplateLines} boilerplate line(s)` : '',
    stats.furnitureLines ? `${stats.furnitureLines} repeated header/footer line(s)` : '',
    stats.duplicateParagraphs ? `${stats.duplicateParagraphs} duplicate paragraph(s)` : '',
  ].filter(Boolean)
  const redacted = Object.entries(stats.redactions).map(([k, n]) => `${n} ${k}`)
  return [
    `[context-packer] Pasted document packed: ${stats.originalChars.toLocaleString('en-US')} → ${stats.packedChars.toLocaleString('en-US')} chars (~${stats.originalTokens.toLocaleString('en-US')} → ~${stats.packedTokens.toLocaleString('en-US')} tokens, −${saved}%).`,
    removed.length ? `Removed: ${removed.join(', ')}.` : 'Nothing removed beyond whitespace.',
    redacted.length ? `Identifiers replaced with placeholders: ${redacted.join(', ')}. Refer to the patient generically.` : '',
    stats.sections.length ? `Sections: ${stats.sections.join(' · ')}.` : '',
  ].filter(Boolean).join(' ')
}
