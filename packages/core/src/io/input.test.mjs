import { test, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createInput } from './input.ts'
import { createIO } from './io.ts'
import { streamInput, CancelledError } from '../index.ts'

function fixture(terminal = true) {
  const stream = new PassThrough()
  const messages = []
  Object.assign(stream, {
    isTTY: terminal, isRaw: false,
    setRawMode(raw) { this.isRaw = raw },
  })
  const output = { write(text) { messages.push(text) } }
  const controller = new AbortController()
  const io = createIO({ stdin: streamInput(stream, output), stderr: output, stdout: { write() {} }, interactive: terminal })
  return { stream, messages, controller, input: createInput(io, controller.signal) }
}

test('confirmation distinguishes refusal, default acceptance, and invalid scripted answers', async () => {
  const { input, stream } = fixture()
  const pending = input.confirm({ message: 'Proceed?' })
  stream.emit('data', new TextEncoder().encode('\r'))
  expect(await pending).toBe(false)
  const io = createIO({ stdin: { isTTY: true, async read() { return '' } }, stderr: { write() {} }, stdout: { write() {} }, interactive: true })
  expect(await createInput(io, new AbortController().signal, [true]).confirm({ message: 'Proceed?' })).toBe(true)
  await expect(createInput(io, new AbortController().signal, ['yes']).confirm({ message: 'Proceed?' })).rejects.toThrow('boolean')
  await expect(fixture(false).input.confirm({ message: 'Proceed?' })).rejects.toThrow('interactive terminal')
})

test('multiselect supports all, descriptions, disabled reasons, and validates scripted selections', async () => {
  const choices = [{ label: 'One', value: 'one', description: 'First skill' }, { label: 'Two', value: 'two' }, { label: 'Three', value: 'three', disabled: 'Global not supported' }]
  const { input, stream, messages } = fixture()
  const pending = input.multiselect({ message: 'Skills', choices, min: 1 })
  stream.emit('data', new TextEncoder().encode('all\r'))
  expect(await pending).toEqual(['one', 'two'])
  expect(messages.join('')).toContain('First skill')
  expect(messages.join('')).toContain('Global not supported')
  const io = createIO({ stdin: { isTTY: true, async read() { return '' } }, stderr: { write() {} }, stdout: { write() {} }, interactive: true })
  for (const answer of [['three'], ['one', 'one'], [], ['unknown']]) {
    await expect(createInput(io, new AbortController().signal, [answer]).multiselect({ message: 'Skills', choices, min: 1 })).rejects.toThrow()
  }
  expect(await createInput(io, new AbortController().signal, [['two', 'one']]).multiselect({ message: 'Skills', choices })).toEqual(['two', 'one'])
})

test.each(['success', 'cancel', 'end', 'error', 'limit', 'signal'])(
  'hidden input restores terminal state and removes listeners after %s', async mode => {
    const { stream, messages, controller, input } = fixture()
    const pending = input.read({ hidden: true, prompt: 'Credential: ', maxBytes: 32 })
    expect(stream.isRaw).toBe(true)
    if (mode === 'success') stream.emit('data', new TextEncoder().encode('private-valuX\b e\b\r'))
    if (mode === 'cancel') stream.emit('data', new TextEncoder().encode('\u0003'))
    if (mode === 'end') stream.emit('end')
    if (mode === 'error') stream.emit('error', new Error('private-value'))
    if (mode === 'limit') stream.emit('data', new TextEncoder().encode('x'.repeat(33)))
    if (mode === 'signal') controller.abort()
    if (mode === 'success') expect(await pending).toBe('private-valu ')
    else await expect(pending).rejects.toThrow()
    expect(stream.isRaw).toBe(false)
    expect(stream.isPaused()).toBe(true)
    expect(stream.listenerCount('data')).toBe(0)
    expect(stream.listenerCount('end')).toBe(0)
    expect(stream.listenerCount('error')).toBe(0)
    expect(messages.join('')).not.toContain('private-valu')
  },
)

test('reads piped UTF-8 across chunk boundaries and rejects repeat reads after EOF', async () => {
  const { stream, messages, input } = fixture(false)
  const pending = input.read({ hidden: true, prompt: 'Hidden: ', stripFinalNewline: true })
  const bytes = new TextEncoder().encode('credential-é\r\n')
  stream.write(bytes.subarray(0, 12))
  stream.end(bytes.subarray(12))
  expect(await pending).toBe('credential-é')
  expect(messages).toEqual([])
  await expect(input.read()).rejects.toThrow('already ended')
})

test('enforces byte limits on piped UTF-8 and rejects invalid encodings', async () => {
  const first = fixture(false)
  const tooLong = first.input.read({ maxBytes: 3 })
  first.stream.write(new TextEncoder().encode('éé'))
  await expect(tooLong).rejects.toThrow('byte limit')
  const second = fixture(false)
  const invalid = second.input.read()
  second.stream.end(new Uint8Array([0xff]))
  await expect(invalid).rejects.toThrow('Unable to read text input')
})

test('rejects unsupported stream chunks and removes input listeners', async () => {
  const { stream, input } = fixture(false)
  const pending = input.read()
  stream.emit('data', { text: 'private-value' })
  await expect(pending).rejects.toThrow('Unable to read text input')
  expect(stream.listenerCount('data')).toBe(0)
  expect(stream.listenerCount('end')).toBe(0)
  expect(stream.listenerCount('error')).toBe(0)
})

test('sanitizes choice labels and supports simple numbered selection', async () => {
  const { stream, messages, input } = fixture()
  const selected = input.select({ message: 'Choose', choices: [{ label: 'One\u001b\u0007', value: 'first' }, { label: 'Two', value: 'second' }] })
  stream.emit('data', new TextEncoder().encode('2\r'))
  expect(await selected).toBe('second')
  expect(messages.join('')).toContain('1. One\n')
  expect(messages.join('')).not.toContain('\u001b')
  expect(messages.join('')).not.toContain('\u0007')
})

test('rejects concurrent interactions before printing another prompt', async () => {
  const { stream, messages, input } = fixture()
  const first = input.read({ hidden: true, prompt: 'First: ' })
  await expect(input.select({ message: 'Second', choices: [{ label: 'One', value: 1 }] })).rejects.toThrow('already in use')
  expect(messages.join('')).toBe('First: ')
  stream.emit('data', new TextEncoder().encode('done\r'))
  expect(await first).toBe('done')
})

test('restores a preexisting raw terminal mode on cancellation', async () => {
  const { stream, input } = fixture()
  stream.isRaw = true
  const pending = input.read({ hidden: true })
  stream.emit('data', new TextEncoder().encode('\u0004'))
  await expect(pending).rejects.toBeInstanceOf(CancelledError)
  expect(stream.isRaw).toBe(true)
})
