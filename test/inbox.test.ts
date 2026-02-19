import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'hypercore-crypto'
import { signMessage, verifyMessage } from '../dist/crypto.js'

// Inbox module uses bare-fs/bare-path/bare-os which resolve to node equivalents in bun,
// but it reads getConfigDir() from config.ts which uses os.homedir(). We test the logic
// directly by reimplementing the core functions with a temp dir.

interface InboxEntry {
  id: string
  file: string
  from: string
  to: string
  subject: string
  senderPubkey: string
  signatureValid: boolean
  receivedAt: number
}

let testDir: string

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function storeMessage(
  inboxDir: string,
  id: string,
  mime: string,
  senderPubkey: string,
  signatureValid: boolean
): InboxEntry {
  const receivedAt = Date.now()
  const filename = `${receivedAt}-${id}.eml`
  const filepath = path.join(inboxDir, filename)

  fs.writeFileSync(filepath, mime)

  const entry: InboxEntry = {
    id,
    file: filename,
    from: extractHeader(mime, 'From'),
    to: extractHeader(mime, 'To'),
    subject: extractHeader(mime, 'Subject'),
    senderPubkey,
    signatureValid,
    receivedAt
  }

  // Load and append to index
  const indexPath = path.join(inboxDir, 'index.json')
  let index: InboxEntry[] = []
  try {
    if (fs.existsSync(indexPath)) {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    }
  } catch {}
  index.push(entry)
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2))

  return entry
}

function listMessages(inboxDir: string): InboxEntry[] {
  const indexPath = path.join(inboxDir, 'index.json')
  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    }
  } catch {}
  return []
}

function makeKeyPair() {
  const kp = crypto.keyPair()
  return {
    publicKey: kp.publicKey.toString('hex'),
    secretKey: kp.secretKey.toString('hex')
  }
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-inbox-test-'))
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

const MIME = [
  'From: alice@alice.quincemail.com',
  'To: bob@bob.quincemail.com',
  'Subject: Test Message',
  '',
  'Hello from Alice!'
].join('\r\n')

describe('inbox storage', () => {
  test('stores .eml file to disk', () => {
    storeMessage(testDir, 'msg-001', MIME, 'abcd'.repeat(16), true)

    const files = fs.readdirSync(testDir).filter((f: string) => f.endsWith('.eml'))
    assert.strictEqual(files.length, 1)
    assert.ok(files[0]!.includes('msg-001.eml'))

    const content = fs.readFileSync(path.join(testDir, files[0]!), 'utf8')
    assert.strictEqual(content, MIME)
  })

  test('extracts metadata into index', () => {
    storeMessage(testDir, 'msg-002', MIME, 'abcd'.repeat(16), true)

    const messages = listMessages(testDir)
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0]!.id, 'msg-002')
    assert.strictEqual(messages[0]!.from, 'alice@alice.quincemail.com')
    assert.strictEqual(messages[0]!.to, 'bob@bob.quincemail.com')
    assert.strictEqual(messages[0]!.subject, 'Test Message')
    assert.strictEqual(messages[0]!.signatureValid, true)
  })

  test('records signatureValid=false for unverified messages', () => {
    storeMessage(testDir, 'msg-003', MIME, 'abcd'.repeat(16), false)

    const messages = listMessages(testDir)
    assert.strictEqual(messages[0]!.signatureValid, false)
  })

  test('appends multiple messages to index', () => {
    storeMessage(testDir, 'msg-a', MIME, 'aaaa'.repeat(16), true)
    storeMessage(testDir, 'msg-b', MIME, 'bbbb'.repeat(16), true)
    storeMessage(testDir, 'msg-c', MIME, 'cccc'.repeat(16), false)

    const messages = listMessages(testDir)
    assert.strictEqual(messages.length, 3)
    assert.strictEqual(messages[0]!.id, 'msg-a')
    assert.strictEqual(messages[1]!.id, 'msg-b')
    assert.strictEqual(messages[2]!.id, 'msg-c')
  })

  test('empty inbox returns empty list', () => {
    const messages = listMessages(testDir)
    assert.strictEqual(messages.length, 0)
  })
})

describe('inbox with signed messages', () => {
  const alice = makeKeyPair()

  test('stores verified message with signatureValid=true', () => {
    const signed = signMessage(MIME, alice.secretKey)
    const { mime, valid } = verifyMessage(signed, alice.publicKey)

    assert.strictEqual(valid, true)
    storeMessage(testDir, 'verified-001', mime, alice.publicKey, valid)

    const messages = listMessages(testDir)
    assert.strictEqual(messages[0]!.signatureValid, true)

    // .eml should have signature preserved
    const content = fs.readFileSync(path.join(testDir, messages[0]!.file), 'utf8')
    assert.ok(content.includes('X-Quince-Signature'))
    assert.ok(content.includes('Hello from Alice!'))
  })

  test('stores unverified message with signatureValid=false', () => {
    const bob = makeKeyPair()
    const signed = signMessage(MIME, alice.secretKey)
    const { mime, valid } = verifyMessage(signed, bob.publicKey) // wrong key

    assert.strictEqual(valid, false)
    storeMessage(testDir, 'unverified-001', mime, bob.publicKey, valid)

    const messages = listMessages(testDir)
    assert.strictEqual(messages[0]!.signatureValid, false)
  })
})
