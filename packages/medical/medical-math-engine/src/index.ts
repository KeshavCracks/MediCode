/**
 * Deterministic clinical math for the medical harness.
 *
 * Three layers keep arithmetic out of the language model:
 *
 * 1. **Interceptor** (`agent/pre-step`): user text is scanned with regexes
 *    for calculation intent (CrCl, eGFR, mg/kg, BSA, drip rates …). Recognised
 *    variables are run through pure calculators and the verified result is
 *    appended to the step as a `medical-math` context message, so the model
 *    receives the answer instead of computing it.
 * 2. **Tool** (`clinical_calc`): the model can request any calculator with
 *    structured inputs. Results are recorded for the turn.
 * 3. **Verifier** (`agent/turn-stopping`): before the turn ends, numbers in the
 *    final reply that sit next to a calculation label are compared against the
 *    verified values; a mismatch steers the model to correct itself.
 *
 * @module @deepseek-ai/dsh-medical-math-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { CALCULATOR_IDS, CALCULATORS, formatResult, runCalculator, type CalcResult } from './calculators.ts'
import { interceptCalculations, type InterceptResult } from './extract.ts'
import { correctionMessage, verifyReply } from './verify.ts'

export * from './calculators.ts'
export * from './units.ts'
export { extractVariables, detectIntents, interceptCalculations, type ExtractedVariables, type InterceptResult } from './extract.ts'
export { verifyReply, correctionMessage, type VerificationReport, type Mismatch } from './verify.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'medical-math': { kind: 'medical-math' } & ContextFormed
  }
}

export const name = 'medical-math-engine'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  intercept: boolean
  verify: boolean
  requireToolForClaims: boolean
  maxCorrectionsPerTurn: number
}

export const Config: z<Config> = z.object({
  intercept: z.boolean().default(true).description('Scan user messages for calculation requests and inject verified results.'),
  verify: z.boolean().default(true).description('Check numbers in the final reply against verified calculations before the turn ends.'),
  requireToolForClaims: z.boolean().default(true).description('Steer when the reply states a calculated value that no deterministic calculator produced.'),
  maxCorrectionsPerTurn: z.natural().default(1).description('Maximum verification steers per turn (prevents loops).'),
})

const POLICY = `# Clinical math policy
All clinical arithmetic (renal function, BSA, BMI, IBW, weight-based doses, infusion and drip rates, maintenance fluids, corrected electrolytes, anion gap, MAP, QTc) is computed by deterministic code, never by you.
- When a \`medical-math\` context block is present, quote its values exactly and show the formula it lists; do not recompute or round differently.
- For any other number, call the \`clinical_calc\` tool. If inputs are missing, ask for them instead of assuming.
- Always state the inputs used and the units. Flag the calculator's warnings to the clinician.`

/** Per-session record of verified values for the current turn. */
interface TurnLedger {
  turn: number
  results: CalcResult[]
  corrections: number
}

function textOf(message: { content: readonly { type: string }[] }): string {
  return message.content
    .map(block => (block.type === 'text' ? (block as { type: 'text'; text: string }).text : ''))
    .join('\n')
}

function boundSummary(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Render the interceptor outcome as one model-facing context message body. */
export function renderInterception(result: InterceptResult): string | undefined {
  if (result.results.length === 0 && result.missing.length === 0 && result.errors.length === 0) return undefined
  const parts: string[] = ['[medical-math] Deterministic calculation results computed by the harness (not by the model). Use these exact values.']
  if (result.parsed.length > 0) parts.push(`Inputs parsed from the user's message (confirm with the clinician if any look wrong): ${result.parsed.join('; ')}.`)
  for (const r of result.results) parts.push(formatResult(r))
  for (const m of result.missing) {
    parts.push(`Cannot compute ${CALCULATORS[m.calculator].description.split(' (')[0]} — missing: ${m.fields.join(', ')}. Ask the clinician for these values; do not estimate them.`)
  }
  for (const e of result.errors) parts.push(`Input problem for ${e.calculator}: ${e.message} Ask the clinician to confirm.`)
  return parts.join('\n\n')
}

/** Last assistant text of the given turn, read from the session log. */
function finalAssistantText(session: Session, turn: number): string {
  const events = session.ownEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'turn/start') break
    if (event.type === 'assistant/message' && event.data.turn === turn) return textOf(event.data.message)
  }
  return ''
}

export function apply(ctx: Context, config: Config): void {
  const ledgers = new WeakMap<Session, TurnLedger>()
  const ledger = (session: Session, turn?: number): TurnLedger => {
    let entry = ledgers.get(session)
    if (entry === undefined || (turn !== undefined && entry.turn !== turn)) {
      entry = { turn: turn ?? entry?.turn ?? 0, results: [], corrections: 0 }
      ledgers.set(session, entry)
    }
    return entry
  }

  ctx.systemPrompt.section({
    name: 'medical:math-policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 10,
    text: POLICY,
  })

  ctx.tools.register(defineTool({
    name: 'clinical_calc',
    description: [
      'Run a deterministic, validated clinical calculator. Use this for EVERY clinical number — never do the arithmetic yourself.',
      'Calculators and required inputs:',
      ...CALCULATOR_IDS.map(id => `- ${id}: ${CALCULATORS[id].description} Required: ${CALCULATORS[id].required.join(', ')}.${CALCULATORS[id].optional.length ? ` Optional: ${CALCULATORS[id].optional.join(', ')}.` : ''}`),
      'Units: weightKg kg, heightCm cm, scr with scrUnit "mg/dL" (default) or "umol/L", sex "male"|"female", age years.',
    ].join('\n'),
    parameters: {
      calculator: { type: 'string', required: true, enum: [...CALCULATOR_IDS], description: 'Calculator id.' },
      inputs: { type: 'json', required: true, description: 'Object of named inputs for the calculator, e.g. {"age":67,"sex":"male","weightKg":70,"scr":1.4}.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const inputs = args.inputs
      if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
        throw new Error('inputs must be a JSON object of named values.')
      }
      const result = runCalculator(args.calculator, inputs as Record<string, unknown>)
      const session = exec.agent?.session
      if (session !== undefined) ledger(session).results.push(result)
      return formatResult(result)
    },
  }))

  if (config.intercept) {
    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const entry = ledger(agent.session, turn)
      if (decision.kind === 'reject' || signal.aborted) return decision
      const userText = messages
        .filter((m: UserMessage) => m.source.kind === 'user')
        .map(textOf)
        .join('\n')
      if (userText.trim() === '') return decision
      let outcome: InterceptResult
      try {
        outcome = interceptCalculations(userText)
      } catch (error) {
        ctx.logger.warn('medical-math: interceptor failed: %o', error)
        return decision
      }
      entry.results.push(...outcome.results)
      const body = renderInterception(outcome)
      if (body === undefined) return decision
      const summary = outcome.results.length > 0
        ? `Verified: ${outcome.results.map(r => `${r.label.split(' (')[0]} ${r.value} ${r.unit}`).join('; ')}`
        : `Calculation needs inputs: ${outcome.missing.map(m => m.fields.join(', ')).join(' | ')}`
      const contextMessage = createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'medical-math', form: 'notice', summary: boundSummary(summary) },
      })
      return { ...decision, messages: [...decision.messages, contextMessage] }
    })
  }

  if (config.verify) {
    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal.aborted) return
      const entry = ledger(agent.session, turn)
      if (entry.corrections >= config.maxCorrectionsPerTurn) return
      const reply = finalAssistantText(agent.session, turn)
      if (reply === '') return
      const report = verifyReply(reply, entry.results)
      const failing = report.mismatches.length > 0 || (config.requireToolForClaims && report.unverifiedClaims.length > 0)
      if (!failing) return
      entry.corrections++
      const effective = config.requireToolForClaims ? report : { ...report, unverifiedClaims: [] }
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: correctionMessage(effective, entry.results) }],
        source: { kind: 'medical-math', form: 'notice', summary: boundSummary(`Math verification: ${report.mismatches.length} mismatch(es), ${report.unverifiedClaims.length} unverified claim(s)`) },
      }))
    })
  }
}
