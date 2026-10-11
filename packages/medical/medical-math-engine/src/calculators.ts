/**
 * Deterministic clinical calculators. Every function here is pure: the same
 * inputs always produce the same output, no model is consulted, and invalid or
 * implausible inputs throw a {@link CalcError} instead of producing a number.
 *
 * Formulas follow their primary references (cited per calculator). Results are
 * decision support for a clinician, not orders.
 *
 * @module @deepseek-ai/dsh-medical-math-engine/calculators
 */

import { convertCreatinine, convertGlucose, roundTo, type CreatinineUnit, type GlucoseUnit } from './units.ts'

/** Raised for missing, malformed, or physiologically implausible inputs. */
export class CalcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalcError'
  }
}

export type Sex = 'male' | 'female'

/** One secondary output of a calculation (e.g. per-day dose beside per-dose dose). */
export interface CalcOutput {
  readonly label: string
  readonly value: number
  readonly unit: string
}

/** A fully explained, reproducible calculation result. */
export interface CalcResult {
  readonly calculator: CalculatorId
  readonly label: string
  /** Primary value, already rounded to the calculator's reporting precision. */
  readonly value: number
  readonly unit: string
  /** Additional outputs, already rounded. */
  readonly extra: readonly CalcOutput[]
  readonly formula: string
  /** Normalised inputs as used (after unit conversion), for audit. */
  readonly inputs: Readonly<Record<string, string>>
  /** Human-readable derivation, one line per step. */
  readonly steps: readonly string[]
  readonly warnings: readonly string[]
  readonly reference: string
}

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

function requireNumber(name: string, value: unknown, min: number, max: number, unit = ''): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CalcError(`${name} is required and must be a finite number${unit ? ` (${unit})` : ''}.`)
  }
  if (value < min || value > max) {
    throw new CalcError(`${name} = ${value}${unit ? ` ${unit}` : ''} is outside the plausible range ${min}–${max}${unit ? ` ${unit}` : ''}; re-check the value and its unit.`)
  }
  return value
}

function requireSex(value: unknown): Sex {
  if (value === 'male' || value === 'female') return value
  throw new CalcError('sex is required and must be "male" or "female" (sex assigned at birth, as used by the published equation).')
}

function fmt(value: number, dp = 2): string {
  return String(roundTo(value, dp))
}

// ---------------------------------------------------------------------------
// Body size
// ---------------------------------------------------------------------------

export interface BodySizeInput { heightCm: number; weightKg: number }

/** Devine ideal body weight (kg). */
export function idealBodyWeight(input: { heightCm: number; sex: Sex }): CalcResult {
  const heightCm = requireNumber('heightCm', input.heightCm, 100, 250, 'cm')
  const sex = requireSex(input.sex)
  const inches = heightCm / 2.54
  const base = sex === 'male' ? 50 : 45.5
  const ibw = base + 2.3 * (inches - 60)
  const warnings: string[] = []
  if (heightCm < 152.4) warnings.push('Devine IBW is not validated below 152.4 cm (5 ft); the result extrapolates below the formula\'s base height.')
  return {
    calculator: 'ibw', label: 'Ideal body weight (Devine)',
    value: roundTo(ibw, 1), unit: 'kg', extra: [],
    formula: `IBW = ${base} + 2.3 × (height in inches − 60)`,
    inputs: { heightCm: fmt(heightCm, 1), sex },
    steps: [`height = ${fmt(heightCm, 1)} cm = ${fmt(inches, 2)} in`, `IBW = ${base} + 2.3 × (${fmt(inches, 2)} − 60) = ${fmt(ibw, 2)} kg`],
    warnings, reference: 'Devine BJ. Drug Intell Clin Pharm. 1974;8:650–655.',
  }
}

/** Adjusted body weight: IBW + 0.4 × (TBW − IBW). */
export function adjustedBodyWeight(input: { heightCm: number; weightKg: number; sex: Sex }): CalcResult {
  const weightKg = requireNumber('weightKg', input.weightKg, 0.3, 400, 'kg')
  const ibw = idealBodyWeight(input).value
  const abw = ibw + 0.4 * (weightKg - ibw)
  return {
    calculator: 'abw', label: 'Adjusted body weight',
    value: roundTo(abw, 1), unit: 'kg', extra: [{ label: 'Ideal body weight', value: ibw, unit: 'kg' }],
    formula: 'AdjBW = IBW + 0.4 × (TBW − IBW)',
    inputs: { heightCm: fmt(input.heightCm, 1), weightKg: fmt(weightKg, 1), sex: input.sex },
    steps: [`IBW = ${fmt(ibw, 1)} kg`, `AdjBW = ${fmt(ibw, 1)} + 0.4 × (${fmt(weightKg, 1)} − ${fmt(ibw, 1)}) = ${fmt(abw, 2)} kg`],
    warnings: weightKg < ibw ? ['Total body weight is below IBW; adjusted weight is not meaningful — use actual weight.'] : [],
    reference: 'Bauer LA. Applied Clinical Pharmacokinetics, 3rd ed.',
  }
}

/** Body-mass index with WHO adult category. */
export function bmi(input: BodySizeInput): CalcResult {
  const heightCm = requireNumber('heightCm', input.heightCm, 30, 250, 'cm')
  const weightKg = requireNumber('weightKg', input.weightKg, 0.3, 400, 'kg')
  const m = heightCm / 100
  const value = weightKg / (m * m)
  const category = value < 18.5 ? 'underweight' : value < 25 ? 'normal' : value < 30 ? 'overweight' : 'obese'
  return {
    calculator: 'bmi', label: 'Body-mass index',
    value: roundTo(value, 1), unit: 'kg/m²', extra: [],
    formula: 'BMI = weight (kg) / height (m)²',
    inputs: { heightCm: fmt(heightCm, 1), weightKg: fmt(weightKg, 1) },
    steps: [`BMI = ${fmt(weightKg, 1)} / ${fmt(m, 3)}² = ${fmt(value, 2)} kg/m²`, `WHO adult category: ${category}`],
    warnings: ['WHO categories apply to adults; use BMI-for-age percentiles in children.'],
    reference: 'WHO. Obesity: preventing and managing the global epidemic. TRS 894, 2000.',
  }
}

/** Body-surface area (Mosteller default, DuBois optional). */
export function bsa(input: BodySizeInput & { method?: 'mosteller' | 'dubois' }): CalcResult {
  const heightCm = requireNumber('heightCm', input.heightCm, 30, 250, 'cm')
  const weightKg = requireNumber('weightKg', input.weightKg, 0.3, 400, 'kg')
  const method = input.method ?? 'mosteller'
  if (method === 'dubois') {
    const value = 0.007184 * weightKg ** 0.425 * heightCm ** 0.725
    return {
      calculator: 'bsa', label: 'Body-surface area (DuBois)', value: roundTo(value, 2), unit: 'm²', extra: [],
      formula: 'BSA = 0.007184 × W^0.425 × H^0.725',
      inputs: { heightCm: fmt(heightCm, 1), weightKg: fmt(weightKg, 1), method },
      steps: [`BSA = 0.007184 × ${fmt(weightKg, 1)}^0.425 × ${fmt(heightCm, 1)}^0.725 = ${fmt(value, 3)} m²`],
      warnings: [], reference: 'DuBois D, DuBois EF. Arch Intern Med. 1916;17:863–871.',
    }
  }
  const value = Math.sqrt((heightCm * weightKg) / 3600)
  return {
    calculator: 'bsa', label: 'Body-surface area (Mosteller)', value: roundTo(value, 2), unit: 'm²', extra: [],
    formula: 'BSA = √(height cm × weight kg / 3600)',
    inputs: { heightCm: fmt(heightCm, 1), weightKg: fmt(weightKg, 1), method },
    steps: [`BSA = √(${fmt(heightCm, 1)} × ${fmt(weightKg, 1)} / 3600) = ${fmt(value, 3)} m²`],
    warnings: [], reference: 'Mosteller RD. N Engl J Med. 1987;317:1098.',
  }
}

// ---------------------------------------------------------------------------
// Renal function
// ---------------------------------------------------------------------------

export interface CreatinineInput { scr: number; scrUnit?: CreatinineUnit }

function normaliseScr(input: CreatinineInput): { mgdl: number; note: string } {
  const unit = input.scrUnit ?? 'mg/dL'
  const raw = requireNumber('scr', input.scr, unit === 'mg/dL' ? 0.1 : 8.8, unit === 'mg/dL' ? 25 : 2210, unit)
  const mgdl = convertCreatinine(raw, unit, 'mg/dL')
  return { mgdl, note: unit === 'mg/dL' ? `SCr = ${fmt(raw, 2)} mg/dL` : `SCr = ${fmt(raw, 1)} µmol/L ÷ 88.4 = ${fmt(mgdl, 3)} mg/dL` }
}

export type WeightBasis = 'actual' | 'ideal' | 'adjusted' | 'auto'

/** Cockcroft–Gault creatinine clearance (mL/min). */
export function crclCockcroftGault(input: CreatinineInput & { age: number; sex: Sex; weightKg: number; heightCm?: number; weightBasis?: WeightBasis }): CalcResult {
  const age = requireNumber('age', input.age, 18, 120, 'years')
  const sex = requireSex(input.sex)
  const tbw = requireNumber('weightKg', input.weightKg, 20, 400, 'kg')
  const { mgdl, note } = normaliseScr(input)
  const steps = [note]
  const warnings: string[] = []
  let basis: WeightBasis = input.weightBasis ?? 'auto'
  let weight = tbw
  let weightLabel = 'actual body weight'
  if (basis !== 'actual') {
    if (input.heightCm === undefined) {
      if (basis !== 'auto') throw new CalcError(`weightBasis "${basis}" needs heightCm to compute ideal body weight.`)
      basis = 'actual'
      warnings.push('Height not supplied: actual body weight used. In obesity this overestimates clearance — supply height for IBW/AdjBW selection.')
    } else {
      const ibw = idealBodyWeight({ heightCm: input.heightCm, sex }).value
      steps.push(`IBW (Devine) = ${fmt(ibw, 1)} kg; actual = ${fmt(tbw, 1)} kg (${fmt((tbw / ibw) * 100, 0)}% of IBW)`)
      let chosen: Exclude<WeightBasis, 'auto'> = basis === 'auto'
        ? (tbw < ibw ? 'actual' : tbw > 1.2 * ibw ? 'adjusted' : 'ideal')
        : basis
      if (chosen === 'ideal' && tbw < ibw) {
        warnings.push('Actual weight is below IBW; actual weight used instead of IBW.')
        chosen = 'actual'
      }
      if (chosen === 'ideal') { weight = ibw; weightLabel = 'ideal body weight' }
      if (chosen === 'adjusted') { weight = ibw + 0.4 * (tbw - ibw); weightLabel = 'adjusted body weight' }
      if (basis === 'auto') steps.push(`Weight selection rule: actual if < IBW, IBW if ≤ 120% IBW, adjusted if > 120% IBW → ${weightLabel}`)
      basis = chosen
    }
  }
  const sexFactor = sex === 'female' ? 0.85 : 1
  const crcl = ((140 - age) * weight * sexFactor) / (72 * mgdl)
  steps.push(`CrCl = ((140 − ${fmt(age, 0)}) × ${fmt(weight, 1)} kg${sex === 'female' ? ' × 0.85' : ''}) / (72 × ${fmt(mgdl, 3)}) = ${fmt(crcl, 2)} mL/min`)
  if (mgdl < 0.7 && age >= 65) warnings.push('Low SCr in an older adult may reflect low muscle mass; rounding SCr up is a local-policy decision and was NOT applied.')
  warnings.push('Cockcroft–Gault is not indexed to BSA and is unreliable in unstable (acute) renal function.')
  return {
    calculator: 'crcl', label: `Creatinine clearance (Cockcroft–Gault, ${weightLabel})`,
    value: roundTo(crcl, 1), unit: 'mL/min', extra: [{ label: 'Dosing weight used', value: roundTo(weight, 1), unit: 'kg' }],
    formula: 'CrCl = ((140 − age) × weight × [0.85 if female]) / (72 × SCr mg/dL)',
    inputs: { age: fmt(age, 0), sex, weightKg: fmt(tbw, 1), scrMgDl: fmt(mgdl, 3), weightBasis: basis, ...(input.heightCm === undefined ? {} : { heightCm: fmt(input.heightCm, 1) }) },
    steps, warnings, reference: 'Cockcroft DW, Gault MH. Nephron. 1976;16:31–41.',
  }
}

/** CKD-EPI 2021 race-free eGFR (mL/min/1.73 m²). */
export function egfrCkdEpi2021(input: CreatinineInput & { age: number; sex: Sex }): CalcResult {
  const age = requireNumber('age', input.age, 18, 120, 'years')
  const sex = requireSex(input.sex)
  const { mgdl, note } = normaliseScr(input)
  const kappa = sex === 'female' ? 0.7 : 0.9
  const alpha = sex === 'female' ? -0.241 : -0.302
  const ratio = mgdl / kappa
  const value = 142 * Math.min(ratio, 1) ** alpha * Math.max(ratio, 1) ** -1.2 * 0.9938 ** age * (sex === 'female' ? 1.012 : 1)
  const stage = value >= 90 ? 'G1' : value >= 60 ? 'G2' : value >= 45 ? 'G3a' : value >= 30 ? 'G3b' : value >= 15 ? 'G4' : 'G5'
  return {
    calculator: 'egfr', label: 'eGFR (CKD-EPI 2021, race-free)',
    value: roundTo(value, 0), unit: 'mL/min/1.73m²', extra: [],
    formula: 'eGFR = 142 × min(SCr/κ,1)^α × max(SCr/κ,1)^−1.200 × 0.9938^age × [1.012 if female]',
    inputs: { age: fmt(age, 0), sex, scrMgDl: fmt(mgdl, 3) },
    steps: [note, `κ = ${kappa}, α = ${alpha}; SCr/κ = ${fmt(ratio, 4)}`, `eGFR = ${fmt(value, 2)} mL/min/1.73m²`, `KDIGO GFR category: ${stage} (requires chronicity > 3 months to stage CKD)`],
    warnings: ['Assumes steady-state creatinine; not valid in AKI. Indexed to 1.73 m² — de-index for drug dosing in very small or large patients.'],
    reference: 'Inker LA, et al. N Engl J Med. 2021;385:1737–1749.',
  }
}

/** Bedside (2009) Schwartz eGFR for children 1–17 y. */
export function egfrSchwartzBedside(input: CreatinineInput & { heightCm: number; age?: number }): CalcResult {
  const heightCm = requireNumber('heightCm', input.heightCm, 40, 220, 'cm')
  const { mgdl, note } = normaliseScr(input)
  const warnings: string[] = ['Validated for CKD in children (CKiD cohort); less accurate at normal GFR.']
  if (input.age !== undefined && (input.age < 1 || input.age >= 18)) warnings.push('Bedside Schwartz is intended for ages 1–17 years.')
  const value = (0.413 * heightCm) / mgdl
  return {
    calculator: 'egfr_peds', label: 'eGFR (bedside Schwartz, pediatric)',
    value: roundTo(value, 0), unit: 'mL/min/1.73m²', extra: [],
    formula: 'eGFR = 0.413 × height (cm) / SCr (mg/dL)',
    inputs: { heightCm: fmt(heightCm, 1), scrMgDl: fmt(mgdl, 3) },
    steps: [note, `eGFR = 0.413 × ${fmt(heightCm, 1)} / ${fmt(mgdl, 3)} = ${fmt(value, 2)} mL/min/1.73m²`],
    warnings, reference: 'Schwartz GJ, et al. J Am Soc Nephrol. 2009;20:629–637.',
  }
}

// ---------------------------------------------------------------------------
// Dosing
// ---------------------------------------------------------------------------

export type DoseUnit = 'mg' | 'mcg' | 'g' | 'units' | 'mEq' | 'mmol'
const MASS_TO_MG: Partial<Record<DoseUnit, number>> = { mg: 1, mcg: 0.001, g: 1000 }

/** Convert between dose units of the same dimension; returns undefined across dimensions. */
function convertDose(value: number, from: DoseUnit, to: DoseUnit): number | undefined {
  if (from === to) return value
  const a = MASS_TO_MG[from]
  const b = MASS_TO_MG[to]
  if (a === undefined || b === undefined) return undefined
  return (value * a) / b
}

export interface WeightDoseInput {
  weightKg: number
  dosePerKg: number
  doseUnit: DoseUnit
  /** Whether dosePerKg is per dose or per day. */
  basis?: 'per_dose' | 'per_day'
  /** Doses per day (e.g. 3 for q8h). Required when basis is per_day; defaults to 1 otherwise. */
  dosesPerDay?: number
  maxSingleDose?: number
  maxDailyDose?: number
  /** Stock concentration, e.g. { amount: 250, unit: 'mg', perMl: 5 } for 250 mg/5 mL. */
  concentration?: { amount: number; unit: DoseUnit; perMl: number }
}

/** Weight-based (mg/kg) dose with optional caps and liquid volume. */
export function weightBasedDose(input: WeightDoseInput): CalcResult {
  const weightKg = requireNumber('weightKg', input.weightKg, 0.3, 400, 'kg')
  const perKg = requireNumber('dosePerKg', input.dosePerKg, 0.000001, 10000, `${input.doseUnit}/kg`)
  const unit = input.doseUnit
  if (!['mg', 'mcg', 'g', 'units', 'mEq', 'mmol'].includes(unit)) throw new CalcError('doseUnit must be one of mg, mcg, g, units, mEq, mmol.')
  const basis = input.basis ?? 'per_dose'
  if (basis === 'per_day' && input.dosesPerDay === undefined) throw new CalcError('dosesPerDay is required when the dose is expressed per day (e.g. 3 for q8h).')
  const dosesPerDay = input.dosesPerDay === undefined ? 1 : requireNumber('dosesPerDay', input.dosesPerDay, 1, 24)
  if (!Number.isInteger(dosesPerDay)) throw new CalcError('dosesPerDay must be a whole number.')
  const steps: string[] = []
  const warnings: string[] = []
  let perDose: number
  let perDay: number
  if (basis === 'per_day') {
    perDay = perKg * weightKg
    perDose = perDay / dosesPerDay
    steps.push(`daily dose = ${perKg} ${unit}/kg/day × ${fmt(weightKg, 2)} kg = ${fmt(perDay, 3)} ${unit}/day`)
    steps.push(`per dose = ${fmt(perDay, 3)} ÷ ${dosesPerDay} = ${fmt(perDose, 3)} ${unit}`)
  } else {
    perDose = perKg * weightKg
    perDay = perDose * dosesPerDay
    steps.push(`per dose = ${perKg} ${unit}/kg × ${fmt(weightKg, 2)} kg = ${fmt(perDose, 3)} ${unit}`)
    if (dosesPerDay > 1) steps.push(`daily = ${fmt(perDose, 3)} × ${dosesPerDay} = ${fmt(perDay, 3)} ${unit}/day`)
  }
  if (input.maxSingleDose !== undefined) {
    const cap = requireNumber('maxSingleDose', input.maxSingleDose, 0.000001, 1e7, unit)
    if (perDose > cap) {
      warnings.push(`Calculated single dose ${fmt(perDose, 3)} ${unit} exceeds the stated maximum ${cap} ${unit}; capped to the maximum.`)
      perDose = cap
      perDay = perDose * dosesPerDay
      steps.push(`capped per dose = ${cap} ${unit}; daily = ${fmt(perDay, 3)} ${unit}/day`)
    }
  }
  if (input.maxDailyDose !== undefined) {
    const cap = requireNumber('maxDailyDose', input.maxDailyDose, 0.000001, 1e8, unit)
    if (perDay > cap) {
      warnings.push(`Daily total ${fmt(perDay, 3)} ${unit} exceeds the stated daily maximum ${cap} ${unit}; capped.`)
      perDay = cap
      perDose = perDay / dosesPerDay
      steps.push(`capped daily = ${cap} ${unit}/day; per dose = ${fmt(perDose, 3)} ${unit}`)
    }
  }
  const extra: CalcOutput[] = [{ label: 'Total daily dose', value: roundTo(perDay, 3), unit: `${unit}/day` }]
  if (input.concentration !== undefined) {
    const c = input.concentration
    const amount = requireNumber('concentration.amount', c.amount, 0.000001, 1e7, c.unit)
    const perMl = requireNumber('concentration.perMl', c.perMl, 0.000001, 10000, 'mL')
    const doseInStockUnit = convertDose(perDose, unit, c.unit)
    if (doseInStockUnit === undefined) throw new CalcError(`Cannot convert ${unit} to the stock unit ${c.unit}.`)
    const mgPerMl = amount / perMl
    const volume = doseInStockUnit / mgPerMl
    steps.push(`concentration = ${amount} ${c.unit} / ${perMl} mL = ${fmt(mgPerMl, 4)} ${c.unit}/mL`)
    steps.push(`volume per dose = ${fmt(doseInStockUnit, 4)} ${c.unit} ÷ ${fmt(mgPerMl, 4)} ${c.unit}/mL = ${fmt(volume, 3)} mL`)
    extra.push({ label: 'Volume per dose', value: roundTo(volume, 2), unit: 'mL' })
  }
  if (weightKg > 40 && basis === 'per_dose') warnings.push('Weight > 40 kg: many pediatric mg/kg regimens switch to adult fixed dosing — check the drug-specific maximum.')
  return {
    calculator: 'weight_dose', label: 'Weight-based dose',
    value: roundTo(perDose, 3), unit: `${unit}/dose`, extra,
    formula: basis === 'per_day' ? 'per dose = (dose/kg/day × weight) ÷ doses per day' : 'per dose = dose/kg × weight',
    inputs: { weightKg: fmt(weightKg, 2), dosePerKg: String(perKg), doseUnit: unit, basis, dosesPerDay: String(dosesPerDay) },
    steps, warnings, reference: 'Arithmetic only — verify the mg/kg regimen and maximum against a current formulary (e.g. BNFc / Lexicomp).',
  }
}

/** Volume-based infusion rate: mL/h and drops/min. */
export function infusionRateVolume(input: { volumeMl: number; durationMinutes: number; dropFactor?: number }): CalcResult {
  const volumeMl = requireNumber('volumeMl', input.volumeMl, 0.1, 10000, 'mL')
  const minutes = requireNumber('durationMinutes', input.durationMinutes, 1, 10080, 'min')
  const mlPerHour = (volumeMl / minutes) * 60
  const steps = [`rate = ${fmt(volumeMl, 1)} mL ÷ ${fmt(minutes / 60, 3)} h = ${fmt(mlPerHour, 2)} mL/h`]
  const extra: CalcOutput[] = []
  if (input.dropFactor !== undefined) {
    const df = requireNumber('dropFactor', input.dropFactor, 10, 60, 'gtt/mL')
    const gtt = (volumeMl * df) / minutes
    steps.push(`drip = ${fmt(volumeMl, 1)} mL × ${df} gtt/mL ÷ ${fmt(minutes, 1)} min = ${fmt(gtt, 2)} gtt/min`)
    extra.push({ label: 'Drip rate', value: roundTo(gtt, 0), unit: 'gtt/min' })
  }
  return {
    calculator: 'infusion_volume', label: 'Infusion rate (volume over time)',
    value: roundTo(mlPerHour, 1), unit: 'mL/h', extra,
    formula: 'mL/h = volume ÷ hours; gtt/min = volume × drop factor ÷ minutes',
    inputs: { volumeMl: fmt(volumeMl, 1), durationMinutes: fmt(minutes, 1), ...(input.dropFactor === undefined ? {} : { dropFactor: String(input.dropFactor) }) },
    steps, warnings: [], reference: 'Standard infusion arithmetic.',
  }
}

export type DoseRateUnit = 'mcg/kg/min' | 'mg/kg/h' | 'mcg/min' | 'mg/h' | 'units/h' | 'units/kg/h' | 'mg/min'

/** Dose-based infusion rate (e.g. noradrenaline mcg/kg/min → mL/h). */
export function infusionRateDose(input: { dose: number; doseUnit: DoseRateUnit; weightKg?: number; drugAmount: number; drugAmountUnit: 'mg' | 'mcg' | 'g' | 'units'; bagVolumeMl: number }): CalcResult {
  const dose = requireNumber('dose', input.dose, 0.000001, 100000, input.doseUnit)
  const bag = requireNumber('bagVolumeMl', input.bagVolumeMl, 1, 5000, 'mL')
  const amount = requireNumber('drugAmount', input.drugAmount, 0.000001, 1e7, input.drugAmountUnit)
  const perKg = input.doseUnit.includes('/kg/')
  const weightKg = perKg ? requireNumber('weightKg', input.weightKg, 0.3, 400, 'kg') : undefined
  const isUnits = input.doseUnit.startsWith('units')
  if (isUnits !== (input.drugAmountUnit === 'units')) throw new CalcError('Dose unit and drug amount unit must both be units, or both be mass units.')
  // Express everything per hour in the base unit (mcg for mass, units for units).
  const base = isUnits ? 1 : ({ mcg: 1, mg: 1000, g: 1_000_000 } as const)[input.drugAmountUnit as 'mcg' | 'mg' | 'g']
  const doseBasePerUnit = isUnits ? 1 : (input.doseUnit.startsWith('mcg') ? 1 : 1000)
  const perMinute = input.doseUnit.endsWith('/min')
  const perHourBase = dose * doseBasePerUnit * (weightKg ?? 1) * (perMinute ? 60 : 1)
  const concentrationBasePerMl = (amount * base) / bag
  const mlPerHour = perHourBase / concentrationBasePerMl
  const baseUnit = isUnits ? 'units' : 'mcg'
  return {
    calculator: 'infusion_dose', label: 'Infusion rate (dose-based)',
    value: roundTo(mlPerHour, 2), unit: 'mL/h', extra: [{ label: 'Concentration', value: roundTo(concentrationBasePerMl, 3), unit: `${baseUnit}/mL` }],
    formula: 'mL/h = (dose × [weight] × [60 if per-min]) ÷ concentration',
    inputs: { dose: String(dose), doseUnit: input.doseUnit, ...(weightKg === undefined ? {} : { weightKg: fmt(weightKg, 1) }), drugAmount: `${amount} ${input.drugAmountUnit}`, bagVolumeMl: fmt(bag, 0) },
    steps: [
      `concentration = ${amount} ${input.drugAmountUnit} in ${fmt(bag, 0)} mL = ${fmt(concentrationBasePerMl, 4)} ${baseUnit}/mL`,
      `hourly dose = ${dose} ${input.doseUnit}${weightKg === undefined ? '' : ` × ${fmt(weightKg, 1)} kg`}${perMinute ? ' × 60' : ''} = ${fmt(perHourBase, 3)} ${baseUnit}/h`,
      `rate = ${fmt(perHourBase, 3)} ÷ ${fmt(concentrationBasePerMl, 4)} = ${fmt(mlPerHour, 3)} mL/h`,
    ],
    warnings: ['Confirm the concentration against the actual prepared infusion label before programming the pump.'],
    reference: 'Standard infusion arithmetic.',
  }
}

/** Holliday–Segar maintenance fluids (4-2-1 rule). */
export function maintenanceFluids(input: { weightKg: number }): CalcResult {
  const w = requireNumber('weightKg', input.weightKg, 0.3, 400, 'kg')
  const first = Math.min(w, 10)
  const second = Math.min(Math.max(w - 10, 0), 10)
  const rest = Math.max(w - 20, 0)
  const perHour = first * 4 + second * 2 + rest * 1
  return {
    calculator: 'maintenance_fluids', label: 'Maintenance fluids (Holliday–Segar 4-2-1)',
    value: roundTo(perHour, 1), unit: 'mL/h', extra: [{ label: 'Daily volume', value: roundTo(perHour * 24, 0), unit: 'mL/day' }],
    formula: '4 mL/kg/h for first 10 kg + 2 mL/kg/h for next 10 kg + 1 mL/kg/h thereafter',
    inputs: { weightKg: fmt(w, 2) },
    steps: [`${fmt(first, 2)}×4 + ${fmt(second, 2)}×2 + ${fmt(rest, 2)}×1 = ${fmt(perHour, 2)} mL/h`],
    warnings: ['Isotonic fluids are recommended for maintenance in hospitalised children (AAP 2018). Not for neonates, burns, renal failure, or SIADH without adjustment.'],
    reference: 'Holliday MA, Segar WE. Pediatrics. 1957;19:823–832.',
  }
}

// ---------------------------------------------------------------------------
// Electrolytes, haemodynamics, ECG
// ---------------------------------------------------------------------------

/** Albumin-corrected calcium. */
export function correctedCalcium(input: { calcium: number; albumin: number; units?: 'conventional' | 'si' }): CalcResult {
  const units = input.units ?? 'conventional'
  if (units === 'si') {
    const ca = requireNumber('calcium', input.calcium, 0.5, 6, 'mmol/L')
    const alb = requireNumber('albumin', input.albumin, 5, 70, 'g/L')
    const value = ca + 0.02 * (40 - alb)
    return {
      calculator: 'corrected_calcium', label: 'Corrected calcium', value: roundTo(value, 2), unit: 'mmol/L', extra: [],
      formula: 'Ca_corr = Ca + 0.02 × (40 − albumin g/L)', inputs: { calcium: String(ca), albumin: String(alb), units },
      steps: [`${ca} + 0.02 × (40 − ${alb}) = ${fmt(value, 3)} mmol/L`],
      warnings: ['Correction formulas are imprecise; measure ionised calcium when it matters clinically.'], reference: 'Payne RB, et al. BMJ. 1973;4:643–646.',
    }
  }
  const ca = requireNumber('calcium', input.calcium, 2, 24, 'mg/dL')
  const alb = requireNumber('albumin', input.albumin, 0.5, 7, 'g/dL')
  const value = ca + 0.8 * (4 - alb)
  return {
    calculator: 'corrected_calcium', label: 'Corrected calcium', value: roundTo(value, 1), unit: 'mg/dL', extra: [],
    formula: 'Ca_corr = Ca + 0.8 × (4 − albumin g/dL)', inputs: { calcium: String(ca), albumin: String(alb), units },
    steps: [`${ca} + 0.8 × (4 − ${alb}) = ${fmt(value, 2)} mg/dL`],
    warnings: ['Correction formulas are imprecise; measure ionised calcium when it matters clinically.'], reference: 'Payne RB, et al. BMJ. 1973;4:643–646.',
  }
}

/** Serum anion gap, optionally albumin-corrected (albumin in g/dL). */
export function anionGap(input: { sodium: number; chloride: number; bicarbonate: number; albumin?: number }): CalcResult {
  const na = requireNumber('sodium', input.sodium, 90, 200, 'mmol/L')
  const cl = requireNumber('chloride', input.chloride, 50, 160, 'mmol/L')
  const hco3 = requireNumber('bicarbonate', input.bicarbonate, 1, 60, 'mmol/L')
  const ag = na - (cl + hco3)
  const steps = [`AG = ${na} − (${cl} + ${hco3}) = ${fmt(ag, 1)} mmol/L`]
  const extra: CalcOutput[] = []
  if (input.albumin !== undefined) {
    const alb = requireNumber('albumin', input.albumin, 0.5, 7, 'g/dL')
    const corrected = ag + 2.5 * (4 - alb)
    steps.push(`albumin-corrected AG = ${fmt(ag, 1)} + 2.5 × (4 − ${alb}) = ${fmt(corrected, 2)} mmol/L`)
    extra.push({ label: 'Albumin-corrected anion gap', value: roundTo(corrected, 1), unit: 'mmol/L' })
  }
  return {
    calculator: 'anion_gap', label: 'Anion gap', value: roundTo(ag, 1), unit: 'mmol/L', extra,
    formula: 'AG = Na − (Cl + HCO₃); corrected AG = AG + 2.5 × (4 − albumin g/dL)',
    inputs: { sodium: String(na), chloride: String(cl), bicarbonate: String(hco3), ...(input.albumin === undefined ? {} : { albumin: String(input.albumin) }) },
    steps, warnings: ['Reference range is analyser-specific (commonly ~3–11 mmol/L without K⁺).'],
    reference: 'Figge J, et al. Crit Care Med. 1998;26:1807–1810.',
  }
}

/** Sodium corrected for hyperglycaemia (Katz 1.6 default, Hillier 2.4 optional). */
export function correctedSodium(input: { sodium: number; glucose: number; glucoseUnit?: GlucoseUnit; factor?: 1.6 | 2.4 }): CalcResult {
  const na = requireNumber('sodium', input.sodium, 90, 200, 'mmol/L')
  const unit = input.glucoseUnit ?? 'mg/dL'
  const glucoseRaw = requireNumber('glucose', input.glucose, unit === 'mg/dL' ? 10 : 0.5, unit === 'mg/dL' ? 3000 : 170, unit)
  const glucose = convertGlucose(glucoseRaw, unit, 'mg/dL')
  const factor = input.factor ?? 1.6
  if (factor !== 1.6 && factor !== 2.4) throw new CalcError('factor must be 1.6 (Katz) or 2.4 (Hillier).')
  const value = na + factor * ((glucose - 100) / 100)
  return {
    calculator: 'corrected_sodium', label: `Corrected sodium (${factor === 1.6 ? 'Katz' : 'Hillier'})`,
    value: roundTo(value, 1), unit: 'mmol/L', extra: [],
    formula: `Na_corr = Na + ${factor} × (glucose mg/dL − 100) / 100`,
    inputs: { sodium: String(na), glucoseMgDl: fmt(glucose, 1), factor: String(factor) },
    steps: [...(unit === 'mmol/L' ? [`glucose ${glucoseRaw} mmol/L × 18.016 = ${fmt(glucose, 1)} mg/dL`] : []), `${na} + ${factor} × (${fmt(glucose, 1)} − 100)/100 = ${fmt(value, 2)} mmol/L`],
    warnings: glucose < 100 ? ['Glucose is not elevated; correction is not applicable.'] : [],
    reference: factor === 1.6 ? 'Katz MA. N Engl J Med. 1973;289:843–844.' : 'Hillier TA, et al. Am J Med. 1999;106:399–403.',
  }
}

/** Mean arterial pressure. */
export function meanArterialPressure(input: { systolic: number; diastolic: number }): CalcResult {
  const sbp = requireNumber('systolic', input.systolic, 30, 300, 'mmHg')
  const dbp = requireNumber('diastolic', input.diastolic, 10, 200, 'mmHg')
  if (dbp >= sbp) throw new CalcError('diastolic must be lower than systolic.')
  const value = (sbp + 2 * dbp) / 3
  return {
    calculator: 'map', label: 'Mean arterial pressure', value: roundTo(value, 0), unit: 'mmHg', extra: [],
    formula: 'MAP = (SBP + 2 × DBP) / 3', inputs: { systolic: String(sbp), diastolic: String(dbp) },
    steps: [`(${sbp} + 2 × ${dbp}) / 3 = ${fmt(value, 2)} mmHg`], warnings: [], reference: 'Standard haemodynamic estimate.',
  }
}

/** Heart-rate-corrected QT interval. */
export function qtc(input: { qtMs: number; heartRate: number; method?: 'bazett' | 'fridericia' | 'framingham' | 'hodges' }): CalcResult {
  const qt = requireNumber('qtMs', input.qtMs, 150, 800, 'ms')
  const hr = requireNumber('heartRate', input.heartRate, 20, 300, 'bpm')
  const method = input.method ?? 'fridericia'
  const rr = 60 / hr
  let value: number
  let formula: string
  switch (method) {
    case 'bazett': value = qt / Math.sqrt(rr); formula = 'QTc = QT / √RR'; break
    case 'fridericia': value = qt / Math.cbrt(rr); formula = 'QTc = QT / ∛RR'; break
    case 'framingham': value = qt + 154 * (1 - rr); formula = 'QTc = QT + 154 × (1 − RR)'; break
    case 'hodges': value = qt + 1.75 * (hr - 60); formula = 'QTc = QT + 1.75 × (HR − 60)'; break
    default: throw new CalcError('method must be bazett, fridericia, framingham or hodges.')
  }
  const warnings: string[] = []
  if (method === 'bazett' && (hr > 100 || hr < 60)) warnings.push('Bazett over-corrects at high and under-corrects at low heart rates; prefer Fridericia.')
  if (value >= 500) warnings.push('QTc ≥ 500 ms: markedly increased torsades risk.')
  return {
    calculator: 'qtc', label: `QTc (${method})`, value: roundTo(value, 0), unit: 'ms', extra: [],
    formula, inputs: { qtMs: String(qt), heartRate: String(hr), method },
    steps: [`RR = 60 / ${hr} = ${fmt(rr, 4)} s`, `QTc = ${fmt(value, 2)} ms`], warnings,
    reference: 'Vandenberk B, et al. J Am Heart Assoc. 2016;5:e003264.',
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type CalculatorId =
  | 'crcl' | 'egfr' | 'egfr_peds' | 'bsa' | 'bmi' | 'ibw' | 'abw'
  | 'weight_dose' | 'infusion_volume' | 'infusion_dose' | 'maintenance_fluids'
  | 'corrected_calcium' | 'anion_gap' | 'corrected_sodium' | 'map' | 'qtc'

export interface CalculatorSpec {
  readonly id: CalculatorId
  readonly description: string
  /** Input field names, required ones first; used for tool docs and extraction gaps. */
  readonly required: readonly string[]
  readonly optional: readonly string[]
  run(inputs: Record<string, unknown>): CalcResult
}

// The registry deliberately passes `unknown` records into typed functions:
// each calculator re-validates every field it reads, so a malformed tool call
// produces a CalcError, never a silently wrong number.
/* eslint-disable @typescript-eslint/no-explicit-any */
const asAny = (v: Record<string, unknown>): any => v

export const CALCULATORS: Readonly<Record<CalculatorId, CalculatorSpec>> = {
  crcl: { id: 'crcl', description: 'Cockcroft–Gault creatinine clearance (mL/min); auto-selects actual/ideal/adjusted weight when height is given.', required: ['age', 'sex', 'weightKg', 'scr'], optional: ['scrUnit', 'heightCm', 'weightBasis'], run: i => crclCockcroftGault(asAny(i)) },
  egfr: { id: 'egfr', description: 'CKD-EPI 2021 race-free eGFR for adults (mL/min/1.73m²).', required: ['age', 'sex', 'scr'], optional: ['scrUnit'], run: i => egfrCkdEpi2021(asAny(i)) },
  egfr_peds: { id: 'egfr_peds', description: 'Bedside Schwartz eGFR for children 1–17 y.', required: ['heightCm', 'scr'], optional: ['scrUnit', 'age'], run: i => egfrSchwartzBedside(asAny(i)) },
  bsa: { id: 'bsa', description: 'Body-surface area (Mosteller default; method "dubois" optional).', required: ['heightCm', 'weightKg'], optional: ['method'], run: i => bsa(asAny(i)) },
  bmi: { id: 'bmi', description: 'Body-mass index with WHO adult category.', required: ['heightCm', 'weightKg'], optional: [], run: i => bmi(asAny(i)) },
  ibw: { id: 'ibw', description: 'Devine ideal body weight.', required: ['heightCm', 'sex'], optional: [], run: i => idealBodyWeight(asAny(i)) },
  abw: { id: 'abw', description: 'Adjusted body weight (IBW + 0.4 × excess).', required: ['heightCm', 'weightKg', 'sex'], optional: [], run: i => adjustedBodyWeight(asAny(i)) },
  weight_dose: { id: 'weight_dose', description: 'Weight-based dose (per dose or per day ÷ doses), optional max caps and liquid volume via concentration {amount, unit, perMl}.', required: ['weightKg', 'dosePerKg', 'doseUnit'], optional: ['basis', 'dosesPerDay', 'maxSingleDose', 'maxDailyDose', 'concentration'], run: i => weightBasedDose(asAny(i)) },
  infusion_volume: { id: 'infusion_volume', description: 'Volume over time → mL/h and gtt/min (with dropFactor).', required: ['volumeMl', 'durationMinutes'], optional: ['dropFactor'], run: i => infusionRateVolume(asAny(i)) },
  infusion_dose: { id: 'infusion_dose', description: 'Dose-rate (e.g. mcg/kg/min) → pump rate mL/h for a given bag.', required: ['dose', 'doseUnit', 'drugAmount', 'drugAmountUnit', 'bagVolumeMl'], optional: ['weightKg'], run: i => infusionRateDose(asAny(i)) },
  maintenance_fluids: { id: 'maintenance_fluids', description: 'Holliday–Segar 4-2-1 maintenance fluid rate.', required: ['weightKg'], optional: [], run: i => maintenanceFluids(asAny(i)) },
  corrected_calcium: { id: 'corrected_calcium', description: 'Albumin-corrected calcium (conventional mg/dL+g/dL, or units "si" mmol/L+g/L).', required: ['calcium', 'albumin'], optional: ['units'], run: i => correctedCalcium(asAny(i)) },
  anion_gap: { id: 'anion_gap', description: 'Anion gap, optionally albumin-corrected.', required: ['sodium', 'chloride', 'bicarbonate'], optional: ['albumin'], run: i => anionGap(asAny(i)) },
  corrected_sodium: { id: 'corrected_sodium', description: 'Sodium corrected for hyperglycaemia (factor 1.6 or 2.4).', required: ['sodium', 'glucose'], optional: ['glucoseUnit', 'factor'], run: i => correctedSodium(asAny(i)) },
  map: { id: 'map', description: 'Mean arterial pressure.', required: ['systolic', 'diastolic'], optional: [], run: i => meanArterialPressure(asAny(i)) },
  qtc: { id: 'qtc', description: 'Corrected QT (fridericia default; bazett/framingham/hodges).', required: ['qtMs', 'heartRate'], optional: ['method'], run: i => qtc(asAny(i)) },
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const CALCULATOR_IDS = Object.keys(CALCULATORS) as CalculatorId[]

/** Run one calculator by id with an untyped input record (tool-call boundary). */
export function runCalculator(id: string, inputs: Record<string, unknown>): CalcResult {
  const spec = (CALCULATORS as Record<string, CalculatorSpec | undefined>)[id]
  if (spec === undefined) throw new CalcError(`Unknown calculator "${id}". Available: ${CALCULATOR_IDS.join(', ')}.`)
  const missing = spec.required.filter(key => inputs[key] === undefined || inputs[key] === null)
  if (missing.length > 0) throw new CalcError(`${id} is missing required input(s): ${missing.join(', ')}.`)
  return spec.run(inputs)
}

/** Render a result as compact, model- and clinician-readable markdown. */
export function formatResult(result: CalcResult): string {
  const lines = [`**${result.label}: ${result.value} ${result.unit}**`]
  for (const e of result.extra) lines.push(`- ${e.label}: ${e.value} ${e.unit}`)
  lines.push(`- Formula: ${result.formula}`)
  lines.push(`- Inputs used: ${Object.entries(result.inputs).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  for (const s of result.steps) lines.push(`  - ${s}`)
  for (const w of result.warnings) lines.push(`- ⚠ ${w}`)
  lines.push(`- Ref: ${result.reference}`)
  return lines.join('\n')
}
