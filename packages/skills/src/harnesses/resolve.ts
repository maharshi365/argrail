import { homedir } from 'node:os'
import { resolve, join, dirname, isAbsolute } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { CLIError } from '@argrail/core'
import registry from './registry.gen.json' with { type: 'json' }
import type { PathRule, HarnessRegistry } from './types.ts'
import type { HarnessSettings, SkillTarget, Harness, HarnessRoot } from '../types.ts'
import { isRecord } from '../files.ts'
// JavaScript callers can supply untrusted target objects.
/* oxlint-disable deslop/no-runtime-typeof */

function evaluate(rule: PathRule | null, home: string, environment: Record<string, string | undefined>): string | undefined {
  if (!rule) return undefined
  switch (rule.kind) {
    case 'literal':
      return rule.value
    case 'home':
      return home
    case 'environment':
      return (
        environment[rule.name]?.trim() ||
        (rule.fallback ? evaluate(rule.fallback, home, environment) : undefined)
      )
    case 'join':
      return join(...rule.parts.map(part => evaluate(part, home, environment)!))
    case 'firstExisting':
      return evaluate(
        rule.paths.find(candidate => existsSync(evaluate(candidate.exists, home, environment)!))
          ?.path ?? rule.fallback,
        home,
        environment,
      )
    default:
      throw new CLIError('HARNESS_RULE', 'Unsupported harness path rule')
  }
}

export function canonicalRoot(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parent = dirname(absolute)
  return parent === absolute
    ? absolute
    : join(canonicalRoot(parent), absolute.slice(parent.length).replace(/^[\\/]/, ''))
}

export function listHarnesses({
  home = homedir(),
  environment = process.env,
  scope = 'project',
}: HarnessSettings = {}): Harness[] {
  // SAFETY: the checked-in registry is generated from validated PathRule entries by sync-harnesses.ts.
  return (registry as HarnessRegistry).harnesses.map(harness => {
    const global = harness.global ? evaluate(harness.global, home, environment) : undefined
    const result: Harness = {
      id: harness.id,
      label: harness.label,
      projectPath: evaluate(harness.project, home, environment)!,
      globalPath: global,
      detected: harness.id !== 'universal' && !!global && existsSync(dirname(global)),
      disabled: scope === 'global' && !global ? 'Global skills are not supported' : undefined,
    }
    return result
  })
}

export function resolveTargets(target: SkillTarget, settings?: HarnessSettings): HarnessRoot[]
// oxlint-disable-next-line deslop/no-unknown-parameters -- Validate JavaScript target inputs before resolving paths.
export function resolveTargets(target: unknown, settings: HarnessSettings = {}): HarnessRoot[] {
  if (!isRecord(target))
    throw new CLIError('SKILL_TARGET', 'An installation target is required')
  if (target.path !== undefined) {
    // oxlint-disable-next-line deslop/no-runtime-typeof -- Custom destinations must be text before path resolution.
    if (
      typeof target.path !== 'string' ||
      !target.path ||
      target.scope !== undefined ||
      target.project !== undefined ||
      target.harnesses !== undefined
    )
      throw new CLIError('SKILL_TARGET', '--path conflicts with harness and scope selections')
    return [{ root: canonicalRoot(target.path), harnesses: [], shared: [] }]
  }
  const scope = target.scope ?? 'project'
  if (
    (scope !== 'project' && scope !== 'global') ||
    (scope === 'global' && target.project !== undefined)
  )
    throw new CLIError('SKILL_TARGET', 'Global and project scope cannot be combined')
  if (!Array.isArray(target.harnesses) || !target.harnesses.length)
    throw new CLIError('SKILL_TARGET', 'Select at least one harness with --harness')
  const harnesses = listHarnesses({ ...settings, scope })
  if (target.project !== undefined && typeof target.project !== 'string')
    throw new CLIError('SKILL_TARGET', 'Project path must be text')
  const project = resolve(target.project ?? process.cwd())
  const destinations = new Map<string, HarnessRoot>()
  for (const id of new Set(target.harnesses)) {
    const harness = harnesses.find(candidate => candidate.id === id)
    if (!harness)
      throw new CLIError(
        'UNKNOWN_HARNESS',
        `Unknown harness: ${id}. Use skills add interactively to select a supported harness.`,
      )
    if (harness.disabled)
      throw new CLIError('HARNESS_SCOPE', `${harness.label}: ${harness.disabled}`)
    const path = scope === 'global' ? harness.globalPath! : resolve(project, harness.projectPath)
    if (scope === 'global' && !isAbsolute(path))
      throw new CLIError('HARNESS_PATH', `${harness.label}: global path must be absolute`)
    const root = canonicalRoot(path)
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (!destinations.has(key)) destinations.set(key, { root, harnesses: [], shared: [] })
    const destination = destinations.get(key)!
    destination.harnesses.push(id)
    destination.shared = harnesses
      .filter(candidate => {
        const other =
          scope === 'global' ? candidate.globalPath : resolve(project, candidate.projectPath)
        const comparable = other && canonicalRoot(other)
        return (
          comparable &&
          (process.platform === 'win32'
            ? comparable.toLowerCase() === root.toLowerCase()
            : comparable === root)
        )
      })
      .map(candidate => candidate.id)
  }
  return [...destinations.values()]
}
