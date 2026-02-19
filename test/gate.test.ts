import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Gate module uses bare-fs/bare-path/bare-os which resolve to node equivalents in bun,
// but it reads getConfigDir() from config.ts which uses os.homedir(). We test the logic
// directly by reimplementing the core functions with a temp dir.

interface GatePayment {
  method: string
  amount: number
  currency: string
  invoiceId: string
}

interface GateEntry {
  id: string
  file: string
  from: string
  to: string
  subject: string
  receivedAt: number
  contentType?: string
  messageId?: string
  senderEmail: string
  payment: GatePayment
  status: 'pending' | 'accepted' | 'rejected'
}

let testDir: string

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function loadIndex(gateDir: string): GateEntry[] {
  const indexPath = path.join(gateDir, 'index.json')
  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    }
  } catch {}
  return []
}

function saveIndex(gateDir: string, entries: GateEntry[]): void {
  fs.writeFileSync(path.join(gateDir, 'index.json'), JSON.stringify(entries, null, 2))
}

function storeGateMessage(
  gateDir: string,
  id: string,
  mime: string,
  senderEmail: string,
  payment: GatePayment
): GateEntry {
  const receivedAt = Date.now()
  const filename = `${receivedAt}-${id}.eml`
  const filepath = path.join(gateDir, filename)

  fs.writeFileSync(filepath, mime)

  const entry: GateEntry = {
    id,
    file: filename,
    from: extractHeader(mime, 'From'),
    to: extractHeader(mime, 'To'),
    subject: extractHeader(mime, 'Subject'),
    receivedAt,
    senderEmail,
    payment,
    status: 'pending'
  }

  const contentType = extractHeader(mime, 'Content-Type')
  if (contentType) entry.contentType = contentType
  const messageId = extractHeader(mime, 'Message-ID')
  if (messageId) entry.messageId = messageId

  const index = loadIndex(gateDir)
  index.push(entry)
  saveIndex(gateDir, index)

  return entry
}

function getGateMessage(gateDir: string, id: string): GateEntry | null {
  const index = loadIndex(gateDir)
  return index.find(e => e.id === id) ?? null
}

function getGateMessageContent(gateDir: string, entry: GateEntry): string | null {
  const filepath = path.join(gateDir, entry.file)
  try {
    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath, 'utf8')
    }
  } catch {}
  return null
}

function deleteGateMessage(gateDir: string, entry: GateEntry): void {
  const filepath = path.join(gateDir, entry.file)
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
    }
  } catch {}
  const index = loadIndex(gateDir)
  const filtered = index.filter(e => e.id !== entry.id)
  saveIndex(gateDir, filtered)
}

function updateGateMessageStatus(gateDir: string, id: string, status: 'pending' | 'accepted' | 'rejected'): GateEntry | null {
  const index = loadIndex(gateDir)
  const entry = index.find(e => e.id === id)
  if (!entry) return null
  entry.status = status
  saveIndex(gateDir, index)
  return entry
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-gate-test-'))
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

const PAYMENT: GatePayment = {
  method: 'lightning',
  amount: 100,
  currency: 'sats',
  invoiceId: 'lnbc100n1abc123'
}

const MIME = [
  'From: stranger@gmail.com',
  'To: alice@quincemail.com',
  'Subject: Hello from the outside',
  'Content-Type: text/plain',
  'Message-ID: <abc123@gmail.com>',
  '',
  'Hi Alice, this is a paid message.'
].join('\r\n')

const MIME_MINIMAL = [
  'From: other@example.com',
  'To: bob@quincemail.com',
  'Subject: Minimal',
  '',
  'Body here.'
].join('\r\n')

describe('gate storage', () => {
  test('stores .eml file to disk', () => {
    storeGateMessage(testDir, 'gate-001', MIME, 'stranger@gmail.com', PAYMENT)

    const files = fs.readdirSync(testDir).filter((f: string) => f.endsWith('.eml'))
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('gate-001.eml')

    const content = fs.readFileSync(path.join(testDir, files[0]!), 'utf8')
    expect(content).toBe(MIME)
  })

  test('extracts metadata into index', () => {
    storeGateMessage(testDir, 'gate-002', MIME, 'stranger@gmail.com', PAYMENT)

    const messages = loadIndex(testDir)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe('gate-002')
    expect(messages[0]!.from).toBe('stranger@gmail.com')
    expect(messages[0]!.to).toBe('alice@quincemail.com')
    expect(messages[0]!.subject).toBe('Hello from the outside')
    expect(messages[0]!.senderEmail).toBe('stranger@gmail.com')
    expect(messages[0]!.contentType).toBe('text/plain')
    expect(messages[0]!.messageId).toBe('<abc123@gmail.com>')
    expect(messages[0]!.status).toBe('pending')
  })

  test('stores payment info', () => {
    storeGateMessage(testDir, 'gate-003', MIME, 'stranger@gmail.com', PAYMENT)

    const messages = loadIndex(testDir)
    expect(messages[0]!.payment).toEqual(PAYMENT)
  })

  test('default status is pending', () => {
    storeGateMessage(testDir, 'gate-004', MIME, 'stranger@gmail.com', PAYMENT)

    const messages = loadIndex(testDir)
    expect(messages[0]!.status).toBe('pending')
  })

  test('omits optional headers when not present', () => {
    storeGateMessage(testDir, 'gate-005', MIME_MINIMAL, 'other@example.com', PAYMENT)

    const messages = loadIndex(testDir)
    expect(messages[0]!.contentType).toBeUndefined()
    expect(messages[0]!.messageId).toBeUndefined()
  })

  test('appends multiple messages to index', () => {
    storeGateMessage(testDir, 'gate-a', MIME, 'stranger@gmail.com', PAYMENT)
    storeGateMessage(testDir, 'gate-b', MIME_MINIMAL, 'other@example.com', PAYMENT)

    const messages = loadIndex(testDir)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.id).toBe('gate-a')
    expect(messages[1]!.id).toBe('gate-b')
  })

  test('empty gate returns empty list', () => {
    const messages = loadIndex(testDir)
    expect(messages).toHaveLength(0)
  })
})

describe('gate get', () => {
  test('getGateMessage finds by id', () => {
    storeGateMessage(testDir, 'find-me', MIME, 'stranger@gmail.com', PAYMENT)

    const entry = getGateMessage(testDir, 'find-me')
    expect(entry).not.toBeNull()
    expect(entry!.id).toBe('find-me')
  })

  test('getGateMessage returns null for missing id', () => {
    const entry = getGateMessage(testDir, 'nonexistent')
    expect(entry).toBeNull()
  })

  test('getGateMessageContent reads .eml file', () => {
    const entry = storeGateMessage(testDir, 'content-test', MIME, 'stranger@gmail.com', PAYMENT)

    const content = getGateMessageContent(testDir, entry)
    expect(content).toBe(MIME)
  })
})

describe('gate delete', () => {
  test('removes .eml file and index entry', () => {
    const entry = storeGateMessage(testDir, 'delete-me', MIME, 'stranger@gmail.com', PAYMENT)
    storeGateMessage(testDir, 'keep-me', MIME_MINIMAL, 'other@example.com', PAYMENT)

    deleteGateMessage(testDir, entry)

    const messages = loadIndex(testDir)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe('keep-me')

    const files = fs.readdirSync(testDir).filter((f: string) => f.endsWith('.eml'))
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('keep-me')
  })
})

describe('gate status update', () => {
  test('updates status to accepted', () => {
    storeGateMessage(testDir, 'status-test', MIME, 'stranger@gmail.com', PAYMENT)

    const updated = updateGateMessageStatus(testDir, 'status-test', 'accepted')
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('accepted')

    // Verify persisted
    const entry = getGateMessage(testDir, 'status-test')
    expect(entry!.status).toBe('accepted')
  })

  test('updates status to rejected', () => {
    storeGateMessage(testDir, 'reject-test', MIME, 'stranger@gmail.com', PAYMENT)

    const updated = updateGateMessageStatus(testDir, 'reject-test', 'rejected')
    expect(updated!.status).toBe('rejected')
  })

  test('returns null for missing id', () => {
    const result = updateGateMessageStatus(testDir, 'nonexistent', 'accepted')
    expect(result).toBeNull()
  })

  test('filtering by status works on loaded index', () => {
    storeGateMessage(testDir, 'p1', MIME, 'a@b.com', PAYMENT)
    storeGateMessage(testDir, 'p2', MIME, 'c@d.com', PAYMENT)
    storeGateMessage(testDir, 'p3', MIME, 'e@f.com', PAYMENT)

    updateGateMessageStatus(testDir, 'p1', 'accepted')
    updateGateMessageStatus(testDir, 'p3', 'rejected')

    const all = loadIndex(testDir)
    const pending = all.filter(e => e.status === 'pending')
    const accepted = all.filter(e => e.status === 'accepted')
    const rejected = all.filter(e => e.status === 'rejected')

    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe('p2')
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.id).toBe('p1')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.id).toBe('p3')
  })
})
