import { test, expect } from 'bun:test'
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  rename,
  symlink,
  stat,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkills } from './index.ts'
import { hashFiles } from './files.ts'
import { randomUUID } from 'node:crypto'

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
const request = (root, action = 'add', extra = {}) => ({
  action,
  skills: ['test-skill'],
  target: { path: resolve(root, 'skills') },
  ...extra,
})

test('rejects malformed JavaScript bundle inputs', () => {
  for (const input of [
    null,
    {},
    { ...bundle(), skills: null },
    { ...bundle(), groups: null },
    { ...bundle(), skills: { 'test-skill': null } },
    { ...bundle(), skills: { 'test-skill': { ...bundle().skills['test-skill'], load: 'invalid' } } },
  ]) {
    expect(() => createSkills(input)).toThrow(/Invalid skill bundle|Invalid bundled skill/)
  }
})

test('rejects malformed receipts without changing the saved file', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const destination = resolve(root, 'skills')
    await mkdir(destination)
    const file = resolve(destination, '.argrail-skills.json')
    for (const receipt of [
      { version: 1, skills: null },
      { version: 1, skills: { 'test-skill': null } },
      {
        version: 1,
        skills: { 'test-skill': { hash: bundle().hash, files: [], owners: [null] } },
      },
    ]) {
      const text = JSON.stringify(receipt)
      await writeFile(file, text)
      await expect(manager.plan(request(root))).rejects.toThrow(/Invalid receipt|Invalid ownership/)
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  }))

test('installs complete resources, repeats as a no-op, and removes only owned content', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan(request(root))
    expect(plan.items[0].operation).toBe('install')
    expect((await manager.apply(plan)).exitCode).toBe(0)
    expect(await readFile(resolve(root, 'skills/test-skill/scripts/check.sh'), 'utf8')).toBe(
      'echo ok\n',
    )
    expect((await manager.plan(request(root))).items[0].operation).toBe('noop')
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'current',
    )
    expect((await manager.apply(await manager.plan(request(root, 'remove')))).items[0].status).toBe(
      'removed',
    )
    expect(await readdir(resolve(root, 'skills'))).not.toContain('test-skill')
  }))

test('yes is not an engine overwrite policy; replacement backs up unowned and edited files', () =>
  fixture(async root => {
    await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
    await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), 'user work')
    const manager = createSkills(bundle())
    const conflict = await manager.apply(await manager.plan(request(root)))
    expect(conflict.exitCode).toBe(1)
    expect(await readFile(resolve(root, 'skills/test-skill/SKILL.md'), 'utf8')).toBe('user work')
    const installed = await manager.apply(
      await manager.plan(request(root, 'add', { replace: true })),
    )
    expect(installed.exitCode).toBe(0)
    expect(await readFile(resolve(installed.items[0].backup, 'SKILL.md'), 'utf8')).toBe('user work')
    await writeFile(resolve(root, 'skills/test-skill/notes.txt'), 'new local file')
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'modified',
    )
    expect((await manager.apply(await manager.plan(request(root, 'remove')))).exitCode).toBe(1)
    expect(await readFile(resolve(root, 'skills/test-skill/notes.txt'), 'utf8')).toBe(
      'new local file',
    )
  }))

test('updates only owned instances and removes obsolete managed resources', () =>
  fixture(async root => {
    const original = createSkills(bundle())
    await original.apply(await original.plan(request(root)))
    const next = bundle('@test/cli', 'changed')
    const files = (await next.skills['test-skill'].load()).slice(0, 1)
    next.hash = next.skills['test-skill'].hash = hashFiles(files)
    next.skills['test-skill'].load = async () => files
    const manager = createSkills(next)
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'outdated',
    )
    expect((await manager.plan(request(root, 'add'))).items[0].operation).toBe('conflict')
    expect((await manager.apply(await manager.plan(request(root, 'update')))).exitCode).toBe(0)
    expect(await readdir(resolve(root, 'skills/test-skill'))).toEqual(['SKILL.md'])
    const absent = await manager.apply(
      await manager.plan(request(resolve(root, 'absent'), 'update')),
    )
    expect(absent.exitCode).toBe(1)
    expect(absent.items[0].status).toBe('missing')
  }))

test("identical bundles share ownership; replacement cannot change another owner's content", () =>
  fixture(async root => {
    const first = createSkills(bundle('@test/one'))
    const second = createSkills(bundle('@test/two'))
    await first.apply(await first.plan(request(root)))
    expect((await second.apply(await second.plan(request(root)))).exitCode).toBe(0)
    const changed = createSkills(bundle('@test/two', 'changed'))
    expect(
      (await changed.apply(await changed.plan(request(root, 'update', { replace: true }))))
        .exitCode,
    ).toBe(1)
    await first.apply(await first.plan(request(root, 'remove')))
    expect((await second.status({ path: resolve(root, 'skills') })).items[0].status).toBe('current')
    await second.apply(await second.plan(request(root, 'remove')))
    expect(await readdir(resolve(root, 'skills'))).not.toContain('test-skill')
  }))

test('revalidates approved plans and refuses stale plans without touching files', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan(request(root))
    await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
    await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), 'concurrent user work')
    await expect(manager.apply(plan)).rejects.toThrow('changed')
    expect(await readFile(resolve(root, 'skills/test-skill/SKILL.md'), 'utf8')).toBe(
      'concurrent user work',
    )
  }))

test('unsafe payloads are rejected before installation', () =>
  fixture(async root => {
    const data = bundle()
    const files = [{ path: '../escape', data: 'eA==', executable: false }]
    data.skills['test-skill'].hash = hashFiles(files)
    data.skills['test-skill'].load = async () => files
    const manager = createSkills(data)
    await expect(manager.apply(await manager.plan(request(root)))).rejects.toThrow('Unsafe')
    expect(await readdir(root)).not.toContain('escape')
  }))

test('abort leaves destinations unchanged and unknown receipt versions are not discarded', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan(request(root))
    const controller = new AbortController()
    controller.abort()
    await expect(manager.apply(plan, { signal: controller.signal })).rejects.toThrow('Cancelled')
    expect(await readdir(root)).toEqual([])
    await mkdir(resolve(root, 'skills'))
    const receipt = '{"version":99,"skills":{}}\n'
    await writeFile(resolve(root, 'skills/.argrail-skills.json'), receipt)
    await expect(manager.plan(request(root))).rejects.toThrow('receipt version')
    expect(await readFile(resolve(root, 'skills/.argrail-skills.json'), 'utf8')).toBe(receipt)
  }))

test('save and restore use portable concrete selections and reject a mismatched bundle', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const target = { scope: 'project', project: root, harnesses: ['claude-code'] }
    const plan = await manager.plan({ action: 'add', skills: ['test-skill'], target })
    const result = await manager.apply(plan)
    await manager.save(plan, result)
    const manifest = await readFile(resolve(root, 'argrail.skills.json'), 'utf8')
    expect(manifest).not.toContain(root.replaceAll('\\', '\\\\'))
    expect(JSON.parse(manifest).bundles['@test/cli'].targets[0].skills).toEqual(['test-skill'])
    const restored = await manager.restore(root)
    expect((await manager.apply(restored)).exitCode).toBe(0)
    await expect(createSkills(bundle('@test/cli', 'changed')).restore(root)).rejects.toThrow(
      'bundle',
    )
  }))

test('saved selections retain per-target intent and restore into a different checkout', () =>
  fixture(async root => {
    const data = bundle()
    const second = bundle('unused', 'second').skills['test-skill']
    const files = (await second.load()).map(file =>
      file.path === 'SKILL.md'
        ? {
            ...file,
            data: Buffer.from('---\nname: other-skill\ndescription: Other\n---\n').toString(
              'base64',
            ),
          }
        : file,
    )
    data.skills['other-skill'] = {
      ...second,
      name: 'other-skill',
      hash: hashFiles(files),
      load: async () => files,
    }
    const manager = createSkills(data)
    const source = resolve(root, 'source'),
      checkout = resolve(root, 'checkout')
    await mkdir(checkout)
    for (const [name, harness] of [
      ['test-skill', 'claude-code'],
      ['other-skill', 'codex'],
    ]) {
      const plan = await manager.plan({
        action: 'add',
        skills: [name],
        target: { scope: 'project', project: source, harnesses: [harness] },
      })
      await manager.save(plan, await manager.apply(plan))
    }
    await writeFile(
      resolve(checkout, 'argrail.skills.json'),
      await readFile(resolve(source, 'argrail.skills.json')),
    )
    const restored = await manager.restore(checkout)
    expect(restored.items.map(item => [item.name, item.harnesses])).toEqual([
      ['test-skill', ['claude-code']],
      ['other-skill', ['codex']],
    ])
    expect((await manager.apply(restored)).exitCode).toBe(0)
    expect(await readdir(resolve(checkout, '.claude/skills'))).toContain('test-skill')
    expect(await readdir(resolve(checkout, '.claude/skills'))).not.toContain('other-skill')
    expect(await readdir(resolve(checkout, '.agents/skills'))).not.toContain('test-skill')
  }))

test('interrupted writes roll back old content and receipts without losing local work', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await manager.apply(await manager.plan(request(root)))
    const destination = resolve(root, 'skills'),
      id = randomUUID()
    const before = JSON.parse(await readFile(resolve(destination, '.argrail-skills.json'), 'utf8'))
    const replacement = [
      {
        path: 'SKILL.md',
        data: Buffer.from('partially applied replacement').toString('base64'),
        executable: false,
      },
    ]
    const journal = {
      version: 1,
      id,
      before,
      entries: [
        {
          name: 'test-skill',
          hadOld: true,
          install: true,
          backup: false,
          hash: hashFiles(replacement),
          files: replacement.map(file => ({ path: file.path, executable: file.executable })),
        },
      ],
    }
    const work = resolve(destination, '.argrail-skills-work', id)
    await mkdir(resolve(work, 'old'), { recursive: true })
    await mkdir(resolve(work, 'stage'))
    await writeFile(resolve(work, 'journal.json'), JSON.stringify(journal))
    await rename(resolve(destination, 'test-skill'), resolve(work, 'old/test-skill'))
    await mkdir(resolve(destination, 'test-skill'))
    await writeFile(resolve(destination, 'test-skill/SKILL.md'), 'partially applied replacement')
    await writeFile(resolve(destination, '.argrail-skills.json'), '{"version":1,"skills":{}}')
    await writeFile(resolve(destination, '.argrail-skills-journal.json'), JSON.stringify(journal))
    await expect(manager.plan(request(root))).rejects.toThrow('Interrupted')
    expect((await manager.recover({ path: destination })).items[0].recovered).toBe(true)
    expect((await manager.status({ path: destination })).items[0].status).toBe('current')
    expect(
      JSON.parse(await readFile(resolve(destination, '.argrail-skills.json'), 'utf8')),
    ).toEqual(before)
  }))

test('refuses recovery without its staging directory rather than deleting a destination', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await manager.apply(await manager.plan(request(root)))
    const files = await bundle().skills['test-skill'].load()
    await writeFile(
      resolve(root, 'skills/.argrail-skills-journal.json'),
      JSON.stringify({
        version: 1,
        id: randomUUID(),
        before: { version: 1, skills: {} },
        entries: [
          {
            name: 'test-skill',
            hadOld: false,
            install: true,
            backup: false,
            hash: hashFiles(files),
            files: files.map(file => ({ path: file.path, executable: file.executable })),
          },
        ],
      }),
    )
    await expect(manager.recover({ path: resolve(root, 'skills') })).rejects.toThrow('recovery')
    expect(await readFile(resolve(root, 'skills/test-skill/scripts/check.sh'), 'utf8')).toBe(
      'echo ok\n',
    )
  }))

test('recovery protects files edited after an interruption', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await manager.apply(await manager.plan(request(root)))
    const destination = resolve(root, 'skills'),
      id = randomUUID()
    const before = JSON.parse(await readFile(resolve(destination, '.argrail-skills.json'), 'utf8'))
    const files = await bundle().skills['test-skill'].load()
    const journal = {
      version: 1,
      id,
      before,
      entries: [
        {
          name: 'test-skill',
          hadOld: true,
          install: true,
          backup: false,
          hash: hashFiles(files),
          files: files.map(file => ({ path: file.path, executable: file.executable })),
        },
      ],
    }
    const work = resolve(destination, '.argrail-skills-work', id)
    await mkdir(resolve(work, 'old'), { recursive: true })
    await mkdir(resolve(work, 'stage'))
    await writeFile(resolve(work, 'journal.json'), JSON.stringify(journal))
    await rename(resolve(destination, 'test-skill'), resolve(work, 'old/test-skill'))
    await mkdir(resolve(destination, 'test-skill'))
    await writeFile(resolve(destination, 'test-skill/SKILL.md'), 'user edit after crash')
    await writeFile(resolve(destination, '.argrail-skills-journal.json'), JSON.stringify(journal))
    await expect(manager.recover({ path: destination })).rejects.toThrow('changed')
    expect(await readFile(resolve(destination, 'test-skill/SKILL.md'), 'utf8')).toBe(
      'user edit after crash',
    )
    expect(await readFile(resolve(work, 'old/test-skill/scripts/check.sh'), 'utf8')).toBe(
      'echo ok\n',
    )
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
    expect(await readdir(root)).not.toContain('escape')
  }))

test('missing updates, absent removals, status, and recovery do not create harness directories', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    expect((await manager.apply(await manager.plan(request(root, 'update')))).exitCode).toBe(1)
    expect((await manager.apply(await manager.plan(request(root, 'remove')))).exitCode).toBe(0)
    expect((await manager.status({ path: resolve(root, 'skills') })).items[0].status).toBe(
      'missing',
    )
    expect((await manager.recover({ path: resolve(root, 'skills') })).items[0].recovered).toBe(
      false,
    )
    expect(await readdir(root)).toEqual([])
  }))

test('resource links are refused and an install plan cannot be edited into a removal', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const plan = await manager.plan(request(root))
    plan.items[0].operation = 'remove'
    await expect(manager.apply(plan)).rejects.toThrow('changed')
    await mkdir(resolve(root, 'original'), { recursive: true })
    await writeFile(resolve(root, 'original/note.txt'), 'outside work')
    await mkdir(resolve(root, 'skills/test-skill'), { recursive: true })
    await symlink(
      resolve(root, 'original'),
      resolve(root, 'skills/test-skill/assets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const result = await manager.apply(await manager.plan(request(root, 'add', { replace: true })))
    expect(result.exitCode).toBe(1)
    expect(await readFile(resolve(root, 'original/note.txt'), 'utf8')).toBe('outside work')
  }))

test('repeating an identical installation leaves resource and receipt timestamps unchanged', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await manager.apply(await manager.plan(request(root)))
    const path = resolve(root, 'skills/test-skill/SKILL.md'),
      receipt = resolve(root, 'skills/.argrail-skills.json')
    const before = [(await stat(path)).mtimeMs, (await stat(receipt)).mtimeMs]
    await manager.apply(await manager.plan(request(root)))
    expect([(await stat(path)).mtimeMs, (await stat(receipt)).mtimeMs]).toEqual(before)
  }))

test('removing one recorded harness claim preserves another claim on the same root', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    const both = { project: root, harnesses: ['codex', 'cursor'] }
    await manager.apply(await manager.plan({ action: 'add', all: true, target: both }))
    const removed = await manager.apply(
      await manager.plan({
        action: 'remove',
        all: true,
        target: { project: root, harnesses: ['codex'] },
      }),
    )
    expect(removed.items[0].status).toBe('released')
    expect(removed.items[0].reason).toContain('cursor')
    const receipt = JSON.parse(
      await readFile(resolve(root, '.agents/skills/.argrail-skills.json'), 'utf8'),
    )
    expect(receipt.skills['test-skill'].owners[0].harnesses).toEqual(['cursor'])
    expect((await manager.status({ project: root, harnesses: ['cursor'] })).items[0].status).toBe(
      'current',
    )
    await manager.apply(
      await manager.plan({
        action: 'remove',
        all: true,
        target: { project: root, harnesses: ['cursor'] },
      }),
    )
    expect(await readdir(resolve(root, '.agents/skills'))).not.toContain('test-skill')
  }))

test('a blocked write reports every destination and preserves unrelated state files', () =>
  fixture(async root => {
    const manager = createSkills(bundle())
    await mkdir(resolve(root, '.claude/skills'), { recursive: true })
    await writeFile(resolve(root, '.claude/skills/.argrail-skills-work'), 'user-owned file')
    const plan = await manager.plan({
      action: 'add',
      skills: ['test-skill'],
      target: { project: root, harnesses: ['claude-code', 'kiro-cli'] },
    })
    const result = await manager.apply(plan)
    expect(result.exitCode).toBe(1)
    expect(result.items.map(item => [item.harnesses, item.status])).toEqual([
      [['claude-code'], 'failed'],
      [['kiro-cli'], 'installed'],
    ])
    expect(await readFile(resolve(root, '.claude/skills/.argrail-skills-work'), 'utf8')).toBe(
      'user-owned file',
    )
    expect(await readFile(resolve(root, '.kiro/skills/test-skill/SKILL.md'), 'utf8')).toContain(
      'original',
    )
  }))
