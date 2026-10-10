import { readlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { CLIError } from '@argrail/core'
import { digest, hashFiles, readTree, stat, validateFiles, checkSignal } from './files.ts'
import { resolveTargets, canonicalRoot } from './harnesses/resolve.ts'
// Public bundles and saved project manifests are untrusted parsing boundaries.
/* oxlint-disable deslop/no-runtime-typeof, typescript/no-unnecessary-condition */
import {
  readReceipt,
  pendingJournal,
  lockRoot,
  transact,
  readJSON,
  writeJSON,
  recoverRoot,
} from './storage.ts'
import type { SkillBundle, HarnessSettings, SkillSelection, SkillPlan, SkillPlanItem, SkillResult, SkillTarget, SkillManager, SkillFile } from './types.ts'
import type { Receipt, ReceiptEntry, Change, MutablePlan, Mutable, Manifest, SavedTarget } from './state.ts'

async function inspect(root: string, name: string, record: ReceiptEntry | undefined) {
  const path = join(root, name),
    info = await stat(path)
  if (!info) return { exists: false, fingerprint: 'absent', clean: false }
  if (!info.isDirectory() || info.isSymbolicLink())
    return {
      exists: true,
      fingerprint: digest(
        JSON.stringify({
          link: info.isSymbolicLink() ? await readlink(path) : null,
          size: info.size,
          mtime: info.mtimeMs,
        }),
      ),
      clean: false,
      unsafe: true,
    }
  try {
    const files = await readTree(path)
    if (process.platform === 'win32' && record)
      for (const file of files)
        file.executable =
          record.files.find(candidate => candidate.path === file.path)?.executable ??
          file.executable
    const hash = hashFiles(files)
    return { exists: true, fingerprint: hash, clean: record?.hash === hash }
  } catch (error) {
    if (!(error instanceof CLIError)) throw error
    return {
      exists: true,
      fingerprint: digest(`${error.code}:${info.mtimeMs}`),
      clean: false,
      unsafe: true,
    }
  }
}
function ownRecord(receipt: Receipt, name: string) {
  return Object.hasOwn(receipt.skills, name) ? receipt.skills[name] : undefined
}

export function createSkills<const B extends SkillBundle>(bundle: B, settings?: HarnessSettings): SkillManager<B>
export function createSkills(bundle: SkillBundle, settings: HarnessSettings = {}): SkillManager<SkillBundle> {
  // oxlint-disable-next-line deslop/no-runtime-typeof -- Validate the public bundle boundary before creating a manager.
  if (
    !bundle ||
    typeof bundle.id !== 'string' ||
    !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(bundle.id) ||
    !/^[a-f0-9]{64}$/.test(bundle.hash) ||
    !bundle.skills ||
    !bundle.groups
  )
    throw new CLIError('INVALID_SKILL_BUNDLE', 'Invalid skill bundle identity or hash')
  // oxlint-disable-next-line deslop/no-runtime-typeof -- JavaScript callers can pass invalid loaders.
  for (const [name, skill] of Object.entries(bundle.skills))
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      name.length > 64 ||
      skill.name !== name ||
      typeof skill.load !== 'function' ||
      !/^[a-f0-9]{64}$/.test(skill.hash)
    )
      throw new CLIError('INVALID_SKILL_BUNDLE', `Invalid bundled skill: ${name}`)
  const approved = new WeakMap<SkillPlan, string>()
  const completed = new WeakMap<SkillResult, { plan: SkillPlan; snapshot: string }>()

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
  async function plan(request: SkillSelection<SkillBundle> & { action: SkillPlan['action']; target: SkillTarget; replace?: boolean }): Promise<MutablePlan> {
    if (!['add', 'update', 'remove'].includes(request.action))
      throw new CLIError('SKILL_ACTION', 'Unsupported skill operation')
    const names = select(request)
    if (!names.length)
      throw new CLIError('SKILL_SELECTION', 'Select skill names, --group, or --all')
    if (request.replace && request.action === 'remove')
      throw new CLIError('SKILL_SELECTION', '--replace cannot discard local edits during removal')
    const destinations = resolveTargets(request.target, settings)
    const items: MutablePlan['items'] = [],
      roots: MutablePlan['roots'] = []
    for (const destination of destinations) {
      if (await pendingJournal(destination.root))
        throw new CLIError(
          'SKILL_RECOVERY_REQUIRED',
          `Interrupted installation in ${destination.root}. Run skills recover with the same target.`,
        )
      const receipt = await readReceipt(destination.root)
      roots.push({ ...destination, receiptHash: digest(JSON.stringify(receipt)) })
      for (const name of names) {
        const record = ownRecord(receipt, name),
          owner = record?.owners.find(owner => owner.id === bundle.id)
        const state = await inspect(destination.root, name, record)
        const skill = bundle.skills[name]!
        const remainingHarnesses =
          owner && request.target.path === undefined
            ? owner.harnesses.filter(id => !destination.harnesses.includes(id))
            : []
        let operation: SkillPlanItem['operation'] = 'conflict',
          reason = '',
          backup = false
        if (request.action === 'remove') {
          if (!state.exists && !owner) operation = 'noop'
          else if (!owner) reason = 'Unmanaged skill; removal refused'
          else if (!state.exists) operation = 'release'
          else if (!state.clean) reason = 'Local files changed; removal refused'
          else
            operation = record!.owners.length > 1 || remainingHarnesses.length ? 'release' : 'remove'
          if (operation === 'release' && remainingHarnesses.length)
            reason = `Files remain for recorded harnesses: ${remainingHarnesses.join(', ')}. The selected harness may still read this shared root.`
        } else if (request.action === 'update' && !owner) {
          reason = state.exists
            ? 'Unmanaged skill; update refused'
            : 'Not installed; update does not add skills'
        } else if (
          record &&
          record.owners.some(owner => owner.id !== bundle.id) &&
          record.hash !== skill.hash
        ) {
          reason = 'Different content is still owned by another CLI'
        } else if (!state.exists) operation = 'install'
        else if (record && state.clean && record.hash === skill.hash)
          operation = owner ? 'noop' : 'claim'
        else if (owner && state.clean && request.action === 'update') operation = 'install'
        else if (request.replace && !state.unsafe) {
          operation = 'install'
          backup = true
        } else if (state.unsafe)
          reason = 'Unsafe link or special file; move it aside before installing'
        else if (owner && state.clean)
          reason = 'A different version is installed; use skills update'
        else reason = 'Unmanaged or modified files; use --replace to back up and replace'
        items.push({
          name,
          root: destination.root,
          path: join(destination.root, name),
          harnesses: destination.harnesses,
          remainingHarnesses,
          operation,
          reason,
          fingerprint: state.fingerprint,
          exists: state.exists,
          backup,
          fileCount: skill.fileCount ?? 0,
          bytes: skill.bytes ?? 0,
        })
      }
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

  async function apply(plan: SkillPlan, { signal }: { signal?: AbortSignal } = {}): Promise<SkillResult> {
    checkSignal(signal)
    if (approved.get(plan) !== JSON.stringify(plan))
      throw new CLIError('SKILL_PLAN', 'Plan is unknown or was changed; create a fresh plan')
    const submitted = plan
    plan = structuredClone(plan)
    const loaded = new Map<string, readonly SkillFile[]>()
    for (const item of plan.items)
      if (item.operation === 'install' && !loaded.has(item.name)) {
        const files = structuredClone(await bundle.skills[item.name]!.load())
        validateFiles(files)
        if (hashFiles(files) !== bundle.skills[item.name]!.hash)
          throw new CLIError('SKILL_INTEGRITY', `Bundled content hash does not match: ${item.name}`)
        loaded.set(item.name, files)
      }
    const unlock: (() => Promise<void>)[] = [],
      results: SkillResult['items'][number][] = []
    let cleanupFailure
    try {
      for (const root of [...plan.roots].sort((a, b) =>
        a.root < b.root ? -1 : a.root > b.root ? 1 : 0,
      )) {
        checkSignal(signal)
        const writes = plan.items.some(
          item => item.root === root.root && !['conflict', 'noop'].includes(item.operation),
        )
        if (writes || (await stat(root.root))) unlock.push(await lockRoot(root.root))
      }
      for (const root of plan.roots) {
        if (await pendingJournal(root.root))
          throw new CLIError(
            'SKILL_RECOVERY_REQUIRED',
            `Interrupted installation in ${root.root}; recover before proceeding`,
          )
        const receipt = await readReceipt(root.root)
        if (digest(JSON.stringify(receipt)) !== root.receiptHash)
          throw new CLIError(
            'SKILL_PLAN_CHANGED',
            `Ownership changed in ${root.root}; create a fresh plan`,
          )
        for (const item of plan.items.filter(item => item.root === root.root))
          if (
            (await inspect(root.root, item.name, ownRecord(receipt, item.name))).fingerprint !==
            item.fingerprint
          )
            throw new CLIError(
              'SKILL_PLAN_CHANGED',
              `Files changed in ${item.path}; create a fresh plan`,
            )
      }
      for (const root of plan.roots) {
        checkSignal(signal)
        const before = await readReceipt(root.root),
          after = structuredClone(before),
          changes: Change[] = []
        const rootItems = plan.items.filter(item => item.root === root.root)
        for (const item of rootItems) {
          if (item.operation === 'conflict') {
            results.push({
              name: item.name,
              path: item.path,
              harnesses: item.harnesses,
              status: item.exists ? 'blocked' : 'missing',
              reason: item.reason,
            })
            continue
          }
          const record = ownRecord(after, item.name)
          if (['remove', 'release'].includes(item.operation)) {
            if (item.remainingHarnesses.length)
              record!.owners.find(owner => owner.id === bundle.id)!.harnesses =
                item.remainingHarnesses
            else record!.owners = record!.owners.filter(owner => owner.id !== bundle.id)
            if (!record!.owners.length) delete after.skills[item.name]
            if (item.operation === 'remove')
              changes.push({ name: item.name, exists: item.exists, backup: false })
          } else if (
            ['install', 'claim', 'noop'].includes(item.operation) &&
            plan.action !== 'remove'
          ) {
            const files = loaded.get(item.name)!
            const entry =
              item.operation === 'install'
                ? {
                    hash: bundle.skills[item.name]!.hash,
                    files: files.map(file => ({
                      path: file.path,
                      hash: digest(Buffer.from(file.data, 'base64')),
                      executable: file.executable,
                    })),
                    owners: record?.owners.filter(owner => owner.id !== bundle.id) ?? [],
                  }
                : record!
            const claim = {
              id: bundle.id,
              bundleHash: bundle.hash,
              harnesses: [
                ...new Set([
                  ...(record?.owners.find(owner => owner.id === bundle.id)?.harnesses ?? []),
                  ...item.harnesses,
                ]),
              ],
            }
            entry.owners = [...entry.owners.filter(owner => owner.id !== bundle.id), claim]
            after.skills[item.name] = entry
            if (item.operation === 'install')
              changes.push({ name: item.name, exists: item.exists, files, backup: item.backup })
          }
        }
        let backups: Record<string, string> = {}
        try {
          if (changes.length || JSON.stringify(before) !== JSON.stringify(after))
            backups = await transact(root.root, before, after, changes, signal)
        } catch (error) {
          checkSignal(signal)
          if (
            !(error instanceof CLIError) &&
            !['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EIO'].includes(
              (error as NodeJS.ErrnoException).code!,
            )
          )
            throw error
          const recoveryRequired = await pendingJournal(root.root)
          const reason = `${error instanceof CLIError ? error.message : `Cannot write destination (${(error as NodeJS.ErrnoException).code})`}${recoveryRequired ? '; run skills recover with this target' : ''}`
          for (const item of rootItems.filter(item => item.operation !== 'conflict'))
            results.push({
              name: item.name,
              path: item.path,
              harnesses: item.harnesses,
              status: 'failed',
              reason,
              recoveryRequired,
            })
          continue
        }
        for (const item of rootItems.filter(item => item.operation !== 'conflict')) {
          const result: Mutable<SkillResult['items'][number]> = {
            name: item.name,
            path: item.path,
            harnesses: [...item.harnesses],
            status:
              item.operation === 'install'
                ? 'installed'
                : item.operation === 'remove'
                  ? 'removed'
                  : item.operation === 'release'
                    ? 'released'
                    : item.operation === 'claim'
                      ? 'claimed'
                      : 'unchanged',
          }
          if (backups[item.name]) result.backup = backups[item.name]!
          if (item.reason) result.reason = item.reason
          results.push(result)
        }
      }
    } finally {
      const released = await Promise.allSettled(unlock.reverse().map(release => release()))
      cleanupFailure = released.find(result => result.status === 'rejected')
    }
    if (cleanupFailure) throw cleanupFailure.reason
    approved.delete(submitted)
    const result = {
      bundleId: bundle.id,
      bundleHash: bundle.hash,
      exitCode: results.some(item => ['blocked', 'missing', 'failed'].includes(item.status))
        ? 1
        : 0,
      items: results,
    }
    completed.set(result, { plan: submitted, snapshot: JSON.stringify(plan) })
    return result
  }
  async function status(target: SkillTarget): ReturnType<SkillManager<SkillBundle>['status']> {
    const items: Awaited<ReturnType<SkillManager<SkillBundle>['status']>>['items'] = []
    for (const destination of resolveTargets(target, settings)) {
      const receipt = await readReceipt(destination.root)
      const recoveryRequired = await pendingJournal(destination.root)
      for (const name of Object.keys(bundle.skills)) {
        const record = ownRecord(receipt, name),
          owner = record?.owners.find(owner => owner.id === bundle.id)
        const state = await inspect(destination.root, name, record)
        const status = !state.exists
          ? 'missing'
          : !owner
            ? 'unmanaged'
            : !state.clean
              ? 'modified'
              : record!.hash !== bundle.skills[name]!.hash
                ? 'outdated'
                : 'current'
        items.push({
          name,
          path: join(destination.root, name),
          harnesses: destination.harnesses,
          status,
          recoveryRequired,
          hint: recoveryRequired
            ? 'Run skills recover with this target'
            : status === 'outdated'
              ? 'Run skills update with this target'
              : status === 'modified'
                ? 'Review local edits before updating'
                : status === 'missing'
                  ? 'Run skills add with this target'
                  : status === 'unmanaged'
                    ? 'Existing files are not owned by this CLI'
                    : '',
        })
      }
    }
    return { bundleId: bundle.id, bundleHash: bundle.hash, items }
  }
  async function recover(target: SkillTarget) {
    const items = []
    for (const destination of resolveTargets(target, settings)) {
      if (!(await pendingJournal(destination.root))) {
        items.push({ path: destination.root, recovered: false })
        continue
      }
      const unlock = await lockRoot(destination.root)
      try {
        items.push({ path: destination.root, recovered: await recoverRoot(destination.root) })
      } finally {
        await unlock()
      }
    }
    return { items }
  }
  async function save(plan: SkillPlan, result: SkillResult) {
    if (
      completed.get(result)?.plan !== plan ||
      completed.get(result)?.snapshot !== JSON.stringify(plan)
    )
      throw new CLIError(
        'SKILL_MANIFEST',
        'Save requires the unchanged plan and its successful apply result',
      )
    if (
      result.exitCode ||
      result.bundleHash !== bundle.hash ||
      plan.action !== 'add' ||
      plan.target.path !== undefined ||
      plan.target.scope === 'global'
    )
      throw new CLIError('SKILL_MANIFEST', 'Only successful project additions can be saved')
    const project = canonicalRoot(plan.target.project ?? process.cwd())
    const file = join(project, 'argrail.skills.json')
    const release = await lockRoot(project)
    try {
      const manifest = (await readJSON<Manifest>(file, { version: 1, bundles: {} }))!
      // oxlint-disable-next-line deslop/no-runtime-typeof -- Validate the saved project manifest before editing it.
      if (
        manifest.version !== 1 ||
        !manifest.bundles ||
        typeof manifest.bundles !== 'object' ||
        Array.isArray(manifest.bundles)
      )
        throw new CLIError(
          'SKILL_MANIFEST',
          'Unsupported or invalid project manifest; existing file preserved',
        )
      const previous = Object.hasOwn(manifest.bundles, bundle.id)
        ? manifest.bundles[bundle.id]
        : undefined
      if (previous && !Array.isArray(previous.targets))
        throw new CLIError(
          'SKILL_MANIFEST',
          'Existing bundle targets are invalid; manifest preserved',
        )
      const targets = new Map<string, SavedTarget>()
      for (const target of previous?.targets ?? []) {
        validateSavedTarget(target)
        select({ skills: target.skills })
        targets.set(target.path, structuredClone(target))
      }
      for (const root of plan.roots) {
        const path = relative(project, root.root).replaceAll('\\', '/')
        const selected = plan.items.filter(item => item.root === root.root).map(item => item.name)
        const before = targets.get(path)
        const target = {
          path,
          harnesses: [...new Set([...(before?.harnesses ?? []), ...root.harnesses])],
          skills: [...new Set([...(before?.skills ?? []), ...selected])],
        }
        validateSavedTarget(target)
        targets.set(path, target)
      }
      manifest.bundles[bundle.id] = { hash: bundle.hash, targets: [...targets.values()] }
      await writeJSON(file, manifest)
      return file
    } finally {
      await release()
    }
  }
  function validateSavedTarget(target: SavedTarget) {
    // oxlint-disable-next-line deslop/no-runtime-typeof -- Parse portable paths and selection arrays from the project manifest.
    if (
      !target ||
      typeof target.path !== 'string' ||
      !target.path ||
      target.path.includes('\\') ||
      target.path.split('/').some(part => !part || part === '.' || part === '..') ||
      isAbsolute(target.path) ||
      !Array.isArray(target.skills) ||
      !target.skills.length ||
      !Array.isArray(target.harnesses) ||
      target.harnesses.some(id => typeof id !== 'string')
    )
      throw new CLIError(
        'SKILL_MANIFEST',
        'Saved targets require relative project paths, concrete skill names, and harness IDs',
      )
  }
  async function restore(project = process.cwd()) {
    project = canonicalRoot(project)
    const manifest = await readJSON<Manifest>(join(project, 'argrail.skills.json'))
    const entry =
      manifest?.version === 1 && Object.hasOwn(manifest.bundles ?? {}, bundle.id)
        ? manifest.bundles[bundle.id]
        : undefined
    if (!entry || entry.hash !== bundle.hash)
      throw new CLIError(
        'SKILL_MANIFEST_BUNDLE',
        'Saved bundle does not match this CLI; use the CLI release that shipped the saved bundle',
      )
    if (!Array.isArray(entry.targets) || !entry.targets.length)
      throw new CLIError('SKILL_MANIFEST', 'Saved bundle has no targets')
    const plans = []
    for (const target of entry.targets) {
      validateSavedTarget(target)
      const path = resolve(project, target.path)
      const next = await plan({ action: 'add', skills: target.skills, target: { path } })
      if (!next.roots[0]!.root.startsWith(project + (process.platform === 'win32' ? '\\' : '/')))
        throw new CLIError('SKILL_MANIFEST', 'Saved target escapes the project')
      next.roots[0]!.harnesses = target.harnesses
      if (target.harnesses.length) {
        const current = resolveTargets({ project, harnesses: target.harnesses }, settings)
        if (current.length !== 1 || current[0]!.root !== next.roots[0]!.root)
          throw new CLIError(
            'SKILL_MANIFEST',
            'Saved destination differs from the harness path rules; review the manifest before restoring',
          )
        next.roots[0]!.shared = current[0]!.shared
      }
      for (const item of next.items) item.harnesses = next.roots[0]!.harnesses
      plans.push(next)
    }
    const roots = new Map<string, MutablePlan['roots'][number]>(),
      items = new Map<string, MutablePlan['items'][number]>()
    for (const next of plans) {
      for (const root of next.roots) {
        const before = roots.get(root.root)
        if (before) before.harnesses = [...new Set([...before.harnesses, ...root.harnesses])]
        else roots.set(root.root, root)
      }
      for (const item of next.items) {
        const key = `${item.root}\0${item.name}`,
          before = items.get(key)
        if (before) before.harnesses = [...new Set([...before.harnesses, ...item.harnesses])]
        else items.set(key, item)
      }
    }
    const combined = { ...plans[0]!, roots: [...roots.values()], items: [...items.values()] }
    approved.set(combined, JSON.stringify(combined))
    return combined
  }
  return { select, plan, apply, status, recover, save, restore }
}
