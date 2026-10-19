import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkills } from './manager.ts'
import { hashFiles } from './files.ts'

test('add and update replace whole directories without generating state files', async () => {
  const root = await mkdtemp(
    resolve(
      process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(),
      'argrail-overwrite-',
    ),
  )
  const files = [
    { path: 'SKILL.md', data: Buffer.from('bundled skill').toString('base64'), executable: false },
  ]
  const manager = createSkills({
    id: '@test/cli',
    hash: hashFiles(files),
    groups: {},
    skills: {
      example: {
        name: 'example',
        description: 'Example',
        hash: hashFiles(files),
        fileCount: files.length,
        bytes: files.reduce((total, file) => total + Buffer.from(file.data, 'base64').length, 0),
        load: async () => files,
      },
    },
  })
  const target = { path: resolve(root, 'skills') }
  try {
    await mkdir(resolve(target.path, 'example'), { recursive: true })
    await writeFile(resolve(target.path, 'example/SKILL.md'), 'local edits')
    await writeFile(resolve(target.path, 'example/obsolete.txt'), 'old resource')
    await mkdir(resolve(target.path, 'unrelated'))
    await writeFile(resolve(target.path, 'unrelated/keep.txt'), 'keep')
    for (const action of ['add', 'update'] as const) {
      const result = await manager.apply(await manager.plan({ action, all: true, target }))
      expect(result.exitCode).toBe(0)
      expect(await readFile(resolve(target.path, 'example/SKILL.md'), 'utf8')).toBe('bundled skill')
      expect(await readdir(resolve(target.path, 'example'))).toEqual(['SKILL.md'])
      expect((await readdir(target.path)).sort()).toEqual(['example', 'unrelated'])
      expect(await readFile(resolve(target.path, 'unrelated/keep.txt'), 'utf8')).toBe('keep')
      await writeFile(resolve(target.path, 'example/SKILL.md'), 'more local edits')
      await writeFile(resolve(target.path, 'example/obsolete.txt'), 'extra file')
    }
    const removed = await manager.apply(await manager.plan({ action: 'remove', all: true, target }))
    expect(removed.items[0]!.status).toBe('removed')
    expect(await readdir(target.path)).toEqual(['unrelated'])
    expect(await readdir(root)).toEqual(['skills'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
