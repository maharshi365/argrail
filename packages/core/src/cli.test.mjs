import { describe, test, expect } from 'bun:test'
import { createFileCommand, createCLI, integer, string, choice, positional, option, flag, value, ValidationError } from './index.ts'

function fixture(settings = {}) {
  const deploy = createFileCommand('/deploy')({
    description: 'Deploy a project.',
    options: {
      environment: option(choice(['dev', 'production']), { default: 'dev', short: 'e' }),
      replicas: option(integer({ min: 1, max: 20 }), { default: 1, short: 'r' }),
      dryRun: flag(),
      label: option(string()),
    },
    run: ({ options }) => options,
  })
  const remove = createFileCommand('/users/$userId/delete')({
    params: { userId: positional(integer({ min: 1 })) },
    options: { force: flag({ short: 'f' }) },
    run: ({ params, options }) => ({ ...params, ...options }),
  })
  const create = createFileCommand('/users/create')({
    options: { name: option(string(), { required: true }) },
    run: ({ options }) => options,
  })
  return createCLI({ '/deploy': deploy, '/users/$userId/delete': remove, '/users/create': create }, {
    name: 'app', version: '1.0.0', description: 'Example CLI.', ...settings,
  })
}

describe('CLI input contract', () => {
  test('decodes file route params and flags', async () => {
    const result = await fixture().execute(['users', '42', 'delete', '-f'])
    expect(result.exitCode).toBe(0)
    expect(result.value).toEqual({ userId: 42, force: true })
  })
  test('applies defaults, optional values, equals syntax, and interspersed options', async () => {
    const cli = fixture()
    expect((await cli.execute(['deploy'])).value).toEqual({ environment: 'dev', replicas: 1, dryRun: false, label: undefined })
    expect((await cli.execute(['-e', 'production', 'deploy', '--replicas=3', '--dry-run'])).value).toEqual({
      environment: 'production', replicas: 3, dryRun: true, label: undefined,
    })
  })
  test('rejects invalid input before executing the handler', async () => {
    let called = false
    const command = createFileCommand('/run')({
      options: { count: option(integer({ min: 1 }), { required: true }) },
      run: () => { called = true },
    })
    const cli = createCLI({ '/run': command }, { name: 'app' })
    for (const argv of [['run'], ['run', '--count=0'], ['run', '--count=1.5'], ['run', '--count'], ['run', '--unknown']]) {
      expect((await cli.execute(argv)).exitCode).toBe(2)
    }
    expect(called).toBe(false)
  })
  test('rejects duplicate options and flag values', async () => {
    expect((await fixture().execute(['deploy', '-r', '2', '--replicas=3'])).stderr).toContain('more than once')
    expect((await fixture().execute(['deploy', '--dry-run=true'])).stderr).toContain('does not accept a value')
    expect((await fixture().execute(['deploy', '--no-dry-run'])).value.dryRun).toBe(false)
  })
  test('honors the option terminator and validates negative integers', async () => {
    expect((await fixture().execute(['users', '-1', 'delete'])).stderr).toContain('must be at least 1')
    const command = createFileCommand('/echo/$text')({ params: { text: positional(string()) }, run: ({ params }) => params.text })
    expect((await createCLI({ '/echo/$text': command }, { name: 'app' }).execute(['echo', '--', '--help'])).value).toBe('--help')
  })
  test('programmatic invocation also validates input and returns handler results', async () => {
    const cli = fixture()
    expect(await cli.invoke('/users/$userId/delete', { params: { userId: 42 } })).toEqual({ userId: 42, force: false })
    await expect(cli.invoke('/deploy', { options: { replicas: 0 } })).rejects.toThrow('must be at least 1')
    await expect(cli.invoke('/deploy', { options: { extra: true } })).rejects.toThrow('unknown option')
    await expect(cli.invoke('/unknown', {})).rejects.toThrow('unknown command')
  })
  test('rejects malformed programmatic argument objects', async () => {
    await expect(fixture().invoke('/deploy', { options: [] })).rejects.toThrow('must be an object')
    await expect(fixture().invoke('/deploy', { options: 123 })).rejects.toThrow('must be an object')
  })
  test('reports handler failures as execution failures, not usage failures', async () => {
    const command = createFileCommand('/fail')({ run: () => { throw new ValidationError('business rule failed') } })
    const result = await createCLI({ '/fail': command }, { name: 'app' }).execute(['fail'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('Error: business rule failed\n')
  })
  test('static route segments take priority at the first differing segment', async () => {
    const dynamic = createFileCommand('/$a/bar/baz')({ params: { a: positional(string()) }, run: () => 'dynamic' })
    const literal = createFileCommand('/foo/$b/$c')({ params: { b: positional(string()), c: positional(string()) }, run: () => 'literal' })
    const result = await createCLI({ [dynamic.path]: dynamic, [literal.path]: literal }, { name: 'app' }).execute(['foo', 'bar', 'baz'])
    expect(result.value).toBe('literal')
  })
})

describe('framework-owned help and output', () => {
  test('generates root and group help without executing a handler', async () => {
    const cli = fixture()
    expect((await cli.execute(['--help'])).stdout).toContain('users')
    expect((await cli.execute(['help', 'users'])).stdout).toContain('create')
    expect((await cli.execute(['users', '--help'])).exitCode).toBe(0)
    expect((await cli.execute(['users'])).exitCode).toBe(0)
    expect((await cli.execute(['--version'])).stdout).toBe('1.0.0\n')
  })
  test('displays argument types, aliases, defaults, and negation', async () => {
    const help = (await fixture().execute(['help', 'deploy'])).stdout
    expect(help).toContain('-r, --replicas <integer>')
    expect(help).toContain('Default: 1.')
    expect(help).toContain('--no-dry-run')
    expect((await fixture().execute(['users', '42', 'delete', '--help'])).stdout).toContain('<userId>')
  })
  test('shows help for a dynamic group using an actual positional value', async () => {
    const result = await fixture().execute(['users', '42', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('delete')
  })
  test('formats narrow terminal output without ANSI codes', () => {
    const help = fixture({ width: 40 }).help('/deploy')
    expect(help).not.toContain('\u001b')
    expect(help).toContain('    Default: 1.')
  })
})

describe('definition validation', () => {
  test('rejects mismatched positional definitions and reserved options', () => {
    expect(() => createFileCommand('/$id')({ run: () => {} })).toThrow('positional definitions')
    expect(() => createFileCommand('/run')({ options: { help: flag() }, run: () => {} })).toThrow('reserved option')
    expect(() => createFileCommand('/run')({ options: { foo: flag({ short: 'h' }) }, run: () => {} })).toThrow('reserved option')
  })
  test('rejects ambiguous dynamic siblings', () => {
    const a = createFileCommand('/$a')({ params: { a: positional(string()) }, run: () => {} })
    const b = createFileCommand('/$b')({ params: { b: positional(string()) }, run: () => {} })
    expect(() => createCLI({ '/$a': a, '/$b': b }, { name: 'app' })).toThrow('ambiguous')
  })
  test('custom value decoders retain runtime validation', async () => {
    const id = value('ID', {
      parse: input => ({ id: input }),
      validate: input => {
        // oxlint-disable-next-line deslop/no-runtime-typeof -- Exercise custom decoder validation before accessing string methods.
        if (!input || typeof input.id !== 'string' || !input.id.startsWith('u_')) throw new ValidationError('expected u_ prefix')
        return input
      },
    })
    const command = createFileCommand('/$id')({ params: { id: positional(id) }, run: ({ params }) => params.id })
    const cli = createCLI({ '/$id': command }, { name: 'app' })
    expect((await cli.execute(['u_42'])).value).toEqual({ id: 'u_42' })
    expect((await cli.execute(['42'])).exitCode).toBe(2)
  })
})
