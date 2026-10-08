import { defineCommand, flag, integer, positional } from '@argrail/core'

export const Command = defineCommand({
  description: 'Delete a user by their numeric ID.',
  params: { userId: positional(integer({ min: 1 }), { description: 'User ID.' }) },
  options: { force: flag({ short: 'f', description: 'Skip confirmation.' }) },
  run: async ({ params, options, ctx }) => {
    if (!options.force) {
      const confirmed = await ctx.input.select({ message: `Delete user ${params.userId}?`, choices: [
        { label: 'No', value: false }, { label: 'Yes', value: true },
      ] })
      if (!confirmed) return { deletedId: null }
    }
    ctx.io.stdout.write(`Deleted user ${params.userId}${options.force ? ' (forced)' : ''}\n`)
    return { deletedId: params.userId }
  },
})
