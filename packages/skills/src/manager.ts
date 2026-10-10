import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { CLIError } from '@argrail/core'
import { hashFiles, readTree, stat, validateFiles, checkSignal, isRecord } from './files.ts'
import { resolveTargets, canonicalRoot } from './harnesses/resolve.ts'
import type {
  SkillBundle,
  HarnessSettings,
  SkillSelection,
  SkillPlan,
  SkillPlanItem,
  SkillResult,
  SkillTarget,
  SkillManager,
  SkillFile,
} from './types.ts'

// Public bundles are untrusted parsing boundaries.
/* oxlint-disable deslop/no-runtime-typeof */

// oxlint-disable-next-line deslop/no-unknown-parameters -- Validate bundles from JavaScript callers before using their typed API.
function validateBundle(input: unknown): asserts input is SkillBundle {
  if (
    !isRecord(input) ||
    typeof input.id !== 'string' ||
    !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(input.id) ||
    typeof input.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.hash) ||
    !isRecord(input.skills) ||
    !isRecord(input.groups)
  )
    throw new CLIError('INVALID_SKILL_BUNDLE', 'Invalid skill bundle identity or hash')
  for (const [name, skill] of Object.entries(input.skills))
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      name.length > 64 ||
      !isRecord(skill) ||
      skill.name !== name ||
      typeof skill.load !== 'function' ||
      typeof skill.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(skill.hash)
    )
      throw new CLIError('INVALID_SKILL_BUNDLE', `Invalid bundled skill: ${name}`)
}

async function inspect(path: string) {
  const info = await stat(path)
  return { exists: !!info, unsafe: !!info && (!info.isDirectory() || info.isSymbolicLink()) }
}

export function createSkills<const B extends SkillBundle>(
  bundle: B,
  settings?: HarnessSettings,
): SkillManager<B>
export function createSkills(
  // oxlint-disable-next-line deslop/no-unknown-parameters -- The public signature stays precise while runtime input is validated.
  input: unknown,
  settings: HarnessSettings = {},
): SkillManager<SkillBundle> {
  validateBundle(input)
  const bundle = input
  const approved = new WeakMap<SkillPlan, string>()

  function select({ skills = [], groups = [], all = false }: SkillSelection<SkillBundle> = {}) {
    if (
      !Array.isArray(skills) ||
      !Array.isArray(groups) ||
      (all && (skills.length || groups.length))
    )
      throw new CLIError('SKILL_SELECTION', '--all cannot be combined with skill names or groups')
    const names = all ? Object.keys(bundle.skills) : [...skills]
    for (const group of groups) {
      if (!Object.hasOwn(bundle.groups, group))
        throw new CLIError(
          'UNKNOWN_SKILL_GROUP',
          `Unknown skill group: ${group}. Available: ${Object.keys(bundle.groups).join(', ')}`,
        )
      names.push(...bundle.groups[group]!.skills)
    }
    for (const name of names)
      if (!Object.hasOwn(bundle.skills, name))
        throw new CLIError(
          'UNKNOWN_SKILL',
          `Unknown skill: ${name}. Available: ${Object.keys(bundle.skills).join(', ')}`,
        )
    return [...new Set(names)]
  }

  async function plan(
    request: SkillSelection<SkillBundle> & { action: SkillPlan['action']; target: SkillTarget },
  ): Promise<SkillPlan> {
    if (!['add', 'update', 'remove'].includes(request.action))
      throw new CLIError('SKILL_ACTION', 'Unsupported skill operation')
    const names = select(request)
    if (!names.length)
      throw new CLIError('SKILL_SELECTION', 'Select skill names, --group, or --all')
    const roots = resolveTargets(request.target, settings)
    const items: SkillPlanItem[] = []
    for (const destination of roots)
      for (const name of names) {
        const path = join(destination.root, name)
        const state = await inspect(path)
        const skill = bundle.skills[name]!
        let operation: SkillPlanItem['operation'],
          reason = ''
        if (state.unsafe) {
          operation = 'conflict'
          reason = 'Unsafe link or special file; move it aside before proceeding'
        } else if (request.action === 'remove') operation = state.exists ? 'remove' : 'noop'
        else if (request.action === 'update' && !state.exists) {
          operation = 'conflict'
          reason = 'Not installed; use skills add'
        } else {
          operation = 'install'
          if (state.exists)
            reason = 'Replace the entire directory, including local edits and extra files'
        }
        items.push({
          name,
          root: destination.root,
          path,
          harnesses: destination.harnesses,
          operation,
          reason,
          exists: state.exists,
          fileCount: skill.fileCount ?? 0,
          bytes: skill.bytes ?? 0,
        })
      }
    const result = {
      action: request.action,
      bundleId: bundle.id,
      bundleHash: bundle.hash,
      target: structuredClone(request.target),
      roots,
      items,
    }
    approved.set(result, JSON.stringify(result))
    return result
  }

  async function load(name: string) {
    const files = structuredClone(await bundle.skills[name]!.load())
    validateFiles(files)
    if (hashFiles(files) !== bundle.skills[name]!.hash)
      throw new CLIError('SKILL_INTEGRITY', `Bundled content hash does not match: ${name}`)
    return files
  }

  async function apply(
    submitted: SkillPlan,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<SkillResult> {
    checkSignal(signal)
    if (approved.get(submitted) !== JSON.stringify(submitted))
      throw new CLIError('SKILL_PLAN', 'Plan is unknown or was changed; create a fresh plan')
    const plan = structuredClone(submitted)
    approved.delete(submitted)
    const loaded = new Map<string, readonly SkillFile[]>()
    for (const item of plan.items)
      if (item.operation === 'install' && !loaded.has(item.name))
        loaded.set(item.name, await load(item.name))
    checkSignal(signal)
    const results: SkillResult['items'][number][] = []
    for (const root of plan.roots) {
      if (canonicalRoot(root.root) !== root.root)
        throw new CLIError(
          'SKILL_PLAN_CHANGED',
          `Destination changed: ${root.root}; create a fresh plan`,
        )
      for (const item of plan.items.filter(item => item.root === root.root)) {
        checkSignal(signal)
        const result = { name: item.name, path: item.path, harnesses: item.harnesses }
        if (item.operation === 'conflict') {
          results.push({
            ...result,
            status: item.exists ? 'blocked' : 'missing',
            reason: item.reason,
          })
          continue
        }
        try {
          const state = await inspect(item.path)
          if (state.unsafe)
            throw new CLIError('UNSAFE_SKILL_PATH', `Unsafe link or special file: ${item.path}`)
          if (item.operation === 'install') {
            if (plan.action === 'update' && !state.exists) {
              results.push({
                ...result,
                status: 'missing',
                reason: 'Not installed; use skills add',
              })
              continue
            }
            await mkdir(root.root, { recursive: true })
            if (canonicalRoot(root.root) !== root.root)
              throw new CLIError('SKILL_PLAN_CHANGED', `Destination changed: ${root.root}`)
            await rm(item.path, { recursive: true, force: true })
            await mkdir(item.path)
            for (const file of loaded.get(item.name)!) {
              checkSignal(signal)
              const destination = join(item.path, ...file.path.split('/'))
              await mkdir(dirname(destination), { recursive: true })
              await writeFile(destination, Buffer.from(file.data, 'base64'), {
                flag: 'wx',
                mode: file.executable ? 0o755 : 0o644,
              })
            }
            results.push({ ...result, status: 'installed' })
          } else if (item.operation === 'remove') {
            await rm(item.path, { recursive: true, force: true })
            results.push({ ...result, status: 'removed' })
          } else results.push({ ...result, status: 'unchanged' })
        } catch (error) {
          checkSignal(signal)
          if (
            !(error instanceof CLIError) &&
            !['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EIO'].includes(
              (error as NodeJS.ErrnoException).code!,
            )
          )
            throw error
          results.push({
            ...result,
            status: 'failed',
            reason:
              error instanceof CLIError
                ? error.message
                : `Cannot write destination (${(error as NodeJS.ErrnoException).code})`,
          })
        }
      }
    }
    return {
      bundleId: bundle.id,
      bundleHash: bundle.hash,
      exitCode: results.some(item => ['blocked', 'missing', 'failed'].includes(item.status))
        ? 1
        : 0,
      items: results,
    }
  }

  async function status(target: SkillTarget): ReturnType<SkillManager<SkillBundle>['status']> {
    const items: Awaited<ReturnType<SkillManager<SkillBundle>['status']>>['items'] = []
    const loaded = new Map<string, readonly SkillFile[]>()
    for (const destination of resolveTargets(target, settings))
      for (const name of Object.keys(bundle.skills)) {
        const path = join(destination.root, name)
        const state = await inspect(path)
        let status: (typeof items)[number]['status'] = 'missing'
        if (state.unsafe) status = 'unsafe'
        else if (state.exists) {
          if (!loaded.has(name)) loaded.set(name, await load(name))
          try {
            const files = await readTree(path)
            if (process.platform === 'win32')
              for (const file of files)
                file.executable =
                  loaded.get(name)!.find(candidate => candidate.path === file.path)?.executable ??
                  file.executable
            status = hashFiles(files) === bundle.skills[name]!.hash ? 'current' : 'different'
          } catch (error) {
            if (!(error instanceof CLIError)) throw error
            status = 'different'
          }
        }
        items.push({
          name,
          path,
          harnesses: destination.harnesses,
          status,
          hint:
            status === 'missing'
              ? 'Run skills add with this target'
              : status === 'different'
                ? 'Run skills update to replace the entire directory'
                : status === 'unsafe'
                  ? 'Move the link or special file aside before proceeding'
                  : '',
        })
      }
    return { bundleId: bundle.id, bundleHash: bundle.hash, items }
  }
  return { select, plan, apply, status }
}
