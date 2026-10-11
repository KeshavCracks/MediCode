import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

import * as plugin from '../src/index.ts'
import { ConstraintStore, DEFAULT_SKILLS_DIR, evaluateGate, hasSection, loadSkillBody, STAGES } from '../src/index.ts'

const COMPLETE_SPEC = `## Clinical question
Is amoxicillin appropriate?
## Patient context
4 y, 18 kg.
## Known data
Fever 3 days.
## Unknowns
Allergy history.
## Goal
Dose.
## Constraints
OPD.
## Acceptance criteria
Dose verified.`

describe('gate evaluation', () => {
  it('recognises headings, bold labels and numbered labels', () => {
    expect(hasSection('## Monitoring\nx', 'Monitoring')).toBe(true)
    expect(hasSection('**Monitoring**: x', 'Monitoring')).toBe(true)
    expect(hasSection('3. **Residual risk** — x', 'Residual risk')).toBe(true)
    expect(hasSection('we will be monitoring closely', 'Monitoring')).toBe(false)
  })

  it('passes a complete spec', () => {
    expect(evaluateGate(COMPLETE_SPEC, 'spec', false)).toEqual([])
  })

  it('reports missing sections, unverified doses and shortcut language', () => {
    const findings = evaluateGate('## Problem list\n1. CAP\n## Steps\nGive amoxicillin 500 mg tid. For brevity I will skip monitoring; it should be fine.', 'plan', false)
    const kinds = findings.map(f => `${f.kind}:${f.detail}`)
    expect(kinds).toEqual(expect.arrayContaining([
      'missing-section:Monitoring', 'missing-section:Escalation', 'missing-section:Risks',
      'unverified-dose:500 mg tid', 'rationalization:for brevity', 'rationalization:I will skip/omit', 'rationalization:should be fine',
    ]))
  })

  it('accepts doses when a deterministic calculation backed the turn', () => {
    const findings = evaluateGate(`${COMPLETE_SPEC}\nGive 15 mg/kg q8h.`, 'spec', true)
    expect(findings).toEqual([])
  })

  it('ignores reasoning inside <think>', () => {
    expect(evaluateGate(`<think>for brevity, TODO</think>${COMPLETE_SPEC}`, 'spec', false)).toEqual([])
  })
})

describe('skills and constraints', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('ships one skill per stage whose body names every required section', () => {
    for (const spec of Object.values(STAGES)) {
      const body = loadSkillBody(DEFAULT_SKILLS_DIR, spec.skill)
      expect(body.startsWith('---')).toBe(false)
      for (const section of spec.sections) expect(body).toContain(`**${section}**`)
    }
  })

  it('persists constraints atomically', () => {
    dir = mkdtempSync(join(tmpdir(), 'qg-'))
    const store = new ConstraintStore(join(dir, 'nested', 'c.json'))
    expect(store.list()).toEqual([])
    store.add('Formulary: NLEM 2022 only')
    store.add('Paediatric doses in mg/kg with max cap')
    expect(store.list().map(c => c.id)).toEqual([1, 2])
    expect(store.remove(1)).toBe(true)
    expect(store.remove(9)).toBe(false)
    expect(new ConstraintStore(join(dir, 'nested', 'c.json')).list().map(c => c.text)).toEqual(['Paediatric doses in mg/kg with max cap'])
  })
})

// ---------------------------------------------------------------------------
// Plugin wiring with fake commands / userQuestions services.
// ---------------------------------------------------------------------------

type Handler = (invocation: { agent: Agent; rawInput: string }) => { kind: string; text?: string }

function fakeAgent(events: unknown[]) {
  const session = { id: 's1', ownEvents: () => events } as unknown as Session
  return { id: 's1', session, options: {}, steer: vi.fn(), inject: vi.fn() } as unknown as Agent & { steer: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> }
}

async function setup(answer?: string) {
  dir = mkdtempSync(join(tmpdir(), 'qg-plugin-'))
  const handlers = new Map<string, Handler>()
  const ask = vi.fn(async () => ({ answers: [{ id: 'quality-gate', selected: answer === undefined ? [] : [answer] }] }))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  ctx.provide('commands', { register: (def: { name: string; handler: Handler }) => { handlers.set(def.name, def.handler); return () => {} } } as never)
  if (answer !== undefined) ctx.provide('userQuestions', { ask } as never)
  await ctx.plugin(plugin, { storePath: join(dir, 'constraints.json'), confirmWithUser: true, maxSteersPerTurn: 2 })
  return { ctx, handlers, ask }
}
let dir: string | undefined
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

async function runTurn(ctx: Context, agent: Agent, turn = 1) {
  const message: UserMessage = createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })
  await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [message], turn, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [message] } as PreStepDecision))
  await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn, signal: new AbortController().signal })
}

const reply = (text: string) => [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } },
]

describe('medical-quality-gates plugin', () => {
  it('registers the six commands', async () => {
    const { handlers } = await setup()
    expect([...handlers.keys()].sort()).toEqual(['build', 'constraints', 'plan', 'review', 'spec', 'test'])
  })

  it('/spec loads the skill lazily and steers with the checklist and constraints', async () => {
    const { handlers } = await setup()
    handlers.get('constraints')!({ agent: fakeAgent([]), rawInput: 'Formulary: NLEM 2022 only' })
    const agent = fakeAgent([])
    const result = handlers.get('spec')!({ agent, rawInput: '4-year-old with otitis media' })
    expect(result.kind).toBe('success')
    const steered = agent.steer.mock.calls[0]![0] as UserMessage
    expect(steered.source).toMatchObject({ kind: 'quality-gate', stage: 'spec', form: 'instructions' })
    const text = steered.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('# Clinical spec gate')
    expect(text).toContain('1. Formulary: NLEM 2022 only')
    expect(text).toContain('4-year-old with otitis media')
    expect(handlers.get('spec')!({ agent, rawInput: '  ' }).kind).toBe('error')
  })

  it('asks the clinician and steers on "Make it complete"', async () => {
    const { ctx, handlers, ask } = await setup('Make it complete')
    const agent = fakeAgent(reply('## Problem list\nCAP\nFor brevity, the rest is omitted.'))
    handlers.get('plan')!({ agent, rawInput: 'CAP in a 70-year-old' })
    agent.steer.mockClear()
    await runTurn(ctx, agent)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const text = (agent.steer.mock.calls[0]![0] as UserMessage).content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toMatch(/missing required section\(s\): Steps, Monitoring, Escalation, Risks/)
  })

  it('records an override and lets the turn end on "Continue anyway"', async () => {
    const { ctx, handlers } = await setup('Continue anyway')
    const agent = fakeAgent(reply('## Problem list\nCAP'))
    handlers.get('plan')!({ agent, rawInput: 'CAP' })
    agent.steer.mockClear()
    await runTurn(ctx, agent)
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect((agent.inject.mock.calls[0]![0] as UserMessage).source).toMatchObject({ kind: 'quality-gate', form: 'notice' })
  })

  it('steers automatically when no question channel exists, at most maxSteersPerTurn times', async () => {
    const { ctx, handlers } = await setup()
    const agent = fakeAgent(reply('incomplete'))
    handlers.get('review')!({ agent, rawInput: 'this discharge letter' })
    agent.steer.mockClear()
    await runTurn(ctx, agent)
    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    expect(agent.steer).toHaveBeenCalledTimes(2)
  })

  it('does not gate ordinary turns', async () => {
    const { ctx } = await setup()
    const agent = fakeAgent(reply('Give 500 mg tid, should be fine.'))
    await runTurn(ctx, agent)
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('adds constraints to the system prompt', async () => {
    const { ctx, handlers } = await setup()
    handlers.get('constraints')!({ agent: fakeAgent([]), rawInput: 'add No fluoroquinolones in children' })
    const agent = fakeAgent([])
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent } as never)
    expect(JSON.stringify(assembly)).toContain('No fluoroquinolones in children')
  })
})
