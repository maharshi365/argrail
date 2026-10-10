import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute, sep } from 'node:path'
import { discoverSkills } from '@argrail/skills/build'
import ts from 'typescript'
import type { SkillBuildConfig } from '@argrail/skills/build'

export type ProjectConfig = Awaited<ReturnType<typeof loadConfig>>
interface Route { file: string; path: string }
type StaticValue = string | readonly StaticValue[] | { readonly [key: string]: StaticValue }

export function commandPath(file: string) {
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

async function sourceFiles(directory: string) {
  const files: string[] = []
  async function visit(dir: string) {
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

function isGroupFile(file: string) {
  return /(?:^|[\\/])__(?:root|group)\.ts$/.test(file)
}

export async function discover(directory: string) {
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

function comparePaths(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function specifier(from: string, to: string) {
  const path = relative(dirname(from), to).replaceAll('\\', '/')
  return path.startsWith('.') ? path : `./${path}`
}

export async function writeIfChanged(file: string, content: string) {
  try { if (await readFile(file, 'utf8') === content) return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
  return true
}

function within(root: string, name: string, label: string) {
  // oxlint-disable-next-line deslop/no-runtime-typeof -- Parse an untrusted configuration path before resolving it.
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new Error(`${label} must be a relative path`)
  const destination = resolve(root, name)
  const rel = relative(root, destination)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} must be inside the project`)
  return destination
}

export async function loadConfig(project: string) {
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

async function routeSkillGroups(route: Route): Promise<NonNullable<SkillBuildConfig['groups']>> {
  const source = ts.createSourceFile(route.file, await readFile(route.file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error(`${route.file}: Invalid route TypeScript`)
  function literal(node: ts.Node): StaticValue {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, StaticValue> = Object.create(null)
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) throw new Error(`${route.file}: SkillGroups must be a static object literal`)
        const name = property.name.text
        if (Object.hasOwn(result, name)) throw new Error(`${route.file}: Duplicate SkillGroups property: ${name}`)
        result[name] = literal(property.initializer)
      }
      return result
    }
    throw new Error(`${route.file}: SkillGroups must be a static object literal`)
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'SkillGroups') {
        if (!declaration.initializer) throw new Error(`${route.file}: SkillGroups must be a static object literal`)
        const groups = literal(declaration.initializer)
        if (!groups || Array.isArray(groups) || Object.getPrototypeOf(groups) !== null) throw new Error(`${route.file}: SkillGroups must be a static object literal`)
        return groups as NonNullable<SkillBuildConfig['groups']>
      }
    }
  }
  return {}
}

async function routeSkillBundle(config: ProjectConfig, commands: Route[]) {
  const route = commands.find(command => command.path === '/skills')
  if (!route) return undefined
  if (commands.some(command => command.path.startsWith('/skills/'))) throw new Error('Author command collides with skills command mount: /skills')
  const directory = resolve(config.root, 'skills')
  if (directory === config.outDirectory || directory.startsWith(config.outDirectory + sep) || config.outDirectory.startsWith(directory + sep)) throw new Error('skills directory cannot overlap outDirectory')
  let id = config.settings.name
  try { id = JSON.parse(await readFile(resolve(config.root, 'package.json'), 'utf8')).name ?? id }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Package metadata is an untrusted JSON boundary.
  // oxlint-disable-next-line deslop/no-runtime-typeof
  if (typeof id !== 'string' || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('Bundled skills require a stable package.json name or CLI name')
  return discoverSkills({ id, directory, groups: await routeSkillGroups(route) })
}

export async function generate(config: ProjectConfig, { scaffold = false } = {}) {
  const commands = await discover(config.commandsDirectory)
  const skillBundle = await routeSkillBundle(config, commands)
  if (!commands.length && !skillBundle) throw new Error('No command files found')
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
  const inheritedGroups = (index: number) => inherited[index]!
  const imports = commands.map(({ file }, index) => `import { Command as command${index} } from ${JSON.stringify(specifier(config.generatedRegistry, file))}`)
  const groupImports = groups.map(({ file, exported }, index) => `import { ${exported} as group${index} } from ${JSON.stringify(specifier(config.generatedRegistry, file))}`)
  const contextTypes = groups.length ? `\ndeclare module '@argrail/core' {\n  interface FileCommandContexts {\n${commands.map(({ path }, index) => `    ${JSON.stringify(path)}: GroupContext<[${inheritedGroups(index).map(group => `typeof group${group}`).join(', ')}]>`).join('\n')}\n  }\n}\n` : ''
  let skillRegistry = ''
  const payload = resolve(config.root, '.argrail/skills.bundle.ts')
  if (skillBundle) {
    const skillEntries = Object.entries(skillBundle.skills).map(([name, metadata]) => `    ${JSON.stringify(name)}: { ...${JSON.stringify(metadata)}, load: async () => (await import(${JSON.stringify(specifier(config.generatedRegistry, payload))})).default[${JSON.stringify(name)}] },`).join('\n')
    skillRegistry = `export const skillTree = {\n  id: ${JSON.stringify(skillBundle.id)},\n  hash: ${JSON.stringify(skillBundle.hash)},\n  groups: ${JSON.stringify(skillBundle.groups)},\n  skills: {\n${skillEntries}\n  },\n} as const\n\n`
  }
  const skillRouteIndex = commands.findIndex(command => command.path === '/skills')
  const mountedGroups = skillBundle ? [...inheritedGroups(skillRouteIndex).map(index => `group${index}`), `command${skillRouteIndex}`] : []
  const registry = `// Generated by argrail. Do not edit.\nimport { bindCommand, defineRegistry${skillBundle ? ', composeRegistries' : ''}${groups.length ? ', type GroupContext' : ''} } from '@argrail/core'\n${skillBundle ? "import { createSkillsCommands } from '@argrail/skills'\n" : ''}${imports.join('\n')}\n${groupImports.length ? groupImports.join('\n') + '\n' : ''}\n${skillRegistry}export const commandTree = ${skillBundle ? 'composeRegistries(' : ''}defineRegistry({\n${commands.map(({ path }, index) => `  ${JSON.stringify(path)}: bindCommand(${JSON.stringify(path)}, command${index}${groups.length ? `, [${inheritedGroups(index).map(group => `group${group}`).join(', ')}]` : ''}),`).join('\n')}\n})${skillBundle ? `, createSkillsCommands(skillTree, "skills", [${mountedGroups.join(', ')}]))` : ''}\n${contextTypes}`
  // Do not replace an existing user-authored file, even at the configured output path.
  try {
    const existing = await readFile(config.generatedRegistry, 'utf8')
    if (!existing.startsWith('// Generated by argrail. Do not edit.\n')) throw new Error(`Refusing to overwrite an unowned file: ${config.generatedRegistry}`)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (skillBundle) {
    try {
      if (!(await readFile(payload, 'utf8')).startsWith('// Generated by argrail. Do not edit.\n')) throw new Error(`Refusing to overwrite an unowned file: ${payload}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (scaffold) {
    for (const { file, path } of commands) {
      if (!(await readFile(file, 'utf8')).trim()) await writeFile(file, commandTemplate(path, groups.length > 0))
    }
  }
  const payloadChanged = skillBundle ? await writeIfChanged(payload, `// Generated by argrail. Do not edit.\nexport default ${JSON.stringify(skillBundle.files)} as const\n`) : false
  const changed = await writeIfChanged(config.generatedRegistry, registry) || payloadChanged
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
  return { changed, count: commands.length + (skillBundle ? 6 : 0), entry: config.entry ?? entry }
}

export async function addCommand(config: ProjectConfig, path: string) {
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
      if (a[index]!.startsWith('$') && b[index]!.startsWith('$')) throw new Error('Ambiguous dynamic command parameters')
      break
    }
  }
  const file = within(config.commandsDirectory, relativeFile, 'command file')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, commandTemplate(path), { flag: 'wx' })
  return file
}

function commandTemplate(path: string, fileBased = false) {
  const params = path.split('/').filter(segment => segment.startsWith('$')).map(segment => segment.slice(1))
  const factory = fileBased ? 'createFileCommand' : 'defineCommand'
  return `import { ${factory}${params.length ? ', positional, string' : ''} } from '@argrail/core'\n\nexport const Command = ${factory}${fileBased ? `(${JSON.stringify(path)})` : ''}({\n  description: 'Describe this command.',\n${params.length ? `  params: {\n${params.map(name => `    ${name}: positional(string()),`).join('\n')}\n  },\n` : ''}  run: ({ ctx }) => {\n    ctx.io.json({ ok: true })\n    return { ok: true }\n  },\n})\n`
}

/** Poll directory names only. Bun/Windows recursive fs.watch behavior varies. */
export async function directorySnapshot(directory: string) {
  const entries: string[] = []
  async function visit(dir: string) {
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

/** Skills can change without adding a file, including binary resources. */
export async function skillsSnapshot(config: ProjectConfig) {
  return (await routeSkillBundle(config, await discover(config.commandsDirectory)))?.hash ?? ''
}
