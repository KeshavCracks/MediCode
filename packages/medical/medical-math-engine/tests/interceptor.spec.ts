import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as plugin from '../src/index.ts'
import { extractVariables, interceptCalculations, renderInterception, verifyReply } from '../src/index.ts'

describe('variable extraction', () => {
  it('reads a typical renal-dosing question', () => {
    const { variables } = extractVariables('67-year-old man, weight 70 kg, creatinine 1.4 mg/dL. What is his CrCl for renal dosing?')
    expect(variables).toMatchObject({ age: 67, sex: 'male', weightKg: 70, scr: 1.4, scrUnit: 'mg/dL' })
  })

  it('reads compact notation, pounds, feet/inches and µmol/L', () => {
    const { variables } = extractVariables('72F, 154 lb, 5\'4", SCr 110 umol/L')
    expect(variables.age).toBe(72)
    expect(variables.sex).toBe('female')
    expect(variables.weightKg).toBeCloseTo(69.85, 2)
    expect(variables.heightCm).toBeCloseTo(162.6, 1)
    expect(variables).toMatchObject({ scr: 110, scrUnit: 'umol/L' })
  })

  it('infers µmol/L for unitless creatinine above 25 and flags the assumption', () => {
    const { variables, parsed } = extractVariables('Cr 132, age 80, male, 60 kg')
    expect(variables.scrUnit).toBe('umol/L')
    expect(parsed.join(' ')).toMatch(/assumed µmol\/L — confirm/)
  })

  it('does not mistake "creatinine clearance 50" for a creatinine value', () => {
    expect(extractVariables('creatinine clearance 50 mL/min').variables.scr).toBeUndefined()
  })

  it('does not read mg/kg as a body weight', () => {
    const { variables } = extractVariables('give 15 mg/kg q8h')
    expect(variables.weightKg).toBeUndefined()
    expect(variables).toMatchObject({ dosePerKg: 15, doseUnit: 'mg', basis: 'per_dose', dosesPerDay: 3 })
  })

  it('distinguishes per-dose from per-day', () => {
    expect(extractVariables('10 mg/kg/dose').variables.basis).toBe('per_dose')
    expect(extractVariables('90 mg/kg/day divided bid').variables).toMatchObject({ basis: 'per_day', dosesPerDay: 2 })
  })

  it('ambiguous sex is not used', () => {
    const { variables, parsed } = extractVariables('the woman and her husband (a man) — 40 years')
    expect(variables.sex).toBeUndefined()
    expect(parsed.join(' ')).toMatch(/ambiguous/)
  })
})

describe('interception', () => {
  it('computes CrCl deterministically from free text', () => {
    const r = interceptCalculations('67 year old male, 70 kg, serum creatinine 1.4 mg/dL — calculate creatinine clearance (Cockcroft-Gault).')
    expect(r.results.map(x => x.calculator)).toContain('crcl')
    expect(r.results.find(x => x.calculator === 'crcl')?.value).toBe(50.7)
  })

  it('computes a pediatric weight-based dose with volume', () => {
    const r = interceptCalculations('4 year old boy 18 kg, amoxicillin 15 mg/kg/dose TID, suspension 250 mg/5 mL. What dose?')
    const dose = r.results.find(x => x.calculator === 'weight_dose')
    expect(dose?.value).toBe(270)
    expect(dose?.extra.find(e => e.label === 'Volume per dose')?.value).toBe(5.4)
  })

  it('routes pediatric eGFR to bedside Schwartz', () => {
    const r = interceptCalculations('8 year old, height 120 cm, creatinine 0.5 mg/dL, what is the eGFR?')
    expect(r.results.map(x => x.calculator)).toEqual(['egfr_peds'])
    expect(r.results[0]?.value).toBe(99)
  })

  it('computes drip rates', () => {
    const r = interceptCalculations('1 L normal saline over 8 hours, giving set 20 drops/mL — drip rate?')
    const rate = r.results.find(x => x.calculator === 'infusion_volume')
    expect(rate?.value).toBe(125)
    expect(rate?.extra[0]?.value).toBe(42)
  })

  it('computes a vasopressor pump rate', () => {
    const r = interceptCalculations('Noradrenaline 0.1 mcg/kg/min for an 80 kg patient, 4 mg in 250 mL. Pump rate?')
    expect(r.results.find(x => x.calculator === 'infusion_dose')?.value).toBe(30)
  })

  it('reports missing variables instead of guessing', () => {
    const r = interceptCalculations('What is the CrCl for a 70 kg man with creatinine 1.2?')
    expect(r.results).toHaveLength(0)
    expect(r.missing).toEqual([{ calculator: 'crcl', fields: ['age'] }])
    expect(renderInterception(r)).toMatch(/missing: age/)
  })

  it('stays quiet for conceptual questions without inputs', () => {
    const r = interceptCalculations('What BMI counts as obese in South Asian adults?')
    expect(renderInterception(r)).toBeUndefined()
  })

  it('surfaces implausible inputs as input problems', () => {
    const r = interceptCalculations('BMI for 70 kg, height 17 cm')
    expect(r.errors[0]?.message).toMatch(/plausible range/)
  })
})

describe('reply verification', () => {
  const crcl = interceptCalculations('67 yo male 70 kg creatinine 1.4 mg/dL CrCl?').results

  it('accepts a reply quoting the verified value', () => {
    expect(verifyReply('Estimated CrCl is 50.7 mL/min, so reduce the dose.', crcl).mismatches).toHaveLength(0)
  })

  it('accepts thresholds and ignores <think> content', () => {
    const reply = '<think>CrCl = 62 mL/min maybe</think>CrCl 50.7 mL/min; if CrCl < 30 mL/min avoid.'
    expect(verifyReply(reply, crcl).mismatches).toHaveLength(0)
  })

  it('flags a wrong number next to the label', () => {
    const report = verifyReply('His creatinine clearance is about 62 mL/min.', crcl)
    expect(report.mismatches[0]).toMatchObject({ calculator: 'crcl', claimed: 62 })
  })

  it('flags calculated claims when nothing was verified', () => {
    expect(verifyReply('BSA = 1.9 m² so the dose is 190 mg.', []).unverifiedClaims).toEqual(['= 1.9 m²'])
  })
})

// ---------------------------------------------------------------------------
// Plugin wiring: real Cordis context, real ToolRuntime and SystemPrompt.
// ---------------------------------------------------------------------------

function fakeSession(events: unknown[] = []): Session {
  return { id: 'med-session', ownEvents: () => events } as unknown as Session
}

function fakeAgent(session: Session): Agent & { steer: ReturnType<typeof vi.fn> } {
  return { id: session.id, session, options: {}, steer: vi.fn(), inject: vi.fn() } as unknown as Agent & { steer: ReturnType<typeof vi.fn> }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { intercept: true, verify: true, requireToolForClaims: true, maxCorrectionsPerTurn: 1 })
  return ctx
}

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('medical-math-engine plugin', () => {
  it('registers clinical_calc and computes through the tool runtime', async () => {
    const ctx = await setup()
    expect(ctx.tools.schemas().some(s => s.name === 'clinical_calc')).toBe(true)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('c1'),
      name: 'clinical_calc',
      arguments: { calculator: 'bsa', inputs: { heightCm: 170, weightKg: 70 } },
      agent: fakeAgent(fakeSession()),
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('1.82 m²')
  })

  it('returns a tool error for invalid inputs instead of a number', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('c2'),
      name: 'clinical_calc',
      arguments: { calculator: 'crcl', inputs: { age: 67 } },
    })
    expect(result.isError).toBe(true)
  })

  it('pre-step appends a verified medical-math context message', async () => {
    const ctx = await setup()
    const agent = fakeAgent(fakeSession())
    const message = user('67 year old male, 70 kg, creatinine 1.4 mg/dL — CrCl?')
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [message] } as PreStepDecision))
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source.kind).toBe('medical-math')
    const body = injected.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(body).toContain('50.7 mL/min')
    expect(body).toContain('not by the model')
  })

  it('turn-stopping steers once when the reply contradicts the verified value', async () => {
    const ctx = await setup()
    const events: unknown[] = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'The CrCl is roughly 62 mL/min.' }] } } },
    ]
    const agent = fakeAgent(fakeSession(events))
    const message = user('67 year old male, 70 kg, creatinine 1.4 mg/dL — CrCl?')
    await agentEvents(ctx, agent).waterfall('agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [message] } as PreStepDecision))
    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const steered = agent.steer.mock.calls[0]![0] as UserMessage
    const text = steered.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toMatch(/stated 62, verified value\(s\): 50\.7/)
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    expect(agent.steer).toHaveBeenCalledTimes(1)
  })
})
