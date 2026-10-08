import type { IO } from './io.ts'
import type { Input } from './input.ts'

export interface CommandContext<Services = {}> {
  readonly signal: AbortSignal
  readonly io: IO
  readonly input: Input
  readonly services: Services
  exitCode: number
}
