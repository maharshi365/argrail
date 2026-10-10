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
- Parent parameters and options are not inherited. Share definitions explicitly.
- Overlapping routes must agree on whether a shared option alias takes a value.
- `app help users 42 delete` shows help without running validation or application services.

## Tooling

`@argrail/core` provides the command API and runtime. `@argrail/tooling` generates
the registry, checks projects, and builds the CLI.

- `argrail dev` watches files and configuration, regenerates the registry, and checks types.
- `argrail generate` generates the command registry.
- `argrail check` runs a one-shot check.
- `argrail build` checks and bundles the CLI.

Dev mode adds starter code to empty command files. It does not run handlers.

Try the [demo](examples/demo) from this repository:

```sh
bun install
bun run build:demo
bun examples/demo/dist/argrail-demo.js --help
```

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for development and checks.
