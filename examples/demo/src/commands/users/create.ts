import { defineCommand, option, string } from '@argrail/core'

export const Command = defineCommand({
  description: 'Create a user.',
  options: { name: option(string(), { required: true, short: 'n', description: 'Name of the new user.' }) },
  run: ({ options, ctx }) => {
    ctx.io.stdout.write(`Created user: ${options.name}\n`)
    return { name: options.name }
  },
})
