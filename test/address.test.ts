import { test, expect, describe } from 'bun:test'

// src/identity.ts transitively imports bare-path / bare-fs / bare-os which
// require the Bare runtime.  We inline the two pure functions under test
// here, mirroring the technique used in gate.test.ts.

// ── Inlined from src/identity.ts ─────────────────────────────────────────────

const EMAIL_DOMAIN = 'quincemail.com'

interface ParsedAddress {
  username: string
  publicKey?: string
  alias?: string
}

function parseEmailDomain(address: string): ParsedAddress | null {
  const match = address.match(/^([^@]+)@([^.]+)\.quincemail\.com$/i)
  if (!match || !match[1] || !match[2]) return null

  const subdomain = match[2]

  if (/^[a-f0-9]{64}$/i.test(subdomain)) {
    return {
      username: match[1],
      publicKey: subdomain.toLowerCase(),
    }
  }

  return {
    username: match[1],
    alias: subdomain.toLowerCase(),
  }
}

function getEmailAddress(username: string, publicKey: string): string {
  return `${username}@${publicKey.toLowerCase()}.${EMAIL_DOMAIN}`
}

function validatePublicKey(pubkey: string): string | null {
  if (!pubkey) return 'Public key is required'
  if (typeof pubkey !== 'string') return 'Public key must be a string'
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) {
    return 'Public key must be 64 hexadecimal characters'
  }
  return null
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PUBKEY = 'a'.repeat(64)
const PUBKEY_UPPER = 'A'.repeat(64)
const PUBKEY_MIXED = 'aAbBcCdDeEfF'.repeat(5) + 'aAbB'  // 64 chars, mixed case

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseEmailDomain — pubkey addresses', () => {
  test('parses user@<64hexchars>.quincemail.com', () => {
    const result = parseEmailDomain(`alice@${PUBKEY}.quincemail.com`)
    expect(result).not.toBeNull()
    expect(result!.username).toBe('alice')
    expect(result!.publicKey).toBe(PUBKEY)
    expect(result!.alias).toBeUndefined()
  })

  test('normalises pubkey to lowercase', () => {
    const result = parseEmailDomain(`alice@${PUBKEY_UPPER}.quincemail.com`)
    expect(result).not.toBeNull()
    expect(result!.publicKey).toBe(PUBKEY_UPPER.toLowerCase())
  })

  test('normalises mixed-case pubkey to lowercase', () => {
    const result = parseEmailDomain(`alice@${PUBKEY_MIXED}.quincemail.com`)
    expect(result).not.toBeNull()
    expect(result!.publicKey).toBe(PUBKEY_MIXED.toLowerCase())
  })

  test('case-insensitive domain match', () => {
    const result = parseEmailDomain(`alice@${PUBKEY}.QUINCEMAIL.COM`)
    expect(result).not.toBeNull()
    expect(result!.publicKey).toBe(PUBKEY)
  })

  test('no alias field on pubkey result', () => {
    const result = parseEmailDomain(`bob@${PUBKEY}.quincemail.com`)
    expect(result!.alias).toBeUndefined()
    expect(result!.publicKey).toBeDefined()
  })
})

describe('parseEmailDomain — alias addresses', () => {
  test('parses user@alias.quincemail.com', () => {
    const result = parseEmailDomain('alice@myalias.quincemail.com')
    expect(result).not.toBeNull()
    expect(result!.username).toBe('alice')
    expect(result!.alias).toBe('myalias')
    expect(result!.publicKey).toBeUndefined()
  })

  test('alias is normalised to lowercase', () => {
    const result = parseEmailDomain('alice@MyAlias.quincemail.com')
    expect(result).not.toBeNull()
    expect(result!.alias).toBe('myalias')
  })

  test('short hex subdomain is treated as alias (not pubkey)', () => {
    const result = parseEmailDomain('user@abc123.quincemail.com')
    expect(result).not.toBeNull()
    expect(result!.alias).toBe('abc123')
    expect(result!.publicKey).toBeUndefined()
  })

  test('63-char hex string is treated as alias (one char short)', () => {
    const shortHex = 'a'.repeat(63)
    const result = parseEmailDomain(`user@${shortHex}.quincemail.com`)
    expect(result).not.toBeNull()
    expect(result!.alias).toBe(shortHex)
    expect(result!.publicKey).toBeUndefined()
  })

  test('65-char hex string is treated as alias (one char over)', () => {
    const longHex = 'a'.repeat(65)
    const result = parseEmailDomain(`user@${longHex}.quincemail.com`)
    expect(result).not.toBeNull()
    expect(result!.alias).toBe(longHex)
    expect(result!.publicKey).toBeUndefined()
  })

  test('64-char non-hex subdomain is treated as alias', () => {
    const nonHex = 'g'.repeat(64)   // 'g' is not a hex digit
    const result = parseEmailDomain(`user@${nonHex}.quincemail.com`)
    expect(result).not.toBeNull()
    expect(result!.alias).toBe(nonHex)
    expect(result!.publicKey).toBeUndefined()
  })
})

describe('parseEmailDomain — legacy/bare domain (no subdomain)', () => {
  test('user@quincemail.com returns null — regex requires exactly one subdomain', () => {
    // The regex ^([^@]+)@([^.]+)\.quincemail\.com$ requires one dot-separated
    // subdomain before quincemail.com.  Bare domain has no subdomain → null.
    // Legacy gateway addressing would need its own parser on top of this.
    const result = parseEmailDomain('alice@quincemail.com')
    expect(result).toBeNull()
  })
})

describe('parseEmailDomain — invalid addresses', () => {
  test('returns null for empty string', () => {
    expect(parseEmailDomain('')).toBeNull()
  })

  test('returns null for wrong domain', () => {
    expect(parseEmailDomain('alice@gmail.com')).toBeNull()
  })

  test('returns null for address with no @', () => {
    expect(parseEmailDomain('notanemail')).toBeNull()
  })

  test('returns null for deep-nested subdomains (two levels)', () => {
    // extra.PUBKEY.quincemail.com → regex does not match
    const result = parseEmailDomain(`alice@extra.${PUBKEY}.quincemail.com`)
    expect(result).toBeNull()
  })

  test('returns null when username is empty (@ at start)', () => {
    // match[1] would be '' which is falsy → null
    const result = parseEmailDomain(`@${PUBKEY}.quincemail.com`)
    expect(result).toBeNull()
  })

  test('throws TypeError for null input (no null guard in implementation)', () => {
    expect(() => parseEmailDomain(null as unknown as string)).toThrow(TypeError)
  })
})

describe('getEmailAddress', () => {
  test('constructs canonical email from username and pubkey', () => {
    const addr = getEmailAddress('alice', PUBKEY)
    expect(addr).toBe(`alice@${PUBKEY}.quincemail.com`)
  })

  test('normalises pubkey to lowercase', () => {
    const addr = getEmailAddress('alice', PUBKEY_UPPER)
    expect(addr).toBe(`alice@${PUBKEY_UPPER.toLowerCase()}.quincemail.com`)
  })

  test('round-trips through parseEmailDomain', () => {
    const addr = getEmailAddress('bob', PUBKEY)
    const parsed = parseEmailDomain(addr)
    expect(parsed).not.toBeNull()
    expect(parsed!.username).toBe('bob')
    expect(parsed!.publicKey).toBe(PUBKEY)
  })
})

describe('validatePublicKey', () => {
  test('accepts valid 64-char lowercase hex', () => {
    expect(validatePublicKey(PUBKEY)).toBeNull()
  })

  test('accepts valid 64-char uppercase hex', () => {
    expect(validatePublicKey(PUBKEY_UPPER)).toBeNull()
  })

  test('rejects empty string', () => {
    expect(validatePublicKey('')).not.toBeNull()
  })

  test('rejects 63-char hex (too short)', () => {
    expect(validatePublicKey('a'.repeat(63))).not.toBeNull()
  })

  test('rejects 65-char hex (too long)', () => {
    expect(validatePublicKey('a'.repeat(65))).not.toBeNull()
  })

  test('rejects non-hex characters', () => {
    expect(validatePublicKey('g'.repeat(64))).not.toBeNull()
  })
})
