import { test, expect } from 'bun:test'
import { bindCommand, createCLI, createFileCommand, defineCommand, flag, integer, option, positional, string } from '../packages/core/src/index.ts'

test('option values cannot become child route parameters', async () => {
  const parent = createFileCommand('/run')({ options: { label: option(string(), { short: 'l' }) }, run: ({ options }) => options.label })
  const child = createFileCommand('/run/$id')({ params: { id: positional(string()) }, run: () => { throw new Error('wrong handler') } })
  const cli = createCLI({ [parent.path]: parent, [child.path]: child }, { name: 'app' })
  for (const argv of [['run', '--label', 'bob'], ['--label', 'bob', 'run'], ['run', '-l', 'bob'], ['run', '--label=bob']]) {
    const result = await cli.test({ argv })
    expect(result.exitCode).toBe(0)
    expect(result.value).toBe('bob')
  }
  const invalid = await cli.test({ argv: ['run', 'record', '--label', 'bob'] })
  expect(invalid.exitCode).toBe(2)
  expect(invalid.stderr).toContain('Unknown option')
})

test('overlapping commands reject conflicting option arity, including short aliases', () => {
  const parent = createFileCommand('/run')({ options: { label: option(string(), { short: 'l' }) }, run: () => {} })
  for (const options of [{ label: flag() }, { loud: flag({ short: 'l' }) }]) {
    const child = createFileCommand('/run/$id')({ params: { id: positional(string()) }, options, run: () => {} })
    expect(() => createCLI({ [parent.path]: parent, [child.path]: child }, { name: 'app' })).toThrow('conflicting option arity')
  }
})

test('disjoint commands can reuse aliases with different arity', async () => {
  const file = createFileCommand('/file')({ options: { file: option(string(), { short: 'f' }) }, run: ({ options }) => options.file })
  const force = createFileCommand('/force')({ options: { force: flag({ short: 'f' }) }, run: ({ options }) => options.force })
  const root = createFileCommand('/')({ description: 'Commands' })
  const cli = createCLI({ [root.path]: root, [file.path]: file, [force.path]: force }, { name: 'app' })
  expect((await cli.test({ argv: ['-f', 'name', 'file'] })).value).toBe('name')
  expect((await cli.test({ argv: ['force', '-f'] })).value).toBe(true)
})

test('executable ancestors do not forbid conflicting aliases in disjoint children', async () => {
  const root = createFileCommand('/')({ run: () => 'root' })
  const parent = createFileCommand('/users')({ run: () => 'parent' })
  const file = createFileCommand('/users/file')({ options: { file: option(string(), { short: 'f' }) }, run: ({ options }) => options.file })
  const force = createFileCommand('/users/force')({ options: { force: flag({ short: 'f' }) }, run: ({ options }) => options.force })
  const cli = createCLI({ [root.path]: root, [parent.path]: parent, [file.path]: file, [force.path]: force }, { name: 'app' })
  expect((await cli.test({ argv: ['users', 'file', '-f', 'name'] })).value).toBe('name')
  expect((await cli.test({ argv: ['users', 'force', '-f'] })).value).toBe(true)
  expect((await cli.test({ argv: ['users'] })).value).toBe('parent')
})

test('help resolves concrete dynamic values and never validates them or initializes services', async () => {
  let initialized = 0
  const command = createFileCommand('/users/$id/delete')({ params: { id: positional(integer()) }, run: () => { throw new Error('must not execute') } })
  const cli = createCLI({ [command.path]: command }, { name: 'app', context: () => { initialized++; return {} } })
  for (const id of ['42', 'not-an-integer', '$id', '--help']) {
    const result = await cli.test({ argv: ['help', 'users', id, 'delete'] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(cli.help(command.path))
  }
  expect((await cli.test({ argv: ['help', 'users', '42'] })).stdout).toContain('delete')
  expect(initialized).toBe(0)
})

test('omitted options ignore Object.prototype properties', async () => {
  const command = createFileCommand('/build')({ options: { constructor: option(string()), toString: option(string()) }, run: ({ options }) => options })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  const result = await cli.test({ argv: ['build'] })
  expect(result.exitCode).toBe(0)
  expect(result.value).toEqual({ constructor: undefined, toString: undefined })
  expect(await cli.invoke(command.path, {})).toEqual(result.value)
})

test('inherited values do not satisfy required programmatic parameters', async () => {
  const command = createFileCommand('/$id')({ params: { id: positional(string()) }, run: () => { throw new Error('must not execute') } })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  await expect(cli.invoke(command.path, { params: Object.create({ id: 'inherited' }) })).rejects.toThrow('missing argument: id')
  await expect(cli.invoke(command.path, Object.create({ params: { id: 'inherited' } }))).rejects.toThrow('missing argument: id')
})

test('inherited properties cannot hide mismatched parameter definitions', () => {
  expect(() => bindCommand('/$constructor', defineCommand({ params: { id: positional(string()) }, run: () => {} }))).toThrow('positional definitions')
})
