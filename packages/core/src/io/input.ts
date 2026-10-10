import { CLIError, checkSignal } from '../execution/errors.ts'
import { terminalText, type IO, type ReadSettings } from './io.ts'

export interface InputChoice<T> {
  label: string
  value: T
  description?: string
  disabled?: string
}
export interface SelectSettings<T> {
  message: string
  choices: readonly InputChoice<T>[]
}
export interface MultiselectSettings<T> extends SelectSettings<T> { min?: number }
export interface ConfirmSettings { message: string; default?: boolean }
export interface Input {
  read(settings?: ReadSettings): Promise<string>
  select<const T>(settings: SelectSettings<T>): Promise<T>
  multiselect<const T>(settings: MultiselectSettings<T>): Promise<T[]>
  confirm(settings: ConfirmSettings): Promise<boolean>
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
        if (!choice || choice.disabled !== undefined) throw new CLIError('INVALID_SELECTION', 'Invalid selection')
        return choice.value
      }
      io.stderr.write(terminalText(settings.message) + '\n')
      printChoices(settings)
      const answer = await readUnlocked({ prompt: 'Selection: ', source: 'terminal', maxBytes: 64 })
      const index = /^\d+$/.test(answer.trim()) ? Number(answer.trim()) - 1 : -1
      const choice = settings.choices[index]
      if (!choice || choice.disabled !== undefined) throw new CLIError('INVALID_SELECTION', 'Invalid selection')
      return choice.value
    })
  }
  function printChoices<T>(settings: SelectSettings<T>) {
    settings.choices.forEach((choice, index) => io.stderr.write(`${index + 1}. ${terminalText(choice.label)}${choice.description ? ` — ${terminalText(choice.description)}` : ''}${choice.disabled !== undefined ? ` (disabled: ${terminalText(choice.disabled)})` : ''}\n`))
  }
  async function confirm(settings: ConfirmSettings): Promise<boolean> {
    return exclusive(async () => {
      if (!io.interactive) throw new CLIError('INTERACTION_REQUIRED', 'An interactive terminal is required')
      if (answers !== undefined) {
        const answer = nextAnswer()
        // oxlint-disable-next-line deslop/no-runtime-typeof -- Scripted answers are a public input boundary.
        if (typeof answer !== 'boolean') throw new CLIError('INVALID_INPUT', 'Expected a boolean answer')
        return answer
      }
      const answer = (await readUnlocked({ source: 'terminal', prompt: `${settings.message} ${settings.default ? '[Y/n]' : '[y/N]'} `, maxBytes: 32 })).trim().toLowerCase()
      if (!answer) return settings.default ?? false
      if (answer === 'y' || answer === 'yes') return true
      if (answer === 'n' || answer === 'no') return false
      throw new CLIError('INVALID_INPUT', 'Answer yes or no')
    })
  }
  async function multiselect<const T>(settings: MultiselectSettings<T>): Promise<T[]> {
    return exclusive(async () => {
      if (!io.interactive) throw new CLIError('INTERACTION_REQUIRED', 'An interactive terminal is required')
      const min = settings.min ?? 0
      if (!Number.isSafeInteger(min) || min < 0) throw new CLIError('INVALID_SELECTION', 'Minimum selection must be a nonnegative integer')
      if (!settings.choices.some(choice => choice.disabled === undefined)) throw new CLIError('NO_CHOICES', 'No choices are available')
      let selected: unknown
      if (answers !== undefined) selected = nextAnswer()
      else {
        io.stderr.write(terminalText(settings.message) + '\n')
        printChoices(settings)
        const text = (await readUnlocked({ source: 'terminal', prompt: 'Selections (comma-separated numbers, or all): ', maxBytes: 4096 })).trim()
        selected = text.toLowerCase() === 'all' ? settings.choices.filter(choice => choice.disabled === undefined).map(choice => choice.value)
          : text ? text.split(',').map(part => /^\d+$/.test(part.trim()) ? settings.choices[Number(part.trim()) - 1]?.value : undefined) : []
      }
      if (!Array.isArray(selected) || selected.length < min) throw new CLIError('INVALID_SELECTION', `Select at least ${min} choices`)
      const result: T[] = []
      for (const item of selected) {
        const choice = settings.choices.find(choice => Object.is(choice.value, item) && choice.disabled === undefined)
        if (!choice || result.some(value => Object.is(value, item))) throw new CLIError('INVALID_SELECTION', 'Invalid or duplicate selection')
        result.push(choice.value)
      }
      return result
    })
  }
  return { read, select, confirm, multiselect }
}
