import { defineCommand } from '@argrail/core'

export const Command = defineCommand({ description: 'Manage the skills bundled with this CLI.' })

export const SkillGroups = {
  starter: {
    description: 'Use the demo CLI safely.',
    skills: ['argrail-demo-deploy'],
  },
} as const
