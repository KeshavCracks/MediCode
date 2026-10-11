/**
 * Regex interceptor: detects calculation intent in clinician free text,
 * extracts the variables needed, and runs the deterministic calculators.
 *
 * Extraction is deliberately conservative — a value is only taken when it
 * carries an explicit unit or a labelled keyword. Anything ambiguous is left
 * out and reported as missing rather than guessed; every parsed value is
 * echoed back so the clinician can see exactly what was used.
 *
 * @module @deepseek-ai/dsh-medical-math-engine/extract
 */

import { CALCULATORS, CalcError, runCalculator, type CalcResult, type CalculatorId, type Sex } from './calculators.ts'
import { inToCm, lbToKg, roundTo, type CreatinineUnit, type GlucoseUnit } from './units.ts'

/** Variables the extractor can recover from text. */
export interface ExtractedVariables {
  age?: number | undefined
  sex?: Sex | undefined
  weightKg?: number | undefined
  heightCm?: number | undefined
  scr?: number | undefined
  scrUnit?: CreatinineUnit | undefined
  dosePerKg?: number | undefined
  doseUnit?: 'mg' | 'mcg' | 'g' | 'units' | 'mEq' | 'mmol' | undefined
  basis?: 'per_dose' | 'per_day' | undefined
  dosesPerDay?: number | undefined
  maxSingleDose?: number | undefined
  maxDailyDose?: number | undefined
  concentration?: { amount: number; unit: 'mg' | 'mcg' | 'g' | 'units'; perMl: number } | undefined
  volumeMl?: number | undefined
  durationMinutes?: number | undefined
  dropFactor?: number | undefined
  infusionDose?: number | undefined
  infusionDoseUnit?: 'mcg/kg/min' | 'mg/kg/h' | 'mcg/min' | 'mg/h' | 'units/h' | 'units/kg/h' | 'mg/min' | undefined
  sodium?: number | undefined
  chloride?: number | undefined
  bicarbonate?: number | undefined
  albumin?: number | undefined
  albuminUnit?: 'g/dL' | 'g/L' | undefined
  calcium?: number | undefined
  calciumUnit?: 'mg/dL' | 'mmol/L' | undefined
  glucose?: number | undefined
  glucoseUnit?: GlucoseUnit | undefined
  systolic?: number | undefined
  diastolic?: number | undefined
  qtMs?: number | undefined
  heartRate?: number | undefined
  bsaMethod?: 'mosteller' | 'dubois' | undefined
  qtcMethod?: 'bazett' | 'fridericia' | 'framingham' | 'hodges' | undefined
  sodiumFactor?: 1.6 | 2.4 | undefined
}

/** What the interceptor concluded for one message. */
export interface InterceptResult {
  readonly intents: readonly CalculatorId[]
  readonly variables: ExtractedVariables
  /** Human-readable record of each parsed value and assumption. */
  readonly parsed: readonly string[]
  readonly results: readonly CalcResult[]
  readonly missing: readonly { calculator: CalculatorId; fields: readonly string[] }[]
  readonly errors: readonly { calculator: CalculatorId; message: string }[]
}

const NUM = String.raw`(\d+(?:\.\d+)?)`

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function first(text: string, re: RegExp): RegExpExecArray | null {
  re.lastIndex = 0
  return re.exec(text)
}

const INTENT_PATTERNS: readonly [CalculatorId, RegExp][] = [
  ['crcl', /\b(?:crcl|creatinine\s+clearance|cockcroft|renal(?:ly)?[-\s]+(?:dos(?:e|ing)|adjust\w*))\b/i],
  ['egfr', /\b(?:e?gfr|ckd[-\s]?epi|kidney\s+function)\b/i],
  ['egfr_peds', /\bschwartz\b/i],
  ['bsa', /\b(?:bsa|body\s+surface\s+area|mosteller|du\s?bois|per\s+m(?:²|2)(?!\w)|(?<!kg)\/m(?:²|2)(?!\w))/i],
  ['bmi', /\b(?:bmi|body\s+mass\s+index)\b/i],
  ['ibw', /\b(?:ibw|ideal\s+(?:body\s+)?weight)\b/i],
  ['abw', /\b(?:adjbw|adjusted\s+(?:body\s+)?weight)\b/i],
  ['maintenance_fluids', /\b(?:maintenance\s+(?:iv\s+)?fluids?|holliday|4[-\s]2[-\s]1)\b/i],
  ['corrected_calcium', /\bcorrected\s+(?:ca\b|calcium)/i],
  ['anion_gap', /\banion\s+gap\b/i],
  ['corrected_sodium', /\b(?:corrected\s+(?:na\b|sodium)|pseudohyponat\w*)/i],
  ['map', /\b(?:MAP|[Mm]ean\s+arterial(?:\s+pressure)?)\b/],
  ['qtc', /\b(?:qtc|corrected\s+qt)\b/i],
]

/** Extract every recognisable variable from free text. */
export function extractVariables(text: string): { variables: ExtractedVariables; parsed: string[] } {
  const v: ExtractedVariables = {}
  const parsed: string[] = []

  // ---- age / sex --------------------------------------------------------
  let m = first(text, /\b(\d{1,3}(?:\.\d+)?)\s*(?:-|\s)?(?:(?:years?|yrs?|yo)\b(?:[-\s]old\b)?|y\/o|y\.o\.?)/i)
    ?? first(text, /\bage[d]?\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\b/i)
  if (m) { v.age = num(m[1]); parsed.push(`age ${v.age} y ("${m[0].trim()}")`) }
  if (v.age === undefined) {
    m = first(text, /\b(\d{1,2})[-\s](?:months?|mo)[-\s]old\b/i)
    if (m) { const months = num(m[1]) ?? 0; v.age = roundTo(months / 12, 2); parsed.push(`age ${months} months = ${v.age} y`) }
  }
  const compact = first(text, /\b(\d{1,3})\s?([MF])(?=[\s,.;:)]|$)/)
  if (compact) {
    const age = num(compact[1])
    if (age !== undefined && age <= 120) {
      if (v.age === undefined) { v.age = age; parsed.push(`age ${age} y ("${compact[0]}")`) }
      v.sex = compact[2] === 'M' ? 'male' : 'female'
      parsed.push(`sex ${v.sex} ("${compact[0]}")`)
    }
  }
  if (v.sex === undefined) {
    const female = /\b(?:female|woman|girl|lady|pregnant)\b/i.test(text)
    const male = /\b(?:male|man|boy|gentleman)\b/i.test(text)
    if (female !== male) { v.sex = female ? 'female' : 'male'; parsed.push(`sex ${v.sex}`) }
    else if (female && male) parsed.push('sex ambiguous (both male and female terms present) — not used')
  }

  // ---- weight -----------------------------------------------------------
  m = first(text, new RegExp(String.raw`\b${NUM}\s*(kg|kgs|kilograms?|lbs?|pounds?)\b(?!\s*\/)`, 'i'))
  if (m) {
    const raw = num(m[1]) ?? 0
    const unit = (m[2] ?? '').toLowerCase()
    v.weightKg = unit.startsWith('k') ? raw : roundTo(lbToKg(raw), 2)
    parsed.push(unit.startsWith('k') ? `weight ${raw} kg` : `weight ${raw} lb = ${v.weightKg} kg`)
  } else {
    m = first(text, /\b(?:weight|wt|weighs|weighing|birth\s?weight)\s*[:=]?\s*(\d{3,4})\s*(?:g|grams?)\b/i)
    if (m) { v.weightKg = (num(m[1]) ?? 0) / 1000; parsed.push(`weight ${m[1]} g = ${v.weightKg} kg`) }
  }

  // ---- height -----------------------------------------------------------
  m = first(text, new RegExp(String.raw`\b${NUM}\s*cm\b`, 'i'))
  if (m) { v.heightCm = num(m[1]); parsed.push(`height ${v.heightCm} cm`) }
  else {
    m = first(text, /\b(?:height|ht|tall)?\s*[:=]?\s*([12]\.\d{1,2})\s*m(?![²2\w/^])/i)
    if (m) { v.heightCm = roundTo((num(m[1]) ?? 0) * 100, 1); parsed.push(`height ${m[1]} m = ${v.heightCm} cm`) }
    else {
      m = first(text, /\b([3-7])\s*(?:'|’|ft|feet|foot)\s*(?:(\d{1,2}(?:\.\d)?)\s*(?:"|”|in|inches)?)?/i)
      if (m) {
        const inches = (num(m[1]) ?? 0) * 12 + (num(m[2]) ?? 0)
        v.heightCm = roundTo(inToCm(inches), 1)
        parsed.push(`height ${m[0].trim()} = ${inches} in = ${v.heightCm} cm`)
      }
    }
  }

  // ---- creatinine -------------------------------------------------------
  m = first(text, /\b(?:s\.?cr|scr|serum\s+creatinine|creatinine|creat|cr)\b(?!\s*cl)(?:\s+(?:of|is|was|level|at))?\s*[:=\-]?\s*(\d{1,4}(?:\.\d+)?)\s*(mg\s*\/\s*dl|[µμu]mol\s*\/\s*l|micromol\s*\/\s*l)?/i)
  if (m) {
    const raw = num(m[1]) ?? 0
    const unitText = (m[2] ?? '').toLowerCase().replace(/\s+/g, '')
    if (unitText.startsWith('mg')) { v.scr = raw; v.scrUnit = 'mg/dL'; parsed.push(`SCr ${raw} mg/dL`) }
    else if (unitText !== '') { v.scr = raw; v.scrUnit = 'umol/L'; parsed.push(`SCr ${raw} µmol/L`) }
    else if (raw > 25) { v.scr = raw; v.scrUnit = 'umol/L'; parsed.push(`SCr ${raw} (no unit; > 25 so assumed µmol/L — confirm)`) }
    else { v.scr = raw; v.scrUnit = 'mg/dL'; parsed.push(`SCr ${raw} (no unit; ≤ 25 so assumed mg/dL — confirm)`) }
  }

  // ---- weight-based dose -----------------------------------------------
  m = first(text, new RegExp(String.raw`\b${NUM}\s*(mg|mcg|[µμ]g|g|units?|iu|u|meq|mmol)\s*(?:\/|per)\s*kg(?:\s*(?:\/|per)\s*(dose|day|24\s*h(?:rs?|ours?)?|d)\b)?(?!\s*(?:\/|per)\s*(?:min|h\b|hr|hour))`, 'i'))
  if (m) {
    v.dosePerKg = num(m[1])
    const u = (m[2] ?? '').toLowerCase()
    v.doseUnit = u === 'mg' ? 'mg' : u === 'g' ? 'g' : u === 'meq' ? 'mEq' : u === 'mmol' ? 'mmol' : /^(?:units?|iu|u)$/.test(u) ? 'units' : 'mcg'
    const per = (m[3] ?? '').toLowerCase()
    v.basis = per !== '' && per !== 'dose' ? 'per_day' : 'per_dose'
    parsed.push(`dose ${v.dosePerKg} ${v.doseUnit}/kg${v.basis === 'per_day' ? '/day' : ''}`)
  }
  const freq = first(text, /\b(?:q\s?(\d{1,2})\s?h(?:rs?|ourly)?|every\s+(\d{1,2})\s*(?:h|hrs?|hours?)|(bid|bd|twice\s+(?:a\s+)?daily)|(tid|tds|thrice\s+daily|three\s+times\s+(?:a\s+)?day)|(qid|qds|four\s+times\s+(?:a\s+)?day)|(od|once\s+(?:a\s+)?daily|once\s+a\s+day)|divided\s+(?:into\s+)?(\d)\s+doses|in\s+(\d)\s+divided\s+doses)\b/i)
  if (freq) {
    const interval = num(freq[1]) ?? num(freq[2])
    v.dosesPerDay = interval !== undefined && interval > 0 && 24 % interval === 0 ? 24 / interval
      : freq[3] ? 2 : freq[4] ? 3 : freq[5] ? 4 : freq[6] ? 1 : num(freq[7]) ?? num(freq[8])
    if (v.dosesPerDay !== undefined) parsed.push(`frequency "${freq[0]}" = ${v.dosesPerDay} doses/day`)
  }
  const max = first(text, new RegExp(String.raw`\bmax(?:imum|\.)?(?:\s+(?:single|daily|per))?(?:\s+dose)?\s*(?:of|:|=)?\s*${NUM}\s*(mg|mcg|g)(?:\s*(?:\/|per|a)\s*(day|dose|24\s*h))?`, 'i'))
  if (max) {
    const daily = /day|24/i.test(max[3] ?? '') || /daily/i.test(max[0])
    if (daily) v.maxDailyDose = num(max[1])
    else v.maxSingleDose = num(max[1])
    parsed.push(`${daily ? 'max daily' : 'max single'} dose ${max[1]} ${max[2]}`)
  }
  const conc = first(text, new RegExp(String.raw`\b${NUM}\s*(mg|mcg|[µμ]g|g|units?)\s*(?:\/|per|in)\s*${NUM}?\s*ml\b`, 'i'))
  if (conc) {
    const u = (conc[2] ?? '').toLowerCase()
    v.concentration = { amount: num(conc[1]) ?? 0, unit: u === 'mg' ? 'mg' : u === 'g' ? 'g' : u.startsWith('unit') ? 'units' : 'mcg', perMl: num(conc[3]) ?? 1 }
    parsed.push(`concentration ${v.concentration.amount} ${v.concentration.unit} per ${v.concentration.perMl} mL`)
  }

  // ---- infusions --------------------------------------------------------
  m = first(text, new RegExp(String.raw`\b${NUM}\s*(ml|l|litres?|liters?)\b[^.\n]{0,40}?\bover\s*${NUM}\s*(h|hrs?|hours?|min|mins|minutes?)\b`, 'i'))
  if (m) {
    const vol = num(m[1]) ?? 0
    const isLitre = /^l/i.test(m[2] ?? '')
    v.volumeMl = isLitre ? vol * 1000 : vol
    const dur = num(m[3]) ?? 0
    v.durationMinutes = /^h/i.test(m[4] ?? '') ? dur * 60 : dur
    parsed.push(`infuse ${v.volumeMl} mL over ${v.durationMinutes} min`)
  }
  m = first(text, /\b(\d{2})\s*(?:gtt|drops?)\s*(?:\/|per)\s*ml\b/i) ?? first(text, /\bdrop\s+factor\s*(?:of|:|=)?\s*(\d{2})\b/i)
  if (m) { v.dropFactor = num(m[1]); parsed.push(`drop factor ${v.dropFactor} gtt/mL`) }
  m = first(text, new RegExp(String.raw`\b${NUM}\s*(mcg|[µμ]g|mg|units?)\s*\/\s*(kg\s*\/\s*)?(min|h|hr|hour)\b`, 'i'))
  if (m) {
    const mass = (m[2] ?? '').toLowerCase()
    const massUnit = mass === 'mg' ? 'mg' : mass.startsWith('unit') ? 'units' : 'mcg'
    const time = /^min/i.test(m[4] ?? '') ? 'min' : 'h'
    const candidate = `${massUnit}/${m[3] ? 'kg/' : ''}${time}`
    const allowed = ['mcg/kg/min', 'mg/kg/h', 'mcg/min', 'mg/h', 'units/h', 'units/kg/h', 'mg/min'] as const
    const unit = allowed.find(a => a === candidate)
    if (unit !== undefined) { v.infusionDose = num(m[1]); v.infusionDoseUnit = unit; parsed.push(`infusion dose ${v.infusionDose} ${unit}`) }
  }

  // ---- labs / vitals ----------------------------------------------------
  m = first(text, /\b(?:na\+?|sodium)\s*(?:of|is|was)?\s*[:=]?\s*(\d{2,3}(?:\.\d)?)\b/i)
  if (m) { v.sodium = num(m[1]); parsed.push(`Na ${v.sodium} mmol/L`) }
  m = first(text, /\b(?:cl-?|chloride)\s*(?:of|is|was)?\s*[:=]?\s*(\d{2,3}(?:\.\d)?)\b/i)
  if (m) { v.chloride = num(m[1]); parsed.push(`Cl ${v.chloride} mmol/L`) }
  m = first(text, /\b(?:hco3-?|bicarb(?:onate)?|tco2)\s*(?:of|is|was)?\s*[:=]?\s*(\d{1,2}(?:\.\d)?)\b/i)
  if (m) { v.bicarbonate = num(m[1]); parsed.push(`HCO₃ ${v.bicarbonate} mmol/L`) }
  m = first(text, /\b(?:alb(?:umin)?)\s*(?:of|is|was)?\s*[:=]?\s*(\d{1,2}(?:\.\d+)?)\s*(g\s*\/\s*dl|g\s*\/\s*l)?/i)
  if (m) {
    const raw = num(m[1]) ?? 0
    const unit = (m[2] ?? '').replace(/\s+/g, '').toLowerCase()
    v.albuminUnit = unit === 'g/l' || (unit === '' && raw > 10) ? 'g/L' : 'g/dL'
    v.albumin = raw
    parsed.push(`albumin ${raw} ${v.albuminUnit}${unit === '' ? ' (unit inferred — confirm)' : ''}`)
  }
  m = first(text, /\b(?:total\s+)?(?:ca|calcium)\b(?!\s*(?:19-9|125\b|15-3))\s*(?:of|is|was)?\s*[:=]?\s*(\d{1,2}(?:\.\d+)?)\s*(mg\s*\/\s*dl|mmol\s*\/\s*l)?/i)
  if (m) {
    const raw = num(m[1]) ?? 0
    const unit = (m[2] ?? '').replace(/\s+/g, '').toLowerCase()
    v.calciumUnit = unit === 'mmol/l' || (unit === '' && raw < 4) ? 'mmol/L' : 'mg/dL'
    v.calcium = raw
    parsed.push(`calcium ${raw} ${v.calciumUnit}${unit === '' ? ' (unit inferred — confirm)' : ''}`)
  }
  m = first(text, /\b(?:glucose|glu|bgl?|blood\s+sugar|cbg|rbs|fbs)\s*(?:of|is|was)?\s*[:=]?\s*(\d{1,4}(?:\.\d+)?)\s*(mg\s*\/\s*dl|mmol\s*\/\s*l)?/i)
  if (m) {
    const raw = num(m[1]) ?? 0
    const unit = (m[2] ?? '').replace(/\s+/g, '').toLowerCase()
    v.glucoseUnit = unit === 'mmol/l' || (unit === '' && raw < 40) ? 'mmol/L' : 'mg/dL'
    v.glucose = raw
    parsed.push(`glucose ${raw} ${v.glucoseUnit}${unit === '' ? ' (unit inferred — confirm)' : ''}`)
  }
  m = first(text, /\b(?:bp|blood\s+pressure)\s*(?:of|is|was)?\s*[:=]?\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/i) ?? first(text, /\b(\d{2,3})\s*\/\s*(\d{2,3})\s*mm\s*hg\b/i)
  if (m) { v.systolic = num(m[1]); v.diastolic = num(m[2]); parsed.push(`BP ${v.systolic}/${v.diastolic} mmHg`) }
  m = first(text, /\bqt\b(?:\s+interval)?\s*(?:of|is|was)?\s*[:=]?\s*(\d{3})\s*(?:ms)?\b/i)
  if (m) { v.qtMs = num(m[1]); parsed.push(`QT ${v.qtMs} ms`) }
  m = first(text, /\b(?:hr|heart\s+rate|pulse)\s*(?:of|is|was)?\s*[:=]?\s*(\d{2,3})\b/i) ?? first(text, /\b(\d{2,3})\s*bpm\b/i)
  if (m) { v.heartRate = num(m[1]); parsed.push(`HR ${v.heartRate} bpm`) }

  // ---- method selectors -------------------------------------------------
  if (/\bdu\s?bois\b/i.test(text)) v.bsaMethod = 'dubois'
  const qm = first(text, /\b(bazett|fridericia|framingham|hodges)\b/i)
  if (qm) v.qtcMethod = (qm[1] ?? '').toLowerCase() as NonNullable<ExtractedVariables['qtcMethod']>
  if (/\bhillier\b|\b2\.4\b/i.test(text)) v.sodiumFactor = 2.4

  return { variables: v, parsed }
}

/** Detect which calculators the text is asking for. */
export function detectIntents(text: string, v: ExtractedVariables): CalculatorId[] {
  const intents = new Set<CalculatorId>()
  for (const [id, re] of INTENT_PATTERNS) if (re.test(text)) intents.add(id)
  // Pediatric eGFR: route an eGFR request for a child to bedside Schwartz.
  if (intents.has('egfr') && v.age !== undefined && v.age < 18) { intents.delete('egfr'); intents.add('egfr_peds') }
  if (v.dosePerKg !== undefined) intents.add('weight_dose')
  if (v.infusionDose !== undefined && v.concentration !== undefined) intents.add('infusion_dose')
  if (v.volumeMl !== undefined && v.durationMinutes !== undefined) intents.add('infusion_volume')
  else if (/\b(?:drip\s+rate|gtt\s*\/\s*min|drops?\s+per\s+min\w*|ml\s*\/\s*h(?:r|our)?\s+rate|infusion\s+rate|rate\s+in\s+ml)\b/i.test(text) && v.infusionDose === undefined) intents.add('infusion_volume')
  if (/\b(?:ckd[-\s]?epi)\b/i.test(text)) intents.add('egfr')
  return [...intents]
}

function inputsFor(id: CalculatorId, v: ExtractedVariables): Record<string, unknown> {
  switch (id) {
    case 'crcl': return { age: v.age, sex: v.sex, weightKg: v.weightKg, scr: v.scr, scrUnit: v.scrUnit, heightCm: v.heightCm }
    case 'egfr': return { age: v.age, sex: v.sex, scr: v.scr, scrUnit: v.scrUnit }
    case 'egfr_peds': return { heightCm: v.heightCm, scr: v.scr, scrUnit: v.scrUnit, age: v.age }
    case 'bsa': return { heightCm: v.heightCm, weightKg: v.weightKg, method: v.bsaMethod }
    case 'bmi': return { heightCm: v.heightCm, weightKg: v.weightKg }
    case 'ibw': return { heightCm: v.heightCm, sex: v.sex }
    case 'abw': return { heightCm: v.heightCm, weightKg: v.weightKg, sex: v.sex }
    case 'weight_dose': return {
      weightKg: v.weightKg, dosePerKg: v.dosePerKg, doseUnit: v.doseUnit, basis: v.basis,
      dosesPerDay: v.dosesPerDay, maxSingleDose: v.maxSingleDose, maxDailyDose: v.maxDailyDose,
      concentration: v.concentration !== undefined && v.concentration.unit !== 'units' && v.doseUnit !== 'units' ? v.concentration : undefined,
    }
    case 'infusion_volume': return { volumeMl: v.volumeMl, durationMinutes: v.durationMinutes, dropFactor: v.dropFactor }
    case 'infusion_dose': return {
      dose: v.infusionDose, doseUnit: v.infusionDoseUnit, weightKg: v.weightKg,
      drugAmount: v.concentration?.amount, drugAmountUnit: v.concentration?.unit, bagVolumeMl: v.concentration?.perMl,
    }
    case 'maintenance_fluids': return { weightKg: v.weightKg }
    case 'corrected_calcium': {
      // Mixed unit systems are converted to the calcium's system.
      if (v.calcium === undefined || v.albumin === undefined) return { calcium: v.calcium, albumin: v.albumin }
      const si = v.calciumUnit === 'mmol/L'
      const albumin = si ? (v.albuminUnit === 'g/L' ? v.albumin : v.albumin * 10) : (v.albuminUnit === 'g/dL' ? v.albumin : v.albumin / 10)
      return { calcium: v.calcium, albumin, units: si ? 'si' : 'conventional' }
    }
    case 'anion_gap': return {
      sodium: v.sodium, chloride: v.chloride, bicarbonate: v.bicarbonate,
      albumin: v.albumin === undefined ? undefined : v.albuminUnit === 'g/L' ? v.albumin / 10 : v.albumin,
    }
    case 'corrected_sodium': return { sodium: v.sodium, glucose: v.glucose, glucoseUnit: v.glucoseUnit, factor: v.sodiumFactor }
    case 'map': return { systolic: v.systolic, diastolic: v.diastolic }
    case 'qtc': return { qtMs: v.qtMs, heartRate: v.heartRate, method: v.qtcMethod }
  }
}

function compact(inputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined))
}

/** Full interception pipeline over one user message. */
export function interceptCalculations(text: string): InterceptResult {
  const { variables, parsed } = extractVariables(text)
  const intents = detectIntents(text, variables)
  const results: CalcResult[] = []
  const missing: { calculator: CalculatorId; fields: string[] }[] = []
  const errors: { calculator: CalculatorId; message: string }[] = []
  for (const id of intents) {
    const inputs = compact(inputsFor(id, variables))
    const gaps = CALCULATORS[id].required.filter(field => inputs[field] === undefined)
    if (gaps.length > 0) {
      // Only report gaps when the clinician supplied part of the inputs —
      // a bare mention ("what BMI counts as obese?") is not a calculation.
      if (gaps.length < CALCULATORS[id].required.length) missing.push({ calculator: id, fields: gaps })
      continue
    }
    try {
      results.push(runCalculator(id, inputs))
    } catch (error) {
      if (error instanceof CalcError) errors.push({ calculator: id, message: error.message })
      else throw error
    }
  }
  return { intents, variables, parsed, results, missing, errors }
}
