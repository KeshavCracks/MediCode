/**
 * `clinical_diagram` — editorial clinical diagrams (timeline, care pathway,
 * decision tree) written as self-contained, accessible HTML+SVG files.
 * No Mermaid, no CDN, no runtime engine: the layout is computed in-process
 * and the file opens offline in any browser or the harness preview.
 *
 * @module @deepseek-ai/dsh-medical-diagrams
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'

import { renderDiagram, type DiagramKind, type DiagramSpec, type Tone } from './render.ts'

export * from './render.ts'

export const name = 'medical-diagrams'
export const inject = ['tools']

export interface Config {
  outputDir: string
}

export const Config: z<Config> = z.object({
  outputDir: z.string().default('clinical-diagrams').description('Output directory; relative paths resolve against the session working directory.'),
})

/** File-system-safe slug for the diagram title. */
export function slugify(title: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return slug || 'diagram'
}

const TONES = ['default', 'accent', 'warning', 'muted'] as const

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'clinical_diagram',
    description: [
      'Render an editorial clinical diagram as a self-contained, accessible HTML+SVG file (no Mermaid).',
      'kind "timeline": ordered events, each node may set `at` (e.g. "Day 0", "08:30"); edges ignored.',
      'kind "pathway": care pathway / algorithm as an acyclic graph (nodes + edges, merges allowed).',
      'kind "decision_tree": one root, each node has one parent; label edges with the decision (e.g. "Yes"/"No").',
      'Tones: accent = the key action, warning = red flag / escalation, muted = optional or note. Keep labels short; put specifics in `detail`.',
      'Never include patient identifiers. Doses shown in a diagram must come from clinical_calc.',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', required: true, enum: ['timeline', 'pathway', 'decision_tree'] },
      title: { type: 'string', required: true, description: 'Figure title.' },
      subtitle: { type: 'string', description: 'Optional one-line context (population, setting, guideline).' },
      source: { type: 'string', description: 'Guideline or reference the diagram is based on, with year.' },
      nodes: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            label: { type: 'string', required: true },
            detail: { type: 'string' },
            tone: { type: 'string', enum: [...TONES] },
            at: { type: 'string', description: 'Timeline time label.' },
          },
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            label: { type: 'string' },
          },
        },
      },
      filename: { type: 'string', description: 'Optional file name (without directory); defaults to a slug of the title.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          nodes: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `Wrote ${args.kind.replace('_', ' ')} "${args.title}" (${value.nodes} nodes, ${value.width}×${value.height}px) to ${value.path}. Open it in the preview or a browser.` }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const spec: DiagramSpec = {
        kind: args.kind as DiagramKind,
        title: args.title,
        subtitle: args.subtitle,
        source: args.source,
        nodes: args.nodes.map(n => ({ id: n.id, label: n.label, detail: n.detail, at: n.at, tone: n.tone as Tone | undefined })),
        edges: args.edges?.map(e => ({ from: e.from, to: e.to, label: e.label })),
      }
      const rendered = renderDiagram(spec)
      const base = exec.agent?.session.header.cwd ?? process.cwd()
      const dir = isAbsolute(config.outputDir) ? config.outputDir : resolve(base, config.outputDir)
      const file = `${slugify(args.filename?.replace(/\.html?$/i, '') ?? args.title)}.html`
      const path = join(dir, file)
      await mkdir(dir, { recursive: true })
      await writeFile(path, rendered.html, 'utf8')
      return { path, width: rendered.width, height: rendered.height, nodes: spec.nodes.length }
    },
  }))
}
