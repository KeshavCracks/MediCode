import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import * as plugin from '../src/index.ts'
import { packDocument, packMessage } from '../src/index.ts'

const HEADER = 'SUNRISE MULTISPECIALITY HOSPITAL — DEPARTMENT OF INTERNAL MEDICINE'
const FOOTER = 'This is a computer generated report and does not require signature'

function page(n: number, body: string): string {
  return [HEADER, `Page ${n} of 3`, '', body, '', FOOTER, '----------'].join('\n')
}

const DISCHARGE = [
  page(1, [
    'Patient Name: Ramesh Kumar Sharma   Age: 67 years   Sex: Male',
    'UHID: SMH2024-118833     IP No: 45512',
    'DOB: 12/03/1957',
    'Contact: +91 98765 43210, ramesh.sharma@example.com',
    'Aadhaar 2345 6789 0123',
    '',
    'CHIEF COMPLAINTS:',
    'Breathlessness on exertion for 2 weeks, bilateral pedal oedema.',
    '',
    'History of present illness',
    'Known case of T2DM and hypertension for 15 years, CKD stage 3b.',
  ].join('\n')),
  page(2, [
    'Investigations:',
    'Hb 10.2 g/dL',
    'Hb 10.2 g/dL',
    'Creatinine 1.8 mg/dL',
    'Na 134  K 5.1',
    '',
    'Patient was managed with IV furosemide and fluid restriction. Renal function was monitored daily and remained stable.',
    '',
    'Patient was managed with IV furosemide and fluid restriction. Renal function was monitored daily and remained stable.',
  ].join('\n')),
  page(3, [
    'Discharge medications',
    'Tab furosemide 40 mg OD',
    'Tab linagliptin 5 mg OD',
    '',
    'Electronically signed by Dr. A. Rao on 04/10/2026 18:22',
    'CONFIDENTIALITY NOTICE: This document contains privileged information.',
  ].join('\n')),
].join('\n\n')

describe('packDocument', () => {
  const { text, stats } = packDocument(DISCHARGE)

  it('shrinks the document', () => {
    expect(stats.packedChars).toBeLessThan(stats.originalChars)
    expect(stats.packedTokens).toBeLessThan(stats.originalTokens)
  })

  it('keeps one copy of repeated page headers and drops footers/page numbers/rules', () => {
    expect(text.split(HEADER).length - 1).toBe(1)
    expect(text).not.toContain(FOOTER)
    expect(text).not.toMatch(/Page \d of 3/)
    expect(text).not.toContain('----------')
  })

  it('removes signature and confidentiality boilerplate', () => {
    expect(text).not.toMatch(/Electronically signed/)
    expect(text).not.toMatch(/CONFIDENTIALITY NOTICE/)
    expect(stats.boilerplateLines).toBeGreaterThanOrEqual(5)
  })

  it('removes duplicate long paragraphs but never short repeated lab lines', () => {
    expect(text.split('Patient was managed with IV furosemide').length - 1).toBe(1)
    expect(stats.duplicateParagraphs).toBe(1)
    expect(text.split('Hb 10.2 g/dL').length - 1).toBe(2)
  })

  it('preserves every clinical value', () => {
    for (const fact of ['Age: 67 years', 'Sex: Male', 'Creatinine 1.8 mg/dL', 'Na 134  K 5.1', 'Tab furosemide 40 mg OD', 'CKD stage 3b']) {
      expect(text).toContain(fact)
    }
  })

  it('redacts identifiers without eating adjacent clinical labels', () => {
    expect(text).not.toContain('Ramesh')
    expect(text).not.toContain('SMH2024-118833')
    expect(text).not.toContain('98765')
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('2345 6789 0123')
    expect(text).not.toContain('12/03/1957')
    expect(text).toContain('[NAME]')
    expect(stats.redactions).toMatchObject({ name: 1, mrn: 2, dob: 1, email: 1, aadhaar: 1, phone: 1 })
  })

  it('labels clinical sections', () => {
    expect(text).toContain('## Chief complaint')
    expect(text).toContain('## Investigations')
    expect(text).toContain('## Medications')
    expect(stats.sections).toEqual(expect.arrayContaining(['Chief complaint', 'History of present illness', 'Investigations', 'Medications']))
  })

  it('is deterministic', () => {
    expect(packDocument(DISCHARGE).text).toBe(text)
  })

  it('can leave identifiers when redaction is disabled', () => {
    expect(packDocument(DISCHARGE, { redactIdentifiers: false }).text).toContain('SMH2024-118833')
  })
})

describe('packMessage / plugin', () => {
  const config = { minChars: 400, redactIdentifiers: true, furnitureMinLength: 25, repeatThreshold: 3 }

  it('keeps id and source, prepends the stats header, and leaves images untouched', () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' } as const
    const message = createUserMessage({
      content: [{ type: 'text', text: DISCHARGE }, image as never, { type: 'text', text: 'Summarise. Call me on 9876543210.' }],
      source: { kind: 'user' },
    })
    const packed = packMessage(message, config)
    expect(packed.id).toBe(message.id)
    expect(packed.source).toEqual(message.source)
    const first = packed.content[0] as { type: 'text'; text: string }
    expect(first.text).toMatch(/^\[context-packer\] Pasted document packed: [\d,]+ → [\d,]+ chars/)
    expect(packed.content[1]).toEqual(image)
    expect((packed.content[2] as { text: string }).text).toBe('Summarise. Call me on [PHONE].')
  })

  it('leaves short messages alone', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'short question' }], source: { kind: 'user' } })
    expect(packMessage(message, config)).toBe(message)
  })

  it('rewrites the accepted pre-step batch in place', async () => {
    const ctx = new Context()
    await ctx.plugin(plugin, config)
    const session = { id: 's' } as unknown as Session
    const agent = { id: 's', session, options: {} } as unknown as Agent
    const message: UserMessage = createUserMessage({ content: [{ type: 'text', text: DISCHARGE }], source: { kind: 'user' } })
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [message] } as PreStepDecision))
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0]!.id).toBe(message.id)
    const text = (decision.messages[0]!.content[0] as { text: string }).text
    expect(text).toContain('[context-packer]')
    expect(text).not.toContain('Ramesh')
  })
})
