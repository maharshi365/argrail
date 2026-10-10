# Bundled skills

Argrail can expose the Agent Skills shipped by a CLI author. It does not install
arbitrary repositories, browse a marketplace, or download skills at runtime.

## Author setup

Install `@argrail/skills` alongside `@argrail/core`. Add a `/skills` route at
`src/commands/skills.ts` (or `src/commands/skills/index.ts`):

```ts
import { defineCommand } from '@argrail/core'

export const Command = defineCommand({ description: 'Manage bundled skills.' })

// Optional selection shortcuts.
export const SkillGroups = {
  deployment: {
    description: 'Deploy and review Acme services',
    skills: ['acme-deploy', 'acme-review'],
  },
} as const
```

The route is the opt-in. There is no `skills` block in `argrail.config.json`.
Resources come from the project-root `skills/` directory. Bundle identity comes
from `package.json`'s `name`, or the CLI name if no package name is set. Keep that
identity stable between releases. Resources without a `/skills` route are ignored.

Groups are optional selection shortcuts, not dependencies or merged skills.
`SkillGroups` must be an exported static object literal; `as const` and `satisfies`
are supported. Generation reads it without executing the route module. Changes
to groups are also watched during development.

```text
skills/
├── acme-deploy/
│   ├── SKILL.md
│   └── scripts/verify.sh
└── acme-review/
    ├── SKILL.md
    └── references/checklist.md
```

Each immediate child is one skill. Its `SKILL.md` must follow the
[Agent Skills specification](https://agentskills.io/specification), including a
name that matches the directory. Use product-prefixed names to reduce conflicts.
All files within that skill directory are included, including binary resources.
Nested `SKILL.md` files remain resources; they do not become separate skills.

Generation rejects invalid frontmatter, unsupported names, links, portable path
collisions, and accidental `.git` or `node_modules` directories. Each skill is
limited to 4,096 files and 32 MB. Executable intent is recorded from file modes;
on Windows, tracked Git executable bits are also used when Git is available.

## Generation and builds

```text
skills/ → src/commandTree.gen.ts → shipped JS bundle / native executable
                   │
                   ├── commandTree: author + management commands
                   └── skillTree: typed metadata + lazy file loaders

.argrail/skills.bundle.ts: internal generated file payload
```

There is no separate public `skillTree.gen.ts` or author-maintained manifest.
Do not edit generated files. `argrail dev` watches skill contents, including
binary resources. `argrail check` validates the bundle and group references.
`argrail build`, including `--compile`, embeds the resources. No source directory
is required after shipping. Help and listing do not load resource payloads.

Generation, development, and build never install skills. The management mount
reserves its `/skills/*` subtree for management commands. Generated management commands inherit
structural root/group middleware and the `/skills` route's own middleware. Pathless
route directories keep their middleware ancestry. Scope authentication to
the business command subtree if installing public skills should not require it.

## Commands

```sh
acme skills list
acme skills add
acme skills add acme-deploy --harness claude-code
acme skills add --group deployment --harness claude-code --yes
acme skills add --all --harness opencode --global --yes
acme skills add acme-review --harness codex --project ./backend --yes
acme skills add acme-deploy --path ./custom-agent/skills --yes
acme skills status --harness claude-code
acme skills update --all --harness claude-code --yes
acme skills remove acme-deploy --harness claude-code --yes
```

`delete` aliases `remove`. Names and groups can combine; `--all` cannot combine
with either. Here, all always means the skills bundled with this CLI, not all
harnesses. Repeat `--harness` to select several targets.

The default scope is the current project. `--global` conflicts with `--project`.
`--path` names an exact skills root and conflicts with harness/scope options.
Missing selections prompt only on an interactive terminal. The simple numbered
picker includes descriptions, destination-specific state, groups, and an `all`
selection. It has no search box. Harness detection supplies suggestions only.

Fully specified safe operations work without a terminal. `--yes` skips
confirmation but never overrides conflicts. `--replace` permits add/update
replacement with a backup. Non-interactive replacement requires both flags.
Interactive users can choose to keep conflicting files or back up and replace.
Removal never discards edited or unowned files.

`--dry-run` returns the same plan without writes. `--json` never prompts and
returns structured results; parser errors still use the framework's standard
error presentation. Blocked work returns a nonzero exit code. Every requested
destination appears in the result, including ordinary write failures.

Updates only affect instances owned by this CLI. They do not add previously
unselected harnesses. The running CLI's bundle is the update source: upgrade
the CLI first to obtain newer skills. Installation uses copies, never symlinks.

## Shared roots and ownership

Some harnesses share `.agents/skills`. Selecting one of them does not provide
harness-only isolation. The preview warns that other compatible harnesses may
also see the files. Resolved roots, including links/junctions, are deduplicated.
Explicitly selected harnesses get their required directories created or a
visible failure.

Each destination has a versioned `.argrail-skills.json` receipt. It tracks the
bundle identity, content hashes, file hashes, executable intent, and ownership
claims. Identical content can have more than one owning CLI. Removing one owner
does not remove another owner's installation. Different content cannot replace
an installation that another CLI still owns.

Removing one recorded harness claim also preserves other claims at the same
shared root. The result says `released`, not `removed`: the selected harness can
still read those shared files. To remove the shared installation, select all its
recorded harnesses or use the explicit physical `--path`. Other CLI owners are
still protected.

Existing unmanaged directories and local changes are conflicts. Argrail also
detects extra local files. Replacement backups remain under
`.argrail-skills-backups/<transaction>/<skill>` and their paths are reported.
Installation never runs a bundled script or changes harness tool permissions.

`skills status` reports `current`, `outdated`, `modified`, `missing`, or
`unmanaged`, with a path and corrective hint. It never repairs files implicitly.

## Recovery

```text
plan → confirm → lock → revalidate → stage → journal → apply → commit receipt
```

Plans are manager-local and cannot be edited or replayed after application.
Changes made after approval require a fresh plan. Writes are recoverable per
physical root, not atomic across separate harness directories. Successful roots
can remain installed when another root fails; inspect the per-root results.

An interrupted transaction blocks further installation at that root. To recover:

```sh
acme skills recover --harness claude-code --yes
```

Recovery restores uncommitted content and receipts, or finishes committed backup
cleanup. It validates its staging directories before deleting anything.
If files were edited after the interruption, move them aside before recovery;
Argrail will not discard those edits. Unknown
receipt versions and corrupt state are not silently reset. Receipt format v1 is
the first format; later migrations must preserve existing ownership data.

## Team save and restore

```sh
acme skills add --group deployment --harness claude-code --save --yes
acme skills restore --project ./backend --yes
```

Commit the opt-in `argrail.skills.json` desired-state file. It stores bundle
hashes, project-relative targets, and concrete skill selections per target.
Repeated saves merge selections instead of losing earlier targets. Groups are
expanded when saving, so changing a group does not silently change a saved set.
Restore rejects a mismatched bundle or a changed harness path mapping.

Global/custom installations are not saved in v1. Local ownership receipts,
transaction directories, and backups are machine state, not desired state.
Exclude them from version control as appropriate; Argrail does not edit your
`.gitignore` automatically.

## Headless and handwritten use

```ts
import { createSkills } from '@argrail/skills'
import { skillTree } from './commandTree.gen.ts'

const manager = createSkills(skillTree)
const plan = await manager.plan({
  action: 'add',
  skills: ['acme-deploy'],
  target: { project: './backend', harnesses: ['claude-code'] },
})
const result = await manager.apply(plan, { signal })
```

The manager does not print or prompt. Generated skill and group names are
inferred. Handwritten apps can use `createSkillsCommands(bundle, 'skills')` and
`composeRegistries(authorCommands, skillsCommands)`. Optional explicit groups
preserve middleware type information when mounting generated commands.

Core also provides `ctx.input.confirm()`, `ctx.input.multiselect()`,
`repeatableOption()`, and `variadicArgument()`. Inputs support existing
`cli.test({ answers })`, cancellation, descriptions, and disabled reasons.
Numbered prompts use the existing terminal cleanup path.

## Maintainer harness synchronization

```sh
bun run sync:harnesses --ref <commit-or-tag>
bun run sync:harnesses --ref <commit-or-tag> --check
```

The script resolves a ref to an immutable Vercel Skills commit, parses
`src/agents.ts` without executing it, and generates symbolic path rules.
Environment overrides are resolved on the user's machine. A reviewed adapter
handles OpenClaw's legacy-directory priority. Unsupported expressions stop
the sync before any output changes. Generated data records its source commit
and source hash.

`bun run build` also runs this sync. Without `--ref`, the sync uses the commit
recorded in `registry.gen.json`, not the latest upstream branch. Update that pin
explicitly with the command above. A network or upstream parsing failure stops
the package build and preserves the existing registry.

The bundled installer and `argrail build` for an author's app make no harness-sync
network calls. Synchronization is part of building the framework packages only.
