/**
 * Stage definitions and the pure anti-rationalization checks run against a
 * finished reply. Kept free of runtime dependencies so it is unit-testable.
 * @module @deepseek-ai/dsh-medical-quality-gates/gate
 */

export type Stage = 'spec' | 'plan' | 'build' | 'test' | 'review'

export interface StageSpec {
  readonly stage: Stage
  readonly skill: string
  readonly description: string
  /** Section headings the reply must contain. */
  readonly sections: readonly string[]
}

export const STAGES: Readonly<Record<Stage, StageSpec>> = {
  spec: { stage: 'spec', skill: 'medical-spec', description: 'Clinical spec gate — define the question, context, unknowns and acceptance criteria before answering', sections: ['Clinical question', 'Patient context', 'Known data', 'Unknowns', 'Goal', 'Constraints', 'Acceptance criteria'] },
  plan: { stage: 'plan', skill: 'medical-plan', description: 'Clinical plan gate — prioritised plan with monitoring, escalation and risks', sections: ['Problem list', 'Steps', 'Monitoring', 'Escalation', 'Risks'] },
  build: { stage: 'build', skill: 'medical-build', description: 'Clinical build gate — produce the deliverable with assumptions and a verification block', sections: ['Deliverable', 'Assumptions', 'Verification'] },
  test: { stage: 'test', skill: 'medical-test', description: 'Clinical test gate — worked cases, safety checks and residual risk', sections: ['Cases', 'Checks', 'Results', 'Residual risk'] },
  review: { stage: 'review', skill: 'medical-review', description: 'Clinical review gate — findings, safety, evidence quality and verdict', sections: ['Findings', 'Safety', 'Evidence', 'Verdict'] },
}

export const STAGE_NAMES = Object.keys(STAGES) as Stage[]

/** Phrases that signal the model is talking itself out of doing the work. */
const RATIONALIZATIONS: readonly [RegExp, string][] = [
  [/\bfor\s+(?:the\s+sake\s+of\s+)?brevity\b/i, 'for brevity'],
  [/\bI(?:'ll|\s+will)\s+(?:skip|omit|leave\s+out)\b/i, 'I will skip/omit'],
  [/\bskipp(?:ed|ing)\s+(?:the\s+)?(?:tests?|checks?|verification|calculation)/i, 'skipped checks'],
  [/\bleft\s+as\s+an\s+exercise\b/i, 'left as an exercise'],
  [/\byou\s+can\s+(?:fill\s+in|add|complete)\s+(?:the\s+)?(?:rest|remaining|details)\b/i, 'you can fill in the rest'],
  [/\b(?:not|isn't|is\s+not)\s+(?:really\s+)?necessary\s+to\s+(?:test|verify|check|calculate)\b/i, 'not necessary to verify'],
  [/\b(?:should|would)\s+(?:probably\s+)?be\s+(?:fine|safe|ok(?:ay)?)\b/i, 'should be fine'],
  [/\bprobably\s+(?:fine|safe|ok(?:ay)?|correct)\b/i, 'probably fine'],
  [/\bI\s+assume(?:d)?\s+(?:it|this|that)\s+(?:is|works|was)\b/i, 'I assume it is'],
  [/\b(?:out\s+of\s+scope|beyond\s+the\s+scope)\s+(?:for\s+now|here)\b/i, 'out of scope for now'],
  [/\b(?:TODO|TBD|FIXME)\b/, 'TODO/TBD placeholder'],
  [/\[(?:insert|add|fill)[^\]]{0,40}\]/i, '[insert …] placeholder'],
  [/\bapproximately\s+(?:the\s+)?(?:usual|standard)\s+dose\b/i, 'approximate "usual dose"'],
]

/** A dose statement: number + mass/volume unit with a frequency or per-kg qualifier. */
const DOSE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|units?|iu|meq|mmol|ml)\s*(?:\/\s*kg|(?:\s+(?:po|iv|im|sc|pr|sl|od|bd|bid|tid|tds|qid|qds|q\d{1,2}h|stat|once|twice|daily|every|per\s+day|\/\s*day)))/i

export interface GateFinding {
  readonly kind: 'missing-section' | 'unverified-dose' | 'rationalization'
  readonly detail: string
}

function visible(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
}

/** Whether `reply` contains `label` as a heading, bold label or numbered label at a line start. */
export function hasSection(reply: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(String.raw`^\s{0,3}(?:#{1,6}\s*|\d+[.)]\s*|[-*]\s+)?(?:\*\*|__)?\s*${escaped}\b`, 'im')
  return re.test(reply)
}

/**
 * Evaluate a finished reply against the stage gate.
 * @param reply - final assistant text for the turn.
 * @param stage - active gate stage.
 * @param doseVerified - whether a deterministic calculation backed this turn.
 */
export function evaluateGate(reply: string, stage: Stage, doseVerified: boolean): GateFinding[] {
  const text = visible(reply)
  const findings: GateFinding[] = []
  for (const section of STAGES[stage].sections) {
    if (!hasSection(text, section)) findings.push({ kind: 'missing-section', detail: section })
  }
  if (!doseVerified && DOSE_PATTERN.test(text)) {
    const m = DOSE_PATTERN.exec(text)
    findings.push({ kind: 'unverified-dose', detail: m ? m[0] : 'dose statement' })
  }
  for (const [re, label] of RATIONALIZATIONS) {
    if (re.test(text)) findings.push({ kind: 'rationalization', detail: label })
  }
  return findings
}

/** Human summary of findings for the confirmation prompt and the steer. */
export function describeFindings(stage: Stage, findings: readonly GateFinding[]): string {
  const missing = findings.filter(f => f.kind === 'missing-section').map(f => f.detail)
  const doses = findings.filter(f => f.kind === 'unverified-dose').map(f => f.detail)
  const excuses = findings.filter(f => f.kind === 'rationalization').map(f => f.detail)
  const parts: string[] = []
  if (missing.length) parts.push(`missing required section(s): ${missing.join(', ')}`)
  if (doses.length) parts.push(`dose stated without a clinical_calc verification ("${doses[0]}")`)
  if (excuses.length) parts.push(`shortcut language: ${excuses.map(e => `"${e}"`).join(', ')}`)
  return `The /${stage} gate found: ${parts.join('; ')}.`
}

/** Steering text asking the model to finish the stage properly. */
export function completionSteer(stage: Stage, findings: readonly GateFinding[]): string {
  return [
    `[quality-gate:${stage}] ${describeFindings(stage, findings)}`,
    `Revise the answer so it is complete: include every required section (${STAGES[stage].sections.join(', ')}),`,
    'verify every dose or derived number with clinical_calc, and replace shortcut language with the actual work or an explicit "not performed — needs clinician" note.',
  ].join(' ')
}
