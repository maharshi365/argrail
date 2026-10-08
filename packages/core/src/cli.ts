import { optionName, pathSegments, type AnyCommand, type Arguments, type CommandInput, type CommandResult, type CommandHandlerInput, type Section } from './command.ts'
import { table, wrap } from './format.ts'
import { ValidationError } from './values.ts'
import { CLIError, CancelledError, checkSignal, type Failure } from './errors.ts'
import { createIO, memoryPorts, type IO, type IOPorts } from './io.ts'
import { createInput } from './input.ts'
import type { CommandContext } from './context.ts'
import { processRuntime } from './process.ts'

type Registry = Record<string, AnyCommand>
type ExecutablePaths<R extends Registry> = { [P in keyof R]: R[P]['run'] extends (...args: any[]) => any ? P : never }[keyof R] & string
type Services<C extends AnyCommand> = CommandHandlerInput<C> extends { ctx: CommandContext<infer S> } ? S : unknown
type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never
type RequiredServices<R extends Registry> = Intersect<{ [P in keyof R]: Services<R[P]> }[keyof R]>

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
  options: Record<string, unknown>
  errors: string[]
  help: boolean
}

function tokenize(argv: readonly string[], command: AnyCommand): Tokens {
  const result: Tokens = { words: [], options: {}, errors: [], help: false }
  const aliases = new Map<string, { key: string; negated: boolean }>()
  for (const [key, descriptor] of Object.entries(command.options as Arguments)) {
    aliases.set(`--${optionName(key)}`, { key, negated: false })
    if (descriptor.short) aliases.set(`-${descriptor.short}`, { key, negated: false })
    if (descriptor.kind === 'flag' && descriptor.negate) aliases.set(`--no-${optionName(key)}`, { key, negated: true })
  }
  let positionalOnly = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!positionalOnly && token === '--') { positionalOnly = true; continue }
    if (!positionalOnly && (token === '--help' || token === '-h')) { result.help = true; continue }
    if (positionalOnly || token === '-' || !token.startsWith('-') || /^-\d/.test(token)) { result.words.push(token); continue }
    const equals = token.indexOf('=')
    const name = equals < 0 ? token : token.slice(0, equals)
    const alias = aliases.get(name)
    if (!alias) { result.errors.push('Unknown option. Run --help to see supported options.'); continue }
    const descriptor = command.options[alias.key] as Arguments[string]
    if (Object.prototype.hasOwnProperty.call(result.options, alias.key)) result.errors.push(`option ${name} was supplied more than once`)
    if (descriptor!.kind === 'flag') {
      if (equals >= 0) result.errors.push(`flag ${name} does not accept a value`)
      result.options[alias.key] = !alias.negated
    } else if (equals >= 0) {
      result.options[alias.key] = token.slice(equals + 1)
    } else {
      const next = argv[index + 1]
      if (next === undefined || (next !== '-' && next.startsWith('-') && !/^-\d/.test(next))) {
        result.errors.push(`missing value for ${name}`)
      } else {
        result.options[alias.key] = next
        index++
      }
    }
  }
  return result
}

function decodeArguments(definitions: Arguments, supplied: Record<string, unknown>, label: string, shell = false): Record<string, unknown> {
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    throw new ValidationError(`${label} values must be an object`)
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, key)) throw new ValidationError(`unknown ${label}`)
  }
  for (const [key, descriptor] of Object.entries(definitions)) {
    const input = supplied[key]
    if (input === undefined) {
      if (descriptor.hasDefault) result[key] = descriptor.value.validate(descriptor.defaultValue)
      else if (descriptor.required) throw new ValidationError(`missing ${label}: ${key}`)
      else result[key] = undefined
      continue
    }
    try {
      const decoded = shell && descriptor.kind !== 'flag' ? descriptor.value.parse(input as string) : input
      result[key] = descriptor.value.validate(decoded)
    }
    catch (error) {
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
  const entries = Object.values(registry)

  function help(path = '/'): string {
    const segments = pathSegments(path)
    const command = registry[path]
    const children = entries.filter(entry => {
      const candidate = pathSegments(entry.path)
      return candidate.length > segments.length && segments.every((segment, index) => candidate[index] === segment)
    })
    if (!command && children.length === 0 && path !== '/') throw new ValidationError('Unknown command. Run --help to see supported commands.')
    const display = segments.map(segment => segment.startsWith('$') ? `<${segment.slice(1)}>` : segment).join(' ')
    const title = [settings.name, display].filter(Boolean).join(' ')
    const trailing = command?.args.map(arg => arg.required ? `<${arg.name}>` : `[${arg.name}]`).join(' ')
    const sections = [`Usage: ${title}${children.length && !command?.run ? ' <command>' : ''}${trailing ? ` ${trailing}` : ''} [options]`]
    const description = command?.description || (path === '/' ? settings.description : '')
    if (description) sections.push(wrap(description, width))
    if (children.length) {
      const groups = new Map<string, string>()
      for (const child of children) {
        const name = pathSegments(child.path)[segments.length]!
        const direct = child.path === `${path === '/' ? '' : path}/${name}`
        if (!groups.has(name) || direct) groups.set(name, direct ? child.description : 'Command group')
      }
      sections.push(`Commands:\n${table([...groups].sort(([a], [b]) => a.localeCompare(b)), width)}`)
    }
    const argumentRows: [string, string][] = command ? [
      ...Object.entries(command.params as Arguments).map(([key, arg]): [string, string] => [
        `<${key}>`, [arg.description, `Type: ${arg.value.label}. Required.`].filter(Boolean).join(' '),
      ]),
      ...command.args.map(arg => [arg.required ? `<${arg.name}>` : `[${arg.name}]`, [arg.description, `Type: ${arg.value.label}.`, arg.required ? 'Required.' : '', arg.hasDefault ? `Default: ${JSON.stringify(arg.defaultValue)}.` : ''].filter(Boolean).join(' ')] as [string, string]),
    ] : []
    if (argumentRows.length) {
      sections.push(`Arguments:\n${table(argumentRows, width)}`)
    }
    const rows: [string, string][] = command ? Object.entries(command.options as Arguments).map(([key, arg]) => [
      `${arg.short ? `-${arg.short}, ` : ''}--${optionName(key)}${arg.kind === 'flag' ? '' : ` <${arg.value.label}>`}`,
      [arg.description, arg.required ? 'Required.' : '', arg.hasDefault ? `Default: ${JSON.stringify(arg.defaultValue)}.` : '',
        arg.kind === 'flag' && arg.negate ? `Negate with --no-${optionName(key)}.` : ''].filter(Boolean).join(' '),
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

  async function invoke<const P extends ExecutablePaths<R>>(path: P, input: CommandInput<NoInfer<R[P]>>, execution: ExecutionOptions = {}): Promise<CommandResult<R[P]>> {
    const command = registry[path]
    if (!command?.run) throw new ValidationError('unknown command or command is not executable')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('invocation must be an object')
    for (const key of Object.keys(input)) {
      if (key !== 'params' && key !== 'options' && key !== 'args') throw new ValidationError('unknown invocation field')
    }
    const params = decodeArguments(command.params, input.params === undefined ? {} : input.params, 'argument')
    const options = decodeArguments(command.options, input.options === undefined ? {} : input.options, 'option')
    const args = decodeArguments(Object.fromEntries(command.args.map(arg => [arg.name, arg])), input.args === undefined ? {} : input.args, 'argument')
    const ctx = await context(createIO(execution.io ?? memoryPorts()), execution.signal ?? new AbortController().signal)
    const result = await command.run({ params, options, args, ctx })
    checkSignal(ctx.signal)
    return result
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
    const result = (exitCode: number, value?: unknown): RunResult => ({ exitCode, stdout, stderr, ...(value === undefined ? {} : { value }) })
    function showHelp(path = '/') {
      const text = help(path)
      if (settings.presentation?.help) settings.presentation.help(text, io)
      else io.stdout.write(text)
      return result(0)
    }
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
        const target = argv.slice(1).join('/')
        return showHelp(target ? `/${target}` : '/')
      }
      const candidates = entries.map(command => {
        const tokens = tokenize(argv, command)
        const segments = pathSegments(command.path)
        return { command, tokens, segments }
      }).filter(candidate => {
        const words = candidate.tokens.words
        if (words.length < candidate.segments.length) {
          return candidate.tokens.help && matches(candidate.segments, words, true) && candidate.segments.slice(words.length).every(segment => segment.startsWith('$'))
        }
        if (!matches(candidate.segments, words.slice(0, candidate.segments.length))) return false
        return words.length <= candidate.segments.length + candidate.command.args.length
      }).sort((a, b) => {
        const aGroup = !a.command.run && a.tokens.words.length === a.segments.length
        const bGroup = !b.command.run && b.tokens.words.length === b.segments.length
        return aGroup !== bGroup ? (aGroup ? -1 : 1) : routePriority(a, b)
      })
      const candidate = candidates[0]
      if (!candidate) {
        // A command group has help even without an index handler.
        const words = argv.filter(token => token !== '--help' && token !== '-h')
        const groups = words.some(word => word.startsWith('-')) ? [] : entries.map(command => ({ segments: pathSegments(command.path) }))
          .filter(candidate => matches(candidate.segments, words, true)).sort(routePriority)
        const group = groups[0]
        const groupPath = words.length && group ? `/${group.segments.slice(0, words.length).join('/')}` : '/'
        if (!argv.length || group) {
          return showHelp(groupPath)
        }
        throw new CLIError('COMMAND_NOT_FOUND', 'Unknown command or unexpected arguments. Run --help to see supported commands.')
      }
      selected = candidate.command
      if (candidate.tokens.errors.length) throw new CLIError('PARSE', candidate.tokens.errors.join('\n'))
      if (candidate.tokens.help || !selected.run) return showHelp(selected.path)
      const supplied: Record<string, unknown> = {}
      candidate.segments.forEach((segment, index) => {
        if (segment.startsWith('$')) supplied[segment.slice(1)] = candidate.tokens.words[index]
      })
      const trailing: Record<string, unknown> = {}
      selected.args.forEach((arg, index) => { trailing[arg.name] = candidate.tokens.words[candidate.segments.length + index] })
      const params = decodeArguments(selected.params, supplied, 'argument', true)
      const options = decodeArguments(selected.options, candidate.tokens.options, 'option', true)
      const args = decodeArguments(Object.fromEntries(selected.args.map(arg => [arg.name, arg])), trailing, 'argument', true)
      // Keep handler errors separate from input errors, including ValidationError thrown by a handler.
      try {
        const ctx = await context(io, signal, answers)
        const value = await selected.run({ params, options, args, ctx })
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
    return execute(options.argv, {
      io: memoryPorts(options.stdin ?? '', options.answers !== undefined),
      ...(options.signal ? { signal: options.signal } : {}),
    }, options.answers)
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
