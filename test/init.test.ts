import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Replicate init logic using node: builtins (bare-* don't load under Bun).
// This mirrors what handleInit() + loadIdentity() + saveConfig() do.

const ID_FILE = 'id'
const ID_PUB_FILE = 'id_pub'
const CONFIG_FILE = 'config.json'
const EMAIL_DOMAIN = 'quincemail.com'

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// Generate an Ed25519 keypair using Node's crypto (same algorithm as hypercore-crypto)
function generateKeypair(): { publicKey: string; secretKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32)
  // Ed25519 secretKey in hypercore-crypto = 64 bytes (private seed 32 + public 32)
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32)
  const secretKeyBuf = Buffer.concat([privRaw, pubRaw])
  return {
    publicKey: pubRaw.toString('hex'),
    secretKey: secretKeyBuf.toString('hex'),
  }
}

function loadOrCreateIdentity(quinceDir: string): { publicKey: string; secretKey: string } {
  const idPath = path.join(quinceDir, ID_FILE)
  const pubPath = path.join(quinceDir, ID_PUB_FILE)

  ensureDir(quinceDir)

  if (fs.existsSync(idPath) && fs.existsSync(pubPath)) {
    const secretKey = fs.readFileSync(idPath, 'utf8').trim()
    const publicKey = fs.readFileSync(pubPath, 'utf8').trim()
    if (/^[a-f0-9]{64}$/i.test(publicKey) && /^[a-f0-9]{128}$/i.test(secretKey)) {
      return { publicKey, secretKey }
    }
  }

  const kp = generateKeypair()
  fs.writeFileSync(idPath, kp.secretKey)
  fs.chmodSync(idPath, 0o600)
  fs.writeFileSync(pubPath, kp.publicKey)
  return kp
}

function ensureDefaultConfig(quinceDir: string): void {
  const configPath = path.join(quinceDir, CONFIG_FILE)
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ username: 'user' }, null, 2))
  }
}

function runInit(quinceDir: string): { publicKey: string; emailAddress: string } {
  const identity = loadOrCreateIdentity(quinceDir)
  ensureDefaultConfig(quinceDir)
  const emailAddress = `user@${identity.publicKey.toLowerCase()}.${EMAIL_DOMAIN}`
  return { publicKey: identity.publicKey, emailAddress }
}

// Tests

describe('quince init', () => {
  let tempHome: string
  let quinceDir: string

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-init-test-'))
    quinceDir = path.join(tempHome, '.quince')
  })

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true })
  })

  test('creates .quince directory', () => {
    runInit(quinceDir)
    expect(fs.existsSync(quinceDir)).toBe(true)
  })

  test('creates keypair files', () => {
    runInit(quinceDir)

    expect(fs.existsSync(path.join(quinceDir, 'id'))).toBe(true)
    expect(fs.existsSync(path.join(quinceDir, 'id_pub'))).toBe(true)

    const pubkey = fs.readFileSync(path.join(quinceDir, 'id_pub'), 'utf8').trim()
    expect(pubkey).toMatch(/^[a-f0-9]{64}$/)

    const secretKey = fs.readFileSync(path.join(quinceDir, 'id'), 'utf8').trim()
    expect(secretKey).toMatch(/^[a-f0-9]{128}$/)
  })

  test('sets private key permissions to 0600', () => {
    runInit(quinceDir)
    const idPath = path.join(quinceDir, 'id')
    const stat = fs.statSync(idPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('is idempotent — running twice keeps same keys', () => {
    const first = runInit(quinceDir)
    const second = runInit(quinceDir)

    expect(second.publicKey).toBe(first.publicKey)

    const secret1 = fs.readFileSync(path.join(quinceDir, 'id'), 'utf8').trim()
    runInit(quinceDir)
    const secret2 = fs.readFileSync(path.join(quinceDir, 'id'), 'utf8').trim()
    expect(secret2).toBe(secret1)
  })

  test('creates default config.json', () => {
    runInit(quinceDir)
    const configPath = path.join(quinceDir, CONFIG_FILE)
    expect(fs.existsSync(configPath)).toBe(true)

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(typeof config).toBe('object')
    expect(config.username).toBe('user')
  })

  test('does not overwrite existing config.json', () => {
    runInit(quinceDir)
    // Manually set a custom username
    const configPath = path.join(quinceDir, CONFIG_FILE)
    fs.writeFileSync(configPath, JSON.stringify({ username: 'alice' }, null, 2))

    runInit(quinceDir)
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    expect(config.username).toBe('alice')
  })

  test('returns public key in email address format', () => {
    const { publicKey, emailAddress } = runInit(quinceDir)
    expect(emailAddress).toBe(`user@${publicKey}.${EMAIL_DOMAIN}`)
    expect(emailAddress).toContain('.quincemail.com')
  })
})
