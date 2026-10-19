import { test, expect } from 'bun:test'
import { createCLI, defineCommand, bindCommand, composeRegistries, argument, integer, string, option, repeatableOption, variadicArgument } from '../index.ts'

test('decodes repeated aliases and trailing values without consuming command words', async () => {
  const command = bindCommand('/skills/add', defineCommand({
    args: [argument('prefix', string()), variadicArgument('names', integer())],
    options: { harness: repeatableOption(string(), { short: 'a' }) },
    run: ({ args, options }) => ({ args, options }),
  }))
  const cli = createCLI({ '/skills/add': command }, { name: 'app' })
  const result = await cli.test({ argv: ['skills', '--harness', 'codex', 'add', 'batch', '1', '-a', 'cursor', '2'] })
  expect(result.exitCode).toBe(0)
  expect(result.value).toEqual({ args: { prefix: 'batch', names: [1, 2] }, options: { harness: ['codex', 'cursor'] } })
  expect(await cli.invoke('/skills/add', { args: { prefix: 'batch', names: [3] }, options: { harness: ['codex'] } })).toEqual({ args: { prefix: 'batch', names: [3] }, options: { harness: ['codex'] } })
  const help = cli.help('/skills/add')
  expect(help).toContain('[names...]')
  expect(help).toContain('--harness <text>')
})

test('collection defaults and invalid elements use normal validation', async () => {
  const command = bindCommand('/add', defineCommand({
    args: [variadicArgument('names', integer())],
    options: { harness: repeatableOption(string()), scalar: option(string()) },
    run: ({ args, options }) => ({ args, options }),
  }))
  const cli = createCLI({ '/add': command }, { name: 'app' })
  expect((await cli.test({ argv: ['add'] })).value).toEqual({ args: { names: [] }, options: { harness: [], scalar: undefined } })
  expect((await cli.test({ argv: ['add', 'bad'] })).stderr).toContain('expected an integer')
  expect((await cli.test({ argv: ['add', '--scalar', 'a', '--scalar', 'b'] })).stderr).toContain('supplied more than once')
  await expect(cli.invoke('/add', { options: { harness: [3] } })).rejects.toThrow('expected text')
  expect(() => defineCommand({ args: [variadicArgument('names', string()), argument('after', string(), { required: false })] })).toThrow('variadic argument must be last')
})

test('registry composition refuses collisions instead of overwriting author commands', () => {
  const first = bindCommand('/first', defineCommand({ run: () => 1 }))
  const second = bindCommand('/second', defineCommand({ run: () => 2 }))
  expect(Object.keys(composeRegistries({ '/first': first }, { '/second': second }))).toEqual(['/first', '/second'])
  expect(() => composeRegistries({ '/first': first }, { '/first': first })).toThrow('duplicate command path')
})
