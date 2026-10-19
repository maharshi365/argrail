import { test, expect, spyOn } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { extractHarnesses, syncHarnesses } from './sync-harnesses.ts'

test('default build synchronization uses the recorded commit and writes its harness rules', async () => {
  const directory = await mkdtemp(resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-sync-'))
  const commit = 'a'.repeat(40)
  const source = `const agents = { custom: { displayName: 'Custom', skillsDir: '.custom/skills', globalSkillsDir: undefined } };`
  const urls: string[] = []
  const request = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
    const address = url instanceof Request ? url.url : url.toString()
    urls.push(address)
    return new Response(address.startsWith('https://api.github.com/') ? JSON.stringify({ sha: commit }) : source)
  }, { preconnect: globalThis.fetch.preconnect }))
  try {
    await writeFile(resolve(directory, 'registry.gen.json'), JSON.stringify({ source: { commit } }))
    await syncHarnesses([], directory)
    const registry = JSON.parse(await readFile(resolve(directory, 'registry.gen.json'), 'utf8'))
    expect(urls).toEqual([
      `https://api.github.com/repos/vercel-labs/skills/commits/${commit}`,
      `https://raw.githubusercontent.com/vercel-labs/skills/${commit}/src/agents.ts`,
    ])
    expect(registry.source.commit).toBe(commit)
    expect(registry.source.sha256).toBe(createHash('sha256').update(source).digest('hex'))
    expect(registry.harnesses).toEqual([{ id: 'custom', label: 'Custom', project: { kind: 'literal', value: '.custom/skills' }, global: null }])
    const existing = await readFile(resolve(directory, 'registry.gen.json'), 'utf8')
    request.mockImplementation(Object.assign(async (url: RequestInfo | URL) => new Response((url instanceof Request ? url.url : url.toString()).startsWith('https://api.github.com/') ? JSON.stringify({ sha: commit }) : source.replace('undefined', 'unsupported()')), { preconnect: globalThis.fetch.preconnect }))
    await expect(syncHarnesses([], directory)).rejects.toThrow('Unsupported path expression')
    expect(await readFile(resolve(directory, 'registry.gen.json'), 'utf8')).toBe(existing)
    request.mockRejectedValue(new Error('Network unavailable'))
    await expect(syncHarnesses([], directory)).rejects.toThrow('Network unavailable')
    expect(await readFile(resolve(directory, 'registry.gen.json'), 'utf8')).toBe(existing)
  } finally {
    request.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

test('extracts portable home, environment, and unsupported-global rules', () => {
  const source = `const home = homedir();
const customHome = process.env.CUSTOM_HOME?.trim() || join(home, '.custom');
const configHome = xdgConfig ?? join(home, '.config');
export const agents = {
  custom: { displayName: 'Custom', skillsDir: '.custom/skills', globalSkillsDir: join(customHome, 'skills') },
  local: { displayName: 'Local', skillsDir: 'agent/skills', globalSkillsDir: undefined },
  config: { displayName: 'Config', skillsDir: '.agents/skills', globalSkillsDir: join(configHome, 'agent/skills') }
};`
  const result = extractHarnesses(source)
  expect(result.map(harness => harness.id)).toEqual(['config', 'custom', 'local'])
  const global = result[1]!.global
  if (global?.kind !== 'join') throw new Error('Expected a joined global path')
  expect(global.parts[0]).toEqual({
    kind: 'environment',
    name: 'CUSTOM_HOME',
    fallback: { kind: 'join', parts: [{ kind: 'home' }, { kind: 'literal', value: '.custom' }] },
  })
  expect(result[2]?.global).toBeNull()
})

test('unknown expressions and alias cycles fail with a source location', () => {
  expect(() =>
    extractHarnesses(
      `const agents = { unknown: { displayName: 'Unknown', skillsDir: '.unknown/skills', globalSkillsDir: arbitraryCode() } };`,
    ),
  ).toThrow('agents.ts:1:')
  expect(() =>
    extractHarnesses(
      `const first = second; const second = first; const agents = { unknown: { displayName: 'Unknown', skillsDir: '.unknown/skills', globalSkillsDir: first } };`,
    ),
  ).toThrow('Unsupported path expression')
})

test('reviewed helper extraction preserves legacy-directory priority and rejects changed defaults', () => {
  const helper = `function getOpenClawGlobalSkillsDir(homeDir = home, pathExists = existsSync) {
    if (pathExists(join(homeDir, '.current'))) { return join(homeDir, '.current/skills'); }
    if (pathExists(join(homeDir, '.legacy'))) { return join(homeDir, '.legacy/skills'); }
    return join(homeDir, '.current/skills');
  }`
  const registry = `const agents = { openclaw: { displayName: 'OpenClaw', skillsDir: 'skills', globalSkillsDir: getOpenClawGlobalSkillsDir() } };`
  const result = extractHarnesses(helper + registry)[0]!.global
  if (result?.kind !== 'firstExisting') throw new Error('Expected legacy-directory fallback paths')
  expect(result.paths.map(rule => rule.exists)).toEqual([
    { kind: 'join', parts: [{ kind: 'home' }, { kind: 'literal', value: '.current' }] },
    { kind: 'join', parts: [{ kind: 'home' }, { kind: 'literal', value: '.legacy' }] },
  ])
  expect(() =>
    extractHarnesses(helper.replace('homeDir = home', 'homeDir = anotherHome') + registry),
  ).toThrow('Unsupported path expression')
})
