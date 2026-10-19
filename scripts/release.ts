import { resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--dry-run')) {
  console.error('Usage: bun run release [--dry-run]')
  process.exit(2)
}

const root = resolve(import.meta.dir, '..')
const publishFlags = args.includes('--dry-run') ? ['--dry-run'] : []
const commands = [
  ['run', 'verify'],
  ['run', 'lint:check'],
  ...['core', 'skills', 'tooling'].map(name => [
    'publish', '--cwd', resolve(root, 'packages', name), '--access', 'public', ...publishFlags,
  ]),
]

for (const command of commands) {
  const child = Bun.spawn([process.execPath, ...command], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  if (code !== 0) process.exit(code)
}
