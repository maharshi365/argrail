import { expect, test } from 'bun:test'
import { argument, bindCommand, choice, createCLI, defineCommand, flag, option, string, variadicArgument } from '../index.ts'

function normalize(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function expectWidth(text: string, width: number) {
  expect(text.split('\n').filter(line => line.length > width)).toEqual([])
}

test('narrow help wraps usage without losing command or argument terms', () => {
  const command = bindCommand('/apps/create', defineCommand({
    args: [argument('appName', string()), variadicArgument('files', string())],
    run() {},
  }))
  const text = createCLI({ '/apps/create': command }, { name: 'app', width: 40 }).help('/apps/create')
  const usage = text.split('\n\n')[0]!
  expect(normalize(usage)).toBe('Usage: app apps create <appName> [files...] [options]')
  expectWidth(usage, 40)
})

test('narrow help wraps choice labels at spaces and preserves every choice', () => {
  const command = bindCommand('/run', defineCommand({
    options: { stage: option(choice(['production', 'staging', 'development']), { required: true, description: 'Deployment stage.' }) },
    run() {},
  }))
  const text = createCLI({ '/run': command }, { name: 'app', width: 40 }).help('/run')
  const normalized = normalize(text)
  expect(normalized).toContain('--stage <production|staging|development>')
  expect(normalized).toContain('Deployment stage. Required.')
  expectWidth(text, 40)
})

test('narrow help wraps long option labels without truncating the option name', () => {
  const command = bindCommand('/run', defineCommand({
    options: { deploymentConfigurationDirectory: option(string(), { short: 'd', description: 'Configuration directory.' }) },
    run() {},
  }))
  const text = createCLI({ '/run': command }, { name: 'app', width: 40 }).help('/run')
  expect(normalize(text)).toContain('-d, --deployment-configuration-directory <text>')
  expect(text).toContain('Configuration directory.')
  expectWidth(text, 40)
})

test('indivisible option and choice tokens can exceed width but are never split or truncated', () => {
  const name = '--unusually-long-configuration-option-name'
  const value = 'a'.repeat(50)
  const command = bindCommand('/run', defineCommand({
    options: {
      unusuallyLongConfigurationOptionName: option(string(), { description: 'Configuration location.' }),
      mode: option(choice([value, 'short']), { description: 'Execution mode.' }),
    },
    run() {},
  }))
  const text = createCLI({ '/run': command }, { name: 'app', width: 40 }).help('/run')
  const choiceToken = `<${value}|short>`
  const normalized = normalize(text)
  expect(normalized).toContain(`${name} <text>`)
  expect(normalized).toContain(`--mode ${choiceToken}`)
  expect(text).toContain('Configuration location.')
  expect(text).toContain('Execution mode.')
  // Only a single indivisible token (plus indentation) may overflow.
  expect(text.split('\n').filter(line => line.length > 40).map(line => line.trim())).toEqual([name, choiceToken])
})

for (const width of [40, 60, 80, 120]) {
  test(`help preserves prose and metadata within width ${width}`, () => {
    const description = 'A useful description with enough words to wrap across a narrow terminal without losing any words or punctuation.'
    const command = bindCommand('/run', defineCommand({
      description,
      options: {
        config: option(string(), { description, default: 'local' }),
        verbose: flag({ description }),
      },
      sections: [{ title: 'Examples', body: 'app run --config local --verbose' }],
      run() {},
    }))
    const text = createCLI({ '/run': command }, { name: 'app', width }).help('/run')
    const normalized = normalize(text)
    expect(normalized).toContain(description)
    expect(normalized).toContain('Default: "local".')
    expect(normalized).toContain('Negate with --no-verbose.')
    expect(normalized).toContain('Examples: app run --config local --verbose')
    expectWidth(text, width)
    expect(text).not.toContain('\u001b[')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').every(line => line === line.trimEnd())).toBe(true)
  })
}

test('root help wraps its command-help footer at the requested width', () => {
  const command = bindCommand('/run', defineCommand({ run() {} }))
  const text = createCLI({ '/run': command }, { name: 'app', width: 40 }).help()
  expect(normalize(text)).toContain('Run "app help <command>" for command help.')
  expectWidth(text, 40)
})

test('empty registry help lists only available actions', () => {
  const text = createCLI({}, { name: 'app' }).help()
  expect(normalize(text.split('\n\n')[0]!)).toBe('Usage: app [options]')
  expect(text).toContain('-h, --help')
  expect(text).toContain('Show help.')
  expect(text).not.toContain('Commands:')
  expect(text).not.toContain('Arguments:')
  expect(text).not.toContain('--version')
  expect(text).not.toContain('help <command>')
})

for (const argv of [[], ['--help'], ['-h'], ['help']]) {
  test(`empty registry displays help for ${JSON.stringify(argv)}`, async () => {
    const cli = createCLI({}, { name: 'app' })
    const result = await cli.test({ argv })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(cli.help())
    expect(result.stderr).toBe('')
    expect(result.value).toBeUndefined()
  })
}
