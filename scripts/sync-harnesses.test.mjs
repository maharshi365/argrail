import { test, expect } from 'bun:test'
import { extractHarnesses } from './sync-harnesses.mjs'

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
  expect(result[1].global.parts[0]).toEqual({
    kind: 'environment',
    name: 'CUSTOM_HOME',
    fallback: { kind: 'join', parts: [{ kind: 'home' }, { kind: 'literal', value: '.custom' }] },
  })
  expect(result[2].global).toBeNull()
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
  const result = extractHarnesses(helper + registry)[0].global
  expect(result.kind).toBe('firstExisting')
  expect(result.paths.map(rule => rule.exists.parts[1].value)).toEqual(['.current', '.legacy'])
  expect(() =>
    extractHarnesses(helper.replace('homeDir = home', 'homeDir = anotherHome') + registry),
  ).toThrow('Unsupported path expression')
})
