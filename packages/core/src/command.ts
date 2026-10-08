import type { Argument, NamedArgument } from './values.ts'
import { ValidationError } from './values.ts'
import type { CommandContext } from './context.ts'

export type ParamNames<Path extends string> =
  Path extends `${string}/$${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> :
  Path extends `${string}/$${infer Name}` ? Name : never

export type Arguments = Record<string, Argument<unknown>>
export type Output<A extends Arguments> = { [K in keyof A]: A[K] extends Argument<infer T> ? T : never }
type RequiredKeys<A extends Arguments> = { [K in keyof A]: A[K]['required'] extends true ? K : never }[keyof A]
export type Input<A extends Arguments> =
  keyof A extends never ? Record<string, never> :
  { [K in RequiredKeys<A>]: Output<A>[K] } &
  { [K in Exclude<keyof A, RequiredKeys<A>>]?: Exclude<Output<A>[K], undefined> }

export type ArgumentMap<A extends readonly NamedArgument[]> = { [D in A[number] as D['name']]: D }
export interface Section { readonly title: string; readonly body: string }

export interface Command<Path extends string | undefined, Params extends Arguments, Options extends Arguments, Result, Args extends readonly NamedArgument[] = [], Services = {}> {
  readonly path: Path
  readonly description: string
  readonly params: Params
  readonly options: Options
  readonly args: Args
  readonly sections: readonly Section[]
  readonly run: (input: { params: Output<Params>; options: Output<Options>; args: Output<ArgumentMap<Args>>; ctx: CommandContext<Services> }) => Result
}

// Erasure is confined to runtime dispatch. Public calls retain the concrete command type.
export type AnyDefinition = Omit<Command<string | undefined, any, any, any, any, any>, 'run' | 'args'> & {
  readonly args: readonly NamedArgument[]
  readonly run: ((input: any) => any) | undefined
}
export type AnyCommand = AnyDefinition & { readonly path: string }
type Group<P extends string | undefined, A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[]> = Omit<Command<P, A, O, never, Args>, 'run'> & { readonly run: undefined }
type ParamShape<Path extends string> = { [K in ParamNames<Path>]: Argument<unknown, true, 'positional'> }
type PositionalShape = Record<string, Argument<unknown, true, 'positional'>>
type OptionShape = Record<string, Argument<unknown, boolean, 'option' | 'flag'>>
type DefinitionConfig<A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[]> = {
  description?: string
  options?: O
  params?: A
  args?: Args
  sections?: readonly Section[]
}
type Handler<A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[], Services, R> = Command<undefined, A, O, R, Args, Services>['run']
type Configuration<P extends string, A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[]> = Omit<DefinitionConfig<A, O, Args>, 'params'> & (ParamNames<P> extends never
  ? { params?: A & Record<Exclude<keyof A, ParamNames<P>>, never> }
  : { params: A & Record<Exclude<keyof A, ParamNames<P>>, never> })

export function createFileCommand<const Path extends string>(path: Path) {
  function file<const Params extends ParamShape<Path> = ParamShape<Path>, const Options extends OptionShape = {}, const Args extends readonly NamedArgument[] = [], Result = unknown>(
    config: Configuration<Path, Params, Options, Args> & { run: Handler<Params, Options, Args, {}, Result> },
  ): Command<Path, Params, Options, Result, Args>
  function file<const Params extends ParamShape<Path> = ParamShape<Path>, const Options extends OptionShape = {}, const Args extends readonly NamedArgument[] = []>(
    config: Configuration<Path, Params, Options, Args> & { run?: never },
  ): Group<Path, Params, Options, Args>
  function file(config: RuntimeConfig): AnyCommand {
    return build(path, config) as AnyCommand
  }
  return file
}

function author<Services>() {
  function definition<const Params extends PositionalShape = {}, const Options extends OptionShape = {}, const Args extends readonly NamedArgument[] = [], Result = unknown>(
    config: DefinitionConfig<Params, Options, Args> & { run: Handler<Params, Options, Args, Services, Result> },
  ): Command<undefined, Params, Options, Result, Args, Services>
  function definition<const Params extends PositionalShape = {}, const Options extends OptionShape = {}, const Args extends readonly NamedArgument[] = []>(
    config: DefinitionConfig<Params, Options, Args> & { run?: never },
  ): Group<undefined, Params, Options, Args>
  function definition(config: RuntimeConfig): AnyDefinition { return build(undefined, config) }
  return definition
}

export const defineCommand = Object.assign(author<{}>(), { withContext: author })

type RuntimeConfig = DefinitionConfig<Arguments, Arguments, readonly NamedArgument[]> & { run?: (input: any) => any }
function build(path: string | undefined, config: RuntimeConfig): AnyDefinition {
  const params = config.params ?? {}
  const options = config.options ?? {}
  const args = config.args ?? []
  validateDefinition(path, params, options, args)
  return { path, params, options, args, sections: config.sections ?? [], description: config.description ?? '', run: config.run }
}

type Field<Name extends string, A extends Arguments> = {} extends Input<A> ? { [K in Name]?: Input<A> } : { [K in Name]: Input<A> }
export type CommandInput<C extends AnyDefinition> = Field<'params', C['params']> & Field<'options', C['options']> & Field<'args', ArgumentMap<C['args']>>
export type CommandResult<C extends AnyDefinition> = C['run'] extends (...args: any[]) => infer R ? Awaited<R> : never
export type CommandHandlerInput<C extends AnyDefinition> = C['run'] extends (input: infer I) => any ? I : never

export function pathSegments(path: string): string[] {
  if (path === '/') return []
  if (!/^\/(?:[a-z][a-z0-9-]*|\$[a-zA-Z][a-zA-Z0-9]*)(?:\/(?:[a-z][a-z0-9-]*|\$[a-zA-Z][a-zA-Z0-9]*))*$/.test(path)) {
    throw new ValidationError('invalid command path')
  }
  return path.slice(1).split('/')
}

export function optionName(key: string): string {
  return key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function validateDefinition(path: string | undefined, params: Arguments, options: Arguments, args: readonly NamedArgument[]): void {
  const names = path === undefined ? Object.keys(params) : pathSegments(path).filter(segment => segment.startsWith('$')).map(segment => segment.slice(1))
  if (new Set(names).size !== names.length) throw new ValidationError(`duplicate positional name in ${path}`)
  if (names.length !== Object.keys(params).length || names.some(name => !params[name])) {
    throw new ValidationError(`positional definitions must match ${path}`)
  }
  for (const descriptor of Object.values(params)) {
    if (descriptor.kind !== 'positional' || !descriptor.required) throw new ValidationError('route params must be required positionals')
  }
  const argumentNames = new Set(names)
  let optional = false
  for (const arg of args) {
    if (argumentNames.has(arg.name)) throw new ValidationError('duplicate argument name')
    if (optional && arg.required) throw new ValidationError('a required argument cannot follow an optional argument')
    if (arg.kind !== 'positional') throw new ValidationError('trailing arguments must be positional')
    argumentNames.add(arg.name)
    optional ||= !arg.required
  }
  const used = new Set(['help', 'version', 'h', 'V'])
  for (const [key, descriptor] of Object.entries(options)) {
    const long = optionName(key)
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(long)) throw new ValidationError(`invalid option name: ${key}`)
    if (descriptor.kind === 'positional') throw new ValidationError(`option ${key} cannot be positional`)
    const aliases = [long, ...(descriptor.kind === 'flag' && descriptor.negate ? [`no-${long}`] : [])]
    if (descriptor.short !== undefined) {
      if (!/^[a-zA-Z]$/.test(descriptor.short)) throw new ValidationError(`invalid short option: ${descriptor.short}`)
      aliases.push(descriptor.short)
    }
    for (const alias of aliases) {
      if (used.has(alias)) throw new ValidationError(`duplicate or reserved option: ${alias}`)
      used.add(alias)
    }
  }
}

export function bindCommand<const P extends string, C extends AnyDefinition>(path: P, command: C & {
  readonly path: NoInfer<P> | undefined
  readonly params: ParamShape<NoInfer<P>> & Record<Exclude<keyof C['params'], ParamNames<NoInfer<P>>>, never>
}): Omit<C, 'path'> & { readonly path: P } {
  if (command.path !== undefined && path !== command.path) throw new ValidationError(`file path ${path} does not match declared path ${command.path}`)
  validateDefinition(path, command.params, command.options, command.args)
  return { ...command, path }
}

export function defineRegistry<const R extends Record<string, AnyCommand>>(registry: R & { [P in keyof R]: { readonly path: P } }): R {
  for (const [path, command] of Object.entries(registry)) {
    if (path !== command.path) throw new ValidationError(`registry path ${path} does not match ${command.path}`)
  }
  return registry
}
