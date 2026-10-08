export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export interface Value<T> {
  readonly label: string
  readonly parse: (text: string) => T
  readonly validate: (input: unknown) => T
}

export function value<T>(label: string, decoder: { parse: (text: string) => T; validate: (input: unknown) => T }): Value<T> {
  return { label, ...decoder }
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
    return input as T[number]
  }
  return value(choices.join('|'), { parse: validate, validate })
}

export interface Argument<T, Required extends boolean = boolean, Kind extends 'positional' | 'option' | 'flag' = 'positional' | 'option' | 'flag'> {
  readonly kind: Kind
  readonly value: Value<T>
  readonly required: Required
  readonly description: string
  readonly short: string | undefined
  readonly hasDefault: boolean
  readonly defaultValue: T | undefined
  readonly negate: boolean
}

type Settings = { description?: string; short?: string }

export function positional<T>(parser: Value<T>, settings: { description?: string } = {}): Argument<T, true, 'positional'> {
  return {
    kind: 'positional', value: parser, required: true,
    description: settings.description ?? '', short: undefined,
    hasDefault: false, defaultValue: undefined, negate: false,
  }
}

export function option<T>(parser: Value<T>, settings: Settings & { default: NoInfer<T> }): Argument<T, false, 'option'>
export function option<T>(parser: Value<T>, settings: Settings & { required: true }): Argument<T, true, 'option'>
export function option<T>(parser: Value<T>, settings?: Settings & { required?: false }): Argument<T | undefined, false, 'option'>
export function option<T>(parser: Value<T>, settings: Settings & { default?: T; required?: boolean } = {}): Argument<T | undefined, boolean, 'option'> {
  const hasDefault = Object.prototype.hasOwnProperty.call(settings, 'default')
  if (hasDefault && settings.required) throw new ValidationError('an option cannot be required and defaulted')
  return {
    kind: 'option', value: parser, required: settings.required ?? false,
    description: settings.description ?? '', short: settings.short,
    hasDefault, defaultValue: hasDefault ? parser.validate(settings.default) : undefined, negate: false,
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

export type NamedArgument<Name extends string = string, T = unknown, Required extends boolean = boolean> = Argument<T, Required, 'positional'> & { readonly name: Name }

export function argument<const N extends string, T>(name: N, parser: Value<T>, settings: { default: NoInfer<T>; description?: string }): NamedArgument<N, T, false>
export function argument<const N extends string, T>(name: N, parser: Value<T>, settings: { required: false; description?: string }): NamedArgument<N, T | undefined, false>
export function argument<const N extends string, T>(name: N, parser: Value<T>, settings?: { required?: true; description?: string }): NamedArgument<N, T, true>
export function argument(name: string, parser: Value<unknown>, settings: { default?: unknown; required?: boolean; description?: string } = {}): NamedArgument {
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) throw new ValidationError('invalid argument name')
  const hasDefault = Object.prototype.hasOwnProperty.call(settings, 'default')
  if (hasDefault && settings.required) throw new ValidationError('an argument cannot be required and defaulted')
  return {
    ...positional(parser, settings), name,
    required: hasDefault ? false : settings.required ?? true,
    hasDefault, defaultValue: hasDefault ? parser.validate(settings.default) : undefined,
  }
}
