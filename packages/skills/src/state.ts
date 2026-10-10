import type { SkillFile, SkillPlan } from './types.ts'

export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] }
export type MutablePlan = Omit<Mutable<SkillPlan>, 'target'> & { target: SkillPlan['target'] }
export interface ReceiptEntry {
  hash: string
  files: { path: string; hash: string; executable: boolean }[]
  owners: { id: string; bundleHash?: string; harnesses: readonly string[] }[]
}
export interface Receipt { version: number; skills: Record<string, ReceiptEntry> }
export interface Change { name: string; exists: boolean; backup: boolean; files?: readonly SkillFile[] }
export interface Journal {
  version: number
  id: string
  before: Receipt
  committed?: boolean
  entries: { name: string; hadOld: boolean; install: boolean; backup: boolean; hash: string | null; files: { path: string; executable: boolean }[] }[]
}
export interface SavedTarget { path: string; skills: string[]; harnesses: string[] }
export interface Manifest { version: number; bundles: Record<string, { hash: string; targets: SavedTarget[] }> }
