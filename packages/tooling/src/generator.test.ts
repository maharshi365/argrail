import { describe, test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { commandPath, discover, generate, loadConfig, addCommand, skillsSnapshot } from './generator.ts'

async function project(run) {
  const root = await mkdtemp(resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-test-'))
  try {
    await mkdir(resolve(root, 'src/commands'), { recursive: true })
    await writeFile(resolve(root, 'argrail.config.json'), JSON.stringify({ name: 'app' }))
    return await run(root, await loadConfig(root))
  } finally { await rm(root, { recursive: true, force: true }) }
}

describe('file-based generation', () => {
  test('generates one public skill registry with a lazy embedded payload and tracks resource changes', async () => {
    await project(async root => {
      await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: '@test/app' }))
      await writeFile(resolve(root, 'src/commands/skills.ts'), 'export const Command = {}; throw new Error("route discovery must not execute modules")')
      await mkdir(resolve(root, 'skills/test-skill/assets'), { recursive: true })
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
      await writeFile(resolve(root, 'skills/test-skill/assets/data.bin'), new Uint8Array([0, 255]))
      await writeFile(resolve(root, 'src/commands/run.ts'), '')
      const config = await loadConfig(root)
      const first = await generate(config)
      const registry = await readFile(config.generatedRegistry, 'utf8')
      expect(registry).toContain('export const skillTree')
      expect(registry).toContain('createSkillsCommands(skillTree')
      expect(registry).toContain('await import(')
      const payload = await readFile(resolve(root, '.argrail/skills.bundle.ts'), 'utf8')
      expect(payload).toContain('assets/data.bin')
      expect((await generate(config)).changed).toBe(false)
      await writeFile(resolve(root, 'skills/test-skill/assets/data.bin'), new Uint8Array([0, 254]))
      expect((await generate(config)).changed).toBe(true)
      expect(await readFile(config.generatedRegistry, 'utf8')).not.toBe(registry)
      expect(registry).toContain('"@test/app"')
      expect(first.count).toBe(10)
    })
  })
  test('rejects skill command collisions before changing generated output', async () => {
    await project(async root => {
      await writeFile(resolve(root, 'src/commands/skills.ts'), '')
      await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
      await mkdir(resolve(root, 'src/commands/skills'))
      await writeFile(resolve(root, 'src/commands/skills/add.ts'), '')
      await expect(generate(await loadConfig(root))).rejects.toThrow('skills command mount')
    })
  })
  test('skills resources alone do not expose commands; adding and removing the route controls bundling', async () => {
    await project(async (root, config) => {
      await writeFile(resolve(root, 'src/commands/run.ts'), '')
      await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), 'invalid until the route opts in')
      expect((await generate(config)).count).toBe(1)
      expect(await readFile(config.generatedRegistry, 'utf8')).not.toContain('skillTree')
      expect(await skillsSnapshot(config)).toBe('')
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
      await writeFile(resolve(root, 'src/commands/skills.ts'), '')
      expect((await generate(config)).count).toBe(10)
      expect(await readFile(config.generatedRegistry, 'utf8')).toContain('id: "app"')
      await rm(resolve(root, 'src/commands/skills.ts'))
      expect((await generate(config)).count).toBe(1)
      expect(await readFile(config.generatedRegistry, 'utf8')).not.toContain('createSkillsCommands')
    })
  })
  test('index and pathless skill routes retain their structural middleware ancestry', async () => {
    await project(async (root, config) => {
      await mkdir(resolve(root, 'src/commands/_protected/skills'), { recursive: true })
      for (const file of ['__root.ts', '_protected/__group.ts', '_protected/skills/index.ts']) await writeFile(resolve(root, 'src/commands', file), '')
      await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
      expect((await generate(config)).count).toBe(9)
      expect(await readFile(config.generatedRegistry, 'utf8')).toContain('createSkillsCommands(skillTree, "skills", [group0, group1, command0])')
    })
  })
  test('route-local groups are read without executing modules and edits change the watched bundle', async () => {
    await project(async (root, config) => {
      const route = resolve(root, 'src/commands/skills.ts')
      const source = `throw new Error('must not execute'); export const Command = {}; export const SkillGroups = { starter: { description: 'Starter', skills: ['test-skill'] } } as const`
      await writeFile(route, source)
      await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
      await generate(config)
      const initial = await skillsSnapshot(config)
      expect(await readFile(config.generatedRegistry, 'utf8')).toContain('"starter":{"description":"Starter","skills":["test-skill"]}')
      await writeFile(route, source.replace("'Starter'", "'Changed'"))
      expect(await skillsSnapshot(config)).not.toBe(initial)
      await writeFile(route, source.replace("['test-skill']", "['unknown']"))
      await expect(generate(config)).rejects.toThrow('unknown skill unknown')
      await writeFile(route, "export const Command = {}; export const SkillGroups = getGroups()")
      await expect(generate(config)).rejects.toThrow('static object literal')
      await writeFile(route, "export const Command = {}; export const SkillGroups = []")
      await expect(generate(config)).rejects.toThrow('static object literal')
    })
  })
  test('bundle identity changes invalidate the watched bundle and invalid package names preserve output', async () => {
    await project(async (root, config) => {
      await writeFile(resolve(root, 'src/commands/skills.ts'), '')
      await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
      await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
      const initial = await skillsSnapshot(config)
      await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: '@test/cli' }))
      expect(await skillsSnapshot(config)).not.toBe(initial)
      await generate(config)
      const registry = await readFile(config.generatedRegistry, 'utf8')
      await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'invalid identity' }))
      await expect(generate(config)).rejects.toThrow('stable package.json name')
      expect(await readFile(config.generatedRegistry, 'utf8')).toBe(registry)
    })
  })
  test('maps nested paths, index files, and dynamic arguments', () => {
    expect(commandPath('index.ts')).toBe('/')
    expect(commandPath('users/index.ts')).toBe('/users')
    expect(commandPath('users/$userId/delete.ts')).toBe('/users/$userId/delete')
    expect(() => commandPath('BadName.ts')).toThrow('Invalid command filename')
  })
  test('generates inherited groups and removes pathless segments from command paths', async () => {
    await project(async (root, config) => {
      const directory = resolve(root, 'src/commands')
      await mkdir(resolve(directory, '_protected/users'), { recursive: true })
      for (const name of ['__root.ts', 'login.ts', '_protected/__group.ts', '_protected/deploy.ts', '_protected/users/__group.ts', '_protected/users/create.ts']) {
        await writeFile(resolve(directory, name), 'throw new Error("discovery must not execute modules")')
      }
      expect(commandPath('_protected/users/create.ts')).toBe('/users/create')
      expect((await generate(config)).count).toBe(3)
      const content = await readFile(config.generatedRegistry, 'utf8')
      expect(content).toContain('bindCommand("/deploy", command0, [group0, group1])')
      expect(content).toContain('bindCommand("/users/create", command1, [group0, group1, group2])')
      expect(content).toContain('bindCommand("/login", command2, [group0])')
      expect(content).toContain('interface FileCommandContexts')
      expect(content).not.toContain('"/_protected/deploy"')
    })
  })
  test('rejects public path collisions across pathless groups', async () => {
    await project(async (root) => {
      const directory = resolve(root, 'src/commands')
      await mkdir(resolve(directory, '_protected'))
      await writeFile(resolve(directory, 'deploy.ts'), '')
      await writeFile(resolve(directory, '_protected/deploy.ts'), '')
      await expect(discover(directory)).rejects.toThrow('Duplicate command path: /deploy')
    })
  })
  test('inherits index middleware through structural ancestors only', async () => {
    await project(async (root, config) => {
      const directory = resolve(root, 'src/commands')
      await mkdir(resolve(directory, '_protected/users'), { recursive: true })
      for (const name of ['login.ts', '_protected/users/index.ts', '_protected/users/create.ts']) await writeFile(resolve(directory, name), '')
      await generate(config)
      const content = await readFile(config.generatedRegistry, 'utf8')
      expect(content).toContain('bindCommand("/users/create", command0, [group0])')
      expect(content).toContain('bindCommand("/users", command1, [])')
      expect(content).toContain('bindCommand("/login", command2, [])')
    })
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
