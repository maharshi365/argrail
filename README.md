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

`schemaValue` accepts any synchronous Standard Schema v1 validator. Libraries
such as Zod, Valibot, and ArkType provide this protocol. No schema library is
required by the framework.

```ts
import { createFileCommand, positional, schemaValue } from '@argrail/core'
import { z } from 'zod'

export const Command = createFileCommand('/users/$id')({
  params: {
    id: positional(schemaValue('user ID', z.string().regex(/^\d+$/).transform(Number))),
  },
  run: ({ params }) => {
    // params.id is a number.
    return { id: params.id }
  },
})
```

Programmatic invocation and explicit defaults use the **schema input type**.
Handlers receive its **output type**. Schema transformations run once per value
during execution; their output is not passed through the input schema again.

```ts
await cli.invoke('/users/$id', { params: { id: '42' } })
```

Options and trailing arguments support the same schemas. To convert shell text
before validation, pass `{ parse: Number }`, `{ parse: JSON.parse }`, or another
conversion function to `schemaValue`.

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
```
