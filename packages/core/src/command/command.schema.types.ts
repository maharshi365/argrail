import { bindCommand, createCLI, createFileCommand, defineCommand } from '../index.ts'
import type { StandardSchema } from '../index.ts'
import { z } from 'zod'
import * as v from 'valibot'

const configuredSchema = z.object({ count: z.string() })
createFileCommand('/check')({
  // @ts-expect-error optionConfig rejects unknown schema input keys for real schemas
  validateOptions: configuredSchema,
  optionConfig: { count: {}, extra: {} },
  run: () => {},
})
createFileCommand('/check')({
  // @ts-expect-error optionConfig rejects unsupported metadata fields
  validateOptions: configuredSchema,
  optionConfig: { count: { required: true } },
  run: () => {},
})
createFileCommand('/check')({
  // @ts-expect-error optionConfig rejects unsupported option types
  validateOptions: configuredSchema,
  optionConfig: { count: { type: 'other' } },
  run: () => {},
})

const params: StandardSchema<{ id: string }, { id: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: input => ({ value: { id: Number((input as { id: string }).id) } }),
  },
}
const options: StandardSchema<
  { limit?: string; verbose?: boolean },
  { limit: number; verbose: boolean }
> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: () => ({ value: { limit: 10, verbose: false } }),
  },
}
const command = createFileCommand('/users/$id')({
  validateParams: params,
  validateOptions: options,
  optionConfig: { limit: {}, verbose: { type: 'flag' } },
  run: ({ params, options }) => {
    const id: number = params.id
    const limit: number = options.limit
    const verbose: boolean = options.verbose
    // @ts-expect-error handlers receive transformed output
    const text: string = params.id
    return { id, limit, verbose, text }
  },
})
const cli = createCLI({ [command.path]: command }, { name: 'app' })
void cli.invoke(command.path, { params: { id: '42' } })
void cli.invoke(command.path, { params: { id: '42' }, options: { limit: '5', verbose: true } })
// @ts-expect-error invocation receives schema input
void cli.invoke(command.path, { params: { id: 42 } })
// @ts-expect-error required schema input cannot be omitted
void cli.invoke(command.path, {})
createFileCommand('/check')({
  // @ts-expect-error every input key needs CLI configuration, including optional keys
  validateOptions: options,
  optionConfig: { limit: {} },
  run: () => {},
})
createFileCommand('/check')({
  // @ts-expect-error unknown configuration keys are rejected
  validateOptions: options,
  optionConfig: { limit: {}, verbose: {}, extra: {} },
  run: () => {},
})
// @ts-expect-error schema input keys must match route parameters
createFileCommand('/users/$other')({ validateParams: params, run: () => {} })
// @ts-expect-error optionConfig is required with validateOptions
createFileCommand('/check')({ validateOptions: options, run: () => {} })
const definition = defineCommand({
  validateParams: params,
  validateOptions: options,
  optionConfig: { limit: {}, verbose: { type: 'flag' } },
  run: ({ params }) => params.id,
})
const bound = bindCommand('/users/$id', definition)
const boundCLI = createCLI({ [bound.path]: bound }, { name: 'app' })
void boundCLI.invoke(bound.path, { params: { id: '42' } })
// @ts-expect-error binding must match schema input keys
bindCommand('/users/$other', definition)

const libraryCommand = createFileCommand('/users/$id')({
  validateParams: z.object({ id: z.string().transform(Number) }),
  validateOptions: v.object({
    limit: v.optional(v.pipe(v.string(), v.transform(Number)), '10'),
    verbose: v.optional(v.boolean(), false),
  }),
  optionConfig: { limit: {}, verbose: { type: 'flag' } },
  run: ({ params, options }) => {
    const id: number = params.id
    const limit: number = options.limit
    const verbose: boolean = options.verbose
    return { id, limit, verbose }
  },
})
const libraryCLI = createCLI({ [libraryCommand.path]: libraryCommand }, { name: 'app' })
void libraryCLI.invoke(libraryCommand.path, { params: { id: '42' } })
// @ts-expect-error real-library transformations preserve their input contracts
void libraryCLI.invoke(libraryCommand.path, { params: { id: 42 } })
createFileCommand('/users/$id')({
  // @ts-expect-error option schemas do not remove required route definitions
  validateOptions: options,
  optionConfig: { limit: {}, verbose: {} },
  run: () => {},
})
