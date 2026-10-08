import { bindCommand, createFileCommand, createCLI, defineRegistry, choice, flag, integer, option, positional, string } from '../../packages/core/src/index.ts'

const remove = createFileCommand('/users/$userId/delete')({
  params: { userId: positional(integer({ min: 1 })) },
  options: { force: flag(), reason: option(string()), mode: option(choice(['soft', 'hard']), { default: 'soft' }) },
  run: ({ params, options }) => {
    const id: number = params.userId
    const force: boolean = options.force
    const reason: string | undefined = options.reason
    const mode: 'soft' | 'hard' = options.mode
    // @ts-expect-error handlers receive decoded numeric arguments
    const invalid: string = params.userId
    return { deletedId: id, force, reason, mode, invalid }
  },
})
const create = createFileCommand('/users/create')({
  options: { name: option(string(), { required: true }) },
  run: ({ options }) => ({ name: options.name }),
})
const cli = createCLI({ '/users/$userId/delete': remove, '/users/create': create }, { name: 'app' })

async function contract() {
  const result = await cli.invoke('/users/$userId/delete', { params: { userId: 42 } })
  const id: number = result.deletedId
  // @ts-expect-error inferred result remains numeric
  const wrong: string = result.deletedId
  await cli.invoke('/users/create', { options: { name: 'Ada' } })
  // @ts-expect-error unknown command paths are rejected
  cli.invoke('/users/remove', {})
  // @ts-expect-error dynamic params cannot be omitted
  cli.invoke('/users/$userId/delete', {})
  // @ts-expect-error argument types stay linked to their command
  cli.invoke('/users/$userId/delete', { params: { userId: '42' } })
  // @ts-expect-error unknown option keys are rejected
  cli.invoke('/users/$userId/delete', { params: { userId: 42 }, options: { typo: true } })
  // @ts-expect-error choice literals stay narrow
  cli.invoke('/users/$userId/delete', { params: { userId: 42 }, options: { mode: 'other' } })
  // @ts-expect-error required options cannot be omitted
  cli.invoke('/users/create', {})
  // @ts-expect-error required options cannot be hidden behind an empty object
  cli.invoke('/users/create', { options: {} })
  // @ts-expect-error another command's options cannot widen the selected path
  cli.invoke('/users/create', { options: { force: true } })
  return { id, wrong }
}
void contract

bindCommand('/users/create', create)
// @ts-expect-error registry keys cannot disagree with command paths
defineRegistry({ '/users/add': create })
// @ts-expect-error direct CLI registries retain the same path constraint
createCLI({ '/users/add': create }, { name: 'app' })
// @ts-expect-error generated file path must match the command's declared path
bindCommand('/users/add', create)
// @ts-expect-error a positional declaration is required for each filename parameter
createFileCommand('/$id')({ run: () => {} })
createFileCommand('/$id')({
  // @ts-expect-error positional definitions cannot invent keys not present in the path
  params: { id: positional(string()), extra: positional(string()) },
  run: () => {},
})
const ping = createFileCommand('/ping')({ run: () => 'pong' as const })
const tiny = createCLI({ '/ping': ping }, { name: 'app' })
// @ts-expect-error commands with no options reject arbitrary option keys
tiny.invoke('/ping', { options: { extra: true } })
// @ts-expect-error static commands reject invented positional keys
tiny.invoke('/ping', { params: { id: 1 } })
createFileCommand('/bad')({
  // @ts-expect-error named options cannot be positional descriptors
  options: { id: positional(integer()) },
  run: () => {},
})
createFileCommand('/$id')({
  // @ts-expect-error route params cannot be flag descriptors
  params: { id: flag() },
  run: () => {},
})
// @ts-expect-error defaults cannot widen the decoder's choice type
option(choice(['soft', 'hard']), { default: 'other' })
