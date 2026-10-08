import { argument, bindCommand, choice, createCLI, defineCommand, integer, option, positional, string, value } from '../../packages/core/src/index.ts'
import type { CommandInput, CommandResult, CommandHandlerInput } from '../../packages/core/src/index.ts'

const lookup = defineCommand({
  params: { id: positional(integer()) },
  args: [argument('format', choice(['short', 'full']), { default: 'short' })],
  options: { label: option(string()) },
  run: async ({ params, args, ctx }) => {
    const id: number = params.id
    const format: 'short' | 'full' = args.format
    const selected = await ctx.input.select({ message: 'Mode', choices: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] })
    const mode: 'one' | 'two' = selected
    // @ts-expect-error selected values retain their literal union
    const invalid: 'other' = selected
    return { id, format, mode, invalid }
  },
})
const command = bindCommand('/records/$id', lookup)
// @ts-expect-error generated route parameters must have corresponding definitions
bindCommand('/records/$other', lookup)
// @ts-expect-error an unbound definition cannot invent parameters for a static file path
bindCommand('/records', lookup)
// @ts-expect-error dynamic files cannot bind definitions without required params
bindCommand('/records/$id', defineCommand({ run: () => {} }))

const cli = createCLI({ '/records/$id': command }, { name: 'app' })
cli.invoke('/records/$id', { params: { id: 1 } })
cli.invoke('/records/$id', { params: { id: 1 }, args: { format: 'full' } })
// @ts-expect-error defaulted positional values retain the parser's literal union
cli.invoke('/records/$id', { params: { id: 1 }, args: { format: 'wrong' } })
// @ts-expect-error unknown trailing argument keys are rejected
cli.invoke('/records/$id', { params: { id: 1 }, args: { unknown: true } })
const input: CommandInput<typeof command> = { params: { id: 1 } }
const result: CommandResult<typeof command> = { id: 1, format: 'short', mode: 'one', invalid: 'other' }
const handler = (input: CommandHandlerInput<typeof command>) => input.params.id
void [input, result, handler]

const group = bindCommand('/records', defineCommand({ description: 'Records' }))
const grouped = createCLI({ '/records': group, '/records/$id': command }, { name: 'app' })
// @ts-expect-error metadata-only groups are not executable through typed invocation
grouped.invoke('/records', {})

const serviceCommand = defineCommand.withContext<{ prefix: string }>()
const service = bindCommand('/service', serviceCommand({ run: ({ ctx }) => ctx.services.prefix }))
createCLI({ '/service': service }, { name: 'app', context: () => ({ prefix: 'hello' }) })
// @ts-expect-error service-dependent commands require context initialization
createCLI({ '/service': service }, { name: 'app' })
// @ts-expect-error supplied services must match the handler context
createCLI({ '/service': service }, { name: 'app', context: () => ({ prefix: 1 }) })
// @ts-expect-error ordinary commands must not erase required application services
createCLI({ '/service': service, '/records/$id': command }, { name: 'app' })

const identifier = value('identifier', {
  parse: text => ({ id: text }),
  validate: (input: unknown): { id: string } => {
    if (typeof input !== 'object' || !input || !('id' in input) || typeof input.id !== 'string') throw new Error()
    return { id: input.id }
  },
})
const transformed = bindCommand('/$id', defineCommand({ params: { id: positional(identifier) }, run: ({ params }) => params.id }))
const transformedCLI = createCLI({ '/$id': transformed }, { name: 'app' })
transformedCLI.invoke('/$id', { params: { id: { id: 'a' } } })
// @ts-expect-error programmatic calls accept decoded values, not shell text
transformedCLI.invoke('/$id', { params: { id: 'a' } })
