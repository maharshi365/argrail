# Argrail

A file-based CLI framework with typed commands and runtime input validation.

## Development

```sh
bun run dev:demo
```

For another project:

```sh
bun run argrail dev --project path/to/project
```

The background watcher regenerates the command registry after file adds,
renames, and deletes. A TypeScript watcher checks source edits. Configuration
changes also trigger generation. Command handlers are never run automatically.

Use `argrail check` for a one-shot check and `argrail build` to check and bundle.

## Routing rules

- Command files determine command paths. `index.ts` defines a group entry.
- `$id` segments require corresponding positional definitions.
- Static segments take priority over dynamic segments.
- Options can appear before or between command words. `--` ends option parsing.
- Overlapping executable routes must agree on whether an option alias is a flag
  or takes a value. This includes short aliases. Conflicts fail at CLI creation.
- Unrelated static commands can reuse an alias with different arity.
- Parent parameter schemas and options are **not inherited**. Share descriptor
  objects explicitly when commands need the same validation rules.
- `app help users 42 delete` resolves dynamic values without validating them or
  starting application services. Route templates also work.
- Narrow a union-typed path before calling `cli.invoke`. Each call must identify
  one command so its input and result types stay linked.

Route segments, option aliases, option scopes, and trailing-argument maps are
compiled when `createCLI` runs, not rebuilt for every invocation.

## Schema libraries

`validateParams` and `validateOptions` accept whole-object, synchronous Standard
Schema v1 validators. Zod v4, Valibot, and ArkType support this protocol. No schema
library is required by the framework.

```ts
import { createFileCommand } from '@argrail/core'
import { z } from 'zod'

export const Command = createFileCommand('/users/$id')({
  validateParams: z.object({
    id: z.string().regex(/^\d+$/).transform(Number),
  }),
  validateOptions: z.object({
    limit: z.coerce.number().int().positive().default(10),
    verbose: z.boolean().default(false),
  }),
  optionConfig: {
    limit: { short: 'l', description: 'Maximum results' },
    verbose: { type: 'flag', short: 'v', description: 'Show more details' },
  },
  run: ({ params, options }) => {
    // params.id and options.limit are numbers; options.verbose is a boolean.
    return { id: params.id, ...options }
  },
})
```

`optionConfig` must cover every schema input key, including optional keys.
TypeScript rejects missing and unknown keys. Options take text values by default;
`type: 'flag'` makes an option boolean. Flags support `--no-verbose` unless
`negate: false` is set. Shell values stay strings, except flags. Schemas own
conversion, validation, defaults, and required fields.

Standard Schema does not expose field names at runtime. For JavaScript callers,
`optionConfig` defines accepted option names; schema-key coverage cannot be checked.
Help displays CLI metadata without executing schemas or inferring schema defaults.

Programmatic invocation uses the **schema input type**. Handlers receive its
**output type**. Each whole-object schema runs once during execution; its output
is not validated again. Parameter schema input keys must match the route's `$`
segments. `defineCommand` also accepts these schemas; `bindCommand` supplies the
route path.

```ts
await cli.invoke('/users/$id', { params: { id: '42' } })
```

The descriptor API remains supported. Use `schemaValue(label, schema)` with
`positional`, `option`, or `argument` for per-value validation, including trailing
arguments. Its optional `{ parse: Number }` or `{ parse: JSON.parse }` setting
converts shell text before validation. Do not combine `params` with
`validateParams`, or `options` with `validateOptions`, in one command.

### Libraries without Standard Schema

Supply a synchronous callback that validates its input and returns the decoded
output. Specify input and output types if the library's API erases them.

```ts
const id = schemaValue<string, number>('user ID', input => legacySchema.parse(input))
```

Standard Schema issue messages become usage errors. Callback exceptions become
a safe `Invalid <label>` message. For a specific user-safe callback error, throw
`ValidationError`. Raw exception messages are not exposed.

Async schemas are rejected with a clear error. Put asynchronous business checks
in the handler, not in argument validation.

## Checks

```sh
bun test
bun run check
bun run check:demo
bun run lint
bun run format
```

Use `bun run lint` to apply safe lint fixes and `bun run format` to format
the workspace. Oxlint uses `oxlint.config.mjs`; Oxfmt uses `.oxfmtrc.json`.
Both tools exclude generated files and build output.
Oxlint enables the `ai-deslop` recommended preset, including type-aware linting,
and `deslop/no-duplicate-types` with default options as an error.
The safety-comment rule is temporarily disabled. Local exceptions document
runtime boundary validation that must remain available to JavaScript callers.
