import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveTargets } from './resolve.mjs'

test('resolves runtime environment overrides and deduplicates shared roots', () => {
  const home = resolve('fake-home'),
    project = resolve('fake-project')
  const shared = resolveTargets(
    { scope: 'project', project, harnesses: ['codex', 'cursor'] },
    { home, environment: {} },
  )
  expect(shared).toHaveLength(1)
  expect(shared[0].root).toBe(resolve(project, '.agents/skills'))
  expect(shared[0].harnesses).toEqual(['codex', 'cursor'])
  expect(shared[0].shared).toContain('opencode')
  expect(
    resolveTargets(
      { scope: 'global', harnesses: ['opencode'] },
      { home, environment: { XDG_CONFIG_HOME: resolve('custom-config') } },
    )[0].root,
  ).toBe(resolve('custom-config/opencode/skills'))
  expect(
    resolveTargets(
      { scope: 'global', harnesses: ['claude-code'] },
      { home, environment: { CLAUDE_CONFIG_DIR: resolve('custom-claude') } },
    )[0].root,
  ).toBe(resolve('custom-claude/skills'))
  expect(() =>
    resolveTargets({ scope: 'global', harnesses: ['eve'] }, { home, environment: {} }),
  ).toThrow('not supported')
  expect(() => resolveTargets({ path: 'skills', harnesses: ['codex'] })).toThrow('conflicts')
})

test('deduplicates harness directories reached through a symlink or Windows junction', async () => {
  const root = await mkdtemp(
    resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-target-'),
  )
  try {
    await mkdir(resolve(root, '.agents/skills'), { recursive: true })
    await mkdir(resolve(root, '.claude'))
    await symlink(
      resolve(root, '.agents/skills'),
      resolve(root, '.claude/skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const targets = resolveTargets(
      { project: root, harnesses: ['claude-code', 'codex'] },
      { home: root, environment: {} },
    )
    expect(targets).toHaveLength(1)
    expect(targets[0].harnesses).toEqual(['claude-code', 'codex'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
