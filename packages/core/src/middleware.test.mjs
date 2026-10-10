import { test, expect } from 'bun:test'
import {
  bindCommand,
  createCLI,
  createMiddleware,
  defineCommand,
  defineGroup,
  defineRoot,
  CLIError,
  integer,
  option,
} from './index.ts'

function fixture() {
  let user = null
  const calls = []
  const logging = createMiddleware().handler(async ({ next }) => {
    calls.push('before')
    try {
      return await next()
    } finally {
      calls.push('after')
    }
  })
  const auth = createMiddleware().handler(({ next }) => {
    calls.push('auth')
    if (!user) throw new CLIError('UNAUTHENTICATED', 'Run "app login" first.')
    return next({ context: { user } })
  })
  const root = defineRoot({ middleware: [logging] })
  const protectedGroup = defineGroup({ middleware: [auth] })
  const admin = defineGroup({
    middleware: [
      createMiddleware().handler(({ ctx, next }) => {
        calls.push('admin')
        if (!ctx.services.user.admin) throw new CLIError('FORBIDDEN', 'Admin required')
        return next()
      }),
    ],
  })
  const login = bindCommand(
    '/login',
    defineCommand({
      run: () => {
        calls.push('login')
        return 'logged in'
      },
    }),
    [root],
  )
  const deploy = bindCommand(
    '/deploy',
    defineCommand({
      options: { count: option(integer({ min: 1 }), { default: 1 }) },
      run: ({ ctx }) => {
        calls.push('deploy')
        return ctx.services.user.id
      },
    }),
    [root, protectedGroup],
  )
  const create = bindCommand(
    '/users/create',
    defineCommand({
      run: () => {
        calls.push('create')
        return 'created'
      },
    }),
    [root, protectedGroup, admin],
  )
  const cli = createCLI(
    { '/login': login, '/deploy': deploy, '/users/create': create },
    { name: 'app', version: '1.0' },
  )
  return {
    cli,
    calls,
    authenticate: value => {
      user = value
    },
  }
}

test('protects only the attached subtree and blocks programmatic bypass', async () => {
  const { cli, calls } = fixture()
  expect((await cli.test({ argv: ['login'] })).value).toBe('logged in')
  expect(calls).toEqual(['before', 'login', 'after'])
  calls.length = 0
  const failure = await cli.execute(['deploy'])
  expect(failure.exitCode).toBe(1)
  expect(failure.stderr).toContain('Run "app login" first.')
  expect(calls).toEqual(['before', 'auth', 'after'])
  await expect(cli.invoke('/deploy', {})).rejects.toThrow('Run "app login" first.')
  expect(calls).not.toContain('deploy')
})

test('passes context through nested guards and unwinds wrapping middleware', async () => {
  const { cli, calls, authenticate } = fixture()
  authenticate({ id: 'u1', admin: false })
  expect(await cli.invoke('/deploy', {})).toBe('u1')
  expect(calls).toEqual(['before', 'auth', 'deploy', 'after'])
  calls.length = 0
  expect((await cli.execute(['users', 'create'])).exitCode).toBe(1)
  expect(calls).toEqual(['before', 'auth', 'admin', 'after'])
  calls.length = 0
  authenticate({ id: 'u2', admin: true })
  expect((await cli.execute(['users', 'create'])).value).toBe('created')
  expect(calls).toEqual(['before', 'auth', 'admin', 'create', 'after'])
})

test('help, version, and invalid input do not initialize context or middleware', async () => {
  const { cli, calls } = fixture()
  for (const argv of [['--help'], ['help', 'deploy'], ['deploy', '--help'], ['--version']]) {
    expect((await cli.test({ argv })).exitCode).toBe(0)
  }
  expect((await cli.execute(['deploy', '--count=0'])).exitCode).toBe(2)
  await expect(cli.invoke('/deploy', { options: { count: 0 } })).rejects.toThrow(
    'must be at least 1',
  )
  expect(calls).toEqual([])
})

test('root middleware protects all commands including login', async () => {
  let ran = false
  const root = defineRoot({
    middleware: [
      createMiddleware().handler(() => {
        throw new CLIError('AUTH', 'Authentication required')
      }),
    ],
  })
  const login = bindCommand(
    '/login',
    defineCommand({
      run: () => {
        ran = true
      },
    }),
    [root],
  )
  expect((await createCLI({ '/login': login }, { name: 'app' }).execute(['login'])).exitCode).toBe(
    1,
  )
  expect(ran).toBe(false)
})

test('middleware on a route applies to that route and descendants, not siblings', async () => {
  const guard = createMiddleware().handler(({ next }) =>
    next({ context: { user: 'authenticated' } }),
  )
  const parent = bindCommand(
    '/users',
    defineCommand({ middleware: [guard], run: ({ ctx }) => ctx.services.user }),
  )
  const child = bindCommand('/users/create', defineCommand({ run: ({ ctx }) => ctx.services.user }))
  const sibling = bindCommand(
    '/login',
    defineCommand({ run: ({ ctx }) => Object.keys(ctx.services) }),
  )
  const cli = createCLI(
    { '/users': parent, '/users/create': child, '/login': sibling },
    { name: 'app' },
  )
  expect(await cli.invoke('/users', {})).toBe('authenticated')
  expect(await cli.invoke('/users/create', {})).toBe('authenticated')
  expect(await cli.invoke('/login', {})).toEqual([])
})

test('middleware keeps framework exitCode shared with the execution result', async () => {
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [createMiddleware().handler(({ next }) => next({ context: { user: 'u1' } }))],
      run: ({ ctx }) => {
        ctx.exitCode = 7
        return ctx.services.user
      },
    }),
  )
  const result = await createCLI({ '/run': command }, { name: 'app' }).execute(['run'])
  expect(result.exitCode).toBe(7)
  expect(result.value).toBe('u1')
})

test('command middleware extends invocation services without leaking between calls', async () => {
  let sequence = 0
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [createMiddleware().handler(({ next }) => next({ context: { id: ++sequence } }))],
      run: ({ ctx }) => ({ id: ctx.services.id, prefix: ctx.services.prefix }),
    }),
  )
  const services = { prefix: 'hello' }
  const cli = createCLI({ '/run': command }, { name: 'app', context: () => services })
  expect(await cli.invoke('/run', {})).toEqual({ id: 1, prefix: 'hello' })
  expect((await cli.execute(['run'])).value).toEqual({ id: 2, prefix: 'hello' })
  expect(services).toEqual({ prefix: 'hello' })
})

test('rejects a second next call without executing the handler again', async () => {
  let executions = 0
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [
        createMiddleware().handler(async ({ next }) => {
          await next()
          return next()
        }),
      ],
      run: () => ++executions,
    }),
  )
  await expect(createCLI({ '/run': command }, { name: 'app' }).invoke('/run', {})).rejects.toThrow(
    'next() can only be called once',
  )
  expect(executions).toBe(1)
})

test('rejects conflicting context keys rather than replacing trusted services', async () => {
  let ran = false
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [
        createMiddleware().handler(({ next }) => next({ context: { user: 'replacement' } })),
      ],
      run: () => {
        ran = true
      },
    }),
  )
  const cli = createCLI({ '/run': command }, { name: 'app', context: () => ({ user: 'original' }) })
  await expect(cli.invoke('/run', {})).rejects.toThrow('context key already exists: user')
  expect(ran).toBe(false)
})

test('context key collision checks include enumerable symbols', async () => {
  const key = Symbol('principal')
  let ran = false
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [
        createMiddleware().handler(({ next }) => next({ context: { [key]: 'replacement' } })),
      ],
      run: () => {
        ran = true
      },
    }),
  )
  const cli = createCLI(
    { '/run': command },
    { name: 'app', context: () => ({ [key]: 'original' }) },
  )
  await expect(cli.invoke('/run', {})).rejects.toThrow(
    'context key already exists: Symbol(principal)',
  )
  expect(ran).toBe(false)
})

test('rejects invalid context bags and unsafe property names', async () => {
  for (const context of [
    null,
    'user',
    [],
    JSON.parse('{"__proto__":{"authenticated":true}}'),
    { constructor: 'replacement' },
    { prototype: 'replacement' },
  ]) {
    let ran = false
    const command = bindCommand(
      '/run',
      defineCommand({
        middleware: [createMiddleware().handler(({ next }) => next({ context }))],
        run: () => {
          ran = true
        },
      }),
    )
    const result = await createCLI({ '/run': command }, { name: 'app' }).execute(['run'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/Middleware context must be an object|invalid context key/)
    expect(ran).toBe(false)
  }
})

test('rejects middleware that silently skips the handler', async () => {
  let ran = false
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [createMiddleware().handler(() => ({ value: 'skipped' }))],
      run: () => {
        ran = true
      },
    }),
  )
  await expect(createCLI({ '/run': command }, { name: 'app' }).invoke('/run', {})).rejects.toThrow(
    'Middleware must return the result of next()',
  )
  expect(ran).toBe(false)
})

test('cancellation stops downstream execution and still runs wrapper cleanup', async () => {
  const controller = new AbortController()
  let cleaned = false,
    ran = false
  const command = bindCommand(
    '/run',
    defineCommand({
      middleware: [
        createMiddleware().handler(async ({ next }) => {
          controller.abort()
          try {
            return await next()
          } finally {
            cleaned = true
          }
        }),
      ],
      run: () => {
        ran = true
      },
    }),
  )
  const result = await createCLI({ '/run': command }, { name: 'app' }).execute(['run'], {
    signal: controller.signal,
  })
  expect(result.exitCode).toBe(130)
  expect(cleaned).toBe(true)
  expect(ran).toBe(false)
})
