export type PathRule =
  | { kind: 'literal'; value: string }
  | { kind: 'home' }
  | { kind: 'environment'; name: string; fallback?: PathRule | null }
  | { kind: 'join'; parts: (PathRule | null)[] }
  | { kind: 'firstExisting'; paths: { exists: PathRule | null; path: PathRule | null }[]; fallback: PathRule | null }

export interface HarnessRegistry {
  version: number
  source: { repository: string; commit: string; file: string; sha256: string }
  harnesses: { id: string; label: string; project: PathRule; global: PathRule | null }[]
}
