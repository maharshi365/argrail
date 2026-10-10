import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSkills } from './bundle.ts'

async function fixture(run) {
  const root = await mkdtemp(
    resolve(
      process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(),
      'argrail-skill-build-',
    ),
  )
  try {
    await mkdir(resolve(root, 'skills/test-skill/references'), { recursive: true })
    await writeFile(
      resolve(root, 'skills/test-skill/SKILL.md'),
      '---\nname: test-skill\ndescription: Test skills\nmetadata:\n  version: "1"\n---\nBody\n',
    )
    await writeFile(
      resolve(root, 'skills/test-skill/references/example.bin'),
      new Uint8Array([0, 255, 1]),
    )
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('discovers only explicit skill children and bundles binary resources deterministically', () =>
  fixture(async root => {
    await writeFile(resolve(root, 'skills/test-skill/references/SKILL.md'), 'not a separate skill')
    const config = {
      id: '@test/cli',
      directory: resolve(root, 'skills'),
      command: 'skills',
      groups: {},
    }
    const first = await discoverSkills(config)
    expect(Object.keys(first.skills)).toEqual(['test-skill'])
    expect(first.files['test-skill'].map(file => file.path)).toContain('references/SKILL.md')
    expect(
      Buffer.from(
        first.files['test-skill'].find(file => file.path.endsWith('.bin')).data,
        'base64',
      ),
    ).toEqual(Buffer.from([0, 255, 1]))
    expect((await discoverSkills(config)).hash).toBe(first.hash)
  }))

test.each([
  ['name: Other\ndescription: Test', 'name'],
  ['name: test-skill\ndescription: ""', 'description'],
  ['name: wrong\ndescription: Test', 'directory'],
  ['name: test-skill\ndescription: Test\nmetadata:\n  version: 1', 'metadata'],
])('reports invalid frontmatter fields: %s', (frontmatter, field) =>
  fixture(async root => {
    await writeFile(resolve(root, 'skills/test-skill/SKILL.md'), `---\n${frontmatter}\n---\n`)
    await expect(
      discoverSkills({ directory: resolve(root, 'skills'), id: 'test', groups: {} }),
    ).rejects.toThrow(field)
  }),
)

test('rejects unknown group members and accidental dependency trees', () =>
  fixture(async root => {
    await expect(
      discoverSkills({
        directory: resolve(root, 'skills'),
        id: 'test',
        groups: { bad: { skills: ['unknown'], description: 'Bad' } },
      }),
    ).rejects.toThrow('unknown')
    await mkdir(resolve(root, 'skills/test-skill/node_modules'))
    await expect(
      discoverSkills({ directory: resolve(root, 'skills'), id: 'test', groups: {} }),
    ).rejects.toThrow('node_modules')
  }))
