import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { commandPath, discover, generate, loadConfig, addCommand } from './generator.mjs'

async function project(run) {
  const root = await mkdtemp(resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-test-'))
  try {
    await mkdir(resolve(root, 'src/commands'), { recursive: true })
    await writeFile(resolve(root, 'argrail.config.json'), JSON.stringify({ name: 'app' }))
    return await run(root, await loadConfig(root))
  } finally { await rm(root, { recursive: true, force: true }) }
}

describe('file-based generation', () => {
  test('maps nested paths, index files, and dynamic arguments', () => {
    expect(commandPath('index.ts')).toBe('/')
    expect(commandPath('users/index.ts')).toBe('/users')
    expect(commandPath('users/$userId/delete.ts')).toBe('/users/$userId/delete')
    expect(() => commandPath('BadName.ts')).toThrow('Invalid command filename')
  })
  test('generates a typed registry without executing command modules', async () => {
    await project(async (root, config) => {
      await writeFile(resolve(root, 'src/commands/build.ts'), 'throw new Error("must not execute during discovery")')
      const result = await generate(config)
      expect(result.count).toBe(1)
      const content = await readFile(config.generatedRegistry, 'utf8')
      expect(content).toContain('bindCommand("/build", command0)')
      expect(content).toContain('from "./commands/build.ts"')
      const before = (await stat(config.generatedRegistry)).mtimeMs
      expect((await generate(config)).changed).toBe(false)
      expect((await stat(config.generatedRegistry)).mtimeMs).toBe(before)
    })
  })
  test('renames and removes registry paths', async () => {
    await project(async (root, config) => {
      const directory = resolve(root, 'src/commands')
      await writeFile(resolve(directory, 'create.ts'), '')
      await writeFile(resolve(directory, 'keep.ts'), '')
      await generate(config)
      await rename(resolve(directory, 'create.ts'), resolve(directory, 'add.ts'))
      await generate(config)
      const content = await readFile(config.generatedRegistry, 'utf8')
      expect(content).toContain('"/add"')
      expect(content).not.toContain('"/create"')
      await rm(resolve(directory, 'add.ts'))
      await generate(config)
      expect(await readFile(config.generatedRegistry, 'utf8')).not.toContain('"/add"')
    })
  })
  test('ignores helpers, tests, declarations, and generated files', async () => {
    await project(async (root, config) => {
      for (const name of ['build.ts', '-helper.ts', 'build.test.ts', 'types.d.ts', 'tree.gen.ts']) await writeFile(resolve(root, 'src/commands', name), '')
      expect((await discover(config.commandsDirectory)).map(entry => entry.path)).toEqual(['/build'])
    })
  })
  test('rejects duplicate paths and ambiguous dynamics', async () => {
    await project(async (root, config) => {
      await mkdir(resolve(root, 'src/commands/users'))
      await writeFile(resolve(root, 'src/commands/users.ts'), '')
      await writeFile(resolve(root, 'src/commands/users/index.ts'), '')
      await expect(discover(config.commandsDirectory)).rejects.toThrow('Duplicate')
      await rm(resolve(root, 'src/commands/users.ts'))
      await writeFile(resolve(root, 'src/commands/$a.ts'), '')
      await writeFile(resolve(root, 'src/commands/$b.ts'), '')
      await expect(discover(config.commandsDirectory)).rejects.toThrow('Ambiguous')
    })
  })
  test('does not overwrite user-authored files', async () => {
    await project(async (root, config) => {
      await writeFile(resolve(root, 'src/commands/build.ts'), '')
      await writeFile(config.generatedRegistry, '// user work\n')
      await expect(generate(config)).rejects.toThrow('unowned file')
      expect(await readFile(config.generatedRegistry, 'utf8')).toBe('// user work\n')
    })
  })
  test('scaffolds only empty command sources when requested', async () => {
    await project(async (root, config) => {
      const directory = resolve(root, 'src/commands')
      await mkdir(resolve(directory, 'tasks/$id'), { recursive: true })
      const file = resolve(directory, 'tasks/$id/run.ts')
      await writeFile(file, ' \n\t')
      const authored = '// Work in progress\n'
      await writeFile(resolve(directory, 'keep.ts'), authored)
      await writeFile(resolve(directory, '-helper.ts'), '')
      await generate(config)
      expect(await readFile(file, 'utf8')).toBe(' \n\t')
      await generate(config, { scaffold: true })
      const content = await readFile(file, 'utf8')
      expect(content).toContain('export const Command = defineCommand({')
      expect(content).toContain('id: positional(string())')
      expect(await readFile(resolve(directory, 'keep.ts'), 'utf8')).toBe(authored)
      expect(await readFile(resolve(directory, '-helper.ts'), 'utf8')).toBe('')
      const before = (await stat(file)).mtimeMs
      await generate(config, { scaffold: true })
      expect((await stat(file)).mtimeMs).toBe(before)
    })
  })
  test('scaffolds pathless commands with positional definitions and refuses overwrites', async () => {
    await project(async (root, config) => {
      const file = await addCommand(config, '/tasks/$id/run')
      const content = await readFile(file, 'utf8')
      expect(content).toContain('defineCommand({')
      expect(content).toContain('id: positional(string())')
      expect(content).not.toContain("'/tasks/$id/run'")
      await expect(addCommand(config, '/tasks/$id/run')).rejects.toThrow('already exists')
      expect(await readFile(file, 'utf8')).toBe(content)
      await expect(addCommand(config, '/tasks/$other/list')).rejects.toThrow('Ambiguous')
      await expect(addCommand(config, '/../outside')).rejects.toThrow('Invalid command filename')
      await generate(config)
      expect(await readFile(config.generatedRegistry, 'utf8')).toContain('bindCommand("/tasks/$id/run"')
    })
  })
})
