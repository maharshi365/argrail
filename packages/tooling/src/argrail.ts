#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, chmod } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { watch } from 'chokidar'
import { build } from 'esbuild'
import { loadConfig, generate, addCommand, type ProjectConfig } from './generator.ts'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const requested = args.shift() ?? 'help'
const action = requested === '--help' || requested === '-h' ? 'help' : requested
let project = '.'
let commandPath
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--project' && args[index + 1]) project = args[++index]!
  else if (action === 'add' && commandPath === undefined && !args[index]!.startsWith('-')) commandPath = args[index]
  else if (args[index] === '--help' || args[index] === '-h') { showHelp(); process.exit(0) }
  else { console.error(`Error: unknown or incomplete option ${args[index]}`); process.exit(2) }
}

function showHelp() {
  console.log(`Usage: argrail <command> [options]

Commands:
  generate  Generate the typed command registry and entry point.
  check     Generate and check all command types.
  dev       Watch routes and run a background type checker.
  build     Check and build a standalone CLI.
  add <path> Create a command file without overwriting existing code.
  help      Show this help.

Options:
  --project <directory>  Project containing argrail.config.json. Default: .
  -h, --help             Show help.`)
}

function compiler(watch = false): [string, string[]] {
  let bin
  try { bin = require.resolve('typescript/bin/tsc') }
  catch { throw new Error('TypeScript is required for checks. Install it with: npm install -D typescript') }
  return [process.execPath, [bin, '-p', '.argrail/tsconfig.json', '--pretty', 'false', ...(watch ? ['--watch', '--preserveWatchOutput'] : [])]]
}

function run(command: string, argv: string[], cwd: string) {
  return new Promise<number>((resolveResult, reject) => {
    const child = spawn(command, argv, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolveResult(code ?? (signal ? 1 : 0)))
  })
}

async function dev(config: ProjectConfig) {
  let lastError: string | undefined
  compiler() // Fail early with the same actionable error as one-shot checks.
  function inside(directory: string, file: string) {
    return file === directory || file.startsWith(directory + sep)
  }
  const watcher = watch(config.root, {
    ignoreInitial: true,
    ignored: file => {
      const parts = relative(config.root, file).split(sep)
      return parts.some(part => ['node_modules', '.git', '.argrail'].includes(part))
        || inside(config.outDirectory, file)
        || file === config.generatedRegistry
    },
  })
  let busy = false
  let stopped = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    if (busy || stopped) return
    busy = true
    pending = false
    try {
      const nextConfig = await loadConfig(config.root)
      // Retain the last valid configuration and registry on failure.
      const result = await generate(nextConfig, { scaffold: true })
      config = nextConfig
      lastError = undefined
      console.log(`Generated ${result.count} commands. Type checker will refresh.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) console.error(`Error: ${message}`)
      lastError = message
    } finally {
      busy = false
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Watch events and shutdown can change these flags during awaited generation.
      if (pending && !stopped) schedule()
    }
  }
  function schedule() {
    pending = true
    clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, 100)
  }
  watcher.on('all', (_event, file) => {
    if (stopped) return
    const commandPath = relative(config.commandsDirectory, file).split(sep)
    const command = inside(config.commandsDirectory, file)
      && !commandPath.some(part => part.startsWith('-') || part.startsWith('.') || part === 'node_modules')
      && file.endsWith('.ts') && !/\.(?:d|test|spec|gen)\.ts$/.test(file)
    if (command || inside(resolve(config.root, 'skills'), file)
      || file === resolve(config.root, 'argrail.config.json')
      || file === resolve(config.root, 'package.json')) schedule()
  })
  try {
    await new Promise<void>((ready, reject) => {
      watcher.once('ready', ready)
      watcher.once('error', reject)
    })
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    await watcher.close()
    throw error
  }
  const checker = spawn(process.execPath, [fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './checker.ts' : './checker.js', import.meta.url)), resolve(config.root, '.argrail/tsconfig.json')], {
    cwd: config.root, stdio: ['pipe', 'inherit', 'inherit'],
  })
  console.log('Watching command files. Commands are never executed automatically. Press Ctrl+C to stop.')
  function stop(code: number) {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    void watcher.close()
    checker.stdin.end()
    process.exitCode = code
  }
  watcher.on('error', error => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); stop(1) })
  checker.on('error', error => { console.error(`Error: ${error.message}`); stop(1) })
  checker.on('exit', code => { if (!stopped) stop(code ?? 1) })
  process.once('SIGINT', () => stop(0))
  process.once('SIGTERM', () => stop(0))
}

try {
  if (action === 'help') showHelp()
  else {
    if (!['generate', 'check', 'dev', 'build', 'add'].includes(action)) throw new Error(`Unknown command: ${action}`)
    const config = await loadConfig(project)
    if (action === 'add') console.log(`Created ${await addCommand(config, commandPath!)}`)
    const generated = await generate(config, { scaffold: action === 'dev' })
    console.log(`${generated.changed ? 'Generated' : 'Up to date:'} ${generated.count} commands.`)
    if (action === 'dev') await dev(config)
    if (action === 'check' || action === 'build') {
      const [command, argv] = compiler()
      const code = await run(command, argv, config.root)
      if (code !== 0) process.exitCode = code
      else if (action === 'build') {
        await mkdir(config.outDirectory, { recursive: true })
        const outfile = resolve(config.outDirectory, config.settings.name + '.js')
        await build({
          absWorkingDir: config.root,
          entryPoints: [generated.entry],
          outfile,
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node22',
        })
        if (process.platform !== 'win32') await chmod(outfile, 0o755)
        console.log(`Built ${outfile}`)
      }
    }
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
