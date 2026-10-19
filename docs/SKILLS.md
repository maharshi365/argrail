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
skills/ → src/commandTree.gen.ts → shipped JavaScript bundle
                   │
                   ├── commandTree: author + management commands
                   └── skillTree: typed metadata + lazy file loaders

.argrail/skills.bundle.ts: internal generated file payload
```

There is no separate public `skillTree.gen.ts` or author-maintained manifest.
Do not edit generated files. `argrail dev` watches skill contents, including
binary resources. `argrail check` validates the bundle and group references.
`argrail build` embeds the resources. No source directory
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

Fully specified operations work without a terminal. Interactive operations show
a preview and ask for confirmation. `--yes` skips confirmation, including
directory replacement.

Add and update replace the entire selected skill directory with the bundled
files. This removes local edits, user-added files, and obsolete resources. Update
requires an existing skill directory; use add for a missing installation. Remove
deletes the selected skill directory, including any local changes. Other skill
directories are left untouched.

`--dry-run` returns the same plan without writes. `--json` never prompts and
returns structured results; parser errors still use the framework's standard
error presentation. Blocked work returns a nonzero exit code. Every requested
destination appears in the result, including ordinary write failures.

The running CLI's bundle is the update source: upgrade the CLI first to obtain
newer skills. Installation uses copies, never symlinks. Existing skill-directory
links and special files are refused; move them aside before proceeding.

## Shared roots and file operations

Some harnesses share `.agents/skills`. Selecting one of them does not provide
harness-only isolation. The preview warns that other compatible harnesses may
also see the files. Resolved roots, including links/junctions, are deduplicated.
Explicitly selected harnesses get their required directories created or a
visible failure.

Replacing or removing a directory in a shared root affects every harness that
reads it. There is no ownership tracking between harnesses or CLIs. Use distinct
skill names to avoid overwriting another CLI's files.

Skill management writes only the installed skill files. It does not create
receipts, manifests, locks, journals, staging directories, or backups. There are
no save, restore, or recovery commands. Installation never runs a bundled script
or changes harness tool permissions.

`skills status` compares installed files with the running CLI's bundle. It reports
`current`, `different`, `missing`, or `unsafe`, with a path and corrective hint.
It cannot distinguish local edits from an older version. It never repairs files
implicitly.

Plans are manager-local and cannot be edited or replayed after application.
Replacement is not atomic: a failed or interrupted write can leave a partial
directory. Run add again to replace it with the complete bundle. Successful
destinations can remain installed when another destination fails; inspect the
per-destination results. Do not run simultaneous installations at the same root.

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
