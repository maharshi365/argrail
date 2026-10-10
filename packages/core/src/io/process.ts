import { CLIError, CancelledError, checkSignal } from '../execution/errors.ts'
import type { InputSource, ReadSettings, Writer } from './io.ts'

export interface TerminalStream {
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  readonly readableEnded?: boolean
  setRawMode?(raw: boolean): void
  on(event: string, listener: (...args: any[]) => void): void
  off(event: string, listener: (...args: any[]) => void): void
  resume(): void
  pause(): void
}

export function streamInput(stream: TerminalStream, output: Writer): InputSource {
  let reading = false
  let ended = false
  return {
    isTTY: stream.isTTY ?? false,
    async read(settings: ReadSettings & { terminal: boolean }, signal: AbortSignal): Promise<string> {
      checkSignal(signal)
      if (ended || stream.readableEnded) throw new CLIError('INPUT_EXHAUSTED', 'Input has already ended')
      if (reading) throw new CLIError('INPUT_BUSY', 'Input is already in use')
      if (settings.terminal && settings.hidden && !stream.setRawMode) throw new CLIError('INTERACTION_REQUIRED', 'Hidden input requires an interactive terminal')
      reading = true
      const wasRaw = stream.isRaw ?? false
      const raw = settings.terminal && !!stream.setRawMode
      try {
        if (raw) stream.setRawMode!(true)
        return await new Promise<string>((resolve, reject) => {
          const decoder = new TextDecoder('utf-8', { fatal: true })
          let text = '', bytes = 0, settled = false
          const maxBytes = settings.maxBytes ?? 1024 * 1024
          function cleanup() {
            stream.off('data', onData)
            stream.off('end', onEnd)
            stream.off('error', onError)
            signal.removeEventListener('abort', onAbort)
          }
          function finish(error?: CLIError) {
            if (settled) return
            settled = true
            cleanup()
            if (error) reject(error)
            else resolve(text)
          }
          function append(chunk: string) {
            if (!settings.terminal) { text += chunk; return }
            for (const char of chunk) {
              if (char === '\r' || char === '\n') { output.write('\n'); finish(); return }
              if (char === '\u0003' || char === '\u0004') { finish(new CancelledError()); return }
              if (char === '\u007f' || char === '\b') {
                if (text) {
                  text = Array.from(text).slice(0, -1).join('')
                  if (raw && !settings.hidden) output.write('\b \b')
                }
              } else if (char >= ' ' && !/[\u007f-\u009f]/.test(char)) {
                text += char
                if (raw && !settings.hidden) output.write(char)
              }
              if (new TextEncoder().encode(text).byteLength > maxBytes) { finish(new CLIError('INPUT_LIMIT', 'Input exceeds the byte limit')); return }
            }
          }
          // Stream events are an I/O boundary; reject values outside the supported chunk types.
          /* oxlint-disable deslop/no-unknown-parameters, deslop/no-runtime-typeof */
          function onData(chunk: unknown) {
            if (settled) return
            try {
              if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new Error()
              if (!settings.terminal) {
                bytes += typeof chunk === 'string' ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength
                if (bytes > maxBytes) { finish(new CLIError('INPUT_LIMIT', 'Input exceeds the byte limit')); return }
              }
              append(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
            } catch { finish(new CLIError('INVALID_INPUT', 'Unable to read text input')) }
          }
          /* oxlint-enable deslop/no-unknown-parameters, deslop/no-runtime-typeof */
          function onEnd() {
            ended = true
            if (settings.terminal) { finish(new CancelledError()); return }
            try { append(decoder.decode()); finish() }
            catch { finish(new CLIError('INVALID_INPUT', 'Unable to read text input')) }
          }
          function onError() { finish(new CLIError('INVALID_INPUT', 'Unable to read text input')) }
          function onAbort() { finish(new CancelledError()) }
          stream.on('data', onData)
          stream.on('end', onEnd)
          stream.on('error', onError)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          else stream.resume()
        })
      } finally {
        reading = false
        try { if (raw) stream.setRawMode!(wasRaw) }
        finally { stream.pause() }
      }
    },
  }
}

interface Process {
  argv: string[]
  stdin: TerminalStream
  stdout: Writer & { isTTY?: boolean }
  stderr: Writer & { isTTY?: boolean }
  exitCode: number
  on(event: string, listener: () => void): void
  off(event: string, listener: () => void): void
}

export function processRuntime() {
  const process = (globalThis as { process?: Process }).process
  if (!process) throw new CLIError('NO_PROCESS', 'A Bun or Node process is required')
  return {
    process,
    io: {
      stdin: streamInput(process.stdin, process.stderr),
      stdout: process.stdout, stderr: process.stderr,
      interactive: !!process.stdin.isTTY && !!process.stderr.isTTY,
    },
  }
}
