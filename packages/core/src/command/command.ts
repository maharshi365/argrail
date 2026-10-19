import type { Argument, NamedArgument, StandardSchema } from '../values/values.ts'
import { ValidationError, value, positional, option } from '../values/values.ts'
import type { CommandContext } from '../execution/context.ts'
import type { MiddlewareList, MiddlewareContext } from '../execution/middleware.ts'
import type { Group, FileCommandContext } from './group.ts'

export type ParamNames<Path extends string> =
  Path extends `${string}/$${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> :
  Path extends `${string}/$${infer Name}` ? Name : never

export type Arguments = Record<string, Argument<unknown>>
export type Output<A extends Arguments> = { [K in keyof A]: A[K] extends Argument<infer T, boolean, 'positional' | 'option' | 'flag', unknown> ? T : never }
type Supplied<A extends Arguments> = { [K in keyof A]: A[K] extends Argument<unknown, boolean, 'positional' | 'option' | 'flag', infer I> ? I : never }
type RequiredKeys<A extends Arguments> = { [K in keyof A]: A[K]['required'] extends true ? K : never }[keyof A]
export type Input<A extends Arguments> =
  keyof A extends never ? Record<string, never> :
  { [K in RequiredKeys<A>]: Supplied<A>[K] } &
  { [K in Exclude<keyof A, RequiredKeys<A>>]?: Exclude<Supplied<A>[K], undefined> }

export type ArgumentMap<A extends readonly NamedArgument[]> = { [D in A[number] as D['name']]: D }
export interface Section { readonly title: string; readonly body: string }

export interface Command<Path extends string | undefined, Params extends Arguments, Options extends Arguments, Result, Args extends readonly NamedArgument[] = [], Services = {}, M extends MiddlewareList = []> {
  readonly path: Path
  readonly description: string
  readonly params: Params
  readonly options: Options
  readonly args: Args
  readonly sections: readonly Section[]
  readonly middleware: M
  readonly run: (input: { params: Output<Params>; options: Output<Options>; args: Output<ArgumentMap<Args>>; ctx: CommandContext<Services & MiddlewareContext<M>> }) => Result
}

// Erasure is confined to runtime dispatch. Public calls retain the concrete command type.
export type AnyDefinition = Omit<Command<string | undefined, any, any, any, any, any, MiddlewareList>, 'run' | 'args'> & {
  readonly args: readonly NamedArgument[]
  readonly run: ((input: any) => any) | undefined
  readonly validateParams?: ObjectSchema | undefined
  readonly validateOptions?: ObjectSchema | undefined
  readonly groups?: readonly Group[]
}
export type AnyCommand = AnyDefinition & { readonly path: string }
type RouteParams<Path extends string> = { [K in ParamNames<Path>]: Argument<unknown, true, 'positional'> }
type Positionals = Record<string, Argument<unknown, true, 'positional'>>
type OptionDefinitions = Record<string, Argument<unknown, boolean, 'option' | 'flag'>>
type DefinitionConfig<A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[], M extends MiddlewareList = []> = {
  description?: string
  options?: O
  params?: A
  args?: Args
  sections?: readonly Section[]
  middleware?: M
}
type Handler<A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[], Services, R, M extends MiddlewareList = []> = Command<undefined, A, O, R, Args, Services, M>['run']
type Configuration<P extends string, A extends Arguments, O extends Arguments, Args extends readonly NamedArgument[], M extends MiddlewareList = []> = Omit<DefinitionConfig<A, O, Args, M>, 'params'> & (ParamNames<P> extends never
  ? { params?: A & Record<Exclude<keyof A, ParamNames<P>>, never> }
  : { params: A & Record<Exclude<keyof A, ParamNames<P>>, never> })

// Standard Schema validators receive untrusted object bags; concrete schemas retain their own input and output types.
// oxlint-disable-next-line deslop/no-unsafe-dictionary-type
type ObjectSchema = StandardSchema<Record<string, unknown>, Record<string, unknown>>
type SchemaInput<S> = S extends StandardSchema<infer I, unknown> ? I : {}
type SchemaOutput<S> = S extends StandardSchema<unknown, infer O> ? O : {}
export interface OptionSettings {
  readonly type?: 'value' | 'flag'
  readonly short?: string
  readonly description?: string
  readonly negate?: boolean
}
export type OptionConfig<Input> = { [K in keyof Input]-?: OptionSettings }
type SchemaParams<S> = { [K in keyof SchemaInput<S>]: Argument<unknown, true, 'positional'> }
type SchemaOptions<S> = { [K in keyof SchemaInput<S>]: Argument<unknown, false, 'option' | 'flag'> }
type SchemaConfig<
  P extends string | undefined,
  PS,
  OS,
  A extends Arguments,
  O extends Arguments,
  Args extends readonly NamedArgument[],
  M extends MiddlewareList = [],
> = {
  description?: string
  args?: Args
  sections?: readonly Section[]
  middleware?: M
} & (PS extends ObjectSchema
  ? {
      validateParams: PS
      params?: never
    } & (P extends string
      ? {
          validateParams: PS &
            (
              | Exclude<ParamNames<P>, keyof SchemaInput<PS>>
              | Exclude<keyof SchemaInput<PS>, ParamNames<P>> extends never
              ? unknown
              : never)
        }
      : {})
  : { validateParams?: never } & (P extends string
      ? Pick<Configuration<P, A, O, Args>, 'params'>
      : { params?: A })) &
  (OS extends ObjectSchema
    ? {
        validateOptions: OS
        optionConfig: OptionConfig<SchemaInput<OS>>
        options?: never
      }
    : { validateOptions?: never; optionConfig?: never; options?: O }) &
  ({ validateParams: ObjectSchema } | { validateOptions: ObjectSchema })
type SchemaHandler<
  PS,
  OS,
  A extends Arguments,
  O extends Arguments,
  Args extends readonly NamedArgument[],
  Services,
  R,
  M extends MiddlewareList = [],
> = (input: {
  params: PS extends ObjectSchema ? SchemaOutput<PS> : Output<A>
  options: OS extends ObjectSchema ? SchemaOutput<OS> : Output<O>
  args: Output<ArgumentMap<Args>>
  ctx: CommandContext<Services & MiddlewareContext<M>>
}) => R
type SchemaCommand<
  P extends string | undefined,
  PS,
  OS,
  A extends Arguments,
  O extends Arguments,
  Args extends readonly NamedArgument[],
  Services,
  R,
  M extends MiddlewareList = [],
> = Omit<
  Command<
    P,
    PS extends ObjectSchema ? SchemaParams<PS> : A,
    OS extends ObjectSchema ? SchemaOptions<OS> : O,
    R,
    Args,
    Services,
    M
  >,
  'run'
> & {
  readonly validateParams: PS
  readonly validateOptions: OS
  readonly run: SchemaHandler<PS, OS, A, O, Args, Services, R, M>
}

export function createFileCommand<const Path extends string>(path: Path) {
  function file<
    PS extends ObjectSchema | undefined = undefined,
    OS extends ObjectSchema | undefined = undefined,
    const Params extends RouteParams<Path> = RouteParams<Path>,
    const Options extends OptionDefinitions = {},
    const Args extends readonly NamedArgument[] = [],
    Result = unknown,
    const M extends MiddlewareList = [],
  >(
    config: SchemaConfig<Path, PS, OS, Params, Options, Args, M> & {
      run: SchemaHandler<PS, OS, Params, Options, Args, FileCommandContext<Path>, Result, M>
    },
  ): SchemaCommand<Path, PS, OS, Params, Options, Args, FileCommandContext<Path>, Result, M>
  function file<
    PS extends ObjectSchema | undefined = undefined,
    OS extends ObjectSchema | undefined = undefined,
    const Params extends RouteParams<Path> = RouteParams<Path>,
    const Options extends OptionDefinitions = {},
    const Args extends readonly NamedArgument[] = [],
    const M extends MiddlewareList = [],
  >(
    config: SchemaConfig<Path, PS, OS, Params, Options, Args, M> & { run?: never },
  ): Omit<SchemaCommand<Path, PS, OS, Params, Options, Args, FileCommandContext<Path>, never, M>, 'run'> & {
    readonly run: undefined
  }
  function file<
    const Params extends RouteParams<Path> = RouteParams<Path>,
    const Options extends OptionDefinitions = {},
    const Args extends readonly NamedArgument[] = [],
    const M extends MiddlewareList = [],
  >(
    config: Configuration<Path, Params, Options, Args, M> & { run?: never },
  ): Omit<Command<Path, Params, Options, never, Args, FileCommandContext<Path>, M>, 'run'> & { readonly run: undefined }
  function file<const Params extends RouteParams<Path> = RouteParams<Path>, const Options extends OptionDefinitions = {}, const Args extends readonly NamedArgument[] = [], Result = unknown, const M extends MiddlewareList = []>(
    config: Configuration<Path, Params, Options, Args, M> & { run: Handler<Params, Options, Args, FileCommandContext<Path>, Result, M> },
  ): Command<Path, Params, Options, Result, Args, FileCommandContext<Path>, M>
  function file(config: RuntimeConfig): AnyCommand {
    return build(path, config)
  }
  return file
}

function author<Services>() {
  function definition<
    PS extends ObjectSchema | undefined = undefined,
    OS extends ObjectSchema | undefined = undefined,
    const Params extends Positionals = {},
    const Options extends OptionDefinitions = {},
    const Args extends readonly NamedArgument[] = [],
    Result = unknown,
    const M extends MiddlewareList = [],
  >(
    config: SchemaConfig<undefined, PS, OS, Params, Options, Args, M> & {
      run: SchemaHandler<PS, OS, Params, Options, Args, Services, Result, M>
    },
  ): SchemaCommand<undefined, PS, OS, Params, Options, Args, Services, Result, M>
  function definition<
    PS extends ObjectSchema | undefined = undefined,
    OS extends ObjectSchema | undefined = undefined,
    const Params extends Positionals = {},
    const Options extends OptionDefinitions = {},
    const Args extends readonly NamedArgument[] = [],
    const M extends MiddlewareList = [],
  >(
    config: SchemaConfig<undefined, PS, OS, Params, Options, Args, M> & { run?: never },
  ): Omit<SchemaCommand<undefined, PS, OS, Params, Options, Args, Services, never, M>, 'run'> & {
    readonly run: undefined
  }
  function definition<const Params extends Positionals = {}, const Options extends OptionDefinitions = {}, const Args extends readonly NamedArgument[] = [], Result = unknown, const M extends MiddlewareList = []>(
    config: DefinitionConfig<Params, Options, Args, M> & { run: Handler<Params, Options, Args, Services, Result, M> },
  ): Command<undefined, Params, Options, Result, Args, Services, M>
  function definition<const Params extends Positionals = {}, const Options extends OptionDefinitions = {}, const Args extends readonly NamedArgument[] = [], const M extends MiddlewareList = []>(
    config: DefinitionConfig<Params, Options, Args, M> & { run?: never },
  ): Omit<Command<undefined, Params, Options, never, Args, Services, M>, 'run'> & { readonly run: undefined }
  function definition(config: RuntimeConfig): AnyDefinition { return build(undefined, config) }
  return definition
}

export const defineCommand = Object.assign(author<{}>(), { withContext: author })

type RuntimeConfig = DefinitionConfig<Arguments, Arguments, readonly NamedArgument[], MiddlewareList> & {
  run?: (input: any) => any
  validateParams?: ObjectSchema
  validateOptions?: ObjectSchema
  optionConfig?: Record<string, OptionSettings>
}
function build<P extends string | undefined>(path: P, config: RuntimeConfig): AnyDefinition & { readonly path: P } {
  if (config.validateParams && config.params)
    throw new ValidationError('params and validateParams cannot be combined')
  if (config.validateOptions && config.options)
    throw new ValidationError('options and validateOptions cannot be combined')
  if (config.validateOptions && !config.optionConfig)
    throw new ValidationError('validateOptions requires optionConfig')
  if (config.optionConfig && !config.validateOptions)
    throw new ValidationError('optionConfig requires validateOptions')
  const raw = value('text', { parse: text => text, validate: input => input })
  const params = config.validateParams
    ? Object.fromEntries(
        (path === undefined ? [] : pathSegments(path))
          .filter(segment => segment.startsWith('$'))
          .map(segment => [segment.slice(1), positional(raw)]),
      )
    : (config.params ?? {})
  const options = config.validateOptions
    ? Object.fromEntries(
        Object.entries(config.optionConfig!).map(([key, settings]) => {
          for (const field of Object.keys(settings)) {
            if (field !== 'type' && field !== 'short' && field !== 'description' && field !== 'negate') throw new ValidationError(`unknown optionConfig setting: ${field}`)
          }
          const type: unknown = settings.type
          if (type !== undefined && type !== 'value' && type !== 'flag')
            throw new ValidationError(`invalid option type: ${key}`)
          if (settings.negate !== undefined && settings.type !== 'flag')
            throw new ValidationError(`negate requires a flag: ${key}`)
          const descriptor = option(raw, settings)
          return [
            key,
            settings.type === 'flag'
              ? { ...descriptor, kind: 'flag' as const, negate: settings.negate ?? true }
              : descriptor,
          ]
        }),
      )
    : (config.options ?? {})
  const args = config.args ?? []
  validateDefinition(path, params, options, args)
  return {
    path,
    params,
    options,
    args,
    sections: config.sections ?? [],
    middleware: config.middleware ?? [],
    description: config.description ?? '',
    run: config.run,
    validateParams: config.validateParams,
    validateOptions: config.validateOptions,
  }
}

type Field<Name extends string, A extends Arguments> =
  {} extends Input<A> ? { [K in Name]?: Input<A> } : { [K in Name]: Input<A> }
type SchemaField<Name extends string, S, A extends Arguments> = S extends ObjectSchema
  ? {} extends SchemaInput<S>
    ? { [K in Name]?: SchemaInput<S> }
    : { [K in Name]: SchemaInput<S> }
  : Field<Name, A>
export type CommandInput<C extends AnyDefinition> = SchemaField<
  'params',
  C['validateParams'],
  C['params']
> &
  SchemaField<'options', C['validateOptions'], C['options']> &
  Field<'args', ArgumentMap<C['args']>>
export type CommandResult<C extends AnyDefinition> = C['run'] extends (...args: any[]) => infer R
  ? Awaited<R>
  : never
export type CommandHandlerInput<C extends AnyDefinition> = C['run'] extends (input: infer I) => any
  ? I
  : never

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
  if (names.length !== Object.keys(params).length || names.some(name => !Object.prototype.hasOwnProperty.call(params, name))) {
    throw new ValidationError(`positional definitions must match ${path}`)
  }
  for (const descriptor of Object.values(params)) {
    if (descriptor.kind !== 'positional' || !descriptor.required) throw new ValidationError('route params must be required positionals')
  }
  const argumentNames = new Set(names)
  let optional = false
  for (const arg of args) {
    if (args.some((candidate, index) => candidate.variadic && index !== args.length - 1)) throw new ValidationError('variadic argument must be last')
    if (argumentNames.has(arg.name)) throw new ValidationError('duplicate argument name')
    if (optional && arg.required) throw new ValidationError('a required argument cannot follow an optional argument')
    const kind: unknown = arg.kind
    if (kind !== 'positional') throw new ValidationError('trailing arguments must be positional')
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

type Bindable<P extends string, C extends AnyDefinition> = C & {
  readonly path: NoInfer<P> | undefined
  readonly params: RouteParams<NoInfer<P>> & Record<Exclude<keyof C['params'], ParamNames<NoInfer<P>>>, never>
}
type BoundCommand<P extends string, C extends AnyDefinition> = Omit<C, 'path' | 'groups'> & { readonly path: P }
export function bindCommand<const P extends string, C extends AnyDefinition, const G extends readonly Group[]>(path: P, command: Bindable<P, C>, groups: G): BoundCommand<P, C> & { readonly groups: G }
export function bindCommand<const P extends string, C extends AnyDefinition>(path: P, command: Bindable<P, C>): BoundCommand<P, C>
// Binding is erased at runtime; the overloads retain concrete command and group types.
export function bindCommand(path: string, command: AnyDefinition, groups?: readonly Group[]): any {
  if (command.path !== undefined && path !== command.path) throw new ValidationError(`file path ${path} does not match declared path ${command.path}`)
  const raw = value('text', { parse: text => text, validate: input => input })
  const params = command.validateParams
    ? Object.fromEntries(
        pathSegments(path)
          .filter(segment => segment.startsWith('$'))
          .map(segment => [segment.slice(1), positional(raw)]),
      )
    : command.params
  validateDefinition(path, params, command.options, command.args)
  const bound: AnyCommand = { ...command, params, path }
  if (groups !== undefined) return { ...bound, groups }
  return bound
}

export function defineRegistry<const R extends Record<string, AnyCommand>>(registry: R & { [P in keyof R]: { readonly path: P } }): R {
  for (const [path, command] of Object.entries(registry)) {
    if (path !== command.path) throw new ValidationError(`registry path ${path} does not match ${command.path}`)
  }
  return registry
}

export function composeRegistries<const A extends Record<string, AnyCommand>, const B extends Record<string, AnyCommand>>(first: A, second: B): A & B {
  for (const path of Object.keys(second)) {
    if (Object.prototype.hasOwnProperty.call(first, path)) throw new ValidationError(`duplicate command path: ${path}`)
  }
  const registry = { ...first, ...second }
  for (const [path, command] of Object.entries(registry)) {
    if (path !== command.path) throw new ValidationError(`registry path ${path} does not match ${command.path}`)
  }
  return registry
}
