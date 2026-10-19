import { test, expect } from 'bun:test'
import { argument, choice, createCLI, createFileCommand, option } from '../index.ts'

test('choice parsing and validation keep the original allowed values after caller mutation', () => {
  const choices: [string, ...string[]] = ['red', 'blue']
  const parser = choice(choices)
  choices.splice(0, choices.length, 'orange', 'purple')

  expect(parser.label).toBe('red|blue')
  for (const text of ['red', 'blue']) {
    expect(parser.parse(text)).toBe(text)
    expect(parser.validate(text)).toBe(text)
  }
  for (const text of ['orange', 'purple']) {
    expect(() => parser.parse(text)).toThrow('expected one of: red, blue')
    expect(() => parser.validate(text)).toThrow('expected one of: red, blue')
  }
})

for (const kind of ['option', 'argument'] as const) {
  test(`choice ${kind} help and validation stay consistent after caller mutation`, async () => {
    const choices: [string, ...string[]] = ['red', 'blue']
    let calls = 0
    const parser = choice(choices)
    const command = kind === 'option'
      ? createFileCommand('/')({ options: { shade: option(parser) }, run: ({ options }) => { calls++; return options.shade } })
      : createFileCommand('/')({ args: [argument('shade', parser)], run: ({ args }) => { calls++; return args.shade } })
    const cli = createCLI({ '/': command }, { name: 'app' })
    const help = cli.help('/')
    choices.push('orange')
    choices.splice(0, 2, 'purple')

    expect(cli.help('/')).toBe(help)
    expect(help).toContain('red|blue')
    for (const text of ['orange', 'purple']) {
      const result = await cli.test({ argv: kind === 'option' ? ['--shade', text] : [text] })
      expect(result.exitCode).toBe(2)
      expect(result.value).toBeUndefined()
      expect(result.stderr).toContain('expected one of: red, blue')
    }
    expect(calls).toBe(0)
    for (const text of ['red', 'blue']) {
      const result = await cli.test({ argv: kind === 'option' ? ['--shade', text] : [text] })
      expect(result.exitCode).toBe(0)
      expect(result.value).toBe(text)
    }
    expect(choices).toEqual(['purple', 'orange'])
  })
}
