import type { IO } from '../io/io.ts'
import type { Input } from '../io/input.ts'

export interface CommandContext<Services = {}> {
  readonly signal: AbortSignal
  readonly io: IO
  readonly input: Input
  readonly services: Services
  exitCode: number
}
