/**
 * The bundle's substance is its patch file. These checks keep it honest: every
 * row parses, every plugin it names is a declared dependency (or comes from
 * the layers below), the medCloud provider matches the cloud plugin's served
 * names, and the clinical preset carries no shell or plan-mode.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { Config as CloudConfig } from '@deepseek-ai/dsh-medical-cloud'
import type { Config as CloudConfigShape } from '@deepseek-ai/dsh-medical-cloud'

interface Row {
  id?: string
  name?: string
  disabled?: boolean | { __jsExpr: string }
  config?: Record<string, unknown>
}
interface Patch extends Row { insert?: Row[] }

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string
  dependencies: Record<string, string>
  dsh: { bundle: { patch: string } }
}
const patches = yaml.load(
  readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8'),
  { schema: entryListSchema },
) as Patch[]
const inserted = patches.flatMap(p => p.insert ?? [])
const edits = new Map(patches.filter(p => p.id !== undefined).map(p => [p.id!, p]))
const preset = inserted.find(r => r.id === 'preset-medical')!
const presetPlugins = (preset.config!['plugins'] as Row[])

describe('dsh-medical bundle', () => {
  it('declares one parseable patch list', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-medical')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(Array.isArray(patches)).toBe(true)
  })

  it('inserts every clinical host plugin, each a declared dependency', () => {
    const host = inserted.filter(r => r.id?.startsWith('medical-'))
    expect(host.map(r => r.id).sort()).toEqual([
      'medical-agent-reach', 'medical-cloud', 'medical-context-packer',
      'medical-diagrams', 'medical-math-engine', 'medical-quality-gates',
    ])
    for (const row of [...inserted, ...presetPlugins]) {
      expect(manifest.dependencies, `${row.id} → ${row.name}`).toHaveProperty(row.name!)
    }
  })

  it('replaces the coding presets with one clinical default preset', () => {
    expect(edits.get('agent-preset-registry')?.config).toEqual({ default: 'medical' })
    for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
      expect(edits.get(id)?.disabled, id).toBe(true)
    }
    expect(preset.config!['id']).toBe('medical')
    const ids = presetPlugins.map(p => p.id)
    // No shell, no general fetch, no plan-mode (it would shadow the clinical /plan gate).
    for (const banned of ['tool-bash', 'tool-pwsh', 'tool-web', 'planning', 'plan-mode', 'tool-subagent']) {
      expect(ids).not.toContain(banned)
    }
    const persona = presetPlugins.find(p => p.id === 'persona')!.config!['prefix'] as string
    expect(persona).toContain('{{model}}')
    expect(persona).toMatch(/clinical_calc/)
    expect(persona).toMatch(/Never invent a citation/)
  })

  it('resolves the bundled stage skills from the bundle package', () => {
    const skills = presetPlugins.find(p => p.id === 'skill-filesystem')!.config!['customSkillDirs'] as { __jsExpr: string }[]
    const dir = evaluate({ process, baseUrl: pathToFileURL(join(root, 'package.json')).href }, skills[0]!.__jsExpr) as string
    for (const stage of ['spec', 'plan', 'build', 'test', 'review']) {
      expect(existsSync(join(dir, `medical-${stage}`, 'SKILL.md')), stage).toBe(true)
    }
  })

  it('defaults agents to the remote reasoner, with provider models matching the served names', () => {
    expect(edits.get('agent-default-model')?.config).toEqual({ provider: 'medcloud', model: 'ii-medical-8b' })
    const provider = (edits.get('llm-pi-ai')!.config!['providers'] as Record<string, Record<string, unknown>>)['medcloud']!
    const cloud = CloudConfig({} as Partial<CloudConfigShape> as CloudConfigShape)
    expect(provider['baseURL']).toBe(`http://127.0.0.1:${cloud.gatewayPort}/v1`)
    expect(provider['apiKeyEnv']).toBe('MEDCLOUD_GATEWAY_KEY')
    const models = provider['models'] as { id: string; input: string[]; contextWindow: number; compat: Record<string, unknown> }[]
    const reasoner = models.find(m => m.id === cloud.reasonerName)!
    const vision = models.find(m => m.id === cloud.visionName)!
    expect(reasoner.input).toEqual(['text'])
    expect(reasoner.compat['thinkingFormat']).toBe('qwen-chat-template')
    expect(reasoner.contextWindow).toBe(cloud.maxModelLen)
    expect(vision.input).toEqual(['text', 'image'])
    expect(vision.contextWindow).toBe(cloud.visionCtx)
    for (const m of models) expect(m.compat['maxTokensField']).toBe('max_tokens')
  })

  it('keeps per-user state under the Harness home', () => {
    const byId = new Map(inserted.map(r => [r.id!, r]))
    const home = (segments: string[]) => segments.join('/')
    const scope = { dshHomePath: (...s: string[]) => home(['HOME', ...s]), process: { env: {} } }
    expect(evaluate(scope, (byId.get('medical-cloud')!.config!['sessionFile'] as { __jsExpr: string }).__jsExpr)).toBe('HOME/medical/cloud-session.json')
    expect(evaluate(scope, (byId.get('medical-quality-gates')!.config!['storePath'] as { __jsExpr: string }).__jsExpr)).toBe('HOME/medical/constraints.json')
    expect(evaluate(scope, (byId.get('medical-agent-reach')!.config!['contactEmail'] as { __jsExpr: string }).__jsExpr)).toBe('')
  })

  it('gives every row a config its plugin schema accepts', async () => {
    const scope = {
      process, dshHomePath: (...s: string[]) => join('/tmp/dsh', ...s),
      baseUrl: pathToFileURL(join(root, 'package.json')).href,
    }
    const resolveJs = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolveJs)
      if (value !== null && typeof value === 'object') {
        if ('__jsExpr' in value) return evaluate(scope, (value as { __jsExpr: string }).__jsExpr)
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveJs(v)]))
      }
      return value
    }
    for (const row of [...inserted, ...presetPlugins].filter(r => r.name!.startsWith('@deepseek-ai/dsh-') && r.name !== '@deepseek-ai/dsh-agent-preset')) {
      const mod = await import(row.name!) as { Config?: (v: unknown) => unknown; default?: { Config?: (v: unknown) => unknown } }
      const schema = mod.Config ?? mod.default?.Config
      if (schema === undefined) continue
      expect(() => schema(resolveJs(row.config ?? {})), `${row.id} (${row.name})`).not.toThrow()
    }
  })
})
