/**
 * Skill-body loading (progressive disclosure) and the persisted clinical
 * constraints list used by `/constraints`.
 * @module @deepseek-ai/dsh-medical-quality-gates/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding the bundled stage skills (`<name>/SKILL.md`). Resolves from both src/ and lib/. */
export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** Remove YAML frontmatter, returning only the markdown body. */
export function stripFrontmatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
  return (m ? markdown.slice(m[0].length) : markdown).trim()
}

const bodyCache = new Map<string, string>()

/** Load one skill body lazily, on first use of its stage. */
export function loadSkillBody(skillsDir: string, skill: string): string {
  const path = join(skillsDir, skill, 'SKILL.md')
  const cached = bodyCache.get(path)
  if (cached !== undefined) return cached
  const body = stripFrontmatter(readFileSync(path, 'utf8'))
  bodyCache.set(path, body)
  return body
}

export interface Constraint {
  readonly id: number
  readonly text: string
  readonly createdAt: string
}

/** Small JSON-file store; writes are atomic (temp file + rename) and private (0600). */
export class ConstraintStore {
  constructor(private readonly path: string) {}

  list(): Constraint[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { items?: unknown }
      if (!Array.isArray(parsed.items)) return []
      return parsed.items.filter((c): c is Constraint =>
        typeof c === 'object' && c !== null && typeof (c as Constraint).id === 'number' && typeof (c as Constraint).text === 'string')
    } catch {
      return []
    }
  }

  add(text: string): Constraint {
    const items = this.list()
    const item: Constraint = { id: items.reduce((m, c) => Math.max(m, c.id), 0) + 1, text: text.trim(), createdAt: new Date().toISOString() }
    this.write([...items, item])
    return item
  }

  remove(id: number): boolean {
    const items = this.list()
    const next = items.filter(c => c.id !== id)
    if (next.length === items.length) return false
    this.write(next)
    return true
  }

  clear(): void {
    this.write([])
  }

  private write(items: Constraint[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ items }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
