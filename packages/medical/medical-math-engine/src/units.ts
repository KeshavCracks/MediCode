/**
 * Unit conversions and decimal-safe rounding used by the calculators and the
 * text extractor. Constants are exact where a definition exists.
 * @module @deepseek-ai/dsh-medical-math-engine/units
 */

export type CreatinineUnit = 'mg/dL' | 'umol/L'
export type GlucoseUnit = 'mg/dL' | 'mmol/L'

/** µmol/L per mg/dL of creatinine (MW 113.12 g/mol). */
export const CREATININE_UMOL_PER_MGDL = 88.4
/** mg/dL per mmol/L of glucose (MW 180.16 g/mol). */
export const GLUCOSE_MGDL_PER_MMOL = 18.016
export const KG_PER_LB = 0.45359237
export const CM_PER_IN = 2.54

/**
 * Round half away from zero at `dp` decimals without binary-float artefacts
 * (e.g. 1.005 → 1.01, not 1.00).
 */
export function roundTo(value: number, dp: number): number {
  if (!Number.isFinite(value)) return value
  const sign = value < 0 ? -1 : 1
  const shifted = Number(`${Math.abs(value)}e${dp}`)
  return sign * Number(`${Math.round(shifted)}e-${dp}`)
}

export function convertCreatinine(value: number, from: CreatinineUnit, to: CreatinineUnit): number {
  if (from === to) return value
  return from === 'umol/L' ? value / CREATININE_UMOL_PER_MGDL : value * CREATININE_UMOL_PER_MGDL
}

export function convertGlucose(value: number, from: GlucoseUnit, to: GlucoseUnit): number {
  if (from === to) return value
  return from === 'mmol/L' ? value * GLUCOSE_MGDL_PER_MMOL : value / GLUCOSE_MGDL_PER_MMOL
}

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB
}

export function inToCm(inches: number): number {
  return inches * CM_PER_IN
}
