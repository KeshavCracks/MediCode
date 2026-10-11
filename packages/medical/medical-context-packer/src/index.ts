/**
 * Context packing for pasted clinical documents (context-mode style).
 *
 * At `agent/pre-step`, any user message whose text exceeds `minChars` is
 * packed in place: boilerplate, repeated page furniture, and duplicate
 * paragraphs are removed, direct identifiers are replaced with typed
 * placeholders, and section headings are normalised. The packed message keeps
 * the original message id and source, so the session log records exactly what
 * the model saw — and, with redaction on, identifiers never reach the log or
 * the remote GPU.
 *
 * @module @deepseek-ai/dsh-medical-context-packer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'

import { packDocument, packHeader, type PackOptions } from './pack.ts'

export { packDocument, packHeader, estimateTokens, type PackOptions, type PackResult, type PackStats } from './pack.ts'

export const name = 'medical-context-packer'

export interface Config {
  minChars: number
  redactIdentifiers: boolean
  furnitureMinLength: number
  repeatThreshold: number
}

export const Config: z<Config> = z.object({
  minChars: z.natural().default(1500).description('Pack user messages whose text is at least this many characters.'),
  redactIdentifiers: z.boolean().default(true).description('Replace MRN/UHID, phone, e-mail, Aadhaar, PAN and labelled name/DOB/address with placeholders before the text is logged or sent.'),
  furnitureMinLength: z.natural().default(25).description('Minimum line length considered page furniture when repeated.'),
  repeatThreshold: z.natural().default(3).description('Occurrences after which a long line is treated as a repeated header/footer.'),
})

/**
 * Pack the text blocks of one user message. Non-text blocks (images, files)
 * pass through untouched. Returns the original object when nothing changes.
 */
export function packMessage(message: UserMessage, config: Config): UserMessage {
  const textLength = message.content.reduce((n, b) => n + (b.type === 'text' ? (b as { text: string }).text.length : 0), 0)
  if (textLength < config.minChars) return message
  const options: PackOptions = {
    redactIdentifiers: config.redactIdentifiers,
    furnitureMinLength: config.furnitureMinLength,
    repeatThreshold: config.repeatThreshold,
  }
  let changed = false
  const content = message.content.map((block) => {
    if (block.type !== 'text') return block
    const original = (block as { type: 'text'; text: string }).text
    if (original.length < config.minChars) {
      // Short companion text (e.g. the question under a pasted document) is still redacted.
      if (!config.redactIdentifiers) return block
      const { text, stats } = packDocument(original, { ...options, furnitureMinLength: Number.MAX_SAFE_INTEGER })
      if (Object.keys(stats.redactions).length === 0) return block
      changed = true
      return { ...block, text }
    }
    const { text, stats } = packDocument(original, options)
    changed = true
    return { ...block, text: `${packHeader(stats)}\n\n${text}` }
  })
  if (!changed) return message
  return Object.freeze({ ...message, content: Object.freeze(content) }) as UserMessage
}

export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async ({ signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    let changed = false
    const messages = decision.messages.map((message) => {
      if (message.source.kind !== 'user') return message
      const packed = packMessage(message, config)
      if (packed !== message) changed = true
      return packed
    })
    return changed ? { ...decision, messages } : decision
  })
}
