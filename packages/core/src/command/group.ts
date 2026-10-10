import type { MiddlewareList, MiddlewareContext, MiddlewareRequirements } from '../execution/middleware.ts'

export interface Group<M extends MiddlewareList = MiddlewareList> {
  readonly middleware: M
}
export function defineGroup<const M extends MiddlewareList = []>(
  config: { middleware?: M } = {},
): Group<M> {
  return { middleware: config.middleware ?? [] } as Group<M>
}
export const defineRoot = defineGroup
export type GroupMiddleware<G extends readonly Group[]> = G extends readonly [
  infer Head extends Group,
  ...infer Tail extends readonly Group[],
]
  ? [...Head['middleware'], ...GroupMiddleware<Tail>]
  : []
export type GroupRequirements<G extends readonly Group[]> = MiddlewareRequirements<
  GroupMiddleware<G>
>
export type GroupContext<G extends readonly Group[]> = MiddlewareContext<GroupMiddleware<G>> &
  GroupRequirements<G>

// The file generator augments this interface with each command's inherited services.
export interface FileCommandContexts {}
export type FileCommandContext<Path extends string> = Path extends keyof FileCommandContexts
  ? FileCommandContexts[Path]
  : {}
