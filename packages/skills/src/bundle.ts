import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseDocument } from 'yaml'
import { digest, hashFiles, readTree, validateFiles, isRecord } from './files.ts'
import type { SkillBundle, SkillFile } from './types.ts'

export interface SkillMetadata {
  name: string
  description: string
  license?: string
  'allowed-tools'?: string
  compatibility?: string
  metadata?: Record<string, string>
}
export interface SkillBuildConfig { id: string; directory: string; groups?: SkillBundle['groups'] }

// YAML and author configuration are untrusted parsing boundaries.
/* oxlint-disable deslop/no-runtime-typeof */

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const execute = promisify(execFile)
async function executablePaths(directory: string) {
  const paths = new Set<string>()
  if (process.platform !== 'win32') return paths
  try {
    // Windows checkouts do not expose Git's executable bit through stat().
    const { stdout } = await execute(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', directory, 'ls-files', '--stage', '-z', '--', '.'],
      { timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true },
    )
    for (const entry of stdout.split('\0')) {
      const match = /^100755 [a-f0-9]+ 0\t(.+)$/.exec(entry)
      if (match) paths.add(match[1]!)
    }
  } catch (error) {
    // SAFETY: execute wraps Node's execFile, whose rejection carries the code and killed process-error fields.
    const failure = error as NodeJS.ErrnoException & { killed?: boolean }
    if (!['ENOENT', 128, 'ETIMEDOUT'].includes(failure.code!) && !failure.killed) throw error
  }
  return paths
}
export function validateMetadata(text: string, directory: string, file: string): SkillMetadata {
  const fail = (message: string): never => {
    throw new Error(`${file}: ${message}`)
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return fail('SKILL.md requires YAML frontmatter')
  const document = parseDocument(match[1]!, { uniqueKeys: true })
  if (document.errors.length) fail(`invalid YAML: ${document.errors[0]!.message}`)
  const data = document.toJS({ maxAliasCount: 20 })
  if (!data || typeof data !== 'object' || Array.isArray(data))
    fail('frontmatter must be a mapping')
  if (typeof data.name !== 'string' || !namePattern.test(data.name) || data.name.length > 64)
    fail('name must be 1–64 lowercase letters, numbers, and single hyphens')
  if (data.name !== directory) fail('name must match the skill directory')
  if (
    typeof data.description !== 'string' ||
    !data.description.trim() ||
    data.description.length > 1024
  )
    fail('description must be 1–1024 characters')
  for (const key of ['license', 'allowed-tools'])
    if (data[key] !== undefined && typeof data[key] !== 'string') fail(`${key} must be text`)
  if (
    data.compatibility !== undefined &&
    (typeof data.compatibility !== 'string' ||
      !data.compatibility.length ||
      data.compatibility.length > 500)
  )
    fail('compatibility must be 1–500 characters')
  if (
    data.metadata !== undefined &&
    (!data.metadata ||
      typeof data.metadata !== 'object' ||
      Array.isArray(data.metadata) ||
      Object.values(data.metadata).some(value => typeof value !== 'string'))
  )
    fail('metadata must map text keys to text values')
  return data
}

export async function discoverSkills(config: SkillBuildConfig) {
  const skills: Record<string, SkillMetadata & { hash: string; fileCount: number; bytes: number }> = Object.create(null),
    files: Record<string, SkillFile[]> = Object.create(null)
  const executables = await executablePaths(config.directory)
  for (const entry of (await readdir(config.directory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const directory = join(config.directory, entry.name)
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error(`${directory}: skill directories cannot be links`)
    if (!entry.isDirectory())
      throw new Error(`${directory}: skills directory must contain only skill directories`)
    const file = join(directory, 'SKILL.md')
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`${file}: SKILL.md must be a regular file, not a link`)
    const metadata = validateMetadata(await readFile(file, 'utf8'), entry.name, file)
    const resources = await readTree(directory, { rejectProjectFiles: true })
    for (const resource of resources)
      if (executables.has(`${entry.name}/${resource.path}`)) resource.executable = true
    validateFiles(resources)
    skills[metadata.name] = {
      ...metadata,
      hash: hashFiles(resources),
      fileCount: resources.length,
      bytes: resources.reduce(
        (total, resource) => total + Buffer.from(resource.data, 'base64').length,
        0,
      ),
    }
    files[metadata.name] = resources
  }
  if (!Object.keys(skills).length) throw new Error(`${config.directory}: no skills found`)
  const groups = config.groups ?? {}
  for (const [name, group] of Object.entries<unknown>(groups)) {
    if (
      !namePattern.test(name) ||
      !isRecord(group) ||
      !Array.isArray(group.skills) ||
      !group.skills.length ||
      typeof group.description !== 'string' ||
      Object.keys(group).some(key => key !== 'skills' && key !== 'description')
    )
      throw new Error(`Invalid skill group: ${name}`)
    for (const member of group.skills)
      if (!Object.hasOwn(skills, member)) throw new Error(`Group ${name}: unknown skill ${member}`)
    if (new Set(group.skills).size !== group.skills.length)
      throw new Error(`Group ${name}: duplicate members`)
  }
  const hash = digest(JSON.stringify({ id: config.id, skills, groups }))
  return { id: config.id, hash, skills, groups, files }
}
