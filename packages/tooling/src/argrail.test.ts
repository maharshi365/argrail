import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dir, '../../..')
const tooling = resolve(import.meta.dir, '../dist/argrail.js')

type RunResult = { code: number | null; stdout: string; stderr: string }

function run(command: string, args: string[], cwd: string) {
  return new Promise<RunResult>((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('exit', code => resolveResult({ code, stdout, stderr }))
  })
}

async function setup() {
  // Keep the source project in the workspace so Bun and TypeScript resolve workspace packages.
  const project = await mkdtemp(resolve(root, 'examples/fixture-'))
  await mkdir(resolve(project, 'src/commands'), { recursive: true })
  await mkdir(resolve(project, 'node_modules/@argrail'), { recursive: true })
  await symlink(resolve(root, 'packages/core'), resolve(project, 'node_modules/@argrail/core'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(resolve(project, 'package.json'), '{"type":"module"}\n')
  await writeFile(resolve(project, 'argrail.config.json'), '{"name":"fixture"}\n')
  await writeFile(resolve(project, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: ['src/**/*.ts'] }))
  await writeFile(resolve(project, 'src/commands/greet.ts'), `import { defineCommand, option, string } from '@argrail/core'
export const Command = defineCommand({
  options: { name: option(string(), { required: true }) },
  run: ({ options, ctx }) => { ctx.io.stdout.write('Hello ' + options.name + '\\n'); return { name: options.name } },
})\n`)
  return project
}

test('builds a CLI that runs without source files or installed framework packages', async () => {
  const project = await setup()
  const isolated = await mkdtemp(resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-bundle-'))
  try {
    const built = await run('node', [tooling, 'build', '--project', project], root)
    expect(built.code, built.stdout + built.stderr).toBe(0)
    const content = await readFile(resolve(project, 'dist/fixture.js'), 'utf8')
    await writeFile(resolve(isolated, 'fixture.mjs'), content)
    const executed = await run('node', [resolve(isolated, 'fixture.mjs'), 'greet', '--name', 'Ada'], isolated)
    expect(executed.code).toBe(0)
    expect(executed.stdout).toBe('Hello Ada\n')
    const help = await run('node', [resolve(isolated, 'fixture.mjs'), 'help', 'greet'], isolated)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('--name <text>')
    const invalid = await run('node', [resolve(isolated, 'fixture.mjs'), 'greet'], isolated)
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('missing option: name')
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(isolated, { recursive: true, force: true })
  }
}, 30000)

test('bundles skills into a JavaScript CLI that installs without author source files', async () => {
  const project = await setup()
  const isolated = await mkdtemp(resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-skill-cli-'))
  try {
    await symlink(resolve(root, 'packages/skills'), resolve(project, 'node_modules/@argrail/skills'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(resolve(project, 'package.json'), JSON.stringify({ name: '@test/fixture', type: 'module' }))
    await writeFile(resolve(project, 'src/commands/skills.ts'), `import { defineCommand, createMiddleware } from '@argrail/core'
const middleware = createMiddleware().handler(({ ctx, next }) => { ctx.io.stderr.write('skills middleware\\n'); return next() })
export const Command = defineCommand({ description: 'Manage bundled skills.', middleware: [middleware] })
export const SkillGroups = { starter: { description: 'Starter skills', skills: ['test-skill'] } } as const\n`)
    await mkdir(resolve(project, 'skills/test-skill/assets'), { recursive: true })
    await writeFile(resolve(project, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test bundled resources\n---\n')
    await writeFile(resolve(project, 'skills/test-skill/assets/data.bin'), new Uint8Array([0, 255, 42]))
    const built = await run('node', [tooling, 'build', '--project', project], root)
    expect(built.code, built.stdout + built.stderr).toBe(0)
    const executable = resolve(isolated, 'fixture.mjs')
    await writeFile(executable, await readFile(resolve(project, 'dist/fixture.js')), { mode: 0o755 })
    const target = resolve(isolated, 'js-skills')
    const installed = await run('node', [executable, 'skills', 'add', '--group', 'starter', '--path', target, '--yes', '--json'], isolated)
    expect(installed.code, installed.stderr + installed.stdout).toBe(0)
    expect(installed.stderr).toContain('skills middleware')
    expect(JSON.parse(installed.stdout).bundleId).toBe('@test/fixture')
    expect(JSON.parse(installed.stdout).items[0].status).toBe('installed')
    expect(await readFile(resolve(target, 'test-skill/assets/data.bin'))).toEqual(Buffer.from([0, 255, 42]))
    const status = await run('node', [executable, 'skills', 'status', '--path', target, '--json'], isolated)
    expect(JSON.parse(status.stdout).items[0].status).toBe('current')
    const help = await run('node', [executable, 'help', 'skills', 'add'], isolated)
    expect(help.stdout).toContain('[names...]')
    expect(help.stdout).toContain('--harness')
    expect(help.stderr).not.toContain('skills middleware')
  } finally {
    await rm(project, { recursive: true, force: true })
    await rm(isolated, { recursive: true, force: true })
  }
}, 60000)

test('custom entry points preserve application services and read portable stdin in the built CLI', async () => {
  const project = await setup()
  try {
    await writeFile(resolve(project, 'argrail.config.json'), '{"name":"fixture","entry":"src/cli.ts"}\n')
    await writeFile(resolve(project, 'src/commands/read.ts'), `import { defineCommand } from '@argrail/core'
export const Command = defineCommand.withContext<{ prefix: string }>()({
  run: async ({ ctx }) => {
    const text = await ctx.input.read({ hidden: true, maxBytes: 32, stripFinalNewline: true })
    ctx.io.json({ length: text.length, prefix: ctx.services.prefix })
  },
})\n`)
    const entry = `import { createCLI } from '@argrail/core'
import { commandTree } from './commandTree.gen.ts'
const cli = createCLI(commandTree, { name: 'fixture', context: () => ({ prefix: 'data' }) })
await cli.run()\n`
    await writeFile(resolve(project, 'src/cli.ts'), entry)
    const built = await run('node', [tooling, 'build', '--project', project], root)
    expect(built.code, built.stdout + built.stderr).toBe(0)
    expect(await readFile(resolve(project, 'src/cli.ts'), 'utf8')).toBe(entry)
    const executed = await new Promise<RunResult>((resolveResult, reject) => {
      const child = spawn('node', [resolve(project, 'dist/fixture.js'), 'read'], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      child.on('error', reject)
      child.on('exit', code => resolveResult({ code, stdout, stderr }))
      child.stdin.end('credential\n')
    })
    expect(executed.code).toBe(0)
    expect(executed.stdout).toBe('{"length":10,"prefix":"data"}\n')
    expect(executed.stderr).toBe('')
  } finally { await rm(project, { recursive: true, force: true }) }
}, 30000)

test('builds typed subtree middleware with public login and pathless command paths', async () => {
  const project = await setup()
  try {
    const directory = resolve(project, 'src/commands')
    await mkdir(resolve(directory, '_protected/users'), { recursive: true })
    await writeFile(resolve(directory, '__root.ts'), `import { createMiddleware, defineRoot } from '@argrail/core'
export const Root = defineRoot({ middleware: [createMiddleware().handler(({ next }) => next({ context: { requestId: 1 } }))] })\n`)
    await writeFile(resolve(directory, '_protected/__group.ts'), `import { CLIError, createMiddleware, defineGroup } from '@argrail/core'
export const Group = defineGroup({ middleware: [createMiddleware.withContext<{ authenticated: boolean }>().handler(({ ctx, next }) => {
  if (!ctx.services.authenticated) throw new CLIError('AUTH', 'Run login first')
  return next({ context: { user: { id: 'u1' } } })
})] })\n`)
    await writeFile(resolve(directory, '_protected/users/__group.ts'), `import { createMiddleware, defineGroup } from '@argrail/core'
export const Group = defineGroup({ middleware: [createMiddleware.withContext<{ user: { id: string } }>().handler(({ ctx, next }) => next({ context: { owner: ctx.services.user.id } }))] })\n`)
    await writeFile(resolve(directory, '_protected/users/create.ts'), `import { createFileCommand } from '@argrail/core'
export const Command = createFileCommand('/users/create')({ run: ({ ctx }) => {
  const id: string = ctx.services.user.id
  const owner: string = ctx.services.owner
  const requestId: number = ctx.services.requestId
  ctx.io.json({ id, owner, requestId })
} })\n`)
    await writeFile(resolve(directory, 'login.ts'), `import { createFileCommand } from '@argrail/core'
export const Command = createFileCommand('/login')({ run: ({ ctx }) => {
  // @ts-expect-error login does not inherit protected context
  ctx.services.user
  ctx.io.stdout.write('login\\n')
} })\n`)
    await writeFile(resolve(project, 'argrail.config.json'), '{"name":"fixture","entry":"src/cli.ts"}\n')
    const entry = (authenticated: boolean) => `import { createCLI } from '@argrail/core'
import { commandTree } from './commandTree.gen.ts'
await createCLI(commandTree, { name: 'fixture', context: () => ({ authenticated: ${authenticated} }) }).run()\n`
    await writeFile(resolve(project, 'src/cli.ts'), entry(false))
    let built = await run('node', [tooling, 'build', '--project', project], root)
    expect(built.code, built.stdout + built.stderr).toBe(0)
    const bundle = resolve(project, 'dist/fixture.js')
    const login = await run('node', [bundle, 'login'], project)
    expect(login.code).toBe(0)
    expect(login.stdout).toBe('login\n')
    const blocked = await run('node', [bundle, 'users', 'create'], project)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain('Run login first')
    expect(blocked.stdout).toBe('')
    const help = await run('node', [bundle, 'help', 'users', 'create'], project)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('fixture users create')
    await writeFile(resolve(project, 'src/cli.ts'), entry(true))
    built = await run('node', [tooling, 'build', '--project', project], root)
    expect(built.code, built.stdout + built.stderr).toBe(0)
    const allowed = await run('node', [bundle, 'users', 'create'], project)
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toBe('{"id":"u1","owner":"u1","requestId":1}\n')
  } finally { await rm(project, { recursive: true, force: true }) }
}, 30000)

test('file renames break stale paths and builds fail instead of emitting an invalid CLI', async () => {
  const project = await setup()
  try {
    expect((await run('node', [tooling, 'generate', '--project', project], root)).code).toBe(0)
    await writeFile(resolve(project, 'src/caller.ts'), `import { createCLI } from '@argrail/core'
import { commandTree } from './commandTree.gen.ts'
const cli = createCLI(commandTree, { name: 'fixture' })
cli.invoke('/greet', { options: { name: 'Ada' } })\n`)
    expect((await run('node', [tooling, 'check', '--project', project], root)).code).toBe(0)
    await rename(resolve(project, 'src/commands/greet.ts'), resolve(project, 'src/commands/hello.ts'))
    const checked = await run('node', [tooling, 'build', '--project', project], root)
    expect(checked.code).not.toBe(0)
    expect(checked.stdout).toContain('"/hello"')
    expect(checked.stdout).toContain('"/greet"')
    expect(await Bun.file(resolve(project, 'dist/fixture.js')).exists()).toBe(false)
  } finally { await rm(project, { recursive: true, force: true }) }
}, 30000)

test('background mode tracks route names, source edits, and config changes without executing commands', async () => {
  const project = await setup()
  let child: ReturnType<typeof spawn> | undefined
  let output = ''
  let allOutput = ''
  const waiters: { text: string; resolve: () => void }[] = []
  function waitFor(text: string) {
    if (output.includes(text)) return Promise.resolve()
    return new Promise<void>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${text}\n${output}`)), 15000)
      waiters.push({ text, resolve: () => { clearTimeout(timeout); resolveResult() } })
    })
  }
  try {
    await writeFile(resolve(project, 'src/commands/greet.ts'), (await readFile(resolve(project, 'src/commands/greet.ts'), 'utf8')).replace("ctx.io.stdout.write('Hello ' + options.name + '\\n')", "ctx.io.stdout.write('HANDLER_WAS_EXECUTED')"))
    await symlink(resolve(root, 'packages/skills'), resolve(project, 'node_modules/@argrail/skills'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(resolve(project, 'src/commands/skills.ts'), '')
    await mkdir(resolve(project, 'skills/test-skill/assets'), { recursive: true })
    await writeFile(resolve(project, 'skills/test-skill/SKILL.md'), '---\nname: test-skill\ndescription: Test\n---\n')
    const asset = resolve(project, 'skills/test-skill/assets/data.bin')
    await writeFile(asset, new Uint8Array([0, 255, 42]))
    await mkdir(resolve(project, 'src/commands/tasks/$id'), { recursive: true })
    await writeFile(resolve(project, 'src/commands/tasks/$id/run.ts'), '')
    child = spawn('node', [tooling, 'dev', '--project', project], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    function collect(data: Buffer) {
      output += data
      allOutput += data
      for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve()
    }
    child.stdout!.on('data', collect)
    child.stderr!.on('data', collect)
    await waitFor('Found 0 errors')
    expect(await readFile(resolve(project, 'src/commands/tasks/$id/run.ts'), 'utf8')).toContain('id: positional(string())')
    const payload = resolve(project, '.argrail/skills.bundle.ts')
    const initialPayload = await readFile(payload, 'utf8')
    output = ''
    await writeFile(asset, new Uint8Array([42, 255, 0]))
    await waitFor('Type checker will refresh')
    expect(await readFile(payload, 'utf8')).not.toBe(initialPayload)
    output = ''
    await rm(asset)
    await waitFor('Type checker will refresh')
    expect(await readFile(payload, 'utf8')).not.toContain('assets/data.bin')
    output = ''
    await writeFile(resolve(project, 'package.json'), '{"name":"@test/watched","type":"module"}\n')
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, 'src/commandTree.gen.ts'), 'utf8')).toContain('id: "@test/watched"')
    output = ''
    await rename(resolve(project, 'src/commands/greet.ts'), resolve(project, 'src/commands/hello.ts'))
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, 'src/commandTree.gen.ts'), 'utf8')).toContain('bindCommand("/hello"')
    output = ''
    await writeFile(resolve(project, 'src/commands/new.ts'), '')
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, 'src/commands/new.ts'), 'utf8')).toContain('export const Command = defineCommand({')
    output = ''
    await writeFile(resolve(project, 'src/commands/hello.ts'), (await readFile(resolve(project, 'src/commands/hello.ts'), 'utf8')).replace('return { name: options.name }', 'return { name: options.missing }'))
    await waitFor('error TS')
    output = ''
    await writeFile(resolve(project, 'argrail.config.json'), '{"name":"renamed","description":"Updated CLI"}\n')
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, '.argrail/entry.ts'), 'utf8')).toContain('Updated CLI')
    output = ''
    await rm(resolve(project, 'src/commands/new.ts'))
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, 'src/commandTree.gen.ts'), 'utf8')).not.toContain('bindCommand("/new"')
    output = ''
    await writeFile(resolve(project, 'argrail.config.json'), '{invalid')
    await waitFor('Error:')
    expect(await readFile(resolve(project, '.argrail/entry.ts'), 'utf8')).toContain('Updated CLI')
    output = ''
    await mkdir(resolve(project, 'commands'), { recursive: true })
    await writeFile(resolve(project, 'commands/moved.ts'), '')
    await writeFile(resolve(project, 'argrail.config.json'), '{"name":"renamed","commandsDirectory":"commands"}\n')
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, 'src/commandTree.gen.ts'), 'utf8')).toContain('bindCommand("/moved"')
    output = ''
    await writeFile(resolve(project, 'commands/another.ts'), '')
    await waitFor('Type checker will refresh')
    expect(await readFile(resolve(project, 'src/commandTree.gen.ts'), 'utf8')).toContain('bindCommand("/another"')
    expect(allOutput).not.toContain('HANDLER_WAS_EXECUTED')
  } finally {
    if (child) {
      const running = child
      const exited = new Promise(resolveResult => running.once('exit', resolveResult))
      child.kill('SIGTERM')
      await exited
    }
    await rm(project, { recursive: true, force: true })
  }
}, 30000)
