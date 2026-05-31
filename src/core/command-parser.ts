export interface ParsedCommand {
  isCommand: boolean
  command?: string
  args?: string
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = stripLeadingMentions(text.trim())

  if (!trimmed.startsWith('/')) {
    return { isCommand: false }
  }

  const withoutSlash = trimmed.slice(1)
  const spaceIndex = withoutSlash.indexOf(' ')

  if (spaceIndex === -1) {
    const command = withoutSlash.toLowerCase()
    return { isCommand: true, command: command || undefined }
  }

  const command = withoutSlash.slice(0, spaceIndex).toLowerCase()
  const args = withoutSlash.slice(spaceIndex + 1).trim()
  return {
    isCommand: true,
    command: command || undefined,
    args: args || undefined,
  }
}

function stripLeadingMentions(text: string): string {
  let rest = text

  while (rest.startsWith('@') || rest.startsWith('＠')) {
    const match = rest.match(/^[@＠]\S+\s*/)
    if (!match) break
    rest = rest.slice(match[0].length).trimStart()
  }

  return rest
}
