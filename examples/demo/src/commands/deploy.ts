import { defineCommand, choice, flag, integer, option } from '@argrail/core'

export const Command = defineCommand({
  description: 'Deploy a project to the selected environment.',
  options: {
    environment: option(choice(['dev', 'production']), { default: 'dev', short: 'e', description: 'Target environment.' }),
    replicas: option(integer({ min: 1, max: 20 }), { default: 1, short: 'r', description: 'Number of replicas.' }),
    dryRun: flag({ description: 'Show the deployment plan without making changes.' }),
  },
  run: ({ options, ctx }) => {
    ctx.io.stdout.write(`${options.dryRun ? 'Plan' : 'Deploy'}: ${options.environment}, ${options.replicas} replica(s)\n`)
    return { environment: options.environment, replicas: options.replicas }
  },
})
