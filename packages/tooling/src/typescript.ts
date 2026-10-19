import ts from 'typescript'

export function parseTypeScript(file: string, text: string, errorMessage: string): ts.SourceFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // SAFETY: TypeScript's parser attaches parseDiagnostics to every SourceFile, but omits it from the public interface.
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error(errorMessage)
  return source
}
