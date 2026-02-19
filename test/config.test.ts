import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Config module uses bare-fs/bare-path/bare-os which don't work under bun.
// We reimplement the pure functions here for testing, same approach as inbox.test.ts.

interface Config {
  username?: string
  smtpPort?: number
  pop3Port?: number
  peers?: Record<string, string>
  trustIntroductions?: Record<string, boolean>
}

// --- Reimplemented pure functions (mirroring src/config.ts) ---

function validateAlias(alias: string): string | null {
  if (!alias) return 'Alias is required'
  if (typeof alias !== 'string') return 'Alias must be a string'
  if (alias.length === 0) return 'Alias cannot be empty'
  if (alias.length > 32) return 'Alias must be 32 characters or less'
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    return 'Alias can only contain letters, numbers, dots, underscores, and hyphens'
  }
  if (/^[a-f0-9]{64}$/i.test(alias)) {
    return 'Alias cannot be a 64-character hex string (looks like a pubkey)'
  }
  return null
}

function validatePublicKey(pubkey: string): string | null {
  if (!pubkey) return 'Public key is required'
  if (typeof pubkey !== 'string') return 'Public key must be a string'
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) {
    return 'Public key must be 64 hexadecimal characters'
  }
  return null
}

interface ConfigValidationError {
  field: string
  message: string
}

function validateConfig(config: unknown): ConfigValidationError[] {
  const errors: ConfigValidationError[] = []
  if (typeof config !== 'object' || config === null) {
    errors.push({ field: 'config', message: 'Config must be an object' })
    return errors
  }
  const c = config as Record<string, unknown>
  if (c.username !== undefined) {
    if (typeof c.username !== 'string') {
      errors.push({ field: 'username', message: 'Username must be a string' })
    } else if (c.username.length === 0) {
      errors.push({ field: 'username', message: 'Username cannot be empty' })
    } else if (!/^[a-zA-Z0-9._-]+$/.test(c.username)) {
      errors.push({ field: 'username', message: 'Username can only contain letters, numbers, dots, underscores, and hyphens' })
    }
  }
  if (c.smtpPort !== undefined) {
    if (typeof c.smtpPort !== 'number') {
      errors.push({ field: 'smtpPort', message: 'SMTP port must be a number' })
    } else if (!Number.isInteger(c.smtpPort) || c.smtpPort < 1 || c.smtpPort > 65535) {
      errors.push({ field: 'smtpPort', message: 'SMTP port must be an integer between 1 and 65535' })
    }
  }
  if (c.peers !== undefined) {
    if (typeof c.peers !== 'object' || c.peers === null || Array.isArray(c.peers)) {
      errors.push({ field: 'peers', message: 'Peers must be an object' })
    } else {
      const peers = c.peers as Record<string, unknown>
      for (const [alias, pubkey] of Object.entries(peers)) {
        const aliasError = validateAlias(alias)
        if (aliasError) {
          errors.push({ field: `peers.${alias}`, message: aliasError })
        }
        if (typeof pubkey !== 'string') {
          errors.push({ field: `peers.${alias}`, message: 'Pubkey must be a string' })
        } else {
          const pubkeyError = validatePublicKey(pubkey)
          if (pubkeyError) {
            errors.push({ field: `peers.${alias}`, message: pubkeyError })
          }
        }
      }
    }
  }
  if (c.trustIntroductions !== undefined) {
    if (typeof c.trustIntroductions !== 'object' || c.trustIntroductions === null || Array.isArray(c.trustIntroductions)) {
      errors.push({ field: 'trustIntroductions', message: 'trustIntroductions must be an object' })
    } else {
      const trust = c.trustIntroductions as Record<string, unknown>
      for (const [alias, value] of Object.entries(trust)) {
        if (typeof value !== 'boolean') {
          errors.push({ field: `trustIntroductions.${alias}`, message: 'Value must be a boolean' })
        }
      }
    }
  }

  return errors
}

function addPeer(config: Config, alias: string, pubkey: string): Config {
  const peers = { ...config.peers }
  peers[alias] = pubkey.toLowerCase()
  return { ...config, peers }
}

function removePeer(config: Config, alias: string): Config {
  const peers = { ...config.peers }
  delete peers[alias]
  return { ...config, peers }
}

function getPeerPubkey(config: Config, alias: string): string | undefined {
  return config.peers?.[alias]
}

function getPeerAlias(config: Config, pubkey: string): string | undefined {
  if (!config.peers) return undefined
  const normalizedPubkey = pubkey.toLowerCase()
  for (const [alias, pk] of Object.entries(config.peers)) {
    if (pk === normalizedPubkey) return alias
  }
  return undefined
}

// --- Save/load with configurable directory ---

function saveConfig(configDir: string, config: Config): boolean {
  const errors = validateConfig(config)
  if (errors.length > 0) return false

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2))
    return true
  } catch {
    return false
  }
}

function loadConfig(configDir: string): Config {
  const configFile = path.join(configDir, 'config.json')
  try {
    if (fs.existsSync(configFile)) {
      const content = fs.readFileSync(configFile, 'utf8')
      const parsed = JSON.parse(content)

      const errors = validateConfig(parsed)
      if (errors.length > 0) {
        // Return only individually-valid fields (strip invalid ones)
        const config: Config = {}
        if (typeof parsed.username === 'string' && parsed.username.length > 0 &&
            /^[a-zA-Z0-9._-]+$/.test(parsed.username)) {
          config.username = parsed.username
        }
        if (typeof parsed.smtpPort === 'number' && Number.isInteger(parsed.smtpPort) &&
            parsed.smtpPort >= 1 && parsed.smtpPort <= 65535) {
          config.smtpPort = parsed.smtpPort
        }
        if (typeof parsed.pop3Port === 'number' && Number.isInteger(parsed.pop3Port) &&
            parsed.pop3Port >= 1 && parsed.pop3Port <= 65535) {
          config.pop3Port = parsed.pop3Port
        }
        if (typeof parsed.peers === 'object' && parsed.peers !== null && !Array.isArray(parsed.peers)) {
          const validPeers: Record<string, string> = {}
          for (const [alias, pubkey] of Object.entries(parsed.peers as Record<string, unknown>)) {
            if (!validateAlias(alias) && typeof pubkey === 'string' && !validatePublicKey(pubkey)) {
              validPeers[alias] = (pubkey as string).toLowerCase()
            }
          }
          if (Object.keys(validPeers).length > 0) {
            config.peers = validPeers
          }
        }
        if (typeof parsed.trustIntroductions === 'object' && parsed.trustIntroductions !== null && !Array.isArray(parsed.trustIntroductions)) {
          const validTrust: Record<string, boolean> = {}
          for (const [alias, value] of Object.entries(parsed.trustIntroductions as Record<string, unknown>)) {
            if (typeof value === 'boolean') {
              validTrust[alias] = value
            }
          }
          if (Object.keys(validTrust).length > 0) {
            config.trustIntroductions = validTrust
          }
        }
        return config
      }

      return parsed as Config
    }
  } catch {}
  return {}
}

// --- Helpers ---

const VALID_PUBKEY = 'a'.repeat(64)
const VALID_PUBKEY_2 = 'b'.repeat(64)

let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-config-test-'))
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

// --- Pure function tests ---

describe('validateAlias', () => {
  test('accepts valid aliases', () => {
    assert.strictEqual(validateAlias('bob'), null)
    assert.strictEqual(validateAlias('alice-1'), null)
    assert.strictEqual(validateAlias('peer.name'), null)
    assert.strictEqual(validateAlias('user_2'), null)
  })

  test('rejects empty alias', () => {
    assert.notStrictEqual(validateAlias(''), null)
  })

  test('rejects alias longer than 32 chars', () => {
    assert.notStrictEqual(validateAlias('a'.repeat(33)), null)
  })

  test('rejects special characters', () => {
    assert.notStrictEqual(validateAlias('bob@host'), null)
    assert.notStrictEqual(validateAlias('alice smith'), null)
  })

  test('rejects 64-char hex string (looks like pubkey)', () => {
    assert.notStrictEqual(validateAlias('a'.repeat(64)), null)
  })
})

describe('validateConfig', () => {
  test('accepts empty config', () => {
    assert.strictEqual(validateConfig({}).length, 0)
  })

  test('accepts valid full config', () => {
    const config = {
      username: 'alice',
      smtpPort: 2525,
      peers: { bob: VALID_PUBKEY }
    }
    assert.strictEqual(validateConfig(config).length, 0)
  })

  test('rejects non-object config', () => {
    assert.notStrictEqual(validateConfig('not-an-object').length, 0)
    assert.notStrictEqual(validateConfig(null).length, 0)
  })

  test('rejects invalid smtpPort', () => {
    assert.notStrictEqual(validateConfig({ smtpPort: 'abc' }).length, 0)
    assert.notStrictEqual(validateConfig({ smtpPort: 0 }).length, 0)
    assert.notStrictEqual(validateConfig({ smtpPort: 99999 }).length, 0)
  })

  test('rejects invalid peer pubkey', () => {
    const config = { peers: { bob: 'not-a-pubkey' } }
    assert.notStrictEqual(validateConfig(config).length, 0)
  })

  test('rejects invalid peer alias', () => {
    const config = { peers: { 'bad alias!': VALID_PUBKEY } }
    assert.notStrictEqual(validateConfig(config).length, 0)
  })
})

describe('addPeer', () => {
  test('adds peer to empty config', () => {
    const config: Config = {}
    const result = addPeer(config, 'bob', VALID_PUBKEY)

    assert.notStrictEqual(result.peers, undefined)
    assert.strictEqual(result.peers!['bob'], VALID_PUBKEY)
  })

  test('adds peer to config with existing peers', () => {
    const config: Config = { peers: { alice: VALID_PUBKEY } }
    const result = addPeer(config, 'bob', VALID_PUBKEY_2)

    assert.strictEqual(Object.keys(result.peers!).length, 2)
    assert.strictEqual(result.peers!['alice'], VALID_PUBKEY)
    assert.strictEqual(result.peers!['bob'], VALID_PUBKEY_2)
  })

  test('lowercases pubkey', () => {
    const config: Config = {}
    const result = addPeer(config, 'bob', 'A'.repeat(64))
    assert.strictEqual(result.peers!['bob'], 'a'.repeat(64))
  })

  test('does not mutate original config', () => {
    const config: Config = { peers: { alice: VALID_PUBKEY } }
    const result = addPeer(config, 'bob', VALID_PUBKEY_2)

    assert.strictEqual(config.peers!['bob'], undefined)
    assert.strictEqual(result.peers!['bob'], VALID_PUBKEY_2)
  })
})

describe('removePeer', () => {
  test('removes existing peer', () => {
    const config: Config = { peers: { alice: VALID_PUBKEY, bob: VALID_PUBKEY_2 } }
    const result = removePeer(config, 'bob')

    assert.strictEqual(result.peers!['alice'], VALID_PUBKEY)
    assert.strictEqual(result.peers!['bob'], undefined)
  })

  test('does not mutate original config', () => {
    const config: Config = { peers: { bob: VALID_PUBKEY } }
    const result = removePeer(config, 'bob')

    assert.strictEqual(config.peers!['bob'], VALID_PUBKEY)
    assert.strictEqual(result.peers!['bob'], undefined)
  })
})

describe('getPeerPubkey', () => {
  test('returns pubkey for known alias', () => {
    const config: Config = { peers: { bob: VALID_PUBKEY } }
    assert.strictEqual(getPeerPubkey(config, 'bob'), VALID_PUBKEY)
  })

  test('returns undefined for unknown alias', () => {
    const config: Config = { peers: { bob: VALID_PUBKEY } }
    assert.strictEqual(getPeerPubkey(config, 'alice'), undefined)
  })

  test('returns undefined when no peers', () => {
    const config: Config = {}
    assert.strictEqual(getPeerPubkey(config, 'bob'), undefined)
  })
})

describe('getPeerAlias', () => {
  test('returns alias for known pubkey', () => {
    const config: Config = { peers: { bob: VALID_PUBKEY } }
    assert.strictEqual(getPeerAlias(config, VALID_PUBKEY), 'bob')
  })

  test('matches case-insensitively', () => {
    const config: Config = { peers: { bob: VALID_PUBKEY } }
    assert.strictEqual(getPeerAlias(config, VALID_PUBKEY.toUpperCase()), 'bob')
  })

  test('returns undefined for unknown pubkey', () => {
    const config: Config = { peers: { bob: VALID_PUBKEY } }
    assert.strictEqual(getPeerAlias(config, VALID_PUBKEY_2), undefined)
  })
})

// --- Save/load round-trip tests ---

describe('saveConfig and loadConfig round-trip', () => {
  test('saves and loads config with peers', () => {
    const config: Config = {
      username: 'alice',
      peers: { bob: VALID_PUBKEY }
    }

    const saved = saveConfig(testDir, config)
    assert.strictEqual(saved, true)

    const loaded = loadConfig(testDir)
    assert.strictEqual(loaded.username, 'alice')
    assert.strictEqual(loaded.peers!['bob'], VALID_PUBKEY)
  })

  test('add-peer round-trips through save/load', () => {
    let config: Config = { username: 'alice' }

    saveConfig(testDir, config)

    config = addPeer(config, 'bob', VALID_PUBKEY)
    const saved = saveConfig(testDir, config)
    assert.strictEqual(saved, true)

    const loaded = loadConfig(testDir)
    assert.notStrictEqual(loaded.peers, undefined)
    assert.strictEqual(loaded.peers!['bob'], VALID_PUBKEY)
  })

  test('add then remove peer round-trips', () => {
    let config: Config = {}

    config = addPeer(config, 'bob', VALID_PUBKEY)
    saveConfig(testDir, config)

    config = removePeer(config, 'bob')
    saveConfig(testDir, config)

    const loaded = loadConfig(testDir)
    assert.strictEqual(loaded.peers!['bob'], undefined)
  })

  test('saveConfig returns false for invalid config', () => {
    const invalid = { smtpPort: 'not-a-number' } as unknown as Config
    const saved = saveConfig(testDir, invalid)
    assert.strictEqual(saved, false)

    // File should not exist
    assert.strictEqual(fs.existsSync(path.join(testDir, 'config.json')), false)
  })

  test('saveConfig creates directory if missing', () => {
    const nestedDir = path.join(testDir, 'subdir', '.quince')
    const config: Config = { peers: { bob: VALID_PUBKEY } }

    const saved = saveConfig(nestedDir, config)
    assert.strictEqual(saved, true)
    assert.strictEqual(fs.existsSync(path.join(nestedDir, 'config.json')), true)
  })

  test('multiple peers persist correctly', () => {
    let config: Config = {}

    config = addPeer(config, 'bob', VALID_PUBKEY)
    config = addPeer(config, 'carol', VALID_PUBKEY_2)
    saveConfig(testDir, config)

    const loaded = loadConfig(testDir)
    assert.strictEqual(Object.keys(loaded.peers!).length, 2)
    assert.strictEqual(loaded.peers!['bob'], VALID_PUBKEY)
    assert.strictEqual(loaded.peers!['carol'], VALID_PUBKEY_2)
  })
})

describe('loadConfig with invalid placeholder values', () => {
  test('strips invalid username from example config and allows add-peer', () => {
    // Simulate config.example.json placeholders that a user might leave in
    const exampleConfig = {
      username: '<your-username>',
      smtpPort: '<smtp-port>',
      pop3Port: '<pop3-port>',
      peers: {}
    }
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify(exampleConfig))

    // loadConfig should strip all invalid fields
    let config = loadConfig(testDir)
    assert.strictEqual(config.username, undefined)
    assert.strictEqual(config.smtpPort, undefined)

    // Now add-peer → save should succeed
    config = addPeer(config, 'bob', VALID_PUBKEY)
    const saved = saveConfig(testDir, config)
    assert.strictEqual(saved, true)

    // Verify the peer persisted
    const loaded = loadConfig(testDir)
    assert.strictEqual(loaded.peers!['bob'], VALID_PUBKEY)
  })

  test('preserves valid fields while stripping invalid ones', () => {
    const mixedConfig = {
      username: 'alice',
      smtpPort: '<bad>',
      peers: {
        bob: VALID_PUBKEY,
        'bad alias!': 'not-a-key'
      }
    }
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify(mixedConfig))

    const config = loadConfig(testDir)
    assert.strictEqual(config.username, 'alice')
    assert.strictEqual(config.smtpPort, undefined)
    assert.strictEqual(config.peers!['bob'], VALID_PUBKEY)
    assert.strictEqual(config.peers!['bad alias!'], undefined)
  })
})

describe('trustIntroductions validation', () => {
  test('accepts valid trustIntroductions', () => {
    const config = { trustIntroductions: { alice: true, bob: false } }
    assert.strictEqual(validateConfig(config).length, 0)
  })

  test('rejects non-object trustIntroductions', () => {
    assert.notStrictEqual(validateConfig({ trustIntroductions: 'not-an-object' }).length, 0)
    assert.notStrictEqual(validateConfig({ trustIntroductions: [true] }).length, 0)
  })

  test('rejects non-boolean values', () => {
    const config = { trustIntroductions: { alice: 'yes' } }
    assert.notStrictEqual(validateConfig(config).length, 0)
  })

  test('round-trips through save/load', () => {
    const config: Config = {
      trustIntroductions: { alice: true, bob: false }
    }

    const saved = saveConfig(testDir, config)
    assert.strictEqual(saved, true)

    const loaded = loadConfig(testDir)
    assert.deepStrictEqual(loaded.trustIntroductions, { alice: true, bob: false })
  })
})
