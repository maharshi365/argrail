#!/usr/bin/env bun
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { PathRule, HarnessRegistry } from '../packages/skills/src/harnesses/types.ts'

const repository = 'vercel-labs/skills'
const destination = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../packages/skills/src/harnesses',
)

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`)
  return response.text()
}
export function extractHarnesses(source: string): HarnessRegistry['harnesses'] {
  const file = ts.createSourceFile(
    'agents.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  // SAFETY: TypeScript's parser attaches parseDiagnostics to every SourceFile, but omits it from the public interface.
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
    throw new Error(
      'Upstream registry contains invalid TypeScript; existing registry was not changed',
    )
  const aliases = new Map<string, PathRule | null>([
    ['home', { kind: 'home' }],
    [
      'xdgConfig',
      {
        kind: 'environment',
        name: 'XDG_CONFIG_HOME',
        fallback: {
          kind: 'join',
          parts: [{ kind: 'home' }, { kind: 'literal', value: '.config' }],
        },
      },
    ],
  ])
  const declarations = new Map<string, ts.Expression | undefined>()
  const resolving = new Set<string>()
  for (const statement of file.statements)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          declarations.set(declaration.name.text, declaration.initializer)
    }
  function unsupported(node: ts.Node): never {
    const location = file.getLineAndCharacterOfPosition(node.getStart(file))
    throw new Error(
      `Unsupported path expression at agents.ts:${location.line + 1}:${location.character + 1}: ${node.getText(file)}. Add a reviewed adapter; existing registry was not changed.`,
    )
  }
  function expression(node: ts.Node | undefined): PathRule | null {
    if (!node) throw new Error('Upstream registry contains a missing path expression')
    if (ts.isParenthesizedExpression(node)) return expression(node.expression)
    if (ts.isStringLiteral(node)) return { kind: 'literal', value: node.text }
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return null
      if (aliases.has(node.text)) return aliases.get(node.text)!
      const declaration = declarations.get(node.text)
      if (!declaration) return unsupported(node)
      if (resolving.has(node.text)) return unsupported(node)
      resolving.add(node.text)
      const rule = expression(declaration)
      resolving.delete(node.text)
      aliases.set(node.text, rule)
      return rule
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    ) {
      const first = expression(node.left)
      if (first?.kind !== 'environment') return unsupported(node)
      return { ...first, fallback: expression(node.right) }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'join')
        return { kind: 'join', parts: node.arguments.map(expression) }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'trim' &&
        !node.arguments.length
      )
        return expression(node.expression.expression)
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'getOpenClawGlobalSkillsDir' &&
        !node.arguments.length
      ) {
        // Reviewed adapter: inspect the current/legacy roots in this exact priority.
        const helper = file.statements.find(
          (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === 'getOpenClawGlobalSkillsDir',
        )
        const paths = []
        let valid = true
        if (
          !helper?.body ||
          helper.parameters.length !== 2 ||
          helper.parameters[0]!.name.getText(file) !== 'homeDir' ||
          helper.parameters[0]!.initializer?.getText(file) !== 'home' ||
          helper.parameters[1]!.name.getText(file) !== 'pathExists' ||
          helper.parameters[1]!.initializer?.getText(file) !== 'existsSync'
        )
          return unsupported(node)
        for (const statement of helper.body.statements) {
          if (
            ts.isIfStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            statement.expression.expression.getText(file) === 'pathExists' &&
            ts.isBlock(statement.thenStatement)
          ) {
            const result = statement.thenStatement.statements
            if (result.length !== 1 || !ts.isReturnStatement(result[0]!) || !result[0].expression) {
              valid = false
              break
            }
            aliases.set('homeDir', { kind: 'home' })
            paths.push({
              exists: expression(statement.expression.arguments[0]),
              path: expression(result[0].expression),
            })
          } else if (ts.isReturnStatement(statement) && statement.expression) {
            if (!paths.length) {
              valid = false
              break
            }
            return { kind: 'firstExisting', paths, fallback: expression(statement.expression) }
          } else {
            valid = false
            break
          }
        }
        if (!valid || !paths.length) return unsupported(node)
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === 'process' &&
      node.expression.name.text === 'env'
    )
      return { kind: 'environment', name: node.name.text }
    return unsupported(node)
  }
  const object = declarations.get('agents')
  const home = declarations.get('home')
  if (
    home &&
    (!ts.isCallExpression(home) ||
      home.expression.getText(file) !== 'homedir' ||
      home.arguments.length)
  )
    unsupported(home)
  if (!object || !ts.isObjectLiteralExpression(object))
    throw new Error('Upstream agents registry shape changed')
  const harnesses: HarnessRegistry['harnesses'] = []
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer))
      unsupported(property)
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) unsupported(property.name)
    const id = property.name.text
    const fields = new Map(
      property.initializer.properties
        .filter(ts.isPropertyAssignment)
        .map(field => {
          if (!ts.isIdentifier(field.name) && !ts.isStringLiteral(field.name)) unsupported(field.name)
          return [field.name.text, field.initializer] as const
        }),
    )
    const display = fields.get('displayName')
    if (
      !display ||
      !ts.isStringLiteral(display) ||
      !fields.has('skillsDir') ||
      !fields.has('globalSkillsDir')
    )
      unsupported(property)
    harnesses.push({
      id,
      label: display.text,
      project: expression(fields.get('skillsDir'))!,
      global: expression(fields.get('globalSkillsDir')),
    })
  }
  harnesses.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return harnesses
}

export async function syncHarnesses(args: string[] = [], outputDirectory = destination) {
  const check = args.includes('--check')
  const index = args.indexOf('--ref')
  const ref = index >= 0
    ? args[index + 1]
    : JSON.parse(await readFile(resolve(outputDirectory, 'registry.gen.json'), 'utf8')).source.commit
  if (!ref || args.some((arg, i) => arg !== '--check' && arg !== '--ref' && i !== index + 1))
    throw new Error('Usage: bun scripts/sync-harnesses.ts [--ref <commit-or-tag>] [--check]')
  const commit = JSON.parse(
    await download(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`),
  ).sha
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Could not resolve immutable upstream commit')
  const source = await download(
    `https://raw.githubusercontent.com/${repository}/${commit}/src/agents.ts`,
  )
  const harnesses = extractHarnesses(source)
  const registry = {
    version: 1,
    source: {
      repository,
      commit,
      file: 'src/agents.ts',
      sha256: createHash('sha256').update(source).digest('hex'),
    },
    harnesses,
  }
  const outputs: [string, string][] = [['registry.gen.json', JSON.stringify(registry, null, 2) + '\n']]
  for (const [name, content] of outputs) {
    let existing
    try {
      existing = await readFile(resolve(outputDirectory, name), 'utf8')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    if (existing === content) continue
    if (check) throw new Error(`${name} is not synchronized with ${commit}`)
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(resolve(outputDirectory, name + '.tmp'), content)
    await rename(resolve(outputDirectory, name + '.tmp'), resolve(outputDirectory, name))
  }
  console.log(
    `${check ? 'Verified' : 'Synchronized'} ${harnesses.length} harness path rules from ${commit}.`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await syncHarnesses(process.argv.slice(2))
