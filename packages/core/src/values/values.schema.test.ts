import { test, expect } from 'bun:test'
import { argument, createCLI, createFileCommand, option, positional, schemaValue, ValidationError } from '../index.ts'

function numericSchema() {
  return {
    '~standard': {
      version: 1, vendor: 'test',
      // oxlint-disable-next-line deslop/no-runtime-typeof -- The test schema must reject non-string inputs before transforming them.
      validate: input => typeof input === 'string' && /^\d+$/.test(input)
        ? { value: Number(input) }
        : { issues: [{ message: 'Expected digits' }] },
    },
  }
}

test('Standard Schema transforms shell and programmatic input exactly once', async () => {
  const command = createFileCommand('/records/$id')({
    params: { id: positional(schemaValue('ID', numericSchema())) },
    run: ({ params }) => params.id,
  })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['records', '42'] })).value).toBe(42)
  expect(await cli.invoke(command.path, { params: { id: '43' } })).toBe(43)
})

test('schema defaults and trailing arguments retain their input and output contracts', async () => {
  const number = schemaValue('number', numericSchema())
  const command = createFileCommand('/count')({
    options: { count: option(number, { default: '10' }), limit: option(number) },
    args: [argument('offset', number, { default: '2' })],
    run: ({ options, args }) => ({ ...options, ...args }),
  })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['count'] })).value).toEqual({ count: 10, limit: undefined, offset: 2 })
  expect(await cli.invoke(command.path, { options: { count: '5' }, args: { offset: '3' } })).toEqual({ count: 5, limit: undefined, offset: 3 })
  expect(() => option(number, { default: 'bad' })).toThrow('Expected digits')
})

test('schema issues are usage failures and prevent service and handler initialization', async () => {
  let initialized = false, called = false
  const command = createFileCommand('/records/$id')({
    params: { id: positional(schemaValue('ID', numericSchema())) },
    run: () => { called = true },
  })
  const cli = createCLI({ [command.path]: command }, { name: 'app', context: () => { initialized = true; return {} } })
  const result = await cli.test({ argv: ['records', 'invalid'] })
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('argument id: Expected digits')
  await expect(cli.invoke(command.path, { params: { id: 'invalid' } })).rejects.toThrow('Expected digits')
  expect(initialized).toBe(false)
  expect(called).toBe(false)
})

test('callback adapters support libraries without Standard Schema and shell preprocessing', async () => {
  const number = schemaValue('positive number', input => {
    // oxlint-disable-next-line deslop/no-runtime-typeof -- This callback is the validation boundary for a library without Standard Schema.
    if (typeof input !== 'number' || input < 1) throw new ValidationError('Must be positive')
    return { number: input }
  }, { parse: Number })
  const command = createFileCommand('/number')({ options: { count: option(number, { required: true }) }, run: ({ options }) => options.count })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['number', '--count', '3'] })).value).toEqual({ number: 3 })
  expect(await cli.invoke(command.path, { options: { count: 4 } })).toEqual({ number: 4 })
  expect((await cli.test({ argv: ['number', '--count', '0'] })).stderr).toContain('Must be positive')
})

test('unexpected adapter exceptions do not reveal exception messages or supplied values', async () => {
  const command = createFileCommand('/check')({
    options: { token: option(schemaValue('token', () => { throw new Error('private-token') }), { required: true }) },
    run: () => { throw new Error('must not execute') },
  })
  const result = await createCLI({ [command.path]: command }, { name: 'app' }).test({ argv: ['check', '--token', 'private-token'] })
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('option token: Invalid token')
  expect(result.stdout + result.stderr).not.toContain('private-token')
})

test('shell preprocessing failures use safe validation errors', async () => {
  const command = createFileCommand('/json')({
    options: { data: option(schemaValue('JSON', input => input, { parse: JSON.parse }), { required: true }) },
    run: ({ options }) => options.data,
  })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['json', '--data', '{"count":3}'] })).value).toEqual({ count: 3 })
  const invalid = await cli.test({ argv: ['json', '--data', 'private-token'] })
  expect(invalid.exitCode).toBe(2)
  expect(invalid.stderr).toContain('option data: Invalid JSON')
  expect(invalid.stderr).not.toContain('private-token')
})

test('async schema validation is rejected with an actionable message', async () => {
  const schema = { '~standard': { version: 1, vendor: 'test', validate: async () => ({ value: 42 }) } }
  const command = createFileCommand('/check')({ options: { count: option(schemaValue('count', schema)) }, run: () => {} })
  const result = await createCLI({ [command.path]: command }, { name: 'app' }).test({ argv: ['check', '--count', '42'] })
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('Async schema validation is not supported')
})
