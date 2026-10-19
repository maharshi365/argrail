import { test, expect } from 'bun:test'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, symlink, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkills } from './index.ts'
import { hashFiles } from './files.ts'

function bundle(id = '@test/cli', text = 'original') {
  const files = [
    {
      path: 'SKILL.md',
      data: Buffer.from(`---\nname: test-skill\ndescription: Test\n---\n${text}`).toString(
        'base64',
      ),
      executable: false,
    },
    {
      path: 'scripts/check.sh',
      data: Buffer.from('echo ok\n').toString('base64'),
      executable: true,
    },
  ]
  return {
    id,
    hash: hashFiles(files),
    skills: {
      'test-skill': {
        name: 'test-skill',
        description: 'Test',
        hash: hashFiles(files),
        load: async () => files,
      },
    },
    groups: {},
  }
}
async function fixture(run) {
  const root = await mkdtemp(
    resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-skills-'),
  )
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const request = (root, action = 'add') => ({
  action,
  skills: ['test-skill'],
  target: { path: resolve(root, 'skills') },
})

test('rejects malformed JavaScript bundle inputs', () => {
  for (const input of [
    null,
    {},
    { ...bundle(), skills: null },
    { ...bundle(), groups: null },
    { ...bundle(), skills: { 'test-skill': null } },
    {
      ...bundle(),
      skills: { 'test-skill': { ...bundle().skills['test-skill'], load: 'invalid' } },
    },
  ])
    expect(() => createSkills(input)).toThrow(/Invalid skill bundle|Invalid bundled skill/)
})

test('rejects invalid skill groups at bundle creation', () => {
  for (const group of [
    null,
    {},
    { description: 'Starter', skills: 'test-skill' },
    { description: 'Starter', skills: [] },
    { description: 1, skills: ['test-skill'] },
    { description: 'Starter', skills: [1] },
    { description: 'Starter', skills: ['missing'] },
    { description: 'Starter', skills: ['test-skill', 'test-skill'] },
  ])
    expect(() => createSkills({ ...bundle(), groups: { starter: group } })).toThrow(
      'Invalid bundled skill group: starter',
    )
})

test('selects and deduplicates valid group members', () => {
  const manager = createSkills({
    ...bundle(),
    groups: { starter: { description: 'Starter', skills: ['test-skill'] } },
  })
  expect(manager.select({ groups: ['starter'], skills: ['test-skill'] })).toEqual(['test-skill'])
})

test('rejects malformed loaded files before replacing installed content', () =>
  fixture(async root => {
    await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
    const installed = resolve(root, 'skills/test-skill/SKILL.md')
    await writeFile(installed, 'keep')
    for (const file of [null, undefined, 1, 'text', {}]) {
      const data = bundle()
      data.skills['test-skill'].load = async () => [file]
      const manager = createSkills(data)
      await expect(manager.apply(await manager.plan(request(root)))).rejects.toMatchObject({
        code: 'INVALID_SKILL_FILE',
      })
      expect(await readFile(installed, 'utf8')).toBe('keep')
    }
  }))

test('installs complete resources and preserves executable intent', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    expect((await manager.apply(await manager.plan(request(root)))).exitCode).toBe(0)
    const script = resolve(root, 'skills/test-skill/scripts/check.sh')
    expect(await readFile(script, 'utf8')).toBe('echo ok\n')
    if (process.platform !== 'win32') expect((await stat(script)).mode & 0o111).toBe(0o111)
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'current',
    )
    expect(await readdir(resolve(root, 'skills'))).toEqual(['test-skill'])
  }))

test('another CLI can overwrite and remove the same skill directory without ownership state', () =>
  fixture(async root => {
    const first = createSkills(bundle())
    await first.apply(await first.plan(request(root)))
    const second = createSkills(bundle('@test/other', 'replacement'))
    expect((await second.apply(await second.plan(request(root, 'update')))).exitCode).toBe(0)
    expect(await readFile(resolve(root, 'skills/test-skill/SKILL.md'), 'utf8')).toContain(
      'replacement',
    )
    expect((await first.apply(await first.plan(request(root, 'remove')))).items[0].status).toBe(
      'removed',
    )
    expect(await readdir(resolve(root, 'skills'))).toEqual([])
  }))

test('status compares files directly and does not repair or write state', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await manager.apply(await manager.plan(request(root)))
    await writeFile(resolve(root, 'skills/test-skill/extra.txt'), 'user file')
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'different',
    )
    expect(await readFile(resolve(root, 'skills/test-skill/extra.txt'), 'utf8')).toBe('user file')
    expect(await readdir(resolve(root, 'skills'))).toEqual(['test-skill'])
  }))

test('rejects unknown skills, groups, mixed all selections, and empty selections', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    expect(() => manager.select({ skills: ['missing'] })).toThrow('Unknown skill')
    expect(() => manager.select({ groups: ['missing'] })).toThrow('Unknown skill group')
    expect(() => manager.select({ all: true, skills: ['test-skill'] })).toThrow('--all')
    await expect(
      manager.plan({ action: 'add', target: { path: resolve(root, 'skills') } }),
    ).rejects.toThrow('Select skill')
    expect(await readdir(root)).toEqual([])
  }))

test('unsafe payloads are rejected before replacing existing content', () =>
  fixture(async root => {
    const data = bundle()
    const files = [{ path: '../escape', data: 'eA==', executable: false }]
    data.skills['test-skill'].hash = hashFiles(files)
    data.skills['test-skill'].load = async () => files
    await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
    await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), 'keep')
    const manager = createSkills(data)
    await expect(manager.apply(await manager.plan(request(root)))).rejects.toThrow('Unsafe')
    expect(await readFile(resolve(root, 'skills/test-skill/SKILL.md'), 'utf8')).toBe('keep')
    expect(await readdir(root)).toEqual(['skills'])
  }))

test('content hash mismatch does not replace existing files', () =>
  fixture(async root => {
    const data = bundle()
    data.skills['test-skill'].load = async () => [
      { path: 'SKILL.md', data: 'eA==', executable: false },
    ]
    await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
    await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), 'keep')
    const manager = createSkills(data)
    await expect(manager.apply(await manager.plan(request(root)))).rejects.toThrow(
      'hash does not match',
    )
    expect(await readFile(resolve(root, 'skills/test-skill/SKILL.md'), 'utf8')).toBe('keep')
  }))

test('abort before apply leaves destinations unchanged', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan(request(root))
    const controller = new AbortController()
    controller.abort()
    await expect(manager.apply(plan, { signal: controller.signal })).rejects.toThrow('Cancelled')
    expect(await readdir(root)).toEqual([])
  }))

test('apply snapshots an approved plan before awaiting file loaders', () =>
  fixture(async root => {
    const data = bundle()
    const files = await data.skills['test-skill'].load()
    let release
    data.skills['test-skill'].load = () =>
      new Promise(resolve => {
        release = resolve
      })
    const manager = createSkills(data)
    const plan = await manager.plan(request(root))
    const applying = manager.apply(plan)
    plan.items[0].name = '../../escape'
    release(files)
    const result = await applying
    expect(result.items[0].name).toBe('test-skill')
    expect(await readFile(resolve(root, 'skills/test-skill/scripts/check.sh'), 'utf8')).toBe(
      'echo ok\n',
    )
    expect(await readdir(root)).toEqual(['skills'])
  }))

test('missing updates, absent removals, and status do not create harness directories', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    expect((await manager.apply(await manager.plan(request(root, 'update')))).items[0].status).toBe(
      'missing',
    )
    expect((await manager.apply(await manager.plan(request(root, 'remove')))).items[0].status).toBe(
      'unchanged',
    )
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'missing',
    )
    expect(await readdir(root)).toEqual([])
  }))

test('changed plans and already applied plans cannot be submitted', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const changed = await manager.plan(request(root))
    changed.items[0].operation = 'remove'
    await expect(manager.apply(changed)).rejects.toThrow('changed')
    expect(await readdir(root)).toEqual([])
    const plan = await manager.plan(request(root))
    await manager.apply(plan)
    await expect(manager.apply(plan)).rejects.toThrow('unknown')
  }))

test('skill directory links cannot overwrite or remove files outside the target', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await mkdir(resolve(root, 'outside'))
    await writeFile(resolve(root, 'outside/SKILL.md'), 'keep')
    await mkdir(resolve(root, 'skills'))
    await symlink(
      resolve(root, 'outside'),
      resolve(root, 'skills/test-skill'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    for (const action of ['add', 'remove']) {
      const result = await manager.apply(await manager.plan(request(root, action)))
      expect(result.items[0].status).toBe('blocked')
    }
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe('unsafe')
    expect(await readFile(resolve(root, 'outside/SKILL.md'), 'utf8')).toBe('keep')
  }))

test('a destination changed to a link after planning is refused', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan(request(root))
    await mkdir(resolve(root, 'outside'))
    await symlink(
      resolve(root, 'outside'),
      resolve(root, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(manager.apply(plan)).rejects.toThrow('Destination changed')
    expect(await readdir(resolve(root, 'outside'))).toEqual([])
  }))

test('removing a skill from a shared root removes it for every harness', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await manager.apply(
      await manager.plan({
        action: 'add',
        all: true,
        target: { project: root, harnesses: ['codex', 'cursor'] },
      }),
    )
    const removed = await manager.apply(
      await manager.plan({
        action: 'remove',
        all: true,
        target: { project: root, harnesses: ['codex'] },
      }),
    )
    expect(removed.items[0].status).toBe('removed')
    expect((await manager.status({ project: root, harnesses: ['cursor'] })).items[0].status).toBe(
      'missing',
    )
    expect(await readdir(resolve(root, '.agents/skills'))).toEqual([])
  }))

test('write failures report each destination without blocking other targets', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan({
      action: 'add',
      all: true,
      target: { project: root, harnesses: ['claude-code', 'kiro-cli'] },
    })
    await mkdir(resolve(root, '.claude'))
    await writeFile(resolve(root, '.claude/skills'), 'not a directory')
    const result = await manager.apply(plan)
    expect(result.exitCode).toBe(1)
    expect(result.items.map(item => [item.harnesses, item.status])).toEqual([
      [['claude-code'], 'failed'],
      [['kiro-cli'], 'installed'],
    ])
    expect(await readFile(resolve(root, '.claude/skills'), 'utf8')).toBe('not a directory')
    expect(await readFile(resolve(root, '.kiro/skills/test-skill/SKILL.md'), 'utf8')).toContain(
      'original',
    )
  }))
