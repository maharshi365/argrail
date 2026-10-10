import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { CLIError } from '@argrail/core'
import { stat, safePath, hashFiles, readTree, isRecord } from './files.ts'
import { canonicalRoot } from './harnesses/resolve.ts'
import type { Receipt, Journal, Change } from './state.ts'

// Receipts, lock files, and journals are untrusted JSON parsing boundaries.
/* oxlint-disable deslop/no-runtime-typeof */

export const receiptName = '.argrail-skills.json'
const journalName = '.argrail-skills-journal.json'
const lockName = '.argrail-skills.lock'
const workName = '.argrail-skills-work'

export async function readJSON<T>(file: string, fallback?: T): Promise<T | undefined> {
  const info = await stat(file)
  if (!info) return fallback
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new CLIError('SKILL_STATE', `Unsafe state file: ${file}`)
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new CLIError('SKILL_STATE', `Invalid JSON state file: ${file}`)
  }
}
// oxlint-disable-next-line deslop/no-unknown-parameters -- Serialization accepts any state object; readers validate each domain format.
export async function writeJSON(file: string, data: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  try {
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function readReceipt(root: string) {
  const receipt = await readJSON<unknown>(join(root, receiptName), { version: 1, skills: {} })
  validateReceipt(receipt, root)
  return receipt
}
// oxlint-disable-next-line deslop/no-unknown-parameters -- Receipts are untrusted JSON until validated.
function validateReceipt(receipt: unknown, root: string): asserts receipt is Receipt {
  if (!isRecord(receipt) || receipt.version !== 1)
    throw new CLIError(
      'SKILL_STATE_VERSION',
      `Unsupported receipt version in ${root}; existing records were preserved`,
    )
  if (!isRecord(receipt.skills))
    throw new CLIError('SKILL_STATE', `Invalid receipt in ${root}`)
  for (const [name, entry] of Object.entries(receipt.skills)) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      !isRecord(entry) ||
      typeof entry.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      !Array.isArray(entry.files) ||
      !Array.isArray(entry.owners) ||
      !entry.owners.length
    )
      throw new CLIError('SKILL_STATE', `Invalid receipt entry in ${root}`)
    for (const file of entry.files) {
      safePath(file.path)
      if (typeof file.executable !== 'boolean' || !/^[a-f0-9]{64}$/.test(file.hash))
        throw new CLIError('SKILL_STATE', `Invalid file record in ${root}`)
    }
    for (const owner of entry.owners)
      if (
        !isRecord(owner) ||
        typeof owner.id !== 'string' ||
        !Array.isArray(owner.harnesses) ||
        owner.harnesses.some(id => typeof id !== 'string')
      )
        throw new CLIError('SKILL_STATE', `Invalid ownership record in ${root}`)
  }
}
export async function pendingJournal(root: string) {
  return !!(await stat(join(root, journalName)))
}
async function directory(path: string) {
  const info = await stat(path)
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new CLIError('SKILL_STATE', `Unsafe working directory: ${path}`)
  if (!info) await mkdir(path)
}
export async function lockRoot(root: string) {
  if (canonicalRoot(root) !== root)
    throw new CLIError('SKILL_PLAN_CHANGED', `Destination changed: ${root}`)
  await mkdir(root, { recursive: true })
  if (canonicalRoot(root) !== root)
    throw new CLIError('SKILL_PLAN_CHANGED', `Destination changed: ${root}`)
  const file = join(root, lockName)
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify({ pid: process.pid, token }), {
        flag: 'wx',
        mode: 0o600,
      })
      return async () => {
        const lock = await readJSON<{ pid: number; token: string }>(file)
        if (lock?.token === token) await rm(file)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const lock = await readJSON<{ pid: number; token: string }>(file)
      if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid < 1 || typeof lock.token !== 'string')
        throw new CLIError('SKILL_LOCKED', `Unrecognized lock file: ${file}`)
      let dead = false
      try {
        process.kill(lock.pid, 0)
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
      if (!dead) throw new CLIError('SKILL_LOCKED', `Another installer is using ${root}`)
      await rm(file)
    }
  }
  throw new CLIError('SKILL_LOCKED', `Could not lock ${root}`)
}

// oxlint-disable-next-line deslop/no-unknown-parameters -- Recovery journals are untrusted JSON until validated.
function validateJournal(journal: unknown): asserts journal is Journal {
  if (
    !isRecord(journal) ||
    journal.version !== 1 ||
    typeof journal.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(journal.id) ||
    !Array.isArray(journal.entries) ||
    !isRecord(journal.before) ||
    journal.before.version !== 1
  )
    throw new CLIError('SKILL_RECOVERY', 'Unrecognized recovery journal; no files were changed')
  validateReceipt(journal.before, 'recovery journal')
  const names = new Set()
  for (const entry of journal.entries) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) ||
      typeof entry.hadOld !== 'boolean' ||
      typeof entry.install !== 'boolean' ||
      typeof entry.backup !== 'boolean' ||
      names.has(entry.name)
    )
      throw new CLIError('SKILL_RECOVERY', 'Invalid recovery entry; no files were changed')
    names.add(entry.name)
    if (entry.install) {
      if (!/^[a-f0-9]{64}$/.test(entry.hash!) || !Array.isArray(entry.files))
        throw new CLIError('SKILL_RECOVERY', 'Invalid recovery content hash')
      for (const file of entry.files) {
        safePath(file.path)
        if (typeof file.executable !== 'boolean')
          throw new CLIError('SKILL_RECOVERY', 'Invalid recovery file record')
      }
    }
  }
}
async function recoveryDirectory(root: string, journal: Journal) {
  // oxlint-disable-next-line deslop/no-known-value-widening -- Exported rollback can receive an unvalidated journal from JavaScript.
  validateJournal(journal)
  const work = join(root, workName, journal.id)
  for (const path of [join(root, workName), work, join(work, 'old'), join(work, 'stage')]) {
    const info = await stat(path)
    if (!info || !info.isDirectory() || info.isSymbolicLink())
      throw new CLIError(
        'SKILL_RECOVERY',
        `Missing or unsafe recovery directory: ${path}; no files were changed`,
      )
  }
  const original = await readJSON<Journal>(join(work, 'journal.json'))
  if (
    !original ||
    original.id !== journal.id ||
    JSON.stringify(original.before) !== JSON.stringify(journal.before) ||
    JSON.stringify(original.entries) !== JSON.stringify(journal.entries)
  )
    throw new CLIError('SKILL_RECOVERY', 'Inconsistent recovery journal; no files were changed')
  return work
}
export async function rollback(root: string, journal: Journal) {
  const work = await recoveryDirectory(root, journal)
  // Check every replacement before removing anything. Edits made after a crash
  // must be moved aside by the user, not discarded by recovery.
  for (const entry of journal.entries) {
    const old = join(work, 'old', entry.name),
      stage = join(work, 'stage', entry.name),
      destination = join(root, entry.name)
    const oldInfo = await stat(old)
    if (oldInfo && (!oldInfo.isDirectory() || oldInfo.isSymbolicLink()))
      throw new CLIError('SKILL_RECOVERY', 'Unsafe original recovery directory')
    if (
      (oldInfo || (!entry.hadOld && entry.install && !(await stat(stage)))) &&
      (await stat(destination))
    ) {
      const info = (await stat(destination))!
      if (!entry.install || !info.isDirectory() || info.isSymbolicLink())
        throw new CLIError(
          'SKILL_RECOVERY',
          `Files changed in ${destination}; move them aside before recovery`,
        )
      const files = await readTree(destination)
      if (process.platform === 'win32')
        for (const file of files)
          file.executable =
            entry.files.find(record => record.path === file.path)?.executable ?? file.executable
      if (hashFiles(files) !== entry.hash)
        throw new CLIError(
          'SKILL_RECOVERY',
          `Files changed in ${destination}; move them aside before recovery`,
        )
    }
  }
  for (const entry of [...journal.entries].reverse()) {
    const old = join(work, 'old', entry.name),
      stage = join(work, 'stage', entry.name),
      destination = join(root, entry.name)
    // Rename state distinguishes an untouched old destination from an applied replacement.
    if (await stat(old)) {
      if (await stat(destination)) await rm(destination, { recursive: true, force: true })
      await rename(old, destination)
    } else if (
      !entry.hadOld &&
      entry.install &&
      !(await stat(stage)) &&
      (await stat(destination))
    ) {
      await rm(destination, { recursive: true, force: true })
    }
  }
  await writeJSON(join(root, receiptName), journal.before)
  await rm(join(root, journalName))
  await rm(work, { recursive: true, force: true })
}
export async function recoverRoot(root: string) {
  const journal = await readJSON<unknown>(join(root, journalName))
  if (!journal) return false
  validateJournal(journal)
  if (journal.committed) {
    await finish(root, journal)
  } else await rollback(root, journal)
  return true
}
async function finish(root: string, journal: Journal): Promise<Record<string, string>> {
  const work = await recoveryDirectory(root, journal)
  const backups: Record<string, string> = Object.create(null)
  for (const entry of journal.entries)
    if (entry.backup && (await stat(join(work, 'old', entry.name)))) {
      const base = join(root, '.argrail-skills-backups')
      await directory(base)
      const target = join(base, journal.id)
      await directory(target)
      const path = join(target, entry.name)
      await rename(join(work, 'old', entry.name), path)
      backups[entry.name] = path
    }
  await rm(join(root, journalName))
  await rm(work, { recursive: true, force: true })
  return backups
}

export async function transact(root: string, before: Receipt, after: Receipt, changes: Change[], signal?: AbortSignal) {
  const id = randomUUID()
  await directory(join(root, workName))
  const work = join(root, workName, id)
  await mkdir(join(work, 'stage'), { recursive: true })
  await mkdir(join(work, 'old'))
  const journal: Journal = {
    version: 1,
    id,
    before,
    entries: changes.map(change => ({
      name: change.name,
      hadOld: change.exists,
      install: !!change.files,
      backup: change.backup,
      hash: change.files ? hashFiles(change.files) : null,
      files: change.files
        ? change.files.map(file => ({ path: file.path, executable: file.executable }))
        : [],
    })),
  }
  let published = false
  try {
    for (const change of changes)
      if (change.files) {
        const stage = join(work, 'stage', change.name)
        await mkdir(stage)
        for (const file of change.files) {
          if (signal?.aborted) throw new CLIError('CANCELLED', 'Cancelled')
          const destination = join(stage, ...file.path.split('/'))
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, Buffer.from(file.data, 'base64'), {
            flag: 'wx',
            mode: file.executable ? 0o755 : 0o644,
          })
        }
      }
    await writeJSON(join(work, 'journal.json'), journal)
    await writeJSON(join(root, journalName), journal)
    published = true
    for (const change of changes) {
      if (signal?.aborted) throw new CLIError('CANCELLED', 'Cancelled')
      const destination = join(root, change.name)
      if (change.exists) await rename(destination, join(work, 'old', change.name))
      if (change.files) await rename(join(work, 'stage', change.name), destination)
    }
    await writeJSON(join(root, receiptName), after)
    journal.committed = true
    await writeJSON(join(root, journalName), journal)
    return await finish(root, journal)
  } catch (error) {
    if (published && !journal.committed) await rollback(root, journal)
    else if (!published) await rm(work, { recursive: true, force: true })
    throw error
  }
}
