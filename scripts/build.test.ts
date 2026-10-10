import { test, expect } from 'bun:test'
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dir, '..')
const require = createRequire(import.meta.url)

test('built packages run and expose declarations without their TypeScript sources', async () => {
  const project = await mkdtemp(resolve(process.env.TEMP ? resolve(process.env.TEMP, 'opencode') : tmpdir(), 'argrail-packages-'))
  try {
    for (const name of ['core', 'skills']) {
      const destination = resolve(project, 'node_modules/@argrail', name)
      await mkdir(destination, { recursive: true })
      await cp(resolve(root, 'packages', name, 'dist'), resolve(destination, 'dist'), { recursive: true })
      await cp(resolve(root, 'packages', name, 'package.json'), resolve(destination, 'package.json'))
    }
    await writeFile(resolve(project, 'package.json'), '{"type":"module"}')
    await writeFile(resolve(project, 'app.ts'), `import { createCLI, defineCommand, bindCommand } from '@argrail/core'
import { listHarnesses } from '@argrail/skills'
const cli = createCLI({ '/hello': bindCommand('/hello', defineCommand({ run: () => 'hello' })) }, { name: 'app' })
const harnesses: string[] = listHarnesses().map(harness => harness.id)
console.log(await cli.invoke('/hello', {}), harnesses.includes('codex'))
`)
    await writeFile(resolve(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], outDir: 'dist' },
      include: ['app.ts'],
    }))
    const compiler = Bun.spawn([process.execPath, require.resolve('typescript/bin/tsc'), '-p', resolve(project, 'tsconfig.json')], { stdout: 'pipe', stderr: 'pipe' })
    const diagnostics = await new Response(compiler.stdout).text()
    expect(await compiler.exited, diagnostics).toBe(0)
    const app = Bun.spawn(['node', resolve(project, 'dist/app.js')], { cwd: project, stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(app.stdout).text()
    const errors = await new Response(app.stderr).text()
    expect(await app.exited, errors).toBe(0)
    expect(output.trim()).toBe('hello true')
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}, 30000)
