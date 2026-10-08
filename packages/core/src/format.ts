/** Terminal formatting is shared by help and errors. No ANSI codes in plain output. */
export function wrap(text: string, width: number, indent = ''): string {
  const available = Math.max(12, width - indent.length)
  return text.split('\n').map(paragraph => {
    const lines: string[] = []
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > available) {
        lines.push(indent + line)
        line = word
      } else line += (line ? ' ' : '') + word
    }
    lines.push(indent + line)
    return lines.join('\n')
  }).join('\n')
}

export function table(rows: readonly (readonly [string, string])[], width: number): string {
  const labelWidth = Math.min(32, Math.max(0, ...rows.map(([label]) => label.length)))
  return rows.map(([label, description]) => {
    const indent = ' '.repeat(labelWidth + 4)
    if (width < 60 || label.length > labelWidth) {
      return `  ${label}\n${wrap(description, width, '    ')}`.trimEnd()
    }
    const details = wrap(description, width, indent).split('\n')
    return `  ${label.padEnd(labelWidth)}  ${(details[0] ?? '').slice(indent.length)}${details.length > 1 ? `\n${details.slice(1).join('\n')}` : ''}`.trimEnd()
  }).join('\n')
}
