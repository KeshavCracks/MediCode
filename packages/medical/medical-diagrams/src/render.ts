/**
 * Editorial clinical diagrams rendered as self-contained, accessible HTML+SVG.
 *
 * Three layouts — vertical timeline, layered pathway (DAG), decision tree —
 * are computed here with no external engine. Every coordinate snaps to a 4 px
 * grid; colours come from CSS custom properties whose text/background pairs
 * meet WCAG 2.1 AA (asserted by {@link contrastRatio} in tests); the SVG
 * carries `role="img"`, `<title>` and a generated `<desc>`, and the page adds a
 * text outline for screen readers and print.
 *
 * @module @deepseek-ai/dsh-medical-diagrams/render
 */

export type DiagramKind = 'timeline' | 'pathway' | 'decision_tree'
export type Tone = 'default' | 'accent' | 'warning' | 'muted'

export interface DiagramNode {
  id: string
  label: string
  detail?: string | undefined
  tone?: Tone | undefined
  /** Timeline only: the time label shown on the axis (e.g. "Day 0", "08:30"). */
  at?: string | undefined
}

export interface DiagramEdge {
  from: string
  to: string
  label?: string | undefined
}

export interface DiagramSpec {
  kind: DiagramKind
  title: string
  subtitle?: string | undefined
  nodes: DiagramNode[]
  edges?: DiagramEdge[] | undefined
  /** Source / attribution line shown under the figure. */
  source?: string | undefined
}

export class DiagramError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagramError'
  }
}

// ---------------------------------------------------------------------------
// Palette and accessibility
// ---------------------------------------------------------------------------

export const PALETTE = {
  paper: '#fbfaf7',
  ink: '#1a1a1a',
  accent: '#0b5d7a',
  muted: '#5c5f66',
  surface: '#ffffff',
  onAccent: '#ffffff',
  warning: '#9a3412',
  warningSurface: '#fdf1ea',
} as const

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** WCAG 2.1 contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every foreground/background pair the renderer actually uses for text. */
export const TEXT_PAIRS: readonly (readonly [string, string, string])[] = [
  ['ink on paper', PALETTE.ink, PALETTE.paper],
  ['ink on surface', PALETTE.ink, PALETTE.surface],
  ['muted on paper', PALETTE.muted, PALETTE.paper],
  ['muted on surface', PALETTE.muted, PALETTE.surface],
  ['on-accent on accent', PALETTE.onAccent, PALETTE.accent],
  ['accent on paper', PALETTE.accent, PALETTE.paper],
  ['ink on warning surface', PALETTE.ink, PALETTE.warningSurface],
  ['warning on warning surface', PALETTE.warning, PALETTE.warningSurface],
]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const GRID = 4
export const snap = (v: number): number => Math.round(v / GRID) * GRID

const NODE_W = 224
const PAD = 12
const LABEL_LH = 20
const DETAIL_LH = 16
/** Conservative average glyph advance (px) for 14 px semibold labels and 12 px details in system UI fonts. */
const LABEL_CHAR_W = 8.6
const DETAIL_CHAR_W = 6.6
const LAYER_GAP = 64
/** Taller gap when edges carry labels, so a label sits on the vertical drop instead of the rule. */
const LABELLED_GAP = 80
const SIBLING_GAP = 32
const MARGIN = 32

/** Greedy word wrap; words longer than the line are hard-split. */
export function wrap(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (let word of words) {
    while (word.length > maxChars) {
      if (line) { lines.push(line); line = '' }
      lines.push(`${word.slice(0, maxChars - 1)}-`)
      word = word.slice(maxChars - 1)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

interface Box {
  node: DiagramNode
  x: number
  y: number
  w: number
  h: number
  labelLines: string[]
  detailLines: string[]
}

function measure(node: DiagramNode, width = NODE_W): Omit<Box, 'x' | 'y'> {
  const inner = width - 2 * PAD
  const labelLines = wrap(node.label, Math.floor(inner / LABEL_CHAR_W))
  const detailLines = node.detail ? wrap(node.detail, Math.floor(inner / DETAIL_CHAR_W)) : []
  const h = snap(2 * PAD + labelLines.length * LABEL_LH + (detailLines.length ? 4 + detailLines.length * DETAIL_LH : 0))
  return { node, w: width, h, labelLines, detailLines }
}

function validate(spec: DiagramSpec): Map<string, DiagramNode> {
  if (!spec.title.trim()) throw new DiagramError('title is required.')
  if (spec.nodes.length === 0) throw new DiagramError('at least one node is required.')
  if (spec.nodes.length > 80) throw new DiagramError('at most 80 nodes are supported; split the diagram.')
  const byId = new Map<string, DiagramNode>()
  for (const node of spec.nodes) {
    if (!node.id.trim()) throw new DiagramError('every node needs a non-empty id.')
    if (byId.has(node.id)) throw new DiagramError(`duplicate node id "${node.id}".`)
    if (!node.label.trim()) throw new DiagramError(`node "${node.id}" needs a label.`)
    byId.set(node.id, node)
  }
  for (const edge of spec.edges ?? []) {
    if (!byId.has(edge.from)) throw new DiagramError(`edge references unknown node "${edge.from}".`)
    if (!byId.has(edge.to)) throw new DiagramError(`edge references unknown node "${edge.to}".`)
    if (edge.from === edge.to) throw new DiagramError(`self-loop on "${edge.from}" is not supported.`)
  }
  return byId
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

interface Layout {
  boxes: Box[]
  edges: { edge: DiagramEdge; d: string; labelAt?: { x: number; y: number } }[]
  extras: string[]
  width: number
  height: number
}

/** Longest-path layering with cycle detection (Kahn). */
function layers(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, number> {
  const indegree = new Map(nodes.map(n => [n.id, 0]))
  const out = new Map<string, string[]>(nodes.map(n => [n.id, []]))
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
    out.get(e.from)?.push(e.to)
  }
  const layer = new Map<string, number>()
  const queue = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id)
  for (const id of queue) layer.set(id, 0)
  let visited = 0
  while (queue.length) {
    const id = queue.shift() as string
    visited++
    for (const next of out.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1))
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (visited !== nodes.length) throw new DiagramError('the pathway contains a cycle; pathways must be acyclic (use a note node for "repeat" loops).')
  return layer
}

/**
 * Orthogonal edge. Rows are top-aligned and the elbow is placed a fixed
 * distance above the target row, so fan-outs and merges share one rule.
 */
function edgePath(from: Box, to: Box, gap: number): { d: string; mid: { x: number; y: number } } {
  const x1 = snap(from.x + from.w / 2)
  const y1 = from.y + from.h
  const x2 = snap(to.x + to.w / 2)
  const y2 = to.y - 8 // leave room for the arrowhead
  const my = Math.max(y1 + 8, snap(to.y - gap / 2))
  return { d: `M${x1} ${y1} V${my} H${x2} V${y2}`, mid: { x: x2, y: snap((my + y2) / 2) } }
}

function layoutPathway(spec: DiagramSpec): Layout {
  const edges = spec.edges ?? []
  const gap = edges.some(e => e.label) ? LABELLED_GAP : LAYER_GAP
  const layerOf = layers(spec.nodes, edges)
  const rows: DiagramNode[][] = []
  for (const node of spec.nodes) (rows[layerOf.get(node.id) ?? 0] ??= []).push(node)
  // One barycentre pass to reduce crossings: order each row by mean parent position.
  const position = new Map<string, number>()
  rows.forEach((row, r) => {
    if (r > 0) {
      const parentMean = (id: string): number => {
        const ps = edges.filter(e => e.to === id).map(e => position.get(e.from) ?? 0)
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0
      }
      row.sort((a, b) => parentMean(a.id) - parentMean(b.id))
    }
    row.forEach((n, i) => position.set(n.id, i - (row.length - 1) / 2))
  })
  const widest = Math.max(...rows.map(r => r.length))
  const contentW = widest * NODE_W + (widest - 1) * SIBLING_GAP
  const boxes = new Map<string, Box>()
  let y = MARGIN
  for (const row of rows) {
    const measured = row.map(n => measure(n))
    const rowW = row.length * NODE_W + (row.length - 1) * SIBLING_GAP
    let x = snap(MARGIN + (contentW - rowW) / 2)
    const rowH = Math.max(...measured.map(m => m.h))
    for (const m of measured) {
      boxes.set(m.node.id, { ...m, x, y })
      x += NODE_W + SIBLING_GAP
    }
    y += rowH + gap
  }
  const laidEdges = edges.map((edge) => {
    const { d, mid } = edgePath(boxes.get(edge.from) as Box, boxes.get(edge.to) as Box, gap)
    return { edge, d, labelAt: mid }
  })
  return { boxes: [...boxes.values()], edges: laidEdges, extras: [], width: snap(contentW + 2 * MARGIN), height: snap(y - gap + MARGIN) }
}

function layoutTree(spec: DiagramSpec): Layout {
  const edges = spec.edges ?? []
  const parent = new Map<string, string>()
  for (const e of edges) {
    if (parent.has(e.to)) throw new DiagramError(`node "${e.to}" has more than one parent; a decision tree needs exactly one path to each node (use kind "pathway" for merging flows).`)
    parent.set(e.to, e.from)
  }
  const roots = spec.nodes.filter(n => !parent.has(n.id))
  if (roots.length !== 1) throw new DiagramError(`a decision tree needs exactly one root; found ${roots.length}.`)
  layers(spec.nodes, edges) // cycle check
  const gap = edges.some(e => e.label) ? LABELLED_GAP : LAYER_GAP
  const children = new Map<string, string[]>(spec.nodes.map(n => [n.id, []]))
  for (const e of edges) children.get(e.from)?.push(e.to)
  const byId = new Map(spec.nodes.map(n => [n.id, n]))
  const depth = new Map<string, number>()
  const centre = new Map<string, number>()
  let nextLeaf = 0
  const slot = NODE_W + SIBLING_GAP
  const visit = (id: string, d: number): void => {
    depth.set(id, d)
    const kids = children.get(id) ?? []
    if (kids.length === 0) { centre.set(id, nextLeaf++ * slot); return }
    for (const k of kids) visit(k, d + 1)
    centre.set(id, ((centre.get(kids[0] as string) ?? 0) + (centre.get(kids[kids.length - 1] as string) ?? 0)) / 2)
  }
  visit((roots[0] as DiagramNode).id, 0)
  const maxDepth = Math.max(...depth.values())
  const rowH: number[] = []
  const measured = new Map(spec.nodes.map(n => [n.id, measure(n)]))
  for (const [id, d] of depth) rowH[d] = Math.max(rowH[d] ?? 0, (measured.get(id) as { h: number }).h)
  const rowY: number[] = []
  let y = MARGIN
  for (let d = 0; d <= maxDepth; d++) { rowY[d] = y; y += (rowH[d] ?? 0) + gap }
  const boxes = new Map<string, Box>()
  for (const [id, d] of depth) {
    const m = measured.get(id) as Omit<Box, 'x' | 'y'>
    boxes.set(id, { ...m, node: byId.get(id) as DiagramNode, x: snap(MARGIN + (centre.get(id) ?? 0)), y: rowY[d] ?? 0 })
  }
  const laidEdges = edges.map((edge) => {
    const { d, mid } = edgePath(boxes.get(edge.from) as Box, boxes.get(edge.to) as Box, gap)
    return { edge, d, labelAt: mid }
  })
  return { boxes: [...boxes.values()], edges: laidEdges, extras: [], width: snap(nextLeaf * slot - SIBLING_GAP + 2 * MARGIN), height: snap(y - gap + MARGIN) }
}

function layoutTimeline(spec: DiagramSpec): Layout {
  const timeW = 128
  const axisX = MARGIN + timeW + 24
  const boxX = axisX + 24
  const boxW = 400
  const boxes: Box[] = []
  const extras: string[] = []
  let y = MARGIN
  for (const node of spec.nodes) {
    const m = measure(node, boxW)
    boxes.push({ ...m, x: boxX, y })
    const cy = y + 20
    const tone = node.tone ?? 'default'
    extras.push(`<circle class="dot dot-${tone}" cx="${axisX}" cy="${cy}" r="6"/>`)
    if (node.at) {
      wrap(node.at, 16).forEach((line, i) => {
        extras.push(`<text class="time" x="${axisX - 20}" y="${cy + 5 + i * 16}" text-anchor="end">${escapeXml(line)}</text>`)
      })
    }
    y += Math.max(m.h, 40) + 24
  }
  const height = snap(y - 24 + MARGIN)
  extras.unshift(`<line class="axis" x1="${axisX}" y1="${MARGIN}" x2="${axisX}" y2="${height - MARGIN}"/>`)
  return { boxes, edges: [], extras, width: snap(boxX + boxW + MARGIN), height }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBox(b: Box): string {
  const tone = b.node.tone ?? 'default'
  const parts = [`<g class="node node-${tone}" data-id="${escapeXml(b.node.id)}">`, `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4"/>`]
  let ty = b.y + PAD + 15
  for (const line of b.labelLines) { parts.push(`<text class="label" x="${b.x + PAD}" y="${ty}">${escapeXml(line)}</text>`); ty += LABEL_LH }
  if (b.detailLines.length) ty += 2
  for (const line of b.detailLines) { parts.push(`<text class="detail" x="${b.x + PAD}" y="${ty}">${escapeXml(line)}</text>`); ty += DETAIL_LH }
  parts.push('</g>')
  return parts.join('')
}

/** Plain-language description of the diagram for `<desc>` and the text outline. */
export function describe(spec: DiagramSpec): string[] {
  const label = new Map(spec.nodes.map(n => [n.id, n.label]))
  if (spec.kind === 'timeline') {
    return spec.nodes.map(n => `${n.at ? `${n.at}: ` : ''}${n.label}${n.detail ? ` — ${n.detail}` : ''}`)
  }
  const lines = spec.nodes.map(n => `${n.label}${n.detail ? ` — ${n.detail}` : ''}`)
  for (const e of spec.edges ?? []) lines.push(`${label.get(e.from)} → ${label.get(e.to)}${e.label ? ` (${e.label})` : ''}`)
  return lines
}

const ROOT_VARS = `:root{--bg-paper:${PALETTE.paper};--text-ink:${PALETTE.ink};--accent-clinical:${PALETTE.accent};--muted-subtle:${PALETTE.muted};--surface:${PALETTE.surface};--on-accent:${PALETTE.onAccent};--warning-clinical:${PALETTE.warning};--warning-surface:${PALETTE.warningSurface}}`
const PAGE_RULES = `*{box-sizing:border-box}
body{margin:0;background:var(--bg-paper);color:var(--text-ink);font:16px/24px system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px}
h1{font-size:24px;line-height:32px;margin:0 0 4px;font-weight:650;letter-spacing:-0.01em}
.subtitle{margin:0 0 24px;color:var(--muted-subtle)}
figure{margin:0;overflow-x:auto}
figcaption,.source{margin-top:16px;font-size:12px;line-height:16px;color:var(--muted-subtle)}
details{margin-top:24px;font-size:14px;line-height:20px}
summary{cursor:pointer;color:var(--accent-clinical)}
summary:focus-visible{outline:2px solid var(--accent-clinical);outline-offset:4px}
@media print{body{background:#fff}main{padding:0}}`
const SVG_RULES = `svg text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}
.node rect{fill:var(--surface);stroke:var(--text-ink);stroke-width:1.5}
.node .label{font-size:14px;font-weight:600;fill:var(--text-ink)}
.node .detail{font-size:12px;fill:var(--muted-subtle)}
.node-accent rect{fill:var(--accent-clinical);stroke:var(--accent-clinical)}
.node-accent .label,.node-accent .detail{fill:var(--on-accent)}
.node-warning rect{fill:var(--warning-surface);stroke:var(--warning-clinical);stroke-width:2}
.node-warning .detail{fill:var(--warning-clinical)}
.node-muted rect{fill:var(--bg-paper);stroke:var(--muted-subtle);stroke-dasharray:4 4}
.node-muted .label{fill:var(--muted-subtle);font-weight:500}
.edge{fill:none;stroke:var(--text-ink);stroke-width:1.5}
.edge-label rect{fill:var(--bg-paper)}
.edge-label text{font-size:12px;font-weight:600;fill:var(--accent-clinical)}
.axis{stroke:var(--muted-subtle);stroke-width:2}
.dot{stroke:var(--bg-paper);stroke-width:2}
.dot-default{fill:var(--text-ink)}.dot-accent{fill:var(--accent-clinical)}.dot-warning{fill:var(--warning-clinical)}.dot-muted{fill:var(--muted-subtle)}
.time{font-size:12px;font-weight:600;fill:var(--muted-subtle)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`
const STYLE = `${ROOT_VARS}\n${PAGE_RULES}\n${SVG_RULES}`

export interface RenderedDiagram {
  html: string
  svg: string
  width: number
  height: number
}

/** Lay out and render a diagram. Throws {@link DiagramError} for invalid input. */
export function renderDiagram(spec: DiagramSpec): RenderedDiagram {
  validate(spec)
  const layout = spec.kind === 'timeline' ? layoutTimeline(spec) : spec.kind === 'decision_tree' ? layoutTree(spec) : layoutPathway(spec)
  const description = describe(spec)
  const edgeSvg = layout.edges.map(({ edge, d, labelAt }) => {
    const path = `<path class="edge" d="${d}" marker-end="url(#arrow)"/>`
    if (!edge.label || labelAt === undefined) return path
    const w = snap(edge.label.length * 7 + 12)
    const x = snap(labelAt.x - w / 2)
    const y = snap(labelAt.y - 10)
    return `${path}<g class="edge-label"><rect x="${x}" y="${y}" width="${w}" height="20" rx="2"/><text x="${snap(labelAt.x)}" y="${y + 14}" text-anchor="middle">${escapeXml(edge.label)}</text></g>`
  }).join('')
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="diagram-title diagram-desc" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">`,
    `<title id="diagram-title">${escapeXml(spec.title)}</title>`,
    `<desc id="diagram-desc">${escapeXml(`${spec.kind.replace('_', ' ')}: ${description.join('; ')}`)}</desc>`,
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="${PALETTE.ink}"/></marker></defs>`,
    `<style>${ROOT_VARS}${SVG_RULES}</style>`,
    `<rect width="100%" height="100%" fill="${PALETTE.paper}"/>`,
    ...layout.extras,
    edgeSvg,
    ...layout.boxes.map(renderBox),
    '</svg>',
  ].join('')
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeXml(spec.title)}</title>`,
    `<style>${STYLE}</style></head>`,
    '<body><main>',
    `<h1>${escapeXml(spec.title)}</h1>`,
    spec.subtitle ? `<p class="subtitle">${escapeXml(spec.subtitle)}</p>` : '',
    `<figure>${svg}<figcaption>Decision support only — verify against current guidelines and the patient in front of you.</figcaption></figure>`,
    spec.source ? `<p class="source">Source: ${escapeXml(spec.source)}</p>` : '',
    `<details><summary>Text version</summary><ol>${description.map(l => `<li>${escapeXml(l)}</li>`).join('')}</ol></details>`,
    '</main></body></html>',
  ].join('\n')
  return { html, svg, width: layout.width, height: layout.height }
}
