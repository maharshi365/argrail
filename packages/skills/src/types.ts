import type { Argument, Command, Group, NamedArgument } from '@argrail/core'

export interface SkillFile {
  readonly path: string
  readonly data: string
  readonly executable: boolean
}
export interface BundledSkill {
  readonly name: string
  readonly description: string
  readonly hash: string
  readonly fileCount?: number
  readonly bytes?: number
  readonly load: () => Promise<readonly SkillFile[]>
}
export interface SkillBundle {
  readonly id: string
  readonly hash: string
  readonly skills: Readonly<Record<string, BundledSkill>>
  readonly groups: Readonly<
    Record<string, { readonly description: string; readonly skills: readonly string[] }>
  >
}
export type SkillTarget =
  | {
      readonly path: string
      readonly scope?: never
      readonly project?: never
      readonly harnesses?: never
    }
  | {
      readonly scope?: 'project'
      readonly project?: string
      readonly harnesses: readonly string[]
      readonly path?: never
    }
  | {
      readonly scope: 'global'
      readonly harnesses: readonly string[]
      readonly project?: never
      readonly path?: never
    }
export interface SkillSelection<B extends SkillBundle> {
  readonly skills?: readonly (keyof B['skills'] & string)[]
  readonly groups?: readonly (keyof B['groups'] & string)[]
  readonly all?: boolean
}
export type SkillPlanItem = {
  readonly name: string
  readonly root: string
  readonly path: string
  readonly harnesses: readonly string[]
  readonly operation: 'install' | 'noop' | 'remove' | 'conflict'
  readonly reason: string
  readonly exists: boolean
  readonly fileCount: number
  readonly bytes: number
}
export type SkillPlan = {
  readonly action: 'add' | 'update' | 'remove'
  readonly bundleId: string
  readonly bundleHash: string
  readonly target: SkillTarget
  readonly roots: readonly {
    readonly root: string
    readonly harnesses: readonly string[]
    readonly shared: readonly string[]
  }[]
  readonly items: readonly SkillPlanItem[]
}
export type SkillResult = {
  readonly bundleId: string
  readonly bundleHash: string
  readonly exitCode: number
  readonly items: readonly {
    readonly name: string
    readonly path: string
    readonly harnesses: readonly string[]
    readonly status:
      | 'installed'
      | 'removed'
      | 'unchanged'
      | 'blocked'
      | 'missing'
      | 'failed'
    readonly reason?: string
  }[]
}
export interface HarnessSettings {
  home?: string
  environment?: Record<string, string | undefined>
  scope?: 'project' | 'global'
}
export type SkillStatus = {
  bundleId: string
  bundleHash: string
  items: {
    name: string
    path: string
    harnesses: string[]
    status: 'missing' | 'different' | 'unsafe' | 'current'
    hint: string
  }[]
}
export interface SkillManager<B extends SkillBundle> {
  select(selection?: SkillSelection<B>): (keyof B['skills'] & string)[]
  plan(
    request: SkillSelection<B> & {
      action: SkillPlan['action']
      target: SkillTarget
    },
  ): Promise<SkillPlan>
  apply(plan: SkillPlan, settings?: { signal?: AbortSignal }): Promise<SkillResult>
  status(target: SkillTarget): Promise<SkillStatus>
}
type BooleanOption = Argument<boolean, false, 'flag'>
type TextOption = Argument<string | undefined, false, 'option', string | undefined>
type TextListOption = Argument<string[], false, 'option', readonly string[]>
type TargetOptions = {
  harness: TextListOption
  global: BooleanOption
  project: TextOption
  path: TextOption
  json: BooleanOption
}
type ActionOptions<B extends SkillBundle> = TargetOptions & {
  all: BooleanOption
  group: Argument<
    (keyof B['groups'] & string)[],
    false,
    'option',
    readonly (keyof B['groups'] & string)[]
  >
  yes: BooleanOption
  dryRun: BooleanOption
}
type Mutation = SkillPlan['action'] | 'delete'
type Action = Mutation | 'list' | 'status'
type ManagementOptions<A extends Action, B extends SkillBundle> = A extends Mutation
  ? ActionOptions<B>
  : A extends 'list'
    ? { json: BooleanOption }
    : TargetOptions
type ManagementArgs<A extends Action, B extends SkillBundle> = A extends Mutation
  ? readonly [
      NamedArgument<
        'names',
        (keyof B['skills'] & string)[],
        false,
        readonly (keyof B['skills'] & string)[]
      >,
    ]
  : []
type CommandFailure = { exitCode: number; error: { code: string; message: string } }
type Cancelled = { cancelled: true }
type SkillList<B extends SkillBundle> = {
  id: string
  hash: string
  skills: { name: keyof B['skills'] & string; description: string }[]
  groups: B['groups']
}
type ManagementResult<A extends Action, B extends SkillBundle> = A extends 'list'
  ? SkillList<B>
  : A extends 'status'
    ? SkillStatus | CommandFailure
    : SkillResult | SkillPlan | Cancelled | CommandFailure
type ManagementCommand<Mount extends string, A extends Action, B extends SkillBundle> = Command<
  `/${Mount}/${A}`,
  {},
  ManagementOptions<A, B>,
  A extends 'list' ? ManagementResult<A, B> : Promise<ManagementResult<A, B>>,
  ManagementArgs<A, B>
>
export type ManagementCommands<Mount extends string, B extends SkillBundle> = {
  [A in Action as `/${Mount}/${A}`]: ManagementCommand<Mount, A, B>
}
export type GroupedManagementCommands<Mount extends string, B extends SkillBundle, G extends readonly Group[]> = {
  [A in Action as `/${Mount}/${A}`]: ManagementCommand<Mount, A, B> & { readonly groups: G }
}
export interface Harness {
  id: string
  label: string
  projectPath: string
  globalPath: string | undefined
  detected: boolean
  disabled?: string
}
export interface HarnessRoot { root: string; harnesses: string[]; shared: string[] }
