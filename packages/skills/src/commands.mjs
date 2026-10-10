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
} from '@argrail/core'
import { createSkills } from './manager.mjs'
import { listHarnesses } from './harnesses/resolve.mjs'

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
  yes: flag({ short: 'y', description: 'Skip confirmation; does not override conflicts.' }),
  dryRun: flag({ description: 'Preview without writing files.' }),
}

export function createSkillsCommands(bundle, mount = 'skills', groups) {
  if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(mount) || mount.split('/')[0] === 'help')
    throw new CLIError('SKILL_COMMAND', 'Invalid skills command mount')
  const manager = createSkills(bundle)
  const names = Object.keys(bundle.skills)
  async function target(options, ctx) {
    if (options.path !== undefined) {
      if (options.harness.length || options.global || options.project !== undefined)
        throw new CLIError('SKILL_TARGET', '--path conflicts with harness and scope selections')
      return { path: options.path }
    }
    if (options.global && options.project !== undefined)
      throw new CLIError('SKILL_TARGET', '--global conflicts with --project')
    let harnesses = options.harness
    let scope = options.global ? 'global' : 'project'
    if (!harnesses.length) {
      if (options.json || !ctx.io.interactive)
        throw new CLIError('INTERACTION_REQUIRED', 'Specify --harness <id> or --path <skills-root>')
      if (!options.global && options.project === undefined)
        scope = await ctx.input.select({
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
            const choice = {
              label: `${harness.label}${harness.detected ? ' (detected)' : ''}`,
              value: harness.id,
              description: scope === 'global' ? harness.globalPath : harness.projectPath,
            }
            if (harness.disabled) choice.disabled = harness.disabled
            return choice
          }),
      })
    }
    const result = { scope, harnesses }
    if (options.project !== undefined) result.project = options.project
    return result
  }
  async function selection(args, options, ctx, destination) {
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
          description: bundle.skills[name].description,
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
  function preview(plan, ctx) {
    ctx.io.stderr.write(`${plan.action} · ${plan.bundleId} · copy mode\n`)
    for (const root of plan.roots)
      if (root.shared.length > root.harnesses.length)
        ctx.io.stderr.write(
          `Shared root: ${root.root}. ${plan.action === 'remove' ? 'Removing shared files affects every harness that reads this root.' : 'Other compatible harnesses may also see these skills.'}\n`,
        )
    for (const item of plan.items)
      ctx.io.stderr.write(
        `  ${item.operation}: ${item.name} → ${item.path}${item.reason ? ` (${item.reason})` : ''}${item.backup ? ' (backup before replacement)' : ''}\n`,
      )
    const installs = plan.items.filter(item => item.operation === 'install')
    ctx.io.stderr.write(
      `${installs.reduce((total, item) => total + item.fileCount, 0)} files · ${installs.reduce((total, item) => total + item.bytes, 0)} bytes\n`,
    )
  }
  async function executePlan(plan, options, ctx) {
    if (options.dryRun) {
      if (options.json) ctx.io.json(plan)
      else preview(plan, ctx)
      ctx.exitCode = plan.items.some(item => item.operation === 'conflict') ? 1 : 0
      return plan
    }
    if (!options.json) preview(plan, ctx)
    if (options.replace && !options.yes && (options.json || !ctx.io.interactive))
      throw new CLIError(
        'INTERACTION_REQUIRED',
        'Use --yes with --replace to confirm backup and replacement without prompts',
      )
    if (
      !options.yes &&
      !options.json &&
      ctx.io.interactive &&
      !(await ctx.input.confirm({ message: 'Proceed?', default: false }))
    )
      return { cancelled: true }
    const result = await manager.apply(plan, { signal: ctx.signal })
    if (options.save) {
      if (result.exitCode)
        result.manifestError = {
          code: 'SKILL_MANIFEST_INCOMPLETE',
          message: 'Project selections were not saved because installation was incomplete',
        }
      else {
        try {
          result.manifest = await manager.save(plan, result)
        } catch (error) {
          if (!(error instanceof CLIError) && !['EACCES', 'EPERM', 'ENOSPC'].includes(error.code))
            throw error
          result.manifestError = {
            code: error instanceof CLIError ? error.code : 'SKILL_MANIFEST_WRITE',
            message:
              error instanceof CLIError
                ? error.message
                : `Cannot save project manifest (${error.code})`,
          }
          result.exitCode = 1
        }
      }
    }
    ctx.exitCode = result.exitCode
    if (options.json) ctx.io.json(result)
    else
      for (const item of result.items)
        ctx.io.stdout.write(
          `${item.status}: ${item.name} → ${item.path}${item.reason ? ` (${item.reason})` : ''}${item.backup ? `; backup: ${item.backup}` : ''}\n`,
        )
    if (!options.json && result.manifestError)
      ctx.io.stderr.write(`Manifest not saved: ${result.manifestError.message}\n`)
    return result
  }
  function managed(action) {
    const definitions = { ...actionOptions }
    if (action !== 'remove')
      definitions.replace = flag({ description: 'Back up and replace conflicting files.' })
    if (action === 'add')
      definitions.save = flag({
        description: 'Save successful project selections to argrail.skills.json.',
      })
    return defineCommand({
      description: `${action === 'add' ? 'Install' : action === 'update' ? 'Update' : 'Remove'} skills bundled with this CLI.`,
      args: [variadicArgument('names', string())],
      options: definitions,
      run: async ({ args, options, ctx }) => {
        try {
          if (options.save && (options.global || options.path !== undefined))
            throw new CLIError(
              'SKILL_MANIFEST',
              '--save supports project harness destinations only',
            )
          const destination = await target(options, ctx)
          const skills = await selection(args, options, ctx, destination)
          let plan = await manager.plan({
            action,
            skills,
            target: destination,
            replace: options.replace ?? false,
          })
          if (
            !options.yes &&
            !options.json &&
            !options.dryRun &&
            ctx.io.interactive &&
            plan.items.some(
              item =>
                item.operation === 'conflict' &&
                item.reason.startsWith('Unmanaged or modified files'),
            )
          ) {
            preview(plan, ctx)
            const conflict = await ctx.input.select({
              message: 'Existing files conflict with this installation',
              choices: [
                { label: 'Keep existing files (report conflicts)', value: 'keep' },
                { label: 'Back up and replace conflicting files', value: 'replace' },
              ],
            })
            if (conflict === 'replace')
              plan = await manager.plan({ action, skills, target: destination, replace: true })
          }
          return await executePlan(plan, options, ctx)
        } catch (error) {
          return failure(error, options, ctx)
        }
      },
    })
  }
  function failure(error, options, ctx) {
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
          skills: names.map(name => ({ name, description: bundle.skills[name].description })),
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
    restore: defineCommand({
      description: 'Restore saved project selections from this exact CLI bundle.',
      options: {
        project: targetOptions.project,
        json: targetOptions.json,
        yes: actionOptions.yes,
        dryRun: actionOptions.dryRun,
      },
      run: async ({ options, ctx }) => {
        try {
          return await executePlan(await manager.restore(options.project), options, ctx)
        } catch (error) {
          return failure(error, options, ctx)
        }
      },
    }),
    recover: defineCommand({
      description: 'Recover an interrupted installation at the selected target.',
      options: { ...targetOptions, yes: actionOptions.yes },
      run: async ({ options, ctx }) => {
        try {
          const destination = await target(options, ctx)
          if (!options.yes && (options.json || !ctx.io.interactive))
            throw new CLIError('INTERACTION_REQUIRED', 'Use --yes to recover without prompts')
          if (
            !options.yes &&
            !(await ctx.input.confirm({
              message: 'Recover interrupted installation?',
              default: false,
            }))
          )
            return { cancelled: true }
          const result = await manager.recover(destination)
          if (options.json) ctx.io.json(result)
          else
            for (const item of result.items)
              ctx.io.stdout.write(
                `${item.recovered ? 'recovered' : 'no recovery needed'}: ${item.path}\n`,
              )
          return result
        } catch (error) {
          return failure(error, options, ctx)
        }
      },
    }),
  }
  commands.delete = commands.remove
  return defineRegistry(
    Object.fromEntries(
      Object.entries(commands).map(([name, command]) => {
        const path = `/${mount}/${name}`
        return [
          path,
          groups === undefined ? bindCommand(path, command) : bindCommand(path, command, groups),
        ]
      }),
    ),
  )
}
