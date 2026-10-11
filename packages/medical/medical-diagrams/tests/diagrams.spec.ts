import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as plugin from '../src/index.ts'
import { contrastRatio, DiagramError, renderDiagram, slugify, TEXT_PAIRS, wrap, type DiagramSpec } from '../src/index.ts'

const SEPSIS: DiagramSpec = {
  kind: 'pathway',
  title: 'Adult sepsis — first hour',
  subtitle: 'Emergency department, suspected infection',
  source: 'Surviving Sepsis Campaign 2021',
  nodes: [
    { id: 'screen', label: 'Suspected infection + qSOFA ≥ 2 or NEWS ≥ 5' },
    { id: 'cultures', label: 'Blood cultures ×2', detail: 'before antibiotics if no delay' },
    { id: 'lactate', label: 'Measure lactate' },
    { id: 'abx', label: 'Broad-spectrum antibiotics within 1 h', tone: 'accent' },
    { id: 'fluids', label: '30 mL/kg crystalloid if hypotensive or lactate ≥ 4', detail: 'volume from clinical_calc' },
    { id: 'pressors', label: 'MAP < 65 after fluids → vasopressors; call ICU', tone: 'warning' },
  ],
  edges: [
    { from: 'screen', to: 'cultures' }, { from: 'screen', to: 'lactate' },
    { from: 'cultures', to: 'abx' }, { from: 'lactate', to: 'fluids' },
    { from: 'abx', to: 'pressors' }, { from: 'fluids', to: 'pressors' },
  ],
}

const CHEST_PAIN: DiagramSpec = {
  kind: 'decision_tree',
  title: 'Chest pain triage',
  nodes: [
    { id: 'ecg', label: '12-lead ECG within 10 min' },
    { id: 'stemi', label: 'STEMI pathway — activate cath lab', tone: 'warning' },
    { id: 'trop', label: 'High-sensitivity troponin 0/1 h' },
    { id: 'nstemi', label: 'NSTE-ACS management', tone: 'accent' },
    { id: 'alt', label: 'Consider alternative diagnoses', tone: 'muted' },
  ],
  edges: [
    { from: 'ecg', to: 'stemi', label: 'ST elevation' },
    { from: 'ecg', to: 'trop', label: 'No ST elevation' },
    { from: 'trop', to: 'nstemi', label: 'Rise' },
    { from: 'trop', to: 'alt', label: 'Rule-out' },
  ],
}

const TIMELINE: DiagramSpec = {
  kind: 'timeline',
  title: 'Admission course',
  nodes: [
    { id: 'd0', at: 'Day 0', label: 'Admitted with CAP', detail: 'CURB-65 = 2' },
    { id: 'd1', at: 'Day 1', label: 'Oxygen weaned', tone: 'accent' },
    { id: 'd3', at: 'Day 3', label: 'AKI — creatinine 2.1 mg/dL', tone: 'warning' },
    { id: 'd5', at: 'Day 5', label: 'Discharged on oral therapy', tone: 'muted' },
  ],
}

function gridViolations(svg: string): string[] {
  const bad: string[] = []
  for (const m of svg.matchAll(/<(rect|circle|line)\b([^>]*)>/g)) {
    for (const a of (m[2] ?? '').matchAll(/\b(x|y|width|height|cx|cy|x1|y1|x2|y2)="(-?[\d.]+)"/g)) {
      if (Number(a[2]) % 4 !== 0) bad.push(`${m[1]} ${a[1]}=${a[2]}`)
    }
  }
  for (const m of svg.matchAll(/<path class="edge" d="([^"]+)"/g)) {
    for (const n of (m[1] ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) if (Number(n[0]) % 4 !== 0) bad.push(`path ${n[0]}`)
  }
  return bad
}

describe('palette', () => {
  it('every text/background pair meets WCAG AA (4.5:1)', () => {
    for (const [name, fg, bg] of TEXT_PAIRS) expect(contrastRatio(fg, bg), name).toBeGreaterThanOrEqual(4.5)
  })
})

describe('renderDiagram', () => {
  for (const spec of [SEPSIS, CHEST_PAIN, TIMELINE]) {
    it(`${spec.kind}: snaps geometry to the 4 px grid`, () => {
      const { svg, width, height } = renderDiagram(spec)
      expect(gridViolations(svg)).toEqual([])
      expect(width % 4).toBe(0)
      expect(height % 4).toBe(0)
    })

    it(`${spec.kind}: is accessible and self-contained`, () => {
      const { html, svg } = renderDiagram(spec)
      expect(svg).toMatch(/role="img"/)
      expect(svg).toMatch(/<title id="diagram-title">/)
      expect(svg).toMatch(/<desc id="diagram-desc">/)
      expect(html).toMatch(/<html lang="en">/)
      expect(html).toContain('<summary>Text version</summary>')
      for (const v of ['--bg-paper', '--text-ink', '--accent-clinical', '--muted-subtle']) expect(html).toContain(v)
      expect(html.toLowerCase()).not.toContain('mermaid')
      expect(html).not.toMatch(/<script|<link|@import|src="http|href="http/)
    })
  }

  it('escapes markup in labels', () => {
    const { html } = renderDiagram({ kind: 'timeline', title: 'x', nodes: [{ id: 'a', label: '<script>alert(1)</script> K+ < 3.5' }] })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('wraps long labels without overflowing the box', () => {
    expect(wrap('Broad-spectrum antibiotics within one hour of recognition', 25).every(l => l.length <= 25)).toBe(true)
    expect(wrap('Supercalifragilisticexpialidociousness', 10).every(l => l.length <= 10)).toBe(true)
  })

  it('rejects cycles, unknown nodes, duplicate ids and multi-parent trees', () => {
    expect(() => renderDiagram({ kind: 'pathway', title: 't', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })).toThrow(/cycle/)
    expect(() => renderDiagram({ kind: 'pathway', title: 't', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'z' }] })).toThrow(/unknown node "z"/)
    expect(() => renderDiagram({ kind: 'pathway', title: 't', nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).toThrow(DiagramError)
    expect(() => renderDiagram({ ...SEPSIS, kind: 'decision_tree' })).toThrow(/more than one parent/)
  })

  it('slugifies titles', () => {
    expect(slugify('Adult sepsis — first hour!')).toBe('adult-sepsis-first-hour')
    expect(slugify('***')).toBe('diagram')
  })
})

describe('clinical_diagram tool', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('writes the HTML into <session cwd>/clinical-diagrams', async () => {
    dir = mkdtempSync(join(tmpdir(), 'diagram-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { outputDir: 'clinical-diagrams' })
    const agent = { id: 'a', session: { id: 'a', header: { cwd: dir } }, options: {} } as unknown as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('d1'),
      name: 'clinical_diagram',
      arguments: { kind: 'decision_tree', title: CHEST_PAIN.title, nodes: CHEST_PAIN.nodes, edges: CHEST_PAIN.edges },
      agent,
    })
    expect(result.isError).toBe(false)
    const path = join(dir, 'clinical-diagrams', 'chest-pain-triage.html')
    expect(readFileSync(path, 'utf8')).toContain('<title>Chest pain triage</title>')
  })
})
