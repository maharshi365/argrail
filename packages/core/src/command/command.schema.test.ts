import { test, expect } from 'bun:test'
import { createCLI, createFileCommand, defineCommand, bindCommand } from '../index.ts'
import { z } from 'zod'
import * as v from 'valibot'

function schema(validate) {
  return { '~standard': { version: 1, vendor: 'test', validate } }
}

test('whole-object schemas own defaults and transformations for shell and invocation', async () => {
  const command = createFileCommand('/users/$id')({
    validateParams: schema(input =>
      /^\d+$/.test(input.id)
        ? { value: { id: Number(input.id) } }
        : { issues: [{ message: 'Expected digits' }] },
    ),
    validateOptions: schema(input => ({
      value: { limit: Number(input.limit ?? 10), verbose: input.verbose ?? false },
    })),
    optionConfig: { limit: { short: 'l' }, verbose: { type: 'flag', short: 'v' } },
    run: ({ params, options }) => ({ ...params, ...options }),
  })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['users', '42', '-l', '5', '-v'] })).value).toEqual({
    id: 42,
    limit: 5,
    verbose: true,
  })
  expect((await cli.test({ argv: ['users', '42'] })).value).toEqual({
    id: 42,
    limit: 10,
    verbose: false,
  })
  expect(await cli.invoke(command.path, { params: { id: '43' }, options: { limit: '7' } })).toEqual(
    { id: 43, limit: 7, verbose: false },
  )
  expect((await cli.test({ argv: ['users', '42', '--no-verbose'] })).value.verbose).toBe(false)
})

test('whole-object validation failures prevent context and handler execution', async () => {
  let initialized = false,
    called = false
  const command = createFileCommand('/check')({
    validateOptions: schema(() => ({ issues: [{ message: 'Required token', path: ['token'] }] })),
    optionConfig: { token: {} },
    run: () => {
      called = true
    },
  })
  const cli = createCLI(
    { '/check': command },
    {
      name: 'app',
      context: () => {
        initialized = true
        return {}
      },
    },
  )
  const result = await cli.test({ argv: ['check'] })
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('Required token')
  await expect(cli.invoke('/check', {})).rejects.toThrow('Required token')
  expect(initialized).toBe(false)
  expect(called).toBe(false)
})

test('whole-object schemas run once and help does not run them', async () => {
  let calls = 0
  const command = createFileCommand('/check')({
    validateOptions: schema(input => {
      calls++
      return { value: { count: Number(input.count) } }
    }),
    optionConfig: { count: { description: 'Count items' } },
    run: ({ options }) => options.count,
  })
  const cli = createCLI({ '/check': command }, { name: 'app' })
  expect((await cli.test({ argv: ['check', '--help'] })).stdout).toContain('Count items')
  expect(calls).toBe(0)
  expect((await cli.test({ argv: ['check', '--count', '3'] })).value).toBe(3)
  expect(calls).toBe(1)
})

test('schema commands support definition and binding', async () => {
  const definition = defineCommand({
    validateOptions: schema(input => ({ value: { name: input.name ?? 'world' } })),
    optionConfig: { name: {} },
    run: ({ options }) => options.name,
  })
  const command = bindCommand('/hello', definition)
  expect(
    (await createCLI({ '/hello': command }, { name: 'app' }).test({ argv: ['hello'] })).value,
  ).toBe('world')
})

test('schema configuration rejects mixed ownership and missing option configuration', () => {
  const validator = schema(input => ({ value: input }))
  expect(() => createFileCommand('/check')({ validateOptions: validator })).toThrow('optionConfig')
  expect(() =>
    createFileCommand('/check')({ validateOptions: validator, optionConfig: {}, options: {} }),
  ).toThrow('options')
  expect(() => createFileCommand('/check')({ validateParams: validator, params: {} })).toThrow(
    'params',
  )
})

test('async whole-object schemas are rejected', async () => {
  const command = createFileCommand('/check')({
    validateOptions: schema(async () => ({ value: {} })),
    optionConfig: {},
    run: () => {},
  })
  const result = await createCLI({ '/check': command }, { name: 'app' }).test({ argv: ['check'] })
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toContain('Async schema validation is not supported')
})

test('Zod and Valibot schemas work directly as whole-object validators', async () => {
  const command = createFileCommand('/users/$id')({
    validateParams: z.object({ id: z.string().regex(/^\d+$/).transform(Number) }),
    validateOptions: v.object({
      limit: v.optional(v.pipe(v.string(), v.transform(Number)), '10'),
      verbose: v.optional(v.boolean(), false),
    }),
    optionConfig: { limit: { short: 'l' }, verbose: { type: 'flag', short: 'v' } },
    run: ({ params, options }) => ({ ...params, ...options }),
  })
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['users', '42', '-l', '5', '-v'] })).value).toEqual({
    id: 42,
    limit: 5,
    verbose: true,
  })
  expect(await cli.invoke(command.path, { params: { id: '43' } })).toEqual({
    id: 43,
    limit: 10,
    verbose: false,
  })
  expect((await cli.test({ argv: ['users', 'bad'] })).exitCode).toBe(2)
})

test('optionConfig validates CLI syntax and rejects unsupported settings', () => {
  const validator = schema(input => ({ value: input }))
  const define = settings => createFileCommand('/check')({ validateOptions: validator, optionConfig: { count: settings } })
  expect(() => define({ type: 'other' })).toThrow('invalid option type')
  expect(() => define({ short: 'long' })).toThrow('invalid short option')
  expect(() => define({ short: 'h' })).toThrow('reserved option')
  expect(() => define({ required: true })).toThrow('unknown optionConfig setting')
  expect(() => define({ negate: true })).toThrow('negate requires a flag')
})

test('binding schema parameters derives their CLI positions from the path', async () => {
  const command = bindCommand('/users/$id', defineCommand({
    validateParams: z.object({ id: z.string().transform(Number) }),
    run: ({ params }) => params.id,
  }))
  const cli = createCLI({ [command.path]: command }, { name: 'app' })
  expect((await cli.test({ argv: ['users', '42'] })).value).toBe(42)
  expect(await cli.invoke(command.path, { params: { id: '43' } })).toBe(43)
})

test('schema commands reject options not declared in optionConfig before validation', async () => {
  let calls = 0
  const command = createFileCommand('/check')({
    validateOptions: schema(input => { calls++; return { value: input } }),
    optionConfig: { count: {} },
    run: ({ options }) => options,
  })
  const cli = createCLI({ '/check': command }, { name: 'app' })
  expect((await cli.test({ argv: ['check', '--extra', '3'] })).exitCode).toBe(2)
  await expect(cli.invoke('/check', { options: { extra: '3' } })).rejects.toThrow('unknown option')
  expect(calls).toBe(0)
})
