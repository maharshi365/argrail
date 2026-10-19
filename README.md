# Argrail

Argrail is a TypeScript framework for building command-line apps. It turns files
into commands, validates user input, and gives handlers typed parameters and
options.

Think **TanStack Router, but for CLIs**: your file tree defines command paths,
`$parameters` capture values, and a generated command registry connects it all.
Instead of matching URLs, Argrail matches command-line arguments. This is a
similar design, not a TanStack integration.

## File-based commands

```text
src/commands/
  deploy.ts                 → app deploy
  users/
    create.ts               → app users create
    $userId/
      delete.ts             → app users 42 delete
```

Each file exports a `Command`. For example, `src/commands/users/$userId/delete.ts`:

```ts
import { defineCommand, flag, integer, positional } from '@argrail/core'

export const Command = defineCommand({
  description: 'Delete a user.',
  params: {
    userId: positional(integer({ min: 1 }), { description: 'User ID' }),
  },
  options: {
    force: flag({ short: 'f', description: 'Skip confirmation' }),
  },
  run: ({ params, options, ctx }) => {
    // params.userId is a number; options.force is a boolean.
    ctx.io.stdout.write(`Deleting user ${params.userId}\n`)
    return { deletedId: params.userId, forced: options.force }
  },
})
```

Argrail handles parsing, validation, and help. You write the command logic.
Use `ctx.io` for output and `ctx.input` for prompts.

## Input validation

Use built-in helpers such as `string`, `integer`, and `choice` with `positional`,
`option`, or `argument`. Use `flag` for boolean options. No schema library is
required.

Prefer a schema library? `validateParams` and `validateOptions` accept synchronous
[Standard Schema](https://standardschema.dev/) validators, including Zod v4,
Valibot, and ArkType:

```ts
import { defineCommand } from '@argrail/core'
import { z } from 'zod'

export const Command = defineCommand({
  validateOptions: z.object({
    limit: z.coerce.number().int().positive().default(10),
  }),
  optionConfig: {
    limit: { short: 'l', description: 'Maximum results' },
  },
  run: ({ options }) => options.limit,
})
```

- Add an `optionConfig` entry for every schema input key. Use `type: 'flag'` for booleans.
- Shell values are strings, except flags. Schemas handle conversion and defaults.
- Handlers receive validated output; programmatic calls accept schema input.
- Use `schemaValue(label, schema)` for per-value schemas or validation callbacks.
- Do not mix `params` with `validateParams`, or `options` with `validateOptions`.
- Keep async business checks in handlers, not input schemas.

## Routing essentials

- `index.ts` defines a group entry. `$name` segments need matching parameter definitions.
- Static commands take priority over dynamic routes.
- Options can appear before or between command words. `--` ends option parsing.
- Short flags can be bundled (`-vf`); short options accept attached values (`-n10`).
- Parent parameters and options are not inherited. Share definitions explicitly.
- Middleware is inherited. A command's middleware protects that command and its descendants.
- Overlapping routes must agree on whether a shared option alias takes a value.
- `app help users 42 delete` shows help without running validation or application services.

## Middleware and authentication

Attach middleware to the root, a group, or one command. It runs parent-first and
can extend `ctx.services` with typed values. A failure stops downstream execution.
Help, version, and invalid input do not initialize services or run middleware.

Keep `login` outside the protected subtree:

```text
src/commands/
├── login.ts
└── _protected/              # pathless: does not add command words
    ├── __group.ts           # auth for every command below this directory
    └── deploy.ts            # app deploy
```

```ts
// src/commands/_protected/__group.ts
import { CLIError, createMiddleware, defineGroup } from '@argrail/core'
import { verifyStoredCredentials } from '../-auth.ts'

const auth = createMiddleware().handler(async ({ next }) => {
  const user = await verifyStoredCredentials()
  if (!user) throw new CLIError('UNAUTHENTICATED', 'Run "app login" first.')
  return next({ context: { user } })
})

export const Group = defineGroup({ middleware: [auth] })
```

Use `createFileCommand` to infer inherited services from the generated tree:

```ts
// src/commands/_protected/deploy.ts
import { createFileCommand } from '@argrail/core'

export const Command = createFileCommand('/deploy')({
  run: ({ ctx }) => {
    ctx.io.stdout.write(`Deploying as ${ctx.services.user.id}\n`)
  },
})
```

- `__root.ts` exports `Root = defineRoot({ middleware: [...] })` for all commands.
- `__group.ts` exports `Group = defineGroup({ middleware: [...] })` for its subtree.
- A command can declare its own `middleware` list. `index.ts` middleware also applies to descendants.
- Children add middleware; they cannot remove parent middleware.
- `createMiddleware.withContext<Services>()` declares services the middleware needs.
  Supply services not added by ancestors through `createCLI({ context })`.
- Middleware must return `next()` or `await next()`'s result, or throw an error.
  Use `try/finally` around `await next()` for cleanup. Call `next()` only once.
  The result envelope is frozen. Do not replace it or change its `value` field.
- Context additions are shallow and invocation-scoped. Existing keys and unsafe
  property names cannot be replaced. Framework fields such as `ctx.io` stay separate.
- `cli.invoke()`, `cli.execute()`, `cli.test()`, and `cli.run()` use the same pipeline.

For a handwritten registry, middleware on `/users` applies to `/users` and its
descendants. Use `bindCommand(path, command, [root, group])` to specify an explicit
ancestor chain, including pathless groups. For unbound `defineCommand` handlers,
use `defineCommand.withContext<GroupContext<[typeof group]>>()` for inherited types.
Regenerate the tree after changing files or groups. Remote APIs must still
authorize their own requests.

## Tooling

### Bundled skills

Add a `/skills` route (`src/commands/skills.ts` or `skills/index.ts`) and standard
`skills/<name>/SKILL.md` directories. No skills configuration is needed. Install
`@argrail/skills` alongside `@argrail/core`. Argrail validates and embeds the complete skill files, exports
`skillTree` from the existing generated registry, and exposes management commands:

```sh
app skills add --all --harness claude-code --yes
app skills status --harness claude-code
app skills update --all --harness claude-code --yes
app skills remove --all --harness claude-code --yes
```

This distributes only skills bundled by the CLI author. It does not browse or
download third-party skills. Add and update replace whole skill directories,
including local edits. See [Bundled skills](docs/SKILLS.md) for groups,
global/custom targets, and direct file operations.

### Build and development

`@argrail/core` provides the command API and runtime. `@argrail/tooling` generates
the registry, checks projects, and builds the CLI.

- `argrail dev` watches files and configuration, regenerates the registry, and checks types.
- `argrail generate` generates the command registry.
- `argrail check` runs a one-shot check.
- `argrail build` checks and bundles the CLI.

Dev mode adds starter code to empty command files. It does not run handlers.

### Set up your app

Use Node.js 22.22 or later for development and builds. In your app, create
`argrail.config.json`:

```json
{
  "name": "my-cli",
  "version": "0.0.1"
}
```

Add scripts to your app's `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "dev": "argrail dev",
    "build": "argrail build"
  }
}
```

Create a `tsconfig.json` if your app does not have one:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts"]
}
```

Put your command files in `src/commands/`, then run `npm run dev`. Argrail
generates `src/commandTree.gen.ts` and the CLI entry point, watches changes,
and checks types. No manual generation step is needed, and handlers do not run
automatically.

Add `.argrail/` and `dist/` to your app's `.gitignore`. To build and run your CLI:

```sh
npm run build
node dist/my-cli.js --help
```

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for development and checks.
