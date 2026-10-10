import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createCLI } from '@argrail/core'
import { createSkillsCommands } from './commands.ts'
import { hashFiles } from './files.ts'

async function fixture(run) {
  const root = await mkdtemp(
    resolve(
      process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(),
      'argrail-skill-command-',
    ),
  )
  let loads = 0
  const files = [
    {
      path: 'SKILL.md',
      data: Buffer.from('---\nname: test-skill\ndescription: Example\n---\n').toString('base64'),
      executable: false,
    },
  ]
  const bundle = {
    id: '@test/cli',
    hash: hashFiles(files),
    skills: {
      'test-skill': {
        name: 'test-skill',
        description: 'Example',
        hash: hashFiles(files),
        load: async () => {
          loads++
          return files
        },
      },
    },
    groups: { starter: { description: 'Start here', skills: ['test-skill'] } },
  }
  const cli = createCLI(createSkillsCommands(bundle), { name: 'app' })
  try {
    await run({ root, cli, loads: () => loads })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('help, listing, dry runs, and missing noninteractive selections never load files or install', () =>
  fixture(async ({ root, cli, loads }) => {
    expect((await cli.test({ argv: ['help', 'skills', 'add'] })).stdout).toContain('--group')
    const listing = await cli.test({ argv: ['skills', 'list', '--json'] })
    expect(JSON.parse(listing.stdout).groups.starter.skills).toEqual(['test-skill'])
    const preview = await cli.test({
      argv: ['skills', 'add', '--all', '--path', resolve(root, 'skills'), '--dry-run', '--json'],
    })
    expect(preview.exitCode).toBe(0)
    expect(JSON.parse(preview.stdout).items[0].operation).toBe('install')
    const missing = await cli.test({ argv: ['skills', 'add', '--json'], answers: [['test-skill']] })
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stdout).error.code).toBe('INTERACTION_REQUIRED')
    expect(loads()).toBe(0)
    expect(await readdir(root)).toEqual([])
  }))

test('yes never replaces local work; explicit replacement reports its backup', () =>
  fixture(async ({ root, cli }) => {
    const target = resolve(root, 'skills')
    await mkdir(resolve(target, 'test-skill'), { recursive: true })
    await writeFile(resolve(target, 'test-skill/SKILL.md'), 'local work')
    const args = ['skills', 'add', '--all', '--path', target, '--yes', '--json']
    const blocked = await cli.test({ argv: args })
    expect(blocked.exitCode).toBe(1)
    expect(JSON.parse(blocked.stdout).items[0].status).toBe('blocked')
    expect(await readFile(resolve(target, 'test-skill/SKILL.md'), 'utf8')).toBe('local work')
    const replaced = await cli.test({ argv: [...args, '--replace'] })
    expect(replaced.exitCode).toBe(0)
    const backup = JSON.parse(replaced.stdout).items[0].backup
    expect(await readFile(resolve(backup, 'SKILL.md'), 'utf8')).toBe('local work')
  }))

test('guided skill selection shows destination-specific status and refusal writes nothing', () =>
  fixture(async ({ root, cli }) => {
    const target = resolve(root, 'skills')
    const installed = await cli.test({
      argv: ['skills', 'add', '--all', '--path', target, '--yes'],
    })
    expect(installed.exitCode).toBe(0)
    const answers = ['2', 'n']
    const cancelled = await cli.execute(['skills', 'add', '--path', target], {
      io: {
        interactive: true,
        stdout: { write() {} },
        stderr: { write() {} },
        stdin: {
          isTTY: true,
          async read() {
            return answers.shift()
          },
        },
      },
    })
    expect(cancelled.value).toEqual({ cancelled: true })
    expect(cancelled.stderr).toContain('current')
    expect(cancelled.stdout).toBe('')
    const refused = await cli.test({
      argv: ['skills', 'delete', '--all', '--path', target],
      answers: [false],
    })
    expect(refused.value).toEqual({ cancelled: true })
    expect(await readFile(resolve(target, 'test-skill/SKILL.md'), 'utf8')).toContain('Example')
  }))

test('complete explicit targets create missing harness directories and shared roots warn', () =>
  fixture(async ({ root, cli }) => {
    const result = await cli.test({
      argv: [
        'skills',
        'add',
        '--group',
        'starter',
        '--project',
        root,
        '--harness',
        'codex',
        '--harness',
        'cursor',
        '--yes',
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('Other compatible harnesses')
    expect(result.value.items).toHaveLength(1)
    expect(result.value.items[0].harnesses).toEqual(['codex', 'cursor'])
    const missing = await cli.test({
      argv: [
        'skills',
        'add',
        '--all',
        '--project',
        root,
        '--harness',
        'kiro-cli',
        '--yes',
        '--json',
      ],
    })
    expect(missing.exitCode).toBe(0)
    expect(await readFile(resolve(root, '.kiro/skills/test-skill/SKILL.md'), 'utf8')).toContain(
      'Example',
    )
  }))

test('a manifest failure still reports successful installations and preserves the manifest', () =>
  fixture(async ({ root, cli }) => {
    await writeFile(resolve(root, 'argrail.skills.json'), 'user-owned invalid state')
    const result = await cli.test({
      argv: [
        'skills',
        'add',
        '--all',
        '--project',
        root,
        '--harness',
        'claude-code',
        '--save',
        '--yes',
        '--json',
      ],
    })
    expect(result.exitCode).toBe(1)
    const output = JSON.parse(result.stdout)
    expect(output.items[0].status).toBe('installed')
    expect(output.manifestError.code).toBe('SKILL_STATE')
    expect(await readFile(resolve(root, 'argrail.skills.json'), 'utf8')).toBe(
      'user-owned invalid state',
    )
    expect(await readFile(resolve(root, '.claude/skills/test-skill/SKILL.md'), 'utf8')).toContain(
      'Example',
    )
  }))
