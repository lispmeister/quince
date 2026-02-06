import type { SmtpCommand } from './types.js'

const COMMAND_PATTERN = /^([A-Z]{4})(?:\s+(.*))?$/i

export function parseCommand(line: string): SmtpCommand | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const match = trimmed.match(COMMAND_PATTERN)
  if (!match) return null

  return {
    command: match[1]!.toUpperCase(),
    argument: match[2]?.trim() ?? ''
  }
}

export function parseMailFrom(arg: string): string | null {
  // MAIL FROM:<address> or MAIL FROM: <address>
  const match = arg.match(/^FROM:\s*<([^>]*)>/i)
  return match ? match[1]! : null
}

export function parseRcptTo(arg: string): string | null {
  // RCPT TO:<address> or RCPT TO: <address>
  const match = arg.match(/^TO:\s*<([^>]*)>/i)
  return match ? match[1]! : null
}

export function parseAddress(address: string): { user: string; domain: string } | null {
  // Format: user@<subdomain>.quincemail.com or user@<pubkey>.quincemail.com
  const atIndex = address.lastIndexOf('@')
  if (atIndex === -1) return null

  const user = address.slice(0, atIndex)
  const domain = address.slice(atIndex + 1)

  if (!user) return null
  if (!domain) return null

  // Accept any quincemail.com subdomain (pubkey or alias)
  // Detailed validation happens later in resolveRecipient()
  if (!/^[a-z0-9._-]+\.quincemail\.com$/i.test(domain)) {
    return null
  }

  return { user, domain: domain.toLowerCase() }
}
