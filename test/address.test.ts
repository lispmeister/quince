import { test, describe } from 'node:test'
import assert from 'node:assert'

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
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.username, 'alice')
    assert.strictEqual(result!.publicKey, PUBKEY)
    assert.strictEqual(result!.alias, undefined)
  })

  test('normalises pubkey to lowercase', () => {
    const result = parseEmailDomain(`alice@${PUBKEY_UPPER}.quincemail.com`)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.publicKey, PUBKEY_UPPER.toLowerCase())
  })

  test('normalises mixed-case pubkey to lowercase', () => {
    const result = parseEmailDomain(`alice@${PUBKEY_MIXED}.quincemail.com`)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.publicKey, PUBKEY_MIXED.toLowerCase())
  })

  test('case-insensitive domain match', () => {
    const result = parseEmailDomain(`alice@${PUBKEY}.QUINCEMAIL.COM`)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.publicKey, PUBKEY)
  })

  test('no alias field on pubkey result', () => {
    const result = parseEmailDomain(`bob@${PUBKEY}.quincemail.com`)
    assert.strictEqual(result!.alias, undefined)
    assert.notStrictEqual(result!.publicKey, undefined)
  })
})

describe('parseEmailDomain — alias addresses', () => {
  test('parses user@alias.quincemail.com', () => {
    const result = parseEmailDomain('alice@myalias.quincemail.com')
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.username, 'alice')
    assert.strictEqual(result!.alias, 'myalias')
    assert.strictEqual(result!.publicKey, undefined)
  })

  test('alias is normalised to lowercase', () => {
    const result = parseEmailDomain('alice@MyAlias.quincemail.com')
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.alias, 'myalias')
  })

  test('short hex subdomain is treated as alias (not pubkey)', () => {
    const result = parseEmailDomain('user@abc123.quincemail.com')
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.alias, 'abc123')
    assert.strictEqual(result!.publicKey, undefined)
  })

  test('63-char hex string is treated as alias (one char short)', () => {
    const shortHex = 'a'.repeat(63)
    const result = parseEmailDomain(`user@${shortHex}.quincemail.com`)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.alias, shortHex)
    assert.strictEqual(result!.publicKey, undefined)
  })

  test('65-char hex string is treated as alias (one char over)', () => {
    const longHex = 'a'.repeat(65)
    const result = parseEmailDomain(`user@${longHex}.quincemail.com`)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.alias, longHex)
    assert.strictEqual(result!.publicKey, undefined)
  })

  test('64-char non-hex subdomain is treated as alias', () => {
    const nonHex = 'g'.repeat(64)   // 'g' is not a hex digit
    const result = parseEmailDomain(`user@${nonHex}.quincemail.com`)
    assert.notStrictEqual(result, null)
    assert.strictEqual(result!.alias, nonHex)
    assert.strictEqual(result!.publicKey, undefined)
  })
})

describe('parseEmailDomain — legacy/bare domain (no subdomain)', () => {
  test('user@quincemail.com returns null — regex requires exactly one subdomain', () => {
    // The regex ^([^@]+)@([^.]+)\.quincemail\.com$ requires one dot-separated
    // subdomain before quincemail.com.  Bare domain has no subdomain → null.
    // Legacy gateway addressing would need its own parser on top of this.
    const result = parseEmailDomain('alice@quincemail.com')
    assert.strictEqual(result, null)
  })
})

describe('parseEmailDomain — invalid addresses', () => {
  test('returns null for empty string', () => {
    assert.strictEqual(parseEmailDomain(''), null)
  })

  test('returns null for wrong domain', () => {
    assert.strictEqual(parseEmailDomain('alice@gmail.com'), null)
  })

  test('returns null for address with no @', () => {
    assert.strictEqual(parseEmailDomain('notanemail'), null)
  })

  test('returns null for deep-nested subdomains (two levels)', () => {
    // extra.PUBKEY.quincemail.com → regex does not match
    const result = parseEmailDomain(`alice@extra.${PUBKEY}.quincemail.com`)
    assert.strictEqual(result, null)
  })

  test('returns null when username is empty (@ at start)', () => {
    // match[1] would be '' which is falsy → null
    const result = parseEmailDomain(`@${PUBKEY}.quincemail.com`)
    assert.strictEqual(result, null)
  })

  test('throws TypeError for null input (no null guard in implementation)', () => {
    assert.throws(() => parseEmailDomain(null as unknown as string), TypeError)
  })
})

describe('getEmailAddress', () => {
  test('constructs canonical email from username and pubkey', () => {
    const addr = getEmailAddress('alice', PUBKEY)
    assert.strictEqual(addr, `alice@${PUBKEY}.quincemail.com`)
  })

  test('normalises pubkey to lowercase', () => {
    const addr = getEmailAddress('alice', PUBKEY_UPPER)
    assert.strictEqual(addr, `alice@${PUBKEY_UPPER.toLowerCase()}.quincemail.com`)
  })

  test('round-trips through parseEmailDomain', () => {
    const addr = getEmailAddress('bob', PUBKEY)
    const parsed = parseEmailDomain(addr)
    assert.notStrictEqual(parsed, null)
    assert.strictEqual(parsed!.username, 'bob')
    assert.strictEqual(parsed!.publicKey, PUBKEY)
  })
})

describe('validatePublicKey', () => {
  test('accepts valid 64-char lowercase hex', () => {
    assert.strictEqual(validatePublicKey(PUBKEY), null)
  })

  test('accepts valid 64-char uppercase hex', () => {
    assert.strictEqual(validatePublicKey(PUBKEY_UPPER), null)
  })

  test('rejects empty string', () => {
    assert.notStrictEqual(validatePublicKey(''), null)
  })

  test('rejects 63-char hex (too short)', () => {
    assert.notStrictEqual(validatePublicKey('a'.repeat(63)), null)
  })

  test('rejects 65-char hex (too long)', () => {
    assert.notStrictEqual(validatePublicKey('a'.repeat(65)), null)
  })

  test('rejects non-hex characters', () => {
    assert.notStrictEqual(validatePublicKey('g'.repeat(64)), null)
  })
})
