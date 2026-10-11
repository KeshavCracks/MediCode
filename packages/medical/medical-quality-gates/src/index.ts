/**
 * Clinical quality gates.
 *
 * Six slash commands — `/spec`, `/plan`, `/build`, `/test`, `/review`,
 * `/constraints` — drive a staged clinical workflow. Each stage command loads
 * its SKILL.md body only when invoked (progressive disclosure: the catalog
 * exposes names and one-line descriptions; the body enters context on use),
 * steers the agent with the stage checklist plus active constraints, and arms
 * an anti-rationalization gate for that turn.
 *
 * Before the turn ends, the gate checks the final reply for the stage's
 * required sections, for dose statements that no deterministic calculation
 * backed, and for shortcut language ("for brevity", "should be fine", TODO).
 * Findings pause the turn and ask the clinician — "Make it complete" steers
 * the model to finish; "Continue anyway" is recorded as a gate override.
 *
 * @module @deepseek-ai/dsh-medical-quality-gates
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'

import { completionSteer, describeFindings, evaluateGate, STAGE_NAMES, STAGES, type GateFinding, type Stage } from './gate.ts'
import { ConstraintStore, DEFAULT_SKILLS_DIR, loadSkillBody } from './store.ts'

export * from './gate.ts'
export { ConstraintStore, DEFAULT_SKILLS_DIR, loadSkillBody, stripFrontmatter, type Constraint } from './store.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'quality-gate': { kind: 'quality-gate'; stage: string } & ContextFormed
  }
}

export const name = 'medical-quality-gates'
export const inject = ['systemPrompt']

export interface Config {
  storePath?: string
  skillsDir?: string
  confirmWithUser: boolean
  maxSteersPerTurn: number
}

export const Config: z<Config> = z.object({
  storePath: z.string().description('Where /constraints are persisted. Defaults to ~/.dsh/medical/constraints.json.'),
  skillsDir: z.string().description('Directory containing the stage skills. Defaults to the bundled skills.'),
  confirmWithUser: z.boolean().default(true).description('Pause and ask the clinician when a gate finds gaps (otherwise steer automatically).'),
  maxSteersPerTurn: z.natural().default(2).description('Maximum completion steers per gated turn.'),
})

const DEFINITION_ID = brandString<CommandDefinitionId>('@deepseek-ai/dsh-medical-quality-gates')
const MAKE_COMPLETE = 'Make it complete'
const CONTINUE = 'Continue anyway'

interface ActiveGate { stage: Stage; turn: number; steers: number; settled: boolean }

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('\n')
}

/** Events of the given turn, newest first, stopping at its `turn/start`. */
function* turnEvents(session: Session, turn: number): Generator<{ type: string; data: unknown }> {
  const events = session.ownEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as { type: string; data: unknown } | undefined
    if (event === undefined) continue
    if (event.type === 'turn/start' && (event.data as { turn: number }).turn === turn) return
    yield event
  }
}

function finalReply(session: Session, turn: number): string {
  for (const event of turnEvents(session, turn)) {
    if (event.type === 'assistant/message') {
      const data = event.data as { turn: number; message: { content: readonly { type: string; text?: string }[] } }
      if (data.turn === turn) return textOf(data.message.content)
    }
  }
  return ''
}

/** Whether a deterministic calculation backed this turn (clinical_calc call or medical-math context). */
function turnVerified(session: Session, turn: number): boolean {
  for (const event of turnEvents(session, turn)) {
    if (event.type === 'tool/call' && (event.data as { name?: string }).name === 'clinical_calc') return true
    if (event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'medical-math') return true
  }
  return false
}

export function apply(ctx: Context, config: Config): void {
  const store = new ConstraintStore(config.storePath ?? join(homedir(), '.dsh', 'medical', 'constraints.json'))
  const skillsDir = config.skillsDir ?? DEFAULT_SKILLS_DIR
  const pending = new WeakMap<Session, Stage>()
  const active = new WeakMap<Session, ActiveGate>()

  ctx.systemPrompt.section({
    name: 'medical:constraints',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 20,
    text: () => {
      const items = store.list()
      if (items.length === 0) return ''
      return ['# Clinical constraints (set by the clinician with /constraints — always honour these)', ...items.map(c => `${c.id}. ${c.text}`)].join('\n')
    },
  })

  // Bind a freshly commanded stage to the turn it starts.
  ctx.on('agent/pre-step', async ({ agent, turn }, next): Promise<PreStepDecision> => {
    const decision = await next()
    const stage = pending.get(agent.session)
    if (stage !== undefined && decision.kind === 'enter') {
      pending.delete(agent.session)
      active.set(agent.session, { stage, turn, steers: 0, settled: false })
    }
    return decision
  })

  const askClinician = async (agent: Agent, stage: Stage, findings: readonly GateFinding[], signal: AbortSignal): Promise<'complete' | 'continue' | 'aborted'> => {
    const questions = config.confirmWithUser ? ctx.get('userQuestions') : undefined
    if (questions === undefined) return 'complete'
    try {
      const answer = await questions.ask({
        agent, signal,
        questions: [{
          id: 'quality-gate',
          header: `/${stage} gate`,
          question: `${describeFindings(stage, findings)} Make the answer complete, or accept it as-is?`,
          options: [
            { label: MAKE_COMPLETE, description: 'Send it back: add the missing sections, verify doses with clinical_calc, remove shortcuts.' },
            { label: CONTINUE, description: 'Accept the answer as it is. This is recorded as a gate override.' },
          ],
        }],
      })
      return answer.answers[0]?.selected[0] === CONTINUE ? 'continue' : 'complete'
    } catch (error) {
      if (signal.aborted) return 'aborted'
      ctx.logger.debug('medical-quality-gates: confirmation unavailable, steering instead: %o', error)
      return 'complete'
    }
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const gate = active.get(agent.session)
    if (gate === undefined || gate.turn !== turn || gate.settled || signal.aborted) return
    if (gate.steers >= config.maxSteersPerTurn) { gate.settled = true; return }
    const reply = finalReply(agent.session, turn)
    if (reply === '') return
    const findings = evaluateGate(reply, gate.stage, turnVerified(agent.session, turn))
    if (findings.length === 0) { gate.settled = true; return }
    const choice = await askClinician(agent, gate.stage, findings, signal)
    if (choice === 'aborted') return
    if (choice === 'continue') {
      gate.settled = true
      const summary = `Gate override: /${gate.stage} accepted with ${findings.length} finding(s)`
      ctx.logger.info('medical-quality-gates: %s', summary)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `[quality-gate:${gate.stage}] The clinician accepted the previous answer despite: ${describeFindings(gate.stage, findings)}` }],
        source: { kind: 'quality-gate', stage: gate.stage, form: 'notice', summary },
      }))
      return
    }
    gate.steers++
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: completionSteer(gate.stage, findings) }],
      source: { kind: 'quality-gate', stage: gate.stage, form: 'notice', summary: `/${gate.stage} gate: ${findings.length} finding(s), revision requested` },
    }))
  })

  ctx.inject(['commands'], (commandCtx) => {
    for (const stage of STAGE_NAMES) {
      const spec = STAGES[stage]
      commandCtx.commands.register({
        definitionId: DEFINITION_ID,
        name: stage,
        description: spec.description,
        input: { hint: 'what to work on (case, question or document)' },
        handler: ({ agent, rawInput }) => {
          const task = rawInput.trim()
          if (task === '') return { kind: 'error', text: `Usage: /${stage} <what to work on>` }
          let body: string
          try {
            body = loadSkillBody(skillsDir, spec.skill)
          } catch (error) {
            return { kind: 'error', text: `Could not load the ${spec.skill} skill: ${String(error)}` }
          }
          const constraints = store.list()
          const text = [
            `[quality-gate:${stage}] Follow the ${spec.skill} stage instructions below. Your reply must contain these sections as headings: ${spec.sections.join(', ')}.`,
            body,
            constraints.length > 0 ? `Active clinical constraints:\n${constraints.map(c => `${c.id}. ${c.text}`).join('\n')}` : '',
            `Task:\n${task}`,
          ].filter(Boolean).join('\n\n')
          pending.set(agent.session, stage)
          agent.steer(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'quality-gate', stage, form: 'instructions' },
          }))
          return { kind: 'success', text: `/${stage} gate started — the reply will be checked for: ${spec.sections.join(', ')}.` }
        },
      })
    }

    commandCtx.commands.register({
      definitionId: DEFINITION_ID,
      name: 'constraints',
      description: 'List, add, remove or clear standing clinical constraints (e.g. "formulary: NLEM 2022 only")',
      input: { hint: '[list | add <text> | remove <n> | clear | <text>]' },
      handler: ({ rawInput }) => {
        const input = rawInput.trim()
        const [verb = '', ...rest] = input.split(/\s+/)
        const argument = rest.join(' ').trim()
        const listing = (): string => {
          const items = store.list()
          return items.length === 0 ? 'No clinical constraints set.' : items.map(c => `${c.id}. ${c.text}`).join('\n')
        }
        switch (verb.toLowerCase()) {
          case '':
          case 'list':
            return { kind: 'success', text: listing() }
          case 'clear':
            store.clear()
            return { kind: 'success', text: 'All clinical constraints cleared.' }
          case 'remove':
          case 'rm':
          case 'delete': {
            const id = Number(argument)
            if (!Number.isInteger(id)) return { kind: 'error', text: 'Usage: /constraints remove <number>' }
            return store.remove(id)
              ? { kind: 'success', text: `Removed constraint ${id}.\n${listing()}` }
              : { kind: 'error', text: `No constraint numbered ${id}.` }
          }
          case 'add': {
            if (argument === '') return { kind: 'error', text: 'Usage: /constraints add <text>' }
            const item = store.add(argument)
            return { kind: 'success', text: `Added constraint ${item.id}: ${item.text}` }
          }
          default: {
            const item = store.add(input)
            return { kind: 'success', text: `Added constraint ${item.id}: ${item.text}` }
          }
        }
      },
    })
  })
}
