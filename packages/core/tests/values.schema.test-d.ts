import { argument, createCLI, createFileCommand, option, positional, schemaValue } from '../src/index.ts'
import type { StandardSchema, CommandInput, Value } from '../src/index.ts'
import { expectTypeOf } from './type-assertions.ts'

const numeric: StandardSchema<string, number> = {
  '~standard': { version: 1, vendor: 'test', validate: input => ({ value: Number(input) }) },
}
const number = schemaValue('number', numeric)
const command = createFileCommand('/records/$id')({
  params: { id: positional(number) },
  options: { count: option(number, { default: '1' }), limit: option(number) },
  args: [argument('offset', number, { default: '0' })],
  run: ({ params, options, args }) => {
    expectTypeOf(params.id).toEqualTypeOf<number>()
    expectTypeOf(options.count).toEqualTypeOf<number>()
    expectTypeOf(options.limit).toEqualTypeOf<number | undefined>()
    expectTypeOf(args.offset).toEqualTypeOf<number>()
    const id: number = params.id
    const count: number = options.count
    const limit: number | undefined = options.limit
    const offset: number = args.offset
    // @ts-expect-error handlers receive schema outputs, not schema inputs
    const text: string = params.id
    return { id, count, limit, offset, text }
  },
})
const cli = createCLI({ [command.path]: command }, { name: 'app' })
declare const commandInput: CommandInput<typeof command>
expectTypeOf(commandInput.params.id).toEqualTypeOf<string>()
declare const optionInput: NonNullable<CommandInput<typeof command>['options']>
declare const argumentInput: NonNullable<CommandInput<typeof command>['args']>
expectTypeOf(optionInput.count).toEqualTypeOf<string | undefined>()
expectTypeOf(optionInput.limit).toEqualTypeOf<string | undefined>()
expectTypeOf(argumentInput.offset).toEqualTypeOf<string | undefined>()
void cli.invoke(command.path, { params: { id: '42' }, options: { count: '3' }, args: { offset: '2' } })
// @ts-expect-error programmatic invocation receives schema inputs, not transformed outputs
void cli.invoke(command.path, { params: { id: 42 } })
// @ts-expect-error schema defaults use the input type
option(number, { default: 1 })
// @ts-expect-error trailing defaults use the input type
argument('offset', number, { default: 0 })
const adapted = schemaValue('number', (input: number) => ({ number: input }), { parse: Number })
expectTypeOf(adapted).toEqualTypeOf<Value<{ number: number }, number>>()
const adapterCommand = createFileCommand('/adapted')({ options: { count: option(adapted, { required: true }) }, run: ({ options }) => options.count.number })
const adapterCLI = createCLI({ [adapterCommand.path]: adapterCommand }, { name: 'app' })
expectTypeOf(adapterCLI.invoke(adapterCommand.path, { options: { count: 3 } })).toEqualTypeOf<Promise<number>>()
void adapterCLI.invoke(adapterCommand.path, { options: { count: 3 } })
// @ts-expect-error callback adapter input is inferred from its validator
void adapterCLI.invoke(adapterCommand.path, { options: { count: '3' } })
