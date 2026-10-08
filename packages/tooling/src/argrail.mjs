#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdir, chmod, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { loadConfig, generate, directorySnapshot, addCommand } from './generator.mjs'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const requested = args.shift() ?? 'help'
const action = requested === '--help' || requested === '-h' ? 'help' : requested
let project = '.'
let compile = false
let commandPath
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--project' && args[index + 1]) project = args[++index]
  else if (args[index] === '--compile') compile = true
  else if (action === 'add' && commandPath === undefined && !args[index].startsWith('-')) commandPath = args[index]
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
  --compile              Build a native executable (build only).
  -h, --help             Show help.`)
}

function compiler(watch = false) {
  let bin
  try { bin = require.resolve('typescript/bin/tsc') }
  catch { throw new Error('TypeScript is required for checks. Install it with: bun add -d typescript') }
  return [process.execPath, [bin, '-p', '.argrail/tsconfig.json', '--pretty', 'false', ...(watch ? ['--watch', '--preserveWatchOutput'] : [])]]
}

function run(command, argv, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, argv, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolveResult(code ?? (signal ? 1 : 0)))
  })
}

async function dev(config) {
  compiler() // Fail early with the same actionable error as one-shot checks.
  const checker = spawn(process.execPath, [fileURLToPath(new URL('./checker.mjs', import.meta.url)), resolve(config.root, '.argrail/tsconfig.json')], {
    cwd: config.root, stdio: ['pipe', 'inherit', 'inherit'],
  })
  let snapshot = await directorySnapshot(config.commandsDirectory)
  let configuration = await readFile(resolve(config.root, 'argrail.config.json'), 'utf8')
  let busy = false
  let stopped = false
  console.log('Watching command files. Commands are never executed automatically. Press Ctrl+C to stop.')
  const timer = setInterval(async () => {
    if (busy || stopped) return
    busy = true
    try {
      const nextConfiguration = await readFile(resolve(config.root, 'argrail.config.json'), 'utf8')
      const nextConfig = nextConfiguration === configuration ? config : await loadConfig(config.root)
      const current = await directorySnapshot(nextConfig.commandsDirectory)
      if (current !== snapshot || nextConfiguration !== configuration) {
        // Generate first: on failure retain the last valid registry and retry next tick.
        const result = await generate(nextConfig, { scaffold: true })
        snapshot = current
        configuration = nextConfiguration
        config = nextConfig
        dev.lastError = undefined
        console.log(`Generated ${result.count} commands. Type checker will refresh.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== dev.lastError) console.error(`Error: ${message}`)
      dev.lastError = message
    } finally { busy = false }
  }, 250)
  function stop(code) {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    checker.stdin.end()
    process.exitCode = code
  }
  checker.on('error', error => { console.error(`Error: ${error.message}`); stop(1) })
  checker.on('exit', code => { if (!stopped) stop(code ?? 1) })
  process.once('SIGINT', () => stop(0))
  process.once('SIGTERM', () => stop(0))
}

try {
  if (action === 'help') showHelp()
  else {
    if (!['generate', 'check', 'dev', 'build', 'add'].includes(action)) throw new Error(`Unknown command: ${action}`)
    if (compile && action !== 'build') throw new Error('--compile is only valid for build')
    const config = await loadConfig(project)
    if (action === 'add') console.log(`Created ${await addCommand(config, commandPath)}`)
    const generated = await generate(config, { scaffold: action === 'dev' })
    console.log(`${generated.changed ? 'Generated' : 'Up to date:'} ${generated.count} commands.`)
    if (action === 'dev') await dev(config)
    if (action === 'check' || action === 'build') {
      const [command, argv] = compiler()
      const code = await run(command, argv, config.root)
      if (code !== 0) process.exitCode = code
      else if (action === 'build') {
        await mkdir(config.outDirectory, { recursive: true })
        const outfile = resolve(config.outDirectory, config.settings.name + (compile ? (process.platform === 'win32' ? '.exe' : '') : '.js'))
        const flags = compile ? ['--compile'] : ['--target=node']
        const buildCode = await run(process.execPath, ['build', generated.entry, ...flags, '--outfile', outfile], config.root)
        process.exitCode = buildCode
        if (!buildCode) {
          if (process.platform !== 'win32') await chmod(outfile, 0o755)
          console.log(`Built ${outfile}`)
        }
      }
    }
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
