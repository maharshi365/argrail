import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute, sep } from 'node:path'

export function commandPath(file) {
  const parts = file.replaceAll('\\', '/').replace(/\.ts$/, '').split('/')
  if (parts.some((part, index) => !/^(?:[a-z][a-z0-9-]*|\$[a-zA-Z][a-zA-Z0-9]*)$/.test(part) && !(index < parts.length - 1 && /^_[a-z][a-z0-9-]*$/.test(part)))) {
    throw new Error(`Invalid command filename: ${file}. Use lowercase kebab-case or $parameter.`)
  }
  if (parts.at(-1) === 'index') parts.pop()
  const segments = parts.filter(part => !part.startsWith('_'))
  if (segments[0] === 'help') throw new Error('help is a reserved root command')
  const params = segments.filter(part => part.startsWith('$'))
  if (new Set(params).size !== params.length) throw new Error(`Repeated positional name: ${file}`)
  return segments.length ? `/${segments.join('/')}` : '/'
}

async function sourceFiles(directory) {
  const files = []
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('-') || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:d|test|spec|gen)\.ts$/.test(entry.name)) files.push(full)
    }
  }
  await visit(directory)
  return files.sort(comparePaths)
}

function isGroupFile(file) {
  return /(?:^|[\\/])__(?:root|group)\.ts$/.test(file)
}

export async function discover(directory) {
  const files = await sourceFiles(directory)
  const paths = new Set()
  const dynamic = new Map()
  return files.filter(file => !isGroupFile(file)).map(file => {
    const path = commandPath(relative(directory, file))
    if (paths.has(path)) throw new Error(`Duplicate command path: ${path}`)
    paths.add(path)
    let prefix = ''
    for (const segment of path.slice(1).split('/').filter(Boolean)) {
      if (segment.startsWith('$')) {
        if (dynamic.has(prefix) && dynamic.get(prefix) !== segment) throw new Error(`Ambiguous dynamic commands below ${prefix || '/'}`)
        dynamic.set(prefix, segment)
      }
      prefix += `/${segment}`
    }
    return { file, path }
  })
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function specifier(from, to) {
  const path = relative(dirname(from), to).replaceAll('\\', '/')
  return path.startsWith('.') ? path : `./${path}`
}

export async function writeIfChanged(file, content) {
  try { if (await readFile(file, 'utf8') === content) return false }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
  return true
}

function within(root, name, label) {
  // oxlint-disable-next-line deslop/no-runtime-typeof -- Parse an untrusted configuration path before resolving it.
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error(`${label} must be a relative path`)
  const destination = resolve(root, name)
  const rel = relative(root, destination)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} must be inside the project`)
  return destination
}

export async function loadConfig(project) {
  const root = resolve(project)
  const raw = JSON.parse(await readFile(resolve(root, 'argrail.config.json'), 'utf8'))
  const allowed = new Set(['name', 'version', 'description', 'width', 'commandsDirectory', 'generatedRegistry', 'outDirectory', 'entry'])
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown configuration key: ${key}`)
  // Configuration JSON is a parsing boundary; check types before using its fields.
  /* oxlint-disable deslop/no-runtime-typeof */
  if (typeof raw.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(raw.name)) throw new Error('Configuration requires a valid CLI name')
  for (const key of ['version', 'description']) if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`${key} must be text`)
  /* oxlint-enable deslop/no-runtime-typeof */
  if (raw.width !== undefined && (!Number.isInteger(raw.width) || raw.width < 40)) throw new Error('width must be an integer of at least 40')
  const commandsDirectory = within(root, raw.commandsDirectory ?? 'src/commands', 'commandsDirectory')
  const generatedRegistry = within(root, raw.generatedRegistry ?? 'src/commandTree.gen.ts', 'generatedRegistry')
  if (!generatedRegistry.endsWith('.gen.ts')) throw new Error('generatedRegistry must end in .gen.ts')
  const outDirectory = within(root, raw.outDirectory ?? 'dist', 'outDirectory')
  if (outDirectory === commandsDirectory || commandsDirectory.startsWith(outDirectory + sep)) throw new Error('outDirectory cannot contain command sources')
  return {
    root, commandsDirectory, generatedRegistry, outDirectory,
    entry: raw.entry === undefined ? undefined : within(root, raw.entry, 'entry'),
    settings: Object.fromEntries(['name', 'version', 'description', 'width'].flatMap(key => raw[key] === undefined ? [] : [[key, raw[key]]])),
  }
}

export async function generate(config, { scaffold = false } = {}) {
  const commands = await discover(config.commandsDirectory)
  if (!commands.length) throw new Error('No command files found')
  const files = await sourceFiles(config.commandsDirectory)
  const groups = files.filter(file => isGroupFile(file) || /(?:^|[\\/])index\.ts$/.test(file)).map(file => {
    const name = relative(config.commandsDirectory, file).replaceAll('\\', '/')
    if (name.endsWith('__root.ts') && name !== '__root.ts') throw new Error('__root.ts is only allowed at the command root')
    if (name === '__group.ts') throw new Error('Use __root.ts at the command root')
    commandPath(name.replace(/__(?:root|group)\.ts$/, 'index.ts'))
    return { file, directory: dirname(file), exported: name.endsWith('__root.ts') ? 'Root' : name.endsWith('__group.ts') ? 'Group' : 'Command' }
  }).sort((a, b) => a.directory.split(sep).length - b.directory.split(sep).length || comparePaths(a.file, b.file))
  const inherited = commands.map(({ file }) => groups.flatMap((group, index) => {
    const rel = relative(group.directory, file)
    return group.file !== file && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? [index] : []
  }))
  const imports = commands.map(({ file }, index) => `import { Command as command${index} } from ${JSON.stringify(specifier(config.generatedRegistry, file))}`)
  const groupImports = groups.map(({ file, exported }, index) => `import { ${exported} as group${index} } from ${JSON.stringify(specifier(config.generatedRegistry, file))}`)
  const contextTypes = groups.length ? `\ndeclare module '@argrail/core' {\n  interface FileCommandContexts {\n${commands.map(({ path }, index) => `    ${JSON.stringify(path)}: GroupContext<[${inherited[index].map(group => `typeof group${group}`).join(', ')}]>`).join('\n')}\n  }\n}\n` : ''
  const registry = `// Generated by argrail. Do not edit.\nimport { bindCommand, defineRegistry${groups.length ? ', type GroupContext' : ''} } from '@argrail/core'\n${imports.join('\n')}\n${groupImports.length ? groupImports.join('\n') + '\n' : ''}\nexport const commandTree = defineRegistry({\n${commands.map(({ path }, index) => `  ${JSON.stringify(path)}: bindCommand(${JSON.stringify(path)}, command${index}${groups.length ? `, [${inherited[index].map(group => `group${group}`).join(', ')}]` : ''}),`).join('\n')}\n})\n${contextTypes}`
  // Do not replace an existing user-authored file, even at the configured output path.
  try {
    const existing = await readFile(config.generatedRegistry, 'utf8')
    if (!existing.startsWith('// Generated by argrail. Do not edit.\n')) throw new Error(`Refusing to overwrite an unowned file: ${config.generatedRegistry}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (scaffold) {
    for (const { file, path } of commands) {
      if (!(await readFile(file, 'utf8')).trim()) await writeFile(file, commandTemplate(path, groups.length > 0))
    }
  }
  const changed = await writeIfChanged(config.generatedRegistry, registry)
  const entry = resolve(config.root, '.argrail/entry.ts')
  if (!config.entry) {
    await writeIfChanged(entry, `#!/usr/bin/env node\n// Generated by argrail. Do not edit.\nimport { createCLI } from '@argrail/core'\nimport { commandTree } from ${JSON.stringify(specifier(entry, config.generatedRegistry))}\n\nconst cli = createCLI(commandTree, ${JSON.stringify(config.settings, null, 2)})\nawait cli.run()\n`)
  }
  // The tool owns the include list so generated route checks cannot be silently excluded.
  await writeIfChanged(resolve(config.root, '.argrail/tsconfig.json'), JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: { noEmit: true, strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, allowImportingTsExtensions: true, moduleResolution: 'Bundler', module: 'ESNext', target: 'ES2022' },
    files: [specifier(resolve(config.root, '.argrail/tsconfig.json'), config.entry ?? entry), specifier(resolve(config.root, '.argrail/tsconfig.json'), config.generatedRegistry)],
    exclude: [],
  }, null, 2) + '\n')
  return { changed, count: commands.length, entry: config.entry ?? entry }
}

export async function addCommand(config, path) {
  // oxlint-disable-next-line deslop/no-runtime-typeof -- Validate caller input before interpreting it as a command path.
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Use an absolute command path such as /tasks/$id')
  const relativeFile = path === '/' ? 'index.ts' : path.slice(1) + '.ts'
  if (commandPath(relativeFile) !== path) throw new Error('index is reserved for group entry files')
  await mkdir(config.commandsDirectory, { recursive: true })
  const existing = await discover(config.commandsDirectory)
  if (existing.some(command => command.path === path)) throw new Error(`Command already exists: ${path}`)
  // Check dynamic siblings before creating a new file.
  for (const command of existing) {
    const a = command.path.slice(1).split('/')
    const b = path.slice(1).split('/')
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] === b[index]) continue
      if (a[index].startsWith('$') && b[index].startsWith('$')) throw new Error('Ambiguous dynamic command parameters')
      break
    }
  }
  const file = within(config.commandsDirectory, relativeFile, 'command file')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, commandTemplate(path), { flag: 'wx' })
  return file
}

function commandTemplate(path, fileBased = false) {
  const params = path.split('/').filter(segment => segment.startsWith('$')).map(segment => segment.slice(1))
  const factory = fileBased ? 'createFileCommand' : 'defineCommand'
  return `import { ${factory}${params.length ? ', positional, string' : ''} } from '@argrail/core'\n\nexport const Command = ${factory}${fileBased ? `(${JSON.stringify(path)})` : ''}({\n  description: 'Describe this command.',\n${params.length ? `  params: {\n${params.map(name => `    ${name}: positional(string()),`).join('\n')}\n  },\n` : ''}  run: ({ ctx }) => {\n    ctx.io.json({ ok: true })\n    return { ok: true }\n  },\n})\n`
}

/** Poll directory names only. Bun/Windows recursive fs.watch behavior varies. */
export async function directorySnapshot(directory) {
  const entries = []
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('-') || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const file = resolve(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile() && entry.name.endsWith('.ts')) entries.push(relative(directory, file))
    }
  }
  await visit(directory)
  return entries.sort(comparePaths).join('\n')
}
