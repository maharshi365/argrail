# Contributing to Argrail

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

Dev mode fills empty (or whitespace-only) command files with starter code,
including positional definitions for `$parameters`. It leaves files with code
or comments unchanged. `generate`, `check`, and `build` do not edit command sources.

Use `argrail check` for a one-shot check and `argrail build` to check and bundle.

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

`bun run check` checks library code and type tests. Run `bun run check:lib`
or `bun run test:types` to check each separately. Type tests live in
`packages/core/tests/*.test-d.ts` and are compiled, not run. Use
`expectTypeOf(...).toEqualTypeOf<...>()` for exact inferred types and
`@ts-expect-error` for API calls that must fail to compile.
