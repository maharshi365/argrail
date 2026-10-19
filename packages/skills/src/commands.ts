import {
  defineCommand,
  bindCommand,
  defineRegistry,
  flag,
  option,
  string,
  repeatableOption,
  variadicArgument,
  CLIError,
  type CommandContext,
  type Group,
  type InputChoice,
  type Output,
} from '@argrail/core'
import { createSkills } from './manager.ts'
import { listHarnesses } from './harnesses/resolve.ts'
import type { SkillBundle, SkillTarget, SkillPlan, ManagementCommands, GroupedManagementCommands } from './types.ts'

const targetOptions = {
  harness: repeatableOption(string(), {
    description: 'Harness ID. Repeat to select several harnesses.',
  }),
  global: flag({ description: 'Use global skills directories.' }),
  project: option(string(), { description: 'Project directory. Default: current directory.' }),
  path: option(string(), {
    description: 'Exact custom skills root; conflicts with harness and scope.',
  }),
  json: flag({ description: 'Structured output without prompts.' }),
}
const actionOptions = {
  ...targetOptions,
  all: flag({ description: 'Select every skill bundled with this CLI.' }),
  group: repeatableOption(string(), { description: 'Select an author-defined group.' }),
  yes: flag({ short: 'y', description: 'Skip confirmation, including directory replacement.' }),
  dryRun: flag({ description: 'Preview without writing files.' }),
}
type TargetValues = Output<typeof targetOptions>
type ActionValues = Output<typeof actionOptions>
type ExecutionValues = Pick<ActionValues, 'dryRun' | 'json' | 'yes'>

export function createSkillsCommands<const B extends SkillBundle, const Mount extends string, const G extends readonly Group[]>(bundle: B, mount: Mount, groups: G): GroupedManagementCommands<Mount, B, G>
export function createSkillsCommands<const B extends SkillBundle, const Mount extends string = 'skills'>(bundle: B, mount?: Mount): ManagementCommands<Mount, B>
export function createSkillsCommands(bundle: SkillBundle, mount = 'skills', groups?: readonly Group[]): ManagementCommands<string, SkillBundle> {
  if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(mount) || mount.split('/')[0] === 'help')
    throw new CLIError('SKILL_COMMAND', 'Invalid skills command mount')
  const manager = createSkills(bundle)
  const names = Object.keys(bundle.skills)
  async function target(options: TargetValues, ctx: CommandContext): Promise<SkillTarget> {
    if (options.path !== undefined) {
      if (options.harness.length || options.global || options.project !== undefined)
        throw new CLIError('SKILL_TARGET', '--path conflicts with harness and scope selections')
      return { path: options.path }
    }
    if (options.global && options.project !== undefined)
      throw new CLIError('SKILL_TARGET', '--global conflicts with --project')
    let harnesses = options.harness
    let scope: 'global' | 'project' = options.global ? 'global' : 'project'
    if (!harnesses.length) {
      if (options.json || !ctx.io.interactive)
        throw new CLIError('INTERACTION_REQUIRED', 'Specify --harness <id> or --path <skills-root>')
      if (!options.global && options.project === undefined)
        scope = await ctx.input.select<'global' | 'project'>({
          message: 'Installation scope',
          choices: [
            { label: 'Project (current directory)', value: 'project' },
            { label: 'Global', value: 'global' },
          ],
        })
      harnesses = await ctx.input.multiselect({
        message: 'Choose harnesses',
        min: 1,
        choices: listHarnesses({ scope })
          .sort((a, b) => Number(b.detected) - Number(a.detected) || a.label.localeCompare(b.label))
          .map(harness => {
            const choice: InputChoice<string> = {
              label: `${harness.label}${harness.detected ? ' (detected)' : ''}`,
              value: harness.id,
              description: (scope === 'global' ? harness.globalPath : harness.projectPath) ?? '',
            }
            if (harness.disabled) choice.disabled = harness.disabled
            return choice
          }),
      })
    }
    if (scope === 'global') return { scope, harnesses }
    if (options.project !== undefined) return { scope, harnesses, project: options.project }
    return { scope, harnesses }
  }
  async function selection(args: { names: string[] }, options: ActionValues, ctx: CommandContext, destination: SkillTarget) {
    let skills = manager.select({ skills: args.names, groups: options.group, all: options.all })
    if (!skills.length) {
      if (options.json || !ctx.io.interactive)
        throw new CLIError('INTERACTION_REQUIRED', 'Specify skill names, --group <name>, or --all')
      const installed = await manager.status(destination)
      const choices = [
        ...Object.entries(bundle.groups).map(([name, group]) => ({
          label: `Group: ${name}`,
          value: `group:${name}`,
          description: group.description,
        })),
        ...names.map(name => ({
          label: `${name} (${[...new Set(installed.items.filter(item => item.name === name).map(item => item.status))].join(', ')})`,
          value: `skill:${name}`,
          description: bundle.skills[name]!.description,
        })),
      ]
      const selected = await ctx.input.multiselect({
        message: 'Choose bundled skills (all selects every group and skill)',
        choices,
        min: 1,
      })
      skills = manager.select({
        skills: selected.filter(value => value.startsWith('skill:')).map(value => value.slice(6)),
        groups: selected.filter(value => value.startsWith('group:')).map(value => value.slice(6)),
      })
    }
    return skills
  }
  function preview(plan: SkillPlan, ctx: CommandContext) {
    ctx.io.stderr.write(`${plan.action} · ${plan.bundleId} · copy mode\n`)
    for (const root of plan.roots)
      if (root.shared.length > root.harnesses.length)
        ctx.io.stderr.write(
          `Shared root: ${root.root}. ${plan.action === 'remove' ? 'Removing shared files affects every harness that reads this root.' : 'Other compatible harnesses may also see these skills.'}\n`,
        )
    for (const item of plan.items)
      ctx.io.stderr.write(
        `  ${item.operation}: ${item.name} → ${item.path}${item.reason ? ` (${item.reason})` : ''}\n`,
      )
    const installs = plan.items.filter(item => item.operation === 'install')
    ctx.io.stderr.write(
      `${installs.reduce((total, item) => total + item.fileCount, 0)} files · ${installs.reduce((total, item) => total + item.bytes, 0)} bytes\n`,
    )
  }
  async function executePlan(plan: SkillPlan, options: ExecutionValues, ctx: CommandContext) {
    if (options.dryRun) {
      if (options.json) ctx.io.json(plan)
      else preview(plan, ctx)
      ctx.exitCode = plan.items.some(item => item.operation === 'conflict') ? 1 : 0
      return plan
    }
    if (!options.json) preview(plan, ctx)
    if (
      !options.yes &&
      !options.json &&
      ctx.io.interactive &&
      !(await ctx.input.confirm({ message: 'Proceed?', default: false }))
    )
      return { cancelled: true }
    const result = await manager.apply(plan, { signal: ctx.signal })
    ctx.exitCode = result.exitCode
    if (options.json) ctx.io.json(result)
    else
      for (const item of result.items)
        ctx.io.stdout.write(
          `${item.status}: ${item.name} → ${item.path}${item.reason ? ` (${item.reason})` : ''}\n`,
        )
    return result
  }
  function managed(action: SkillPlan['action']) {
    return defineCommand({
      description: `${action === 'add' ? 'Install' : action === 'update' ? 'Update' : 'Remove'} skills bundled with this CLI.`,
      args: [variadicArgument('names', string())],
      options: actionOptions,
      run: async ({ args, options, ctx }) => {
        try {
          const destination = await target(options, ctx)
          const skills = await selection(args, options, ctx, destination)
          const plan = await manager.plan({
            action,
            skills,
            target: destination,
          })
          return await executePlan(plan, options, ctx)
        } catch (error) {
          return failure(error, options, ctx)
        }
      },
    })
  }
  // oxlint-disable-next-line deslop/no-unknown-parameters -- Caught values are unknown until the CLIError boundary check.
  function failure(error: unknown, options: { json: boolean }, ctx: CommandContext) {
    if (!options.json || !(error instanceof CLIError)) throw error
    const result = {
      exitCode: ctx.signal.aborted ? 130 : 1,
      error: { code: error.code, message: error.message },
    }
    ctx.exitCode = result.exitCode
    ctx.io.json(result)
    return result
  }
  const commands = {
    add: managed('add'),
    update: managed('update'),
    remove: managed('remove'),
    list: defineCommand({
      description: 'List the skills and groups bundled with this CLI.',
      options: { json: targetOptions.json },
      run: ({ options, ctx }) => {
        const result = {
          id: bundle.id,
          hash: bundle.hash,
          skills: names.map(name => ({ name, description: bundle.skills[name]!.description })),
          groups: bundle.groups,
        }
        if (options.json) ctx.io.json(result)
        else {
          for (const skill of result.skills)
            ctx.io.stdout.write(`${skill.name} — ${skill.description}\n`)
          for (const [name, group] of Object.entries(result.groups))
            ctx.io.stdout.write(
              `Group ${name}: ${group.skills.join(', ')} — ${group.description}\n`,
            )
        }
        return result
      },
    }),
    status: defineCommand({
      description: 'Inspect installed skills without changing files.',
      options: targetOptions,
      run: async ({ options, ctx }) => {
        try {
          const result = await manager.status(await target(options, ctx))
          if (options.json) ctx.io.json(result)
          else
            for (const item of result.items)
              ctx.io.stdout.write(
                `${item.status}: ${item.name} → ${item.path}${item.hint ? `; ${item.hint}` : ''}\n`,
              )
          return result
        } catch (error) {
          return failure(error, options, ctx)
        }
      },
    }),
  }
  const aliases = { ...commands, delete: commands.remove }
  // SAFETY: aliases contains all six management commands and each key is prefixed with the validated mount.
  return defineRegistry(
    Object.fromEntries(
      Object.entries(aliases).map(([name, command]) => {
        const path = `/${mount}/${name}`
        return [
          path,
          groups === undefined ? bindCommand(path, command) : bindCommand(path, command, groups),
        ]
      }),
    ),
  ) as ManagementCommands<string, SkillBundle>
}
