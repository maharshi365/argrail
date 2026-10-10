import { CLIError, checkSignal } from '../execution/errors.ts'
import { terminalText, type IO, type ReadSettings } from './io.ts'

export interface SelectSettings<T> {
  message: string
  choices: readonly { label: string; value: T }[]
}
export interface Input {
  read(settings?: ReadSettings): Promise<string>
  select<const T>(settings: SelectSettings<T>): Promise<T>
}

export function createInput(io: IO, signal: AbortSignal, answers?: readonly unknown[]): Input {
  let answerIndex = 0
  let active = false
  // Scripted answers are untrusted until read or select validates them.
  // oxlint-disable-next-line deslop/no-unknown-returns
  function nextAnswer(): unknown {
    if (!answers || answerIndex >= answers.length) throw new CLIError('INPUT_EXHAUSTED', 'No scripted answer is available')
    return answers[answerIndex++]
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (active) throw new CLIError('INPUT_BUSY', 'Input is already in use')
    checkSignal(signal)
    active = true
    try { return await operation() }
    finally { active = false }
  }
  async function readUnlocked(settings: ReadSettings): Promise<string> {
    const maxBytes = settings.maxBytes ?? 1024 * 1024
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new CLIError('INVALID_INPUT_LIMIT', 'Input limit must be a positive integer')
    const terminal = settings.source === 'terminal' || (settings.source !== 'stdin' && io.stdin.isTTY)
    if (terminal && !io.interactive) throw new CLIError('INTERACTION_REQUIRED', 'An interactive terminal is required')
    if (terminal && settings.prompt) io.stderr.write(terminalText(settings.prompt))
    const input = terminal && answers !== undefined ? nextAnswer() : await io.stdin.read({ ...settings, maxBytes, terminal }, signal)
    checkSignal(signal)
    // oxlint-disable-next-line deslop/no-runtime-typeof -- Validate the scripted-answer boundary.
    if (typeof input !== 'string') throw new CLIError('INVALID_INPUT', 'Expected a text answer')
    if (new TextEncoder().encode(input).byteLength > maxBytes) throw new CLIError('INPUT_LIMIT', 'Input exceeds the byte limit')
    return settings.stripFinalNewline ? input.replace(/\r?\n$/, '') : input
  }
  async function read(settings: ReadSettings = {}): Promise<string> { return exclusive(() => readUnlocked(settings)) }
  async function select<const T>(settings: SelectSettings<T>): Promise<T> {
    return exclusive(async () => {
      if (!io.interactive) throw new CLIError('INTERACTION_REQUIRED', 'An interactive terminal is required')
      if (!settings.choices.length) throw new CLIError('NO_CHOICES', 'No choices are available')
      if (answers !== undefined) {
        const answer = nextAnswer()
        const choice = settings.choices.find(choice => Object.is(choice.value, answer))
        if (!choice) throw new CLIError('INVALID_SELECTION', 'Invalid selection')
        return choice.value
      }
      io.stderr.write(terminalText(settings.message) + '\n')
      settings.choices.forEach((choice, index) => io.stderr.write(`${index + 1}. ${terminalText(choice.label)}\n`))
      const answer = await readUnlocked({ prompt: 'Selection: ', source: 'terminal', maxBytes: 64 })
      const index = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1
      const choice = settings.choices[index]
      if (!choice) throw new CLIError('INVALID_SELECTION', 'Invalid selection')
      return choice.value
    })
  }
  return { read, select }
}
