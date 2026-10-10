export class CLIError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CLIError'
  }
}

export class CancelledError extends CLIError {
  constructor() { super('CANCELLED', 'Cancelled'); this.name = 'CancelledError' }
}

export interface Failure {
  readonly category: 'usage' | 'application' | 'cancelled'
  readonly code: string
  readonly message: string
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError()
}
