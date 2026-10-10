import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CLIError, CancelledError } from '@argrail/core'
// Parse byte payloads and reject control characters at the portable-path boundary.
/* oxlint-disable deslop/no-runtime-typeof, eslint/no-control-regex */

export const MAX_FILES = 4096
export const MAX_BYTES = 32 * 1024 * 1024
export const digest = value => createHash('sha256').update(value).digest('hex')
export function hashFiles(files) {
  return digest(
    JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
  )
}
export function checkSignal(signal) {
  if (signal?.aborted) throw new CancelledError()
}
export function safePath(path) {
  // oxlint-disable-next-line deslop/no-runtime-typeof, eslint/no-control-regex -- Parse portable paths and reject control characters at the filesystem boundary.
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|?*\u0000-\u001f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  ) {
    throw new CLIError('UNSAFE_SKILL_PATH', `Unsafe skill path: ${path}`)
  }
}
export function validateFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES)
    throw new CLIError('SKILL_LIMIT', 'Skill has too many files')
  const names = new Set()
  let bytes = 0
  for (const file of files) {
    safePath(file.path)
    const key = file.path.toLowerCase()
    if (names.has(key)) throw new CLIError('SKILL_COLLISION', `Duplicate skill file: ${file.path}`)
    names.add(key)
    // oxlint-disable-next-line deslop/no-runtime-typeof -- Validate bundled bytes before writing them to disk.
    if (
      typeof file.data !== 'string' ||
      typeof file.executable !== 'boolean' ||
      Buffer.from(file.data, 'base64').toString('base64') !== file.data
    )
      throw new CLIError('INVALID_SKILL_FILE', `Invalid bundled file: ${file.path}`)
    bytes += Buffer.from(file.data, 'base64').length
  }
  if (bytes > MAX_BYTES) throw new CLIError('SKILL_LIMIT', 'Skill exceeds the 32 MB limit')
  if (!files.some(file => file.path === 'SKILL.md'))
    throw new CLIError('INVALID_SKILL', 'Skill requires a correctly cased SKILL.md')
  for (const name of names) {
    const parts = name.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (names.has(parts.join('/')))
        throw new CLIError('SKILL_COLLISION', `File/directory collision: ${name}`)
    }
  }
}
export async function stat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
export async function readTree(root, { rejectProjectFiles = false } = {}) {
  const files = []
  let bytes = 0
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = prefix + entry.name
      safePath(path)
      if (rejectProjectFiles && ['.git', 'node_modules', '.hg', '.svn'].includes(entry.name))
        throw new CLIError('SKILL_PROJECT_FILES', `Remove ${path} from the skill directory`)
      const full = join(directory, entry.name)
      const info = await lstat(full)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new CLIError('UNSAFE_SKILL_PATH', `Unsafe link or special file: ${path}`)
      if (info.isDirectory()) await visit(full, path + '/')
      else {
        bytes += info.size
        if (bytes > MAX_BYTES || files.length >= MAX_FILES)
          throw new CLIError('SKILL_LIMIT', 'Skill exceeds file count or size limits')
        files.push({
          path,
          data: (await readFile(full)).toString('base64'),
          executable: !!(info.mode & 0o111),
        })
      }
    }
  }
  await visit(root)
  return files
}
