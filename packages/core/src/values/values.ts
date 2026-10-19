// This module is the parsing boundary: validators must accept unknown input and check its runtime type.
/* oxlint-disable deslop/no-unknown-parameters, deslop/no-runtime-typeof */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export interface Value<T, Input = T> {
  readonly label: string
  readonly parse: (text: string) => T
  readonly validate: (input: unknown) => T
  readonly decode?: (text: string) => T
  readonly '~input'?: Input
}

export function value<T>(label: string, decoder: { parse: (text: string) => T; validate: (input: unknown) => T }): Value<T> {
  return { label, ...decoder }
}

type SchemaResult<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string }[] }
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
    readonly validate: (input: unknown) => SchemaResult<Output> | Promise<SchemaResult<Output>>
  }
}

export function schemaValue<Input, Output>(label: string, schema: StandardSchema<Input, Output> | ((input: Input) => Output), settings: { parse?: (text: string) => NoInfer<Input> } = {}): Value<Output, Input> {
  function validate(input: unknown): Output {
    try {
      if (typeof schema === 'function') {
        // SAFETY: the callback is the validation boundary and must reject invalid input; errors are normalized below.
        const output = schema(input as Input)
        if (output !== null && (typeof output === 'object' || typeof output === 'function') && 'then' in output && typeof output.then === 'function') {
          void Promise.resolve(output).catch(() => {})
          throw new ValidationError('Async schema validation is not supported')
        }
        return output
      }
      const result = schema['~standard'].validate(input)
      if ('then' in result) {
        // Consume a possible rejection even though synchronous validation rejects this schema.
        void Promise.resolve(result).catch(() => {})
        throw new ValidationError('Async schema validation is not supported')
      }
      if (result.issues) throw new ValidationError(result.issues.map(issue => issue.message).join('; '))
      return result.value
    } catch (error) {
      if (error instanceof ValidationError) throw error
      throw new ValidationError(`Invalid ${label}`)
    }
  }
  const parse = (text: string) => {
    try { return validate(settings.parse ? settings.parse(text) : text) }
    catch (error) {
      if (error instanceof ValidationError) throw error
      throw new ValidationError(`Invalid ${label}`)
    }
  }
  return { label, parse, validate, decode: parse }
}

export function string(): Value<string> {
  const validate = (input: unknown) => {
    if (typeof input !== 'string') throw new ValidationError('expected text')
    return input
  }
  return value('text', { parse: validate, validate })
}

export function integer(settings: { min?: number; max?: number } = {}): Value<number> {
  const validate = (input: unknown) => {
    if (typeof input !== 'number') throw new ValidationError('expected an integer')
    const result = input
    if (!Number.isSafeInteger(result)) throw new ValidationError('expected a safe integer')
    if (settings.min !== undefined && result < settings.min) {
      throw new ValidationError(`must be at least ${settings.min}`)
    }
    if (settings.max !== undefined && result > settings.max) {
      throw new ValidationError(`must be at most ${settings.max}`)
    }
    return result
  }
  return value('integer', {
    parse: text => {
      if (!/^-?\d+$/.test(text)) throw new ValidationError('expected an integer')
      return validate(Number(text))
    },
    validate,
  })
}

export function choice<const T extends readonly [string, ...string[]]>(choices: T): Value<T[number]> {
  const validate = (input: unknown): T[number] => {
    if (typeof input !== 'string' || !choices.includes(input)) {
      throw new ValidationError(`expected one of: ${choices.join(', ')}`)
    }
    // SAFETY: the membership check above proves input is one of the literal choices.
    return input as T[number]
  }
  return value(choices.join('|'), { parse: validate, validate })
}

export interface Argument<T, Required extends boolean = boolean, Kind extends 'positional' | 'option' | 'flag' = 'positional' | 'option' | 'flag', Input = T> {
  readonly kind: Kind
  readonly value: Value<T, Input>
  readonly required: Required
  readonly description: string
  readonly short: string | undefined
  readonly hasDefault: boolean
  readonly defaultValue: Input | undefined
  readonly negate: boolean
  readonly repeated?: boolean
  readonly variadic?: boolean
  readonly element?: Value<unknown>
}

type Settings = { description?: string; short?: string }

export function positional<T, Input = T>(parser: Value<T, Input>, settings: { description?: string } = {}): Argument<T, true, 'positional', Input> {
  return {
    kind: 'positional', value: parser, required: true,
    description: settings.description ?? '', short: undefined,
    hasDefault: false, defaultValue: undefined, negate: false,
  }
}

export function option<T, Input = T>(parser: Value<T, Input>, settings: Settings & { default: NoInfer<Input> }): Argument<T, false, 'option', Input>
export function option<T, Input = T>(parser: Value<T, Input>, settings: Settings & { required: true }): Argument<T, true, 'option', Input>
export function option<T, Input = T>(parser: Value<T, Input>, settings?: Settings & { required?: false }): Argument<T | undefined, false, 'option', Input | undefined>
export function option<T, Input = T>(parser: Value<T, Input>, settings: Settings & { default?: Input; required?: boolean } = {}): Argument<T | undefined, boolean, 'option', Input | undefined> {
  const hasDefault = Object.prototype.hasOwnProperty.call(settings, 'default')
  if (hasDefault && settings.required) throw new ValidationError('an option cannot be required and defaulted')
  if (hasDefault) parser.validate(settings.default)
  return {
    kind: 'option', value: parser, required: settings.required ?? false,
    description: settings.description ?? '', short: settings.short,
    hasDefault, defaultValue: hasDefault ? settings.default : undefined, negate: false,
  }
}

export function flag(settings: Settings & { default?: boolean; negate?: boolean } = {}): Argument<boolean, false, 'flag'> {
  return {
    kind: 'flag', required: false,
    value: value('boolean', {
      parse: text => {
        if (text !== 'true' && text !== 'false') throw new ValidationError('expected a boolean')
        return text === 'true'
      },
      validate: input => {
        if (typeof input !== 'boolean') throw new ValidationError('expected a boolean')
        return input
      },
    }),
    description: settings.description ?? '', short: settings.short,
    hasDefault: true, defaultValue: settings.default ?? false, negate: settings.negate ?? true,
  }
}

export type NamedArgument<Name extends string = string, T = unknown, Required extends boolean = boolean, Input = T> = Argument<T, Required, 'positional', Input> & { readonly name: Name }

export function argument<const N extends string, T, Input = T>(name: N, parser: Value<T, Input>, settings: { default: NoInfer<Input>; description?: string }): NamedArgument<N, T, false, Input>
export function argument<const N extends string, T, Input = T>(name: N, parser: Value<T, Input>, settings: { required: false; description?: string }): NamedArgument<N, T | undefined, false, Input | undefined>
export function argument<const N extends string, T, Input = T>(name: N, parser: Value<T, Input>, settings?: { required?: true; description?: string }): NamedArgument<N, T, true, Input>
export function argument(name: string, parser: Value<unknown>, settings: { default?: unknown; required?: boolean; description?: string } = {}): NamedArgument {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) throw new ValidationError('invalid argument name')
  const hasDefault = Object.prototype.hasOwnProperty.call(settings, 'default')
  if (hasDefault && settings.required) throw new ValidationError('an argument cannot be required and defaulted')
  if (hasDefault) parser.validate(settings.default)
  return {
    ...positional(parser, settings), name,
    required: hasDefault ? false : settings.required ?? true,
    hasDefault, defaultValue: hasDefault ? settings.default : undefined,
  }
}

function collection<T, Input>(parser: Value<T, Input>): Value<T[], readonly Input[]> {
  return {
    label: `${parser.label}[]`,
    parse: text => [parser.parse(text)],
    validate: input => {
      if (!Array.isArray(input)) throw new ValidationError('expected an array')
      return input.map(item => parser.validate(item))
    },
  }
}

export function repeatableOption<T, Input = T>(parser: Value<T, Input>, settings: Settings = {}): Argument<T[], false, 'option', readonly Input[]> {
  return { ...option(collection(parser), { ...settings, default: [] }), repeated: true, element: parser }
}

export function variadicArgument<const N extends string, T, Input = T>(name: N, parser: Value<T, Input>, settings: { description?: string } = {}): NamedArgument<N, T[], false, readonly Input[]> {
  return { ...argument(name, collection(parser), { ...settings, default: [] }), variadic: true, element: parser }
}
