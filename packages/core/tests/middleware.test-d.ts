import {
  bindCommand,
  createCLI,
  createFileCommand,
  createMiddleware,
  defineCommand,
  defineGroup,
  defineRoot,
} from '../src/index.ts'
import type { GroupContext } from '../src/index.ts'
import { expectTypeOf } from './type-assertions.ts'

const auth = createMiddleware.withContext<{ token: string }>().handler(({ ctx, next }) => {
  expectTypeOf(ctx.services).toEqualTypeOf<{ token: string }>()
  const token: string = ctx.services.token
  return next({ context: { user: { id: token } } })
})
const root = defineRoot({ middleware: [auth] })
const admin = defineGroup({
  middleware: [
    createMiddleware.withContext<GroupContext<[typeof root]>>().handler(({ ctx, next }) => {
      const id: string = ctx.services.user.id
      return next({ context: { adminId: id } })
    }),
  ],
})
const local = defineCommand({
  middleware: [createMiddleware().handler(({ next }) => next({ context: { count: 1 } }))],
  run: ({ ctx }) => {
    expectTypeOf(ctx.services).toEqualTypeOf<{ count: number }>()
    const count: number = ctx.services.count
    // @ts-expect-error unrelated services are not exposed by middleware
    void ctx.services.user
    return count
  },
})
const command = bindCommand('/middleware-local', local)
createCLI({ '/middleware-local': command }, { name: 'app' })

const protectedCommand = bindCommand(
  '/middleware-protected',
  defineCommand.withContext<GroupContext<[typeof root, typeof admin]>>()({
    run: ({ ctx }) => {
      const id: string = ctx.services.user.id
      const adminId: string = ctx.services.adminId
      return { id, adminId }
    },
  }),
  [root, admin],
)
createCLI(
  { '/middleware-protected': protectedCommand },
  { name: 'app', context: () => ({ token: 'credential' }) },
)
// @ts-expect-error middleware still requires initial services that ancestors do not provide
createCLI({ '/middleware-protected': protectedCommand }, { name: 'app' })
createCLI(
  { '/middleware-protected': protectedCommand },
  // @ts-expect-error initial services retain their required value types
  { name: 'app', context: () => ({ token: 1 }) },
)

declare module '../src/command/group.ts' {
  interface FileCommandContexts {
    '/middleware-file': GroupContext<[typeof root, typeof admin]>
  }
}
const file = createFileCommand('/middleware-file')({
  middleware: [createMiddleware().handler(({ next }) => next({ context: { count: 1 } }))],
  run: ({ ctx }) => {
    expectTypeOf(ctx.services.user).toEqualTypeOf<{ id: string }>()
    expectTypeOf(ctx.services.count).toEqualTypeOf<number>()
    expectTypeOf(ctx.services.token).toEqualTypeOf<string>()
    const id: string = ctx.services.user.id
    const count: number = ctx.services.count
    const token: string = ctx.services.token
    return { id, count, token }
  },
})
createCLI(
  { '/middleware-file': bindCommand('/middleware-file', file, [root, admin]) },
  { name: 'app', context: () => ({ token: 'credential' }) },
)

const groupEntry = bindCommand('/middleware-parent', defineCommand({ middleware: [auth] }))
const child = bindCommand(
  '/middleware-parent/child',
  defineCommand.withContext<{ user: { id: string } }>()({ run: ({ ctx }) => ctx.services.user.id }),
)
createCLI(
  { '/middleware-parent': groupEntry, '/middleware-parent/child': child },
  { name: 'app', context: () => ({ token: 'credential' }) },
)
