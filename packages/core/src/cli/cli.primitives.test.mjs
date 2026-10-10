import { test, expect } from 'bun:test'
import { argument, bindCommand, CLIError, createCLI, defineCommand, flag, integer, option, positional, string, value } from '../index.ts'

test('captures explicit output and keeps handler results separate', async () => {
  const command = bindCommand('/accounts', defineCommand({
    run: ({ ctx }) => {
      ctx.io.json({ status: 'starting' })
      ctx.io.stderr.write('Working\n')
      ctx.io.json({ status: 'ready' })
      return { count: 2 }
    },
  }))
  const result = await createCLI({ '/accounts': command }, { name: 'app' }).test({ argv: ['accounts'] })
  expect(result.stdout).toBe('{"status":"starting"}\n{"status":"ready"}\n')
  expect(result.stderr).toBe('Working\n')
  expect(result.value).toEqual({ count: 2 })
})

test('reads bounded piped credentials without prompting or exposing them', async () => {
  const command = bindCommand('/credentials', defineCommand({
    run: async ({ ctx }) => {
      const text = await ctx.input.read({ prompt: 'Credential: ', hidden: true, maxBytes: 16, stripFinalNewline: true })
      ctx.io.json({ length: text.length })
    },
  }))
  const cli = createCLI({ '/credentials': command }, { name: 'app' })
  const result = await cli.test({ argv: ['credentials'], stdin: 'private-é\r\n' })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('{"length":9}\n')
  expect(result.stderr).toBe('')
  const oversized = await cli.test({ argv: ['credentials'], stdin: 'é'.repeat(9) })
  expect(oversized.exitCode).toBe(1)
  expect(oversized.stderr).toContain('Input exceeds')
  expect(oversized.stderr).not.toContain('é')
})

test('scripts typed selections and text answers without a real terminal', async () => {
  const command = bindCommand('/choose', defineCommand({
    run: async ({ ctx }) => ({
      account: await ctx.input.select({ message: 'Account', choices: [{ label: 'First', value: 'a' }, { label: 'Second', value: 'b' }] }),
      name: await ctx.input.read({ prompt: 'Name: ', source: 'terminal' }),
    }),
  }))
  const result = await createCLI({ '/choose': command }, { name: 'app' }).test({ argv: ['choose'], answers: ['b', 'Ada'] })
  expect(result.exitCode).toBe(0)
  expect(result.value).toEqual({ account: 'b', name: 'Ada' })
  expect(result.stdout).toBe('')
})

test('non-interactive selection fails instead of waiting for input', async () => {
  const command = bindCommand('/choose', defineCommand({
    run: ({ ctx }) => ctx.input.select({ message: 'Choose', choices: [{ label: 'One', value: 1 }] }),
  }))
  const result = await createCLI({ '/choose': command }, { name: 'app' }).test({ argv: ['choose'] })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('interactive terminal')
})

test('validates decoded values without parsing them a second time', async () => {
  const identifier = value('identifier', {
    parse: text => ({ id: text }),
    validate: input => {
      // oxlint-disable-next-line deslop/no-runtime-typeof -- Exercise validation of the custom decoder's output.
      if (!input || typeof input.id !== 'string') throw new CLIError('INVALID_ID', 'Invalid identifier')
      return input
    },
  })
  const command = bindCommand('/records/$id', defineCommand({ params: { id: positional(identifier) }, run: ({ params }) => params.id }))
  const cli = createCLI({ '/records/$id': command }, { name: 'app' })
  expect((await cli.test({ argv: ['records', 'r_1'] })).value).toEqual({ id: 'r_1' })
  expect(await cli.invoke('/records/$id', { params: { id: { id: 'r_2' } } })).toEqual({ id: 'r_2' })
})

test('supports defaulted trailing arguments and non-negatable flags', async () => {
  const command = bindCommand('/validate', defineCommand({
    args: [argument('file', string(), { default: 'project.json' })],
    options: { offline: flag({ negate: false }) },
    run: ({ args, options }) => ({ file: args.file, offline: options.offline }),
  }))
  const cli = createCLI({ '/validate': command }, { name: 'app' })
  expect((await cli.test({ argv: ['validate'] })).value).toEqual({ file: 'project.json', offline: false })
  expect((await cli.test({ argv: ['validate', 'custom.json', '--offline'] })).value).toEqual({ file: 'custom.json', offline: true })
  expect((await cli.test({ argv: ['validate', '--no-offline'] })).exitCode).toBe(2)
  expect(cli.help('/validate')).not.toContain('--no-offline')
  expect(await cli.invoke('/validate', {})).toEqual({ file: 'project.json', offline: false })
})

test('help works without required route params or application initialization', async () => {
  let initialized = 0
  const command = bindCommand('/tasks/$id', defineCommand({
    params: { id: positional(integer()) },
    options: { name: option(string(), { required: true }) },
    sections: [{ title: 'Notes', body: 'Read-only task lookup.' }],
    run: () => { throw new Error('must not execute') },
  }))
  const cli = createCLI({ '/tasks/$id': command }, { name: 'app', context: () => { initialized++; return {} } })
  const result = await cli.test({ argv: ['tasks', '--help'] })
  expect(result.exitCode).toBe(0)
  expect(initialized).toBe(0)
  expect((await cli.test({ argv: ['help', 'tasks', '$id'] })).stdout).toContain('Read-only task lookup.')
})

test('groups carry metadata and show help with successful exit status', async () => {
  const group = bindCommand('/accounts', defineCommand({ description: 'Manage accounts', sections: [{ title: 'Access', body: 'Sign in first.' }] }))
  const command = bindCommand('/accounts/list', defineCommand({ run: () => [] }))
  const cli = createCLI({ '/accounts': group, '/accounts/list': command }, { name: 'app' })
  const result = await cli.test({ argv: ['accounts'] })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Manage accounts')
  expect(result.stdout).toContain('Sign in first.')
})

test('usage failures never echo argv and unexpected failures never echo exception messages', async () => {
  const command = bindCommand('/fail', defineCommand({ run: () => { throw new Error('private-token') } }))
  const cli = createCLI({ '/fail': command }, { name: 'app' })
  for (const argv of [['private-token'], ['help', 'private-token?'], ['fail', '--private-token'], ['fail', '--', 'private-token'], ['fail']]) {
    const result = await cli.test({ argv })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).not.toContain('private-token')
  }
})

test('custom presentation emits JSON failures and version output', async () => {
  const command = bindCommand('/fail', defineCommand({ run: () => { throw new CLIError('DENIED', 'Access denied') } }))
  const cli = createCLI({ '/fail': command }, {
    name: 'app', version: '1.0.0',
    presentation: {
      failure: (failure, io) => { io.json({ ok: false, error: { code: failure.code, message: failure.message } }); return 1 },
      version: (version, io) => io.json({ version }),
    },
  })
  expect((await cli.test({ argv: ['fail'] })).stdout).toBe('{"ok":false,"error":{"code":"DENIED","message":"Access denied"}}\n')
  expect((await cli.test({ argv: ['--version'] })).stdout).toBe('{"version":"1.0.0"}\n')
  expect((await cli.test({ argv: ['-V'] })).stdout).toBe('{"version":"1.0.0"}\n')
  expect((await cli.test({ argv: ['unknown'] })).stderr).toBe('')
})

test('cancellation is distinct and prevents starting a handler', async () => {
  let called = false
  const controller = new AbortController()
  controller.abort()
  const command = bindCommand('/run', defineCommand({ run: () => { called = true } }))
  const result = await createCLI({ '/run': command }, { name: 'app' }).test({ argv: ['run'], signal: controller.signal })
  expect(result.exitCode).toBe(130)
  expect(called).toBe(false)
})

test('rejects invalid trailing argument order and duplicate parameter names', () => {
  expect(() => defineCommand({ args: [argument('first', string(), { required: false }), argument('second', string())], run: () => {} })).toThrow('required argument')
  expect(() => bindCommand('/$id', defineCommand({ params: { id: positional(string()) }, args: [argument('id', string())], run: () => {} }))).toThrow('duplicate argument')
  expect(() => defineCommand({ args: [{ ...flag(), name: 'force' }], run: () => {} })).toThrow('trailing arguments must be positional')
})

test('rejects invalid JavaScript invocation inputs before starting the handler', async () => {
  let called = false
  const command = bindCommand('/run', defineCommand({ run: () => { called = true } }))
  const cli = createCLI({ '/run': command }, { name: 'app' })
  for (const input of [null, 'text', [], { params: null }, { options: [] }, { args: 'text' }]) {
    await expect(cli.invoke('/run', input)).rejects.toThrow()
  }
  expect(called).toBe(false)
})

test('rejects JSON output that cannot be serialized without writing partial output', async () => {
  for (const value of [undefined, { toJSON: () => undefined }, { toJSON: () => { throw new Error('private-value') } }]) {
    const command = bindCommand('/json', defineCommand({ run: ({ ctx }) => ctx.io.json(value) }))
    const result = await createCLI({ '/json': command }, { name: 'app' }).test({ argv: ['json'] })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Output is not JSON serializable')
    expect(result.stderr).not.toContain('private-value')
  }
})

test('a literal child command takes priority over a parent trailing argument', async () => {
  const parent = bindCommand('/tasks', defineCommand({ args: [argument('file', string())], run: () => 'parent' }))
  const child = bindCommand('/tasks/create', defineCommand({ run: () => 'child' }))
  const result = await createCLI({ '/tasks': parent, '/tasks/create': child }, { name: 'app' }).test({ argv: ['tasks', 'create'] })
  expect(result.value).toBe('child')
})

test('dynamic command help shows sections before a required positional value is supplied', async () => {
  const command = bindCommand('/tasks/$id', defineCommand({
    params: { id: positional(integer()) }, sections: [{ title: 'Notes', body: 'Find a task by ID.' }], run: () => {},
  }))
  const result = await createCLI({ '/tasks/$id': command }, { name: 'app' }).test({ argv: ['tasks', '--help'] })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('Find a task by ID.')
  expect(result.stdout).toContain('<id>')
})

test('typed application services are initialized only for valid executable commands', async () => {
  let initialized = 0
  const command = bindCommand('/greet', defineCommand.withContext()({
    options: { name: option(string(), { required: true }) },
    run: ({ options, ctx }) => `${ctx.services.prefix} ${options.name}`,
  }))
  const cli = createCLI({ '/greet': command }, { name: 'app', context: () => { initialized++; return { prefix: 'Hello' } } })
  await cli.test({ argv: ['greet', '--help'] })
  await cli.test({ argv: ['greet'] })
  expect(initialized).toBe(0)
  expect((await cli.test({ argv: ['greet', '--name', 'Ada'] })).value).toBe('Hello Ada')
  expect(initialized).toBe(1)
})

test('failure rendering errors use a safe fallback rather than exposing exception messages', async () => {
  const command = bindCommand('/fail', defineCommand({ run: () => { throw new CLIError('DENIED', 'Access denied') } }))
  const cli = createCLI({ '/fail': command }, { name: 'app', presentation: { failure: () => { throw new Error('private-token') } } })
  const result = await cli.test({ argv: ['fail'] })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('Unable to render the failure')
  expect(result.stderr).not.toContain('private-token')
})

test('shell parsing validates transformed outputs before executing a handler', async () => {
  let called = false
  const identifier = value('identifier', {
    parse: () => ({ id: 123 }),
    validate: input => {
      // oxlint-disable-next-line deslop/no-runtime-typeof -- Reject the intentionally invalid custom decoder output.
      if (typeof input.id !== 'string') throw new CLIError('INVALID_ID', 'Invalid identifier')
      return input
    },
  })
  const command = bindCommand('/$id', defineCommand({ params: { id: positional(identifier) }, run: () => { called = true } }))
  const result = await createCLI({ '/$id': command }, { name: 'app' }).test({ argv: ['record'] })
  expect(result.exitCode).toBe(2)
  expect(called).toBe(false)
})

test('accepts the stdin marker as an option value and a positional argument', async () => {
  const command = bindCommand('/read', defineCommand({
    args: [argument('file', string(), { default: '-' })],
    options: { source: option(string()) },
    run: ({ args, options }) => ({ file: args.file, source: options.source }),
  }))
  const result = await createCLI({ '/read': command }, { name: 'app' }).test({ argv: ['read', '-', '--source', '-'] })
  expect(result.exitCode).toBe(0)
  expect(result.value).toEqual({ file: '-', source: '-' })
})
