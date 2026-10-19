import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { syncHarnesses } from './sync-harnesses.ts'

const root = resolve(import.meta.dir, '..')
const require = createRequire(import.meta.url)

export async function build() {
  await syncHarnesses()
  await rm(resolve(root, '.argrail/build'), { recursive: true, force: true })
  const compiler = Bun.spawn([process.execPath, require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (await compiler.exited !== 0) throw new Error('Package compilation failed')
  for (const name of ['core', 'skills', 'tooling']) {
    const destination = resolve(root, 'packages', name, 'dist')
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await cp(resolve(root, '.argrail/build/packages', name, 'src'), destination, { recursive: true })
    for (const file of ['LICENSE', 'README.md']) {
      await cp(resolve(root, file), resolve(root, 'packages', name, file))
    }
  }
}

if (import.meta.main) await build()
