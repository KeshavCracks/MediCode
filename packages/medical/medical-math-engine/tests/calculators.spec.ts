import { describe, expect, it } from 'vitest'

import {
  anionGap, bmi, bsa, CalcError, correctedCalcium, correctedSodium, crclCockcroftGault,
  egfrCkdEpi2021, egfrSchwartzBedside, idealBodyWeight, infusionRateDose, infusionRateVolume,
  maintenanceFluids, meanArterialPressure, qtc, runCalculator, weightBasedDose, roundTo,
} from '../src/index.ts'

// Expected values were computed independently (Python, full precision) from
// the published equations, then rounded to each calculator's reporting
// precision.

describe('rounding', () => {
  it('rounds half away from zero without binary-float artefacts', () => {
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(2.675, 2)).toBe(2.68)
    expect(roundTo(-1.5, 0)).toBe(-2)
  })
})

describe('renal function', () => {
  it('Cockcroft–Gault with actual weight when height is absent (67 M, 70 kg, SCr 1.4)', () => {
    const r = crclCockcroftGault({ age: 67, sex: 'male', weightKg: 70, scr: 1.4 })
    expect(r.value).toBe(50.7) // 50.694…
    expect(r.unit).toBe('mL/min')
    expect(r.warnings.join(' ')).toMatch(/Height not supplied/)
  })

  it('Cockcroft–Gault converts µmol/L (124 µmol/L ≈ 1.403 mg/dL)', () => {
    const r = crclCockcroftGault({ age: 67, sex: 'male', weightKg: 70, scr: 124, scrUnit: 'umol/L' })
    expect(r.value).toBe(50.6) // 50.596…
    expect(r.steps[0]).toMatch(/÷ 88\.4/)
  })

  it('Cockcroft–Gault selects adjusted weight in obesity (55 F, 120 kg, 165 cm, SCr 1.0)', () => {
    const r = crclCockcroftGault({ age: 55, sex: 'female', weightKg: 120, heightCm: 165, scr: 1.0 })
    expect(r.label).toMatch(/adjusted/)
    expect(r.extra[0]?.value).toBe(82.1) // AdjBW 82.146
    expect(r.value).toBe(82.4) // 82.431…
  })

  it('Cockcroft–Gault uses actual weight when below IBW', () => {
    const r = crclCockcroftGault({ age: 70, sex: 'male', weightKg: 55, heightCm: 180, scr: 1.0 })
    expect(r.label).toMatch(/actual/)
  })

  it('refuses pediatric ages and implausible creatinine', () => {
    expect(() => crclCockcroftGault({ age: 10, sex: 'male', weightKg: 30, scr: 0.5 })).toThrow(CalcError)
    expect(() => crclCockcroftGault({ age: 50, sex: 'male', weightKg: 70, scr: 140 })).toThrow(/plausible range/)
  })

  it('CKD-EPI 2021 male and female', () => {
    expect(egfrCkdEpi2021({ age: 67, sex: 'male', scr: 1.4 }).value).toBe(55) // 55.09
    expect(egfrCkdEpi2021({ age: 50, sex: 'female', scr: 0.6 }).value).toBe(109) // 109.28
  })

  it('bedside Schwartz', () => {
    expect(egfrSchwartzBedside({ heightCm: 120, scr: 0.5 }).value).toBe(99) // 99.12
  })
})

describe('body size', () => {
  it('BSA Mosteller and DuBois', () => {
    expect(bsa({ heightCm: 170, weightKg: 70 }).value).toBe(1.82)
    expect(bsa({ heightCm: 170, weightKg: 70, method: 'dubois' }).value).toBe(1.81)
  })
  it('BMI', () => {
    const r = bmi({ heightCm: 175, weightKg: 70 })
    expect(r.value).toBe(22.9)
    expect(r.steps[1]).toMatch(/normal/)
  })
  it('Devine IBW', () => {
    expect(idealBodyWeight({ heightCm: 180, sex: 'male' }).value).toBe(75)
  })
})

describe('dosing', () => {
  it('per-dose mg/kg with frequency and liquid volume (amoxicillin-style)', () => {
    const r = weightBasedDose({ weightKg: 18, dosePerKg: 15, doseUnit: 'mg', dosesPerDay: 3, concentration: { amount: 250, unit: 'mg', perMl: 5 } })
    expect(r.value).toBe(270)
    expect(r.extra.find(e => e.label === 'Total daily dose')?.value).toBe(810)
    expect(r.extra.find(e => e.label === 'Volume per dose')?.value).toBe(5.4)
  })

  it('per-day mg/kg divided into doses', () => {
    const r = weightBasedDose({ weightKg: 20, dosePerKg: 90, doseUnit: 'mg', basis: 'per_day', dosesPerDay: 2 })
    expect(r.value).toBe(900)
  })

  it('applies a maximum single dose and says so', () => {
    const r = weightBasedDose({ weightKg: 60, dosePerKg: 15, doseUnit: 'mg', maxSingleDose: 500 })
    expect(r.value).toBe(500)
    expect(r.warnings.join(' ')).toMatch(/exceeds the stated maximum/)
  })

  it('requires dosesPerDay for per-day regimens', () => {
    expect(() => weightBasedDose({ weightKg: 20, dosePerKg: 90, doseUnit: 'mg', basis: 'per_day' })).toThrow(/dosesPerDay/)
  })

  it('converts mcg doses against mg stock', () => {
    const r = weightBasedDose({ weightKg: 10, dosePerKg: 10, doseUnit: 'mcg', concentration: { amount: 1, unit: 'mg', perMl: 10 } })
    expect(r.value).toBe(100)
    expect(r.extra.find(e => e.label === 'Volume per dose')?.value).toBe(1)
  })
})

describe('infusions and fluids', () => {
  it('volume over time with drop factor', () => {
    const r = infusionRateVolume({ volumeMl: 1000, durationMinutes: 480, dropFactor: 20 })
    expect(r.value).toBe(125)
    expect(r.extra[0]?.value).toBe(42) // 41.67 gtt/min
  })
  it('noradrenaline 0.1 mcg/kg/min, 80 kg, 4 mg in 250 mL → 30 mL/h', () => {
    const r = infusionRateDose({ dose: 0.1, doseUnit: 'mcg/kg/min', weightKg: 80, drugAmount: 4, drugAmountUnit: 'mg', bagVolumeMl: 250 })
    expect(r.value).toBe(30)
  })
  it('rejects mixing units with mass', () => {
    expect(() => infusionRateDose({ dose: 5, doseUnit: 'units/h', drugAmount: 50, drugAmountUnit: 'mg', bagVolumeMl: 50 })).toThrow(/units/)
  })
  it('Holliday–Segar', () => {
    expect(maintenanceFluids({ weightKg: 25 }).value).toBe(65)
    expect(maintenanceFluids({ weightKg: 8 }).value).toBe(32)
  })
})

describe('electrolytes, haemodynamics, ECG', () => {
  it('corrected calcium in both unit systems', () => {
    expect(correctedCalcium({ calcium: 8.0, albumin: 2.0 }).value).toBe(9.6)
    expect(correctedCalcium({ calcium: 2.0, albumin: 25, units: 'si' }).value).toBe(2.3)
  })
  it('anion gap with albumin correction', () => {
    const r = anionGap({ sodium: 140, chloride: 100, bicarbonate: 24, albumin: 2.0 })
    expect(r.value).toBe(16)
    expect(r.extra[0]?.value).toBe(21)
  })
  it('corrected sodium (Katz)', () => {
    expect(correctedSodium({ sodium: 130, glucose: 600 }).value).toBe(138)
  })
  it('MAP', () => {
    expect(meanArterialPressure({ systolic: 120, diastolic: 80 }).value).toBe(93)
  })
  it('QTc Bazett and Fridericia', () => {
    expect(qtc({ qtMs: 400, heartRate: 75, method: 'bazett' }).value).toBe(447)
    expect(qtc({ qtMs: 400, heartRate: 75 }).value).toBe(431)
  })
})

describe('registry', () => {
  it('names missing inputs and unknown calculators', () => {
    expect(() => runCalculator('crcl', { age: 60 })).toThrow(/missing required input\(s\): sex, weightKg, scr/)
    expect(() => runCalculator('nope', {})).toThrow(/Unknown calculator/)
  })
  it('rejects non-numeric strings rather than coercing them', () => {
    expect(() => runCalculator('bmi', { heightCm: '175', weightKg: 70 })).toThrow(CalcError)
  })
})
