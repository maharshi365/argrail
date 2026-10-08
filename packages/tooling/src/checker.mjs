// Compiler process lifetime follows its stdin pipe, including abrupt parent exits on Windows.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const formatHost = {
  getCanonicalFileName: file => file,
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  getNewLine: () => ts.sys.newLine,
}
const host = ts.createWatchCompilerHost(
  process.argv[2], {}, ts.sys, ts.createSemanticDiagnosticsBuilderProgram,
  diagnostic => process.stdout.write(ts.formatDiagnostics([diagnostic], formatHost)),
  diagnostic => console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, ts.sys.newLine)),
)
const program = ts.createWatchProgram(host)
function close() { program.close(); process.exit(0) }
process.stdin.resume()
process.stdin.once('end', close)
process.once('SIGINT', close)
process.once('SIGTERM', close)
