import { CLIError, checkSignal } from '../execution/errors.ts'

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined }
export interface Writer { write(text: string): void }
export interface ReadSettings {
  prompt?: string
  source?: 'auto' | 'terminal' | 'stdin'
  hidden?: boolean
  maxBytes?: number
  stripFinalNewline?: boolean
}
export interface InputSource {
  readonly isTTY: boolean
  read(settings: ReadSettings & { terminal: boolean }, signal: AbortSignal): Promise<string>
}
export interface IO {
  readonly stdin: InputSource
  readonly stdout: Writer
  readonly stderr: Writer
  readonly interactive: boolean
  json(value: JsonValue): void
}
export type IOPorts = Pick<IO, 'stdin' | 'stdout' | 'stderr' | 'interactive'>

export function createIO(ports: IOPorts): IO {
  return {
    ...ports,
    json(value) {
      let text: string | undefined
      try {
        // SAFETY: JSON.stringify can return undefined for untyped callers or a toJSON method; the check below rejects it.
        text = JSON.stringify(value) as string | undefined
      }
      catch { throw new CLIError('OUTPUT_ERROR', 'Output is not JSON serializable') }
      if (text === undefined) throw new CLIError('OUTPUT_ERROR', 'Output is not JSON serializable')
      ports.stdout.write(text + '\n')
    },
  }
}

export function memoryPorts(stdin = '', interactive = false): IOPorts {
  let consumed = false
  return {
    interactive, stdout: { write() {} }, stderr: { write() {} },
    stdin: {
      isTTY: interactive,
      async read(_settings, signal) {
        checkSignal(signal)
        if (consumed) throw new CLIError('INPUT_EXHAUSTED', 'Input has already been read')
        consumed = true
        return stdin
      },
    },
  }
}

export function terminalText(text: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal control characters from untrusted labels.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}
