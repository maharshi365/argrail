import type { CommandContext } from './context.ts'
import { CLIError, checkSignal } from './errors.ts'

export interface MiddlewareResult<Added = {}> {
  readonly value: unknown
  readonly context?: Added
}
export interface MiddlewareNext {
  <Added extends object = {}>(settings?: { context: Added }): Promise<MiddlewareResult<Added>>
}
export interface Middleware<Required = {}, Added = {}> {
  readonly handler: (input: {
    ctx: CommandContext<Required>
    next: MiddlewareNext
  }) => MiddlewareResult<Added> | Promise<MiddlewareResult<Added>>
}
// Erasure is confined to dispatch. Definitions retain their context requirements and additions.
export type AnyMiddleware = Middleware<any, any>
export type MiddlewareList = readonly AnyMiddleware[]
type Added<M> = M extends Middleware<any, infer A> ? A : {}
type Required<M> = M extends Middleware<infer R, any> ? R : {}
export type MiddlewareContext<M extends MiddlewareList> = M extends readonly [
  infer Head,
  ...infer Tail extends MiddlewareList,
]
  ? Added<Head> & MiddlewareContext<Tail>
  : {}
export type MiddlewareRequirements<M extends MiddlewareList, Available = {}> = M extends readonly [
  infer Head,
  ...infer Tail extends MiddlewareList,
]
  ? Omit<Required<Head>, keyof Available> & MiddlewareRequirements<Tail, Available & Added<Head>>
  : {}

function author<Required>() {
  return {
    handler<Result extends MiddlewareResult<any> | Promise<MiddlewareResult<any>>>(
      handler: (input: { ctx: CommandContext<Required>; next: MiddlewareNext }) => Result,
    ): Middleware<Required, Awaited<Result> extends MiddlewareResult<infer Added> ? Added : {}> {
      return { handler }
    },
  }
}
export const createMiddleware = Object.assign(author<{}>, { withContext: author })

// Handler results are erased only inside runtime dispatch; public invocation retains its result type.
export async function runMiddleware(
  middlewares: MiddlewareList,
  ctx: CommandContext<any>,
  terminal: (ctx: CommandContext<any>) => any,
): Promise<any> {
  async function dispatch(index: number, current: CommandContext<any>): Promise<MiddlewareResult> {
    checkSignal(current.signal)
    const middleware = middlewares[index]
    if (!middleware) return { value: await terminal(current) }
    const state = { called: false, active: true }
    const next: MiddlewareNext = async <Added extends object = {}>(settings?: {
      context: Added
    }) => {
      if (state.called || !state.active)
        throw new CLIError(
          'INVALID_MIDDLEWARE',
          'next() can only be called once while middleware is active',
        )
      state.called = true
      const additions: unknown = settings === undefined ? {} : settings.context
      // Context is a public JavaScript boundary; only object bags can be merged.
      /* oxlint-disable deslop/no-runtime-typeof */
      if (!additions || typeof additions !== 'object' || Array.isArray(additions))
        throw new CLIError('INVALID_CONTEXT', 'Middleware context must be an object')
      /* oxlint-enable deslop/no-runtime-typeof */
      for (const key of Reflect.ownKeys(additions).filter(key =>
        Object.prototype.propertyIsEnumerable.call(additions, key),
      )) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
          throw new CLIError('INVALID_CONTEXT', `invalid context key: ${key}`)
        if (Object.prototype.hasOwnProperty.call(current.services, key))
          throw new CLIError('INVALID_CONTEXT', `context key already exists: ${String(key)}`)
      }
      const services = { ...current.services, ...additions }
      const downstream = { ...current, services }
      // Framework state is shared even though each stage gets its own services snapshot.
      Object.defineProperty(downstream, 'exitCode', {
        get: () => ctx.exitCode,
        set: code => {
          ctx.exitCode = code
        },
        enumerable: true,
      })
      const result = await dispatch(index + 1, downstream)
      if (settings) return { value: result.value, context: settings.context }
      return { value: result.value }
    }
    try {
      const result: unknown = await middleware.handler({ ctx: current, next })
      // Untyped middleware can omit next() or return a malformed result.
      if (!state.called || !result || !Object.prototype.hasOwnProperty.call(result, 'value'))
        throw new CLIError(
          'INVALID_MIDDLEWARE',
          'Middleware must return the result of next() or throw an error',
        )
      return result as MiddlewareResult
    } finally {
      state.active = false
    }
  }
  const result = await dispatch(0, ctx)
  checkSignal(ctx.signal)
  return result.value
}
