/**
 * Post-hoc numeric verification of a model reply. Before a turn ends, every
 * number the reply attaches to a known calculation label (CrCl, eGFR, BSA,
 * dose, rate…) is compared with the deterministic value computed for this
 * turn. A mismatch — or a calculation-shaped claim with no verified source —
 * is reported so the plugin can steer the model to correct itself.
 *
 * @module @deepseek-ai/dsh-medical-math-engine/verify
 */

import type { CalcResult, CalculatorId } from './calculators.ts'

interface LabelSpec {
  readonly label: RegExp
  /** Unit that must follow a number for it to count as a claim about this calculation. */
  readonly unit: RegExp
}

const LABELS: Readonly<Record<CalculatorId, LabelSpec>> = {
  crcl: { label: /\b(?:crcl|creatinine\s+clearance|cockcroft[-–\s]?gault)\b/gi, unit: /^\s*ml\s*\/\s*min(?!\s*\/\s*1\.73)/i },
  egfr: { label: /\b(?:e?gfr|ckd[-\s]?epi)\b/gi, unit: /^\s*ml\s*\/\s*min/i },
  egfr_peds: { label: /\b(?:e?gfr|schwartz)\b/gi, unit: /^\s*ml\s*\/\s*min/i },
  bsa: { label: /\b(?:bsa|body\s+surface\s+area)\b/gi, unit: /^\s*m(?:²|2|\^2)/i },
  bmi: { label: /\b(?:bmi|body\s+mass\s+index)\b/gi, unit: /^\s*kg\s*\/\s*m/i },
  ibw: { label: /\b(?:ibw|ideal\s+(?:body\s+)?weight)\b/gi, unit: /^\s*kg\b/i },
  abw: { label: /\b(?:adjbw|adjusted\s+(?:body\s+)?weight)\b/gi, unit: /^\s*kg\b/i },
  weight_dose: { label: /\b(?:dose|dosing|give|administer)\b/gi, unit: /^\s*(?:mg|mcg|µg|g|units?|meq|mmol)\b(?!\s*\/\s*kg)/i },
  infusion_volume: { label: /\b(?:rate|infuse|infusion|drip|pump)\b/gi, unit: /^\s*(?:ml\s*\/\s*h(?:r|our)?|gtt\s*\/\s*min|drops?\s*\/\s*min)/i },
  infusion_dose: { label: /\b(?:rate|infusion|pump|run)\b/gi, unit: /^\s*ml\s*\/\s*h(?:r|our)?/i },
  maintenance_fluids: { label: /\b(?:maintenance|holliday)\b/gi, unit: /^\s*ml\s*\/\s*(?:h(?:r|our)?|day|24)/i },
  corrected_calcium: { label: /\bcorrected\s+(?:ca|calcium)\b/gi, unit: /^\s*(?:mg\s*\/\s*dl|mmol\s*\/\s*l)/i },
  anion_gap: { label: /\b(?:anion\s+gap|AG)\b/g, unit: /^\s*(?:mmol\s*\/\s*l|meq\s*\/\s*l)?/i },
  corrected_sodium: { label: /\bcorrected\s+(?:na|sodium)\b/gi, unit: /^\s*(?:mmol\s*\/\s*l|meq\s*\/\s*l)/i },
  map: { label: /\b(?:MAP|mean\s+arterial\s+pressure)\b/g, unit: /^\s*mm\s*hg/i },
  qtc: { label: /\bqtc\b/gi, unit: /^\s*(?:ms|msec)\b/i },
}

/** How far after a label (in characters) a number may appear and still be "about" it. */
const WINDOW = 90

export interface Mismatch {
  readonly calculator: CalculatorId
  readonly claimed: number
  readonly expected: readonly number[]
  readonly excerpt: string
}

export interface VerificationReport {
  readonly mismatches: readonly Mismatch[]
  /** Calculation-shaped claims (e.g. "= 42 mL/min") when nothing was verified this turn. */
  readonly unverifiedClaims: readonly string[]
}

function matches(claimed: number, allowed: readonly number[]): boolean {
  return allowed.some(value => {
    const tolerance = Math.max(Math.abs(value) * 0.02, 0.051)
    return Math.abs(claimed - value) <= tolerance
  })
}

/** Strip reasoning blocks — only the visible answer is checked. */
function visible(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
}

/** Compare numbers in `reply` against verified results for the same turn. */
export function verifyReply(reply: string, results: readonly CalcResult[]): VerificationReport {
  const text = visible(reply)
  const mismatches: Mismatch[] = []
  const byCalculator = new Map<CalculatorId, CalcResult[]>()
  for (const r of results) byCalculator.set(r.calculator, [...(byCalculator.get(r.calculator) ?? []), r])
  const allValues = results.flatMap(r => [r.value, ...r.extra.map(e => e.value)])

  for (const [calculator, list] of byCalculator) {
    const spec = LABELS[calculator]
    const allowed = list.flatMap(r => [r.value, ...r.extra.map(e => e.value)])
    spec.label.lastIndex = 0
    for (let hit = spec.label.exec(text); hit !== null; hit = spec.label.exec(text)) {
      const windowText = text.slice(hit.index + hit[0].length, hit.index + hit[0].length + WINDOW)
      // Stop at a sentence/line boundary so a later, unrelated number is not attributed here.
      const clause = windowText.split(/(?<=[.;!?])\s|\n/)[0] ?? windowText
      const numberRe = /(?<![\d.])(\d{1,5}(?:\.\d+)?)(?![\d.])/g
      for (let n = numberRe.exec(clause); n !== null; n = numberRe.exec(clause)) {
        const after = clause.slice(n.index + n[0].length)
        if (!spec.unit.test(after)) continue
        const before = clause.slice(Math.max(0, n.index - 2), n.index)
        // Thresholds ("< 30 mL/min", "> 60") and ranges are guidance, not claims.
        if (/[<>≤≥]\s*$/.test(before) || /^\s*[-–]\s*\d/.test(after)) continue
        const claimed = Number(n[1])
        // A number equal to any verified value from this turn is fine (e.g. CrCl quoted near a dose line).
        if (matches(claimed, allowed) || matches(claimed, allValues)) continue
        mismatches.push({
          calculator, claimed, expected: allowed,
          excerpt: text.slice(hit.index, Math.min(text.length, hit.index + hit[0].length + n.index + n[0].length + 12)).trim(),
        })
      }
    }
  }

  const unverifiedClaims: string[] = []
  if (results.length === 0) {
    const claimRe = /(?:=|≈|~|approx(?:imately|\.)?|calculated\s+(?:as|to\s+be|at)|works\s+out\s+(?:to|at)|comes\s+to)\s*(\d{1,5}(?:\.\d+)?)\s*(ml\s*\/\s*min(?:\s*\/\s*1\.73\s*m(?:²|2))?|m(?:²|2)(?!\w)|ml\s*\/\s*h(?:r|our)?|gtt\s*\/\s*min|mg\s*\/\s*(?:dose|day)|mcg\s*\/\s*kg\s*\/\s*min|kg\s*\/\s*m(?:²|2))/gi
    for (let c = claimRe.exec(text); c !== null; c = claimRe.exec(text)) unverifiedClaims.push(c[0].trim())
  }
  return { mismatches, unverifiedClaims }
}

/** Steering text for a failed verification. */
export function correctionMessage(report: VerificationReport, results: readonly CalcResult[]): string {
  const lines = ['[med-math verification] Your reply contains clinical numbers that do not match the harness\'s deterministic calculations.']
  for (const m of report.mismatches) {
    lines.push(`- "${m.excerpt}" — stated ${m.claimed}, verified value(s): ${m.expected.join(' / ')}`)
  }
  if (report.unverifiedClaims.length > 0) {
    lines.push(`- Calculated values without a verified source: ${report.unverifiedClaims.map(c => `"${c}"`).join(', ')}. Recompute them with the clinical_calc tool.`)
  }
  if (results.length > 0) {
    lines.push('Verified values for this turn:')
    for (const r of results) lines.push(`- ${r.label}: ${r.value} ${r.unit}${r.extra.length ? ` (${r.extra.map(e => `${e.label} ${e.value} ${e.unit}`).join('; ')})` : ''}`)
  }
  lines.push('Rewrite the answer using only verified values. Do not perform arithmetic yourself; call clinical_calc for any new number.')
  return lines.join('\n')
}
