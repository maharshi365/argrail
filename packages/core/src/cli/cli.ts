import { optionName, pathSegments, type AnyCommand, type Arguments, type Input, type Output, type CommandInput, type CommandResult, type CommandHandlerInput, type Section } from '../command/command.ts'
import { table, wrap } from './format.ts'
import { ValidationError, schemaValue } from '../values/values.ts'
import { CLIError, CancelledError, checkSignal, type Failure } from '../execution/errors.ts'
import { createIO, memoryPorts, type IO, type IOPorts } from '../io/io.ts'
import { createInput } from '../io/input.ts'
import type { CommandContext } from '../execution/context.ts'
import { processRuntime } from '../io/process.ts'
import { runMiddleware, type MiddlewareContext, type MiddlewareRequirements, type MiddlewareList } from '../execution/middleware.ts'
import type { Group, GroupMiddleware } from '../command/group.ts'

type Registry = Record<string, AnyCommand>
type ExecutablePaths<R extends Registry> = { [P in keyof R]: R[P]['run'] extends (...args: any[]) => any ? P : never }[keyof R] & string
type MiddlewareAt<R extends Registry, P extends string> = P extends keyof R ? R[P]['middleware'] : []
type SegmentMiddleware<R extends Registry, Rest extends string, Prefix extends string = ''> = Rest extends `${infer Segment}/${infer Tail}`
  ? [...MiddlewareAt<R, `${Prefix}/${Segment}`>, ...SegmentMiddleware<R, Tail, `${Prefix}/${Segment}`>] : []
type AncestorMiddleware<R extends Registry, P extends string> = P extends `/${infer Rest}`
  ? P extends '/' ? [] : [...MiddlewareAt<R, '/'>, ...SegmentMiddleware<R, Rest>] : []
type CommandMiddleware<R extends Registry, P extends keyof R & string> = R[P] extends { groups: infer G extends readonly Group[] }
  ? [...GroupMiddleware<G>, ...R[P]['middleware']] : [...AncestorMiddleware<R, P>, ...R[P]['middleware']]
type Services<C extends AnyCommand, M extends MiddlewareList> = (CommandHandlerInput<C> extends { ctx: CommandContext<infer S> }
  ? Omit<S, keyof MiddlewareContext<M>> : {}) & MiddlewareRequirements<M>
type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never
type RequiredServices<R extends Registry> = Intersect<{ [P in keyof R & string]: Services<R[P], CommandMiddleware<R, P>> }[keyof R & string]>
type IsUnion<T, Whole = T> = T extends Whole ? [Whole] extends [T] ? false : true : never

export interface CLISettings {
  name: string
  version?: string
  description?: string
  width?: number
  sections?: readonly Section[]
  presentation?: {
    failure?: (failure: Failure, io: IO) => number
    version?: (version: string, io: IO) => void
    help?: (text: string, io: IO) => void
  }
}

export interface ExecutionOptions { io?: IOPorts; signal?: AbortSignal }
export interface TestOptions { argv: readonly string[]; stdin?: string; answers?: readonly unknown[]; signal?: AbortSignal }
type Settings<R extends Registry> = CLISettings & ({} extends RequiredServices<R>
  ? { context?: () => RequiredServices<R> | Promise<RequiredServices<R>> }
  : { context: () => RequiredServices<R> | Promise<RequiredServices<R>> })

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  value?: unknown
}

interface Tokens {
  words: string[]
  options: Record<string, string | string[] | boolean | undefined>
  errors: string[]
  help: boolean
}

interface CompiledCommand {
  command: AnyCommand
  segments: string[]
  aliases: Map<string, { key: string; negated: boolean; takesValue: boolean }>
  arities: Map<string, boolean>
  args: Arguments
}

interface OptionScope {
  children: Map<string, OptionScope>
  dynamic: OptionScope | undefined
  own: Map<string, boolean>
  all: Map<string, boolean | null>
}

function optionScope(): OptionScope {
  return { children: new Map(), dynamic: undefined, own: new Map(), all: new Map() }
}

function compileCommands(registry: Registry): CompiledCommand[] {
  const entries = Object.values(registry).map(command => {
    const aliases: CompiledCommand['aliases'] = new Map()
    for (const [key, descriptor] of Object.entries<Arguments[string]>(command.options)) {
      const alias = { key, negated: false, takesValue: descriptor.kind !== 'flag' }
      aliases.set(`--${optionName(key)}`, alias)
      if (descriptor.short) aliases.set(`-${descriptor.short}`, alias)
      if (descriptor.kind === 'flag' && descriptor.negate) aliases.set(`--no-${optionName(key)}`, { ...alias, negated: true })
    }
    return { command, segments: pathSegments(command.path), aliases, arities: new Map<string, boolean>(), args: Object.fromEntries(command.args.map(arg => [arg.name, arg])) }
  }).sort(routePriority)
  const root = optionScope()
  for (const entry of entries) {
    let node = root
    for (const segment of entry.segments) {
      if (segment.startsWith('$')) node = node.dynamic ??= optionScope()
      else {
        let child = node.children.get(segment)
        if (!child) { child = optionScope(); node.children.set(segment, child) }
        node = child
      }
    }
    for (const [name, alias] of entry.aliases) node.own.set(name, alias.takesValue)
  }
  function collect(node: OptionScope): Map<string, boolean | null> {
    for (const [name, arity] of node.own) node.all.set(name, arity)
    const children = [...node.children.values(), ...(node.dynamic ? [node.dynamic] : [])]
    for (const child of children) {
      for (const [name, arity] of collect(child)) {
        node.all.set(name, node.all.has(name) && node.all.get(name) !== arity ? null : arity)
      }
    }
    return node.all
  }
  collect(root)
  for (const entry of entries) {
    function merge(arities: Map<string, boolean | null>, allowUnknownConflict = false) {
      for (const [name, arity] of arities) {
        // An ancestor with no such option cannot outrank its matching descendants.
        if (arity === null && allowUnknownConflict && !entry.aliases.has(name)) continue
        if (arity === null || (entry.arities.has(name) && entry.arities.get(name) !== arity)) {
          throw new ValidationError(`conflicting option arity for ${name} around ${entry.command.path}`)
        }
        entry.arities.set(name, arity)
      }
    }
    let nodes = [root]
    merge(root.own)
    for (const segment of entry.segments) {
      nodes = nodes.flatMap(node => {
        const children = segment.startsWith('$') ? [...node.children.values()] : [node.children.get(segment)].filter((child): child is OptionScope => child !== undefined)
        if (node.dynamic) children.push(node.dynamic)
        return children
      })
      for (const node of nodes) merge(node.own)
    }
    if (entry.command.run) {
      for (const node of nodes) merge(node.all, nodes.length === 1)
    }
  }
  return entries
}

function tokenize(argv: readonly string[], entry: CompiledCommand): Tokens {
  const result: Tokens = { words: [], options: {}, errors: [], help: false }
  let positionalOnly = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!positionalOnly && token === '--') { positionalOnly = true; continue }
    if (!positionalOnly && (token === '--help' || token === '-h')) { result.help = true; continue }
    if (positionalOnly || token === '-' || !token.startsWith('-') || /^-\d/.test(token)) { result.words.push(token); continue }
    const equals = token.indexOf('=')
    const name = equals < 0 ? token : token.slice(0, equals)
    const alias = entry.aliases.get(name)
    if (!alias) result.errors.push('Unknown option. Run --help to see supported options.')
    if (!entry.arities.has(name)) continue
    const repeated = alias && entry.command.options[alias.key]?.repeated
    if (alias && !repeated && Object.prototype.hasOwnProperty.call(result.options, alias.key)) result.errors.push(`option ${name} was supplied more than once`)
    function assign(text: string) {
      if (!alias) return
      if (repeated) {
        const previous = result.options[alias.key]
        result.options[alias.key] = [...(Array.isArray(previous) ? previous : []), text]
      }
      else result.options[alias.key] = text
    }
    if (!entry.arities.get(name)) {
      if (alias && equals >= 0) result.errors.push(`flag ${name} does not accept a value`)
      if (alias) result.options[alias.key] = !alias.negated
    } else if (equals >= 0) {
      assign(token.slice(equals + 1))
    } else {
      const next = argv[index + 1]
      if (next === undefined || (next !== '-' && next.startsWith('-') && !/^-\d/.test(next))) {
        if (alias) result.errors.push(`missing value for ${name}`)
      } else {
        assign(next)
        index++
      }
    }
  }
  return result
}

// oxlint-disable-next-line deslop/no-unknown-parameters -- Argument bags are validated at the invocation boundary.
function decodeArguments(definitions: Arguments, supplied: unknown, label: string, schema?: AnyCommand['validateOptions']): Output<Arguments> {
  // oxlint-disable-next-line deslop/no-runtime-typeof -- JavaScript callers can pass non-object argument bags.
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    throw new ValidationError(`${label} values must be an object`)
  }
  const result: Output<Arguments> = {}
  for (const key of Object.keys(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, key)) throw new ValidationError(`unknown ${label}`)
  }
  if (schema) return schemaValue(`${label} values`, schema).validate(supplied)
  for (const [key, descriptor] of Object.entries(definitions)) {
    // SAFETY: supplied is a non-null object; descriptors validate each property before use.
    const input = Object.prototype.hasOwnProperty.call(supplied, key) ? (supplied as Input<Arguments>)[key] : undefined
    if (input === undefined) {
      if (descriptor.hasDefault) result[key] = descriptor.value.validate(descriptor.defaultValue)
      else if (descriptor.required) throw new ValidationError(`missing ${label}: ${key}`)
      else result[key] = undefined
      continue
    }
    try { result[key] = descriptor.value.validate(input) }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error
      throw new ValidationError(`${label} ${key}: ${error.message}`)
    }
  }
  return result
}

function decodeShellArguments(definitions: Arguments, supplied: Tokens['options'], label: string, schema?: AnyCommand['validateOptions']): Output<Arguments> {
  if (schema) return schemaValue(`${label} values`, schema).validate(supplied)
  const result: Output<Arguments> = {}
  for (const [key, descriptor] of Object.entries(definitions)) {
    const input = Object.prototype.hasOwnProperty.call(supplied, key) ? supplied[key] : undefined
    if (input === undefined) {
      if (descriptor.hasDefault) result[key] = descriptor.value.validate(descriptor.defaultValue)
      else if (descriptor.required) throw new ValidationError(`missing ${label}: ${key}`)
      else result[key] = undefined
      continue
    }
    try {
      if (descriptor.element && (descriptor.repeated || descriptor.variadic)) {
        if (!Array.isArray(input)) throw new ValidationError('expected repeated text values')
        const element = descriptor.element
        result[key] = input.map(text => element.decode ? element.decode(text) : element.validate(element.parse(text)))
      } else if (descriptor.kind === 'flag') result[key] = descriptor.value.validate(input)
      else {
        // oxlint-disable-next-line deslop/no-runtime-typeof -- Check the tokenizer's scalar representation before decoding text.
        if (typeof input !== 'string') throw new ValidationError('expected text')
        result[key] = descriptor.value.decode ? descriptor.value.decode(input) : descriptor.value.validate(descriptor.value.parse(input))
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error
      throw new ValidationError(`${label} ${key}: ${error.message}`)
    }
  }
  return result
}

function matches(segments: string[], words: string[], partial = false): boolean {
  if (partial ? words.length > segments.length : words.length !== segments.length) return false
  return words.every((word, index) => segments[index]!.startsWith('$') || segments[index] === word)
}

function routePriority(a: { segments: string[] }, b: { segments: string[] }): number {
  for (let index = 0; index < Math.min(a.segments.length, b.segments.length); index++) {
    const aDynamic = a.segments[index]!.startsWith('$')
    const bDynamic = b.segments[index]!.startsWith('$')
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1
  }
  return b.segments.length - a.segments.length
}

function assertRoutes(registry: Registry): void {
  const dynamic = new Map<string, string>()
  for (const [path, command] of Object.entries(registry)) {
    if (path !== command.path) throw new ValidationError(`registry key does not match ${command.path}`)
    const segments = pathSegments(path)
    if (segments[0] === 'help') throw new ValidationError('help is a reserved root command')
    let prefix = ''
    for (const segment of segments) {
      if (segment.startsWith('$')) {
        const previous = dynamic.get(prefix)
        if (previous && previous !== segment) throw new ValidationError(`ambiguous dynamic commands below ${prefix || '/'}`)
        dynamic.set(prefix, segment)
      }
      prefix += `/${segment}`
    }
  }
}

export function createCLI<const R extends Registry>(registry: R & { [P in keyof R]: { readonly path: P } }, settings: Settings<R>) {
  assertRoutes(registry)
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(settings.name)) throw new ValidationError('invalid CLI name')
  const width = Math.max(40, settings.width ?? 80)
  const entries = compileCommands(registry)
  const byPath = new Map(entries.map(entry => [entry.command.path, entry]))
  const groups = entries.filter(entry => !entry.command.run)

  function resolve(argv: readonly string[]) {
    for (const entry of groups) {
      const tokens = tokenize(argv, entry)
      if (matches(entry.segments, tokens.words)) return { ...entry, tokens }
    }
    for (const entry of entries) {
      const tokens = tokenize(argv, entry)
      const { words } = tokens
      const { segments, command } = entry
      const matched = words.length < segments.length
        ? tokens.help && matches(segments, words, true) && segments.slice(words.length).every(segment => segment.startsWith('$'))
        : matches(segments, words.slice(0, segments.length)) && (command.args.at(-1)?.variadic || words.length <= segments.length + command.args.length)
      if (!matched) continue
      return { ...entry, tokens }
    }
    return undefined
  }

  function groupPath(words: string[]): string | undefined {
    const group = entries.find(entry => matches(entry.segments, words, true))
    return group ? `/${group.segments.slice(0, words.length).join('/')}` : undefined
  }

  function help(path = '/'): string {
    const segments = pathSegments(path)
    const command = byPath.get(path)?.command
    const children = entries.filter(entry => {
      const candidate = entry.segments
      return candidate.length > segments.length && segments.every((segment, index) => candidate[index] === segment)
    })
    if (!command && children.length === 0 && path !== '/') throw new ValidationError('Unknown command. Run --help to see supported commands.')
    const display = segments.map(segment => segment.startsWith('$') ? `<${segment.slice(1)}>` : segment).join(' ')
    const title = [settings.name, display].filter(Boolean).join(' ')
    const trailing = command?.args.map(arg => arg.required ? `<${arg.name}${arg.variadic ? '...' : ''}>` : `[${arg.name}${arg.variadic ? '...' : ''}]`).join(' ')
    const sections = [`Usage: ${title}${children.length && !command?.run ? ' <command>' : ''}${trailing ? ` ${trailing}` : ''} [options]`]
    const description = command?.description || (path === '/' ? settings.description : '')
    if (description) sections.push(wrap(description, width))
    if (children.length) {
      const groups = new Map<string, string>()
      for (const child of children) {
        const name = child.segments[segments.length]!
        const direct = child.command.path === `${path === '/' ? '' : path}/${name}`
        if (!groups.has(name) || direct) groups.set(name, direct ? child.command.description : 'Command group')
      }
      sections.push(`Commands:\n${table([...groups].sort(([a], [b]) => a.localeCompare(b)), width)}`)
    }
    const argumentRows: [string, string][] = command ? [
      ...Object.entries<Arguments[string]>(command.params).map(([key, arg]): [string, string] => [
        `<${key}>`, [arg.description, `Type: ${arg.value.label}. Required.`].filter(Boolean).join(' '),
      ]),
      ...command.args.map((arg): [string, string] => [arg.required ? `<${arg.name}${arg.variadic ? '...' : ''}>` : `[${arg.name}${arg.variadic ? '...' : ''}]`, [arg.description, `Type: ${arg.value.label}.`, arg.required ? 'Required.' : '', arg.hasDefault ? `Default: ${JSON.stringify(arg.defaultValue)}.` : ''].filter(Boolean).join(' ')]),
    ] : []
    if (argumentRows.length) {
      sections.push(`Arguments:\n${table(argumentRows, width)}`)
    }
    const rows: [string, string][] = command ? Object.entries<Arguments[string]>(command.options).map(([key, arg]) => [
      `${arg.short ? `-${arg.short}, ` : ''}--${optionName(key)}${arg.kind === 'flag' ? '' : ` <${arg.element?.label ?? arg.value.label}>`}`,
      [arg.description, arg.required ? 'Required.' : '', arg.hasDefault ? `Default: ${JSON.stringify(arg.defaultValue)}.` : '',
        arg.repeated ? 'Repeatable.' : '', arg.kind === 'flag' && arg.negate ? `Negate with --no-${optionName(key)}.` : ''].filter(Boolean).join(' '),
    ]) : []
    rows.push(['-h, --help', 'Show help.'])
    if (path === '/' && settings.version) rows.push(['-V, --version', 'Show version.'])
    sections.push(`Options:\n${table(rows, width)}`)
    for (const section of [...(path === '/' ? settings.sections ?? [] : []), ...(command?.sections ?? [])]) {
      sections.push(`${section.title}:\n${wrap(section.body, width)}`)
    }
    if (path === '/') sections.push(`Run "${settings.name} help <command>" for command help.`)
    return sections.join('\n\n') + '\n'
  }

  async function context(io: IO, signal: AbortSignal, answers?: readonly unknown[]): Promise<CommandContext<unknown>> {
    checkSignal(signal)
    const services = settings.context ? await settings.context() : {}
    checkSignal(signal)
    return { io, signal, input: createInput(io, signal, answers), services, exitCode: 0 }
  }

  function middleware(command: AnyCommand): MiddlewareList {
    if (command.groups !== undefined) return [...command.groups.flatMap(group => group.middleware), ...command.middleware]
    const segments = pathSegments(command.path)
    const parents = segments.map((_, index) => registry[index === 0 ? '/' : `/${segments.slice(0, index).join('/')}`]).filter((parent): parent is AnyCommand => parent !== undefined)
    return [...parents.flatMap(parent => parent.middleware), ...command.middleware]
  }

  async function dispatch(command: AnyCommand, params: Output<Arguments>, options: Output<Arguments>, args: Output<Arguments>, ctx: CommandContext<unknown>): Promise<any> {
    return runMiddleware(middleware(command), ctx, current => command.run!({ params, options, args, ctx: current }))
  }

  async function invoke<const P extends ExecutablePaths<R>>(path: P & (IsUnion<P> extends true ? never : unknown), input: CommandInput<NoInfer<R[P]>>, execution: ExecutionOptions = {}): Promise<CommandResult<R[P]>> {
    // SAFETY: Registry is the generic constraint; widening permits a missing key from untyped callers to be checked below.
    const command = (registry as Registry)[path]
    if (!command?.run) throw new ValidationError('unknown command or command is not executable')
    // oxlint-disable-next-line deslop/no-runtime-typeof -- Validate the public invocation boundary for JavaScript callers.
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('invocation must be an object')
    for (const key of Object.keys(input)) {
      if (key !== 'params' && key !== 'options' && key !== 'args') throw new ValidationError('unknown invocation field')
    }
    const params = decodeArguments(command.params, Object.prototype.hasOwnProperty.call(input, 'params') && input.params !== undefined ? input.params : {}, 'argument', command.validateParams)
    const options = decodeArguments(command.options, Object.prototype.hasOwnProperty.call(input, 'options') && input.options !== undefined ? input.options : {}, 'option', command.validateOptions)
    const args = decodeArguments(byPath.get(path)!.args, Object.prototype.hasOwnProperty.call(input, 'args') && input.args !== undefined ? input.args : {}, 'argument')
    const ctx = await context(createIO(execution.io ?? memoryPorts()), execution.signal ?? new AbortController().signal)
    const result = await dispatch(command, params, options, args, ctx)
    checkSignal(ctx.signal)
    // SAFETY: dispatch runs the command at path P and preserves its handler's return value.
    return result as CommandResult<R[P]>
  }

  async function execute(argv: readonly string[], execution: ExecutionOptions = {}, answers?: readonly unknown[]): Promise<RunResult> {
    let selected: AnyCommand | undefined
    const ports = execution.io ?? memoryPorts()
    let stdout = '', stderr = ''
    const io = createIO({
      ...ports,
      stdout: { write(text) { stdout += text; ports.stdout.write(text) } },
      stderr: { write(text) { stderr += text; ports.stderr.write(text) } },
    })
    const signal = execution.signal ?? new AbortController().signal
    function result<T>(exitCode: number, value?: T): RunResult {
      const output: RunResult = { exitCode, stdout, stderr }
      if (value !== undefined) output.value = value
      return output
    }
    function showHelp(path = '/') {
      const text = help(path)
      if (settings.presentation?.help) settings.presentation.help(text, io)
      else io.stdout.write(text)
      return result(0)
    }
    // oxlint-disable-next-line deslop/no-unknown-parameters -- Caught values can be arbitrary; only known errors expose their messages.
    function failure(error: unknown, category: Failure['category']): RunResult {
      const cancelled = error instanceof CancelledError || signal.aborted
      const safe = error instanceof CLIError || error instanceof ValidationError
      const info: Failure = {
        category: cancelled ? 'cancelled' : category,
        code: cancelled ? 'CANCELLED' : error instanceof CLIError ? error.code : category === 'usage' ? 'VALIDATION' : 'COMMAND_ERROR',
        message: cancelled ? 'Cancelled' : safe ? error.message : 'The command could not be completed',
      }
      if (settings.presentation?.failure) {
        try {
          const code = settings.presentation.failure(info, io)
          if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error()
          return result(code)
        } catch {
          io.stderr.write('Error: Unable to render the failure\n')
          return result(1)
        }
      }
      io.stderr.write(wrap(`Error: ${info.message}`, width) + '\n')
      if (info.category === 'usage') io.stderr.write('\n' + help(selected?.path ?? '/'))
      return result(cancelled ? 130 : category === 'usage' ? 2 : 1)
    }
    try {
      if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V') && settings.version) {
        if (settings.presentation?.version) settings.presentation.version(settings.version, io)
        else io.stdout.write(`${settings.version}\n`)
        return result(0)
      }
      if (argv[0] === 'help') {
        const words = argv.slice(1)
        if (!words.length) return showHelp()
        const target = resolve(['--help', '--', ...words])
        const path = target?.command.path ?? groupPath(words)
        if (path) return showHelp(path)
        throw new CLIError('COMMAND_NOT_FOUND', 'Unknown command. Run --help to see supported commands.')
      }
      const candidate = resolve(argv)
      if (!candidate) {
        // A command group has help even without an index handler.
        const words = argv.filter(token => token !== '--help' && token !== '-h')
        const path = words.some(word => word.startsWith('-')) ? undefined : groupPath(words)
        if (!argv.length || path) {
          return showHelp(path ?? '/')
        }
        throw new CLIError('COMMAND_NOT_FOUND', 'Unknown command or unexpected arguments. Run --help to see supported commands.')
      }
      selected = candidate.command
      if (candidate.tokens.errors.length) throw new CLIError('PARSE', candidate.tokens.errors.join('\n'))
      if (candidate.tokens.help || !selected.run) return showHelp(selected.path)
      const supplied: Record<string, string | undefined> = {}
      candidate.segments.forEach((segment, index) => {
        if (segment.startsWith('$')) supplied[segment.slice(1)] = candidate.tokens.words[index]
      })
      const trailing: Record<string, string | string[] | undefined> = {}
      selected.args.forEach((arg, index) => { trailing[arg.name] = arg.variadic ? candidate.tokens.words.slice(candidate.segments.length + index) : candidate.tokens.words[candidate.segments.length + index] })
      const params = decodeShellArguments(selected.params, supplied, 'argument', selected.validateParams)
      const options = decodeShellArguments(selected.options, candidate.tokens.options, 'option', selected.validateOptions)
      const args = decodeShellArguments(candidate.args, trailing, 'argument')
      // Keep handler errors separate from input errors, including ValidationError thrown by a handler.
      try {
        const ctx = await context(io, signal, answers)
        const value = await dispatch(selected, params, options, args, ctx)
        checkSignal(signal)
        if (!Number.isInteger(ctx.exitCode) || ctx.exitCode < 0 || ctx.exitCode > 255) throw new CLIError('INVALID_EXIT_CODE', 'Exit code must be an integer from 0 to 255')
        return result(ctx.exitCode, value)
      } catch (error) {
        return failure(error, 'application')
      }
    } catch (error) {
      return failure(error, 'usage')
    }
  }

  async function test(options: TestOptions): Promise<RunResult> {
    const execution: ExecutionOptions = {
      io: memoryPorts(options.stdin ?? '', options.answers !== undefined),
    }
    if (options.signal) execution.signal = options.signal
    return execute(options.argv, execution, options.answers)
  }

  async function run(argv?: readonly string[]): Promise<RunResult> {
    const runtime = processRuntime()
    const controller = new AbortController()
    const cancel = () => controller.abort()
    runtime.process.on('SIGINT', cancel)
    runtime.process.on('SIGTERM', cancel)
    try {
      const output = await execute(argv ?? runtime.process.argv.slice(2), { io: runtime.io, signal: controller.signal })
      runtime.process.exitCode = output.exitCode
      return output
    } finally {
      runtime.process.off('SIGINT', cancel)
      runtime.process.off('SIGTERM', cancel)
    }
  }

  return { invoke, execute, test, run, help }
}
