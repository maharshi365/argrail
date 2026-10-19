import { expect, test } from 'bun:test'
import { argument, bindCommand, createCLI, defineCommand, flag, integer, option, positional, repeatableOption, string, variadicArgument } from '../index.ts'

function fixture() {
  const command = bindCommand('/run', defineCommand({
    args: [variadicArgument('words', string())],
    options: {
      debug: flag({ short: 'd' }),
      verbose: flag({ short: 'v' }),
      port: option(string(), { short: 'p' }),
      count: option(integer(), { short: 'n' }),
      tags: repeatableOption(string(), { short: 't' }),
    },
    run: ({ args, options }) => ({ ...options, words: args.words }),
  }))
  return createCLI({ '/run': command }, { name: 'app' })
}

for (const text of ['80', '-5', 'str', '-', '--flag', 'a=b']) {
  test(`attached short option preserves ${JSON.stringify(text)}`, async () => {
    const result = await fixture().test({ argv: ['run', `-p${text}`] })
    expect(result.exitCode).toBe(0)
    expect(result.value).toMatchObject({ port: text, words: [] })
  })
}

for (const argv of [['-dv'], ['-vd'], ['-dvp80'], ['-dvp=80'], ['-dv', '-p', '80'], ['-dvp', '80']]) {
  test(`short option bundles decode declared flags and values: ${argv.join(' ')}`, async () => {
    const result = await fixture().test({ argv: ['run', ...argv] })
    expect(result.exitCode).toBe(0)
    expect(result.value).toMatchObject({ debug: true, verbose: true, port: argv.join('').includes('p') ? '80' : undefined, words: [] })
  })
}

test('attached short integer and repeated values reach their decoders', async () => {
  const result = await fixture().test({ argv: ['run', '-n123', '-tone', 'operand', '-ttwo'] })
  expect(result.exitCode).toBe(0)
  expect(result.value).toMatchObject({ count: 123, tags: ['one', 'two'], words: ['operand'] })
})

for (const argv of [['-dd'], ['-dv', '--debug'], ['-pfirst', '--port=second'], ['-dv=true'], ['-dvx'], ['-p'], ['-dvp']]) {
  test(`invalid short options prevent handler execution: ${argv.join(' ')}`, async () => {
    let called = false
    const command = bindCommand('/run', defineCommand({
      options: { debug: flag({ short: 'd' }), verbose: flag({ short: 'v' }), port: option(string(), { short: 'p' }) },
      run: () => { called = true },
    }))
    const result = await createCLI({ '/run': command }, { name: 'app' }).test({ argv: ['run', ...argv] })
    expect(result.exitCode).toBe(2)
    expect(called).toBe(false)
  })
}

test('the option terminator leaves short bundles and attached values untouched', async () => {
  const result = await fixture().test({ argv: ['run', '--', '-dv', '-p80', '-n123'] })
  expect(result.exitCode).toBe(0)
  expect(result.value).toMatchObject({ debug: false, verbose: false, port: undefined, count: undefined, words: ['-dv', '-p80', '-n123'] })
})

test('bundled help bypasses required input without running the handler', async () => {
  let called = false
  const command = bindCommand('/run', defineCommand({ args: [argument('file', string())], options: { debug: flag({ short: 'd' }) }, run: () => { called = true } }))
  const result = await createCLI({ '/run': command }, { name: 'app' }).test({ argv: ['run', '-dh'] })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Usage: app run <file>')
  expect(called).toBe(false)
})

for (const text of ['-.1', '-.5', '-123', '-123.45', '-123.', '-1e3', '-1e+3', '-1e-3', '-1.2e3', '-1.2e+3', '-1.2e-3', '-1E3', '-0', '1', '']) {
  for (const mode of ['argument', 'short', 'long', 'short repeated', 'long repeated'] as const) {
    test(`numeric text is preserved in ${mode}: ${JSON.stringify(text)}`, async () => {
      const argv = mode === 'argument' ? [text] : mode === 'short' ? ['-p', text] : mode === 'long' ? ['--port', text] : mode === 'short repeated' ? ['-t', 'first', '-t', text] : ['--tags', 'first', '--tags', text]
      const result = await fixture().test({ argv: ['run', ...argv] })
      expect(result.exitCode).toBe(0)
      expect(result.value).toMatchObject(mode === 'argument' ? { words: [text] } : mode.endsWith('repeated') ? { tags: ['first', text], words: [] } : { port: text, words: [] })
    })
  }
}

for (const text of ['-1e-3.0', '-1x', '-0x1234', '--1 ', '-x-1 ']) {
  for (const mode of ['argument', 'short', 'long', 'short repeated', 'long repeated'] as const) {
    test(`malformed negative tokens cannot bypass option parsing in ${mode}: ${JSON.stringify(text)}`, async () => {
      const argv = mode === 'argument' ? [text] : mode === 'short' ? ['-p', text] : mode === 'long' ? ['--port', text] : mode === 'short repeated' ? ['-t', 'first', '-t', text] : ['--tags', 'first', '--tags', text]
      const result = await fixture().test({ argv: ['run', ...argv] })
      expect(result.exitCode).toBe(2)
      expect(result.value).toBeUndefined()
    })
  }
  test(`explicit literal syntax preserves option-shaped text: ${JSON.stringify(text)}`, async () => {
    const cli = fixture()
    expect((await cli.test({ argv: ['run', `--port=${text}`] })).value).toMatchObject({ port: text })
    expect((await cli.test({ argv: ['run', '--', text] })).value).toMatchObject({ words: [text] })
  })
}

for (const argv of [['-dpbob', 'run'], ['run', '-dpbob'], ['-d', 'run', '-pbob']]) {
  test(`attached values cannot become dynamic child parameters: ${argv.join(' ')}`, async () => {
    const parent = bindCommand('/run', defineCommand({ options: { debug: flag({ short: 'd' }), label: option(string(), { short: 'p' }) }, run: ({ options }) => options }))
    const child = bindCommand('/run/$id', defineCommand({ params: { id: positional(string()) }, run: () => 'wrong handler' }))
    const result = await createCLI({ '/run': parent, '/run/$id': child }, { name: 'app' }).test({ argv })
    expect(result.exitCode).toBe(0)
    expect(result.value).toEqual({ debug: true, label: 'bob' })
  })
}

test('disjoint commands resolve a bundled alias using their own option arity', async () => {
  const file = bindCommand('/file', defineCommand({ options: { debug: flag({ short: 'd' }), file: option(string(), { short: 'f' }) }, run: ({ options }) => options }))
  const force = bindCommand('/force', defineCommand({ options: { debug: flag({ short: 'd' }), force: flag({ short: 'f' }) }, run: ({ options }) => options }))
  const cli = createCLI({ '/file': file, '/force': force }, { name: 'app' })
  expect((await cli.test({ argv: ['-dfname', 'file'] })).value).toEqual({ debug: true, file: 'name' })
  expect((await cli.test({ argv: ['-df', 'force'] })).value).toEqual({ debug: true, force: true })
})
