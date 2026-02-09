import { test, expect, describe, beforeEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HttpRequest } from '../src/http/parser.js'
import type { HttpContext } from '../src/http/handlers.js'
import {
  handleListInbox,
  handleGetMessage,
  handleGetMessageRaw,
  handleDeleteMessage,
  handleSend,
  handleListPeers,
  handlePeerStatus,
  handleIdentity,
  handleTransfers,
  handleMedia,
  guessContentType
} from '../src/http/handlers.js'

// Local type to avoid importing inbox.ts (which pulls in bare-fs)
interface InboxEntry {
  id: string
  file: string
  from: string
  to: string
  subject: string
  senderPubkey: string
  signatureValid: boolean
  receivedAt: number
  contentType?: string
  messageType?: string
  messageId?: string
  inReplyTo?: string
  references?: string
}

const ALICE_PUBKEY = 'a'.repeat(64)
const BOB_PUBKEY = 'b'.repeat(64)

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    body: '',
    ...overrides
  }
}

function makeEntry(id: string, overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id,
    file: `123-${id}.eml`,
    from: `alice@${ALICE_PUBKEY}.quincemail.com`,
    to: `bob@${BOB_PUBKEY}.quincemail.com`,
    subject: 'Test Message',
    senderPubkey: ALICE_PUBKEY,
    signatureValid: true,
    receivedAt: 1700000000000,
    ...overrides
  }
}

let testMediaDir: string

function makeContext(overrides: Partial<HttpContext> = {}): HttpContext {
  const messages = [
    makeEntry('msg-1', { subject: 'Hello', receivedAt: 1700000000000 }),
    makeEntry('msg-2', { subject: 'World', senderPubkey: BOB_PUBKEY, from: `bob@${BOB_PUBKEY}.quincemail.com`, receivedAt: 1700000001000 }),
    makeEntry('msg-3', { subject: 'Threaded', messageType: 'chat', messageId: '<thread-1>', receivedAt: 1700000002000 }),
    makeEntry('msg-4', { subject: 'Reply', inReplyTo: '<thread-1>', receivedAt: 1700000003000 })
  ]

  return {
    identity: { publicKey: BOB_PUBKEY, secretKey: 'x'.repeat(128) },
    config: {
      peers: { alice: ALICE_PUBKEY, bob: BOB_PUBKEY }
    },
    username: 'bob',
    listMessages: () => messages,
    getMessage: (id: string) => messages.find(m => m.id === id) ?? null,
    getMessageContent: (entry: InboxEntry) => `From: test\r\nSubject: ${entry.subject}\r\n\r\nBody of ${entry.id}`,
    deleteMessage: (_entry: InboxEntry) => {},
    sendMessage: async (_to, _subject, _body) => ({ id: 'new-msg-1', queued: false }),
    transport: {
      isPeerConnected: (pk: string) => pk === ALICE_PUBKEY,
      getConnectedPeers: () => [ALICE_PUBKEY]
    } as any,
    transferManager: {} as any,
    getTransfers: () => [],
    readMediaFile: (relativePath: string) => {
      const fullPath = path.join(testMediaDir, relativePath)
      const resolved = path.resolve(fullPath)
      if (!resolved.startsWith(path.resolve(testMediaDir) + '/') && resolved !== path.resolve(testMediaDir)) {
        return null
      }
      try {
        if (!fs.existsSync(fullPath)) return null
        const content = fs.readFileSync(fullPath)
        return { content: Buffer.from(content), contentType: guessContentType(relativePath) }
      } catch {
        return null
      }
    },
    ...overrides
  }
}

beforeEach(() => {
  testMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-media-test-'))
})

// --- Inbox ---

describe('handleListInbox', () => {
  test('returns all messages', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(4)
    expect(data.total).toBe(4)
  })

  test('filters by from (pubkey)', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { from: BOB_PUBKEY } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('msg-2')
  })

  test('filters by after timestamp', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { after: '1700000001000' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(2)
  })

  test('filters by subject', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { subject: 'hello' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('msg-1')
  })

  test('filters by type', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { type: 'chat' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('msg-3')
  })

  test('filters by thread', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { thread: '<thread-1>' } }), {}, ctx)
    const data = JSON.parse(res.body)
    // msg-3 has messageId=<thread-1>, msg-4 has inReplyTo=<thread-1>
    expect(data.messages).toHaveLength(2)
  })

  test('filters by full-text q', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { q: 'msg-2' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('msg-2')
  })

  test('pagination with offset and limit', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { offset: '1', limit: '2' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(2)
    expect(data.messages[0].id).toBe('msg-2')
    expect(data.total).toBe(4)
    expect(data.offset).toBe(1)
    expect(data.limit).toBe(2)
  })
})

describe('handleGetMessage', () => {
  test('returns message with body', () => {
    const ctx = makeContext()
    const res = handleGetMessage(makeRequest(), { id: 'msg-1' }, ctx)
    const data = JSON.parse(res.body)
    expect(data.id).toBe('msg-1')
    expect(data.body).toContain('Body of msg-1')
  })

  test('returns 404 for unknown message', () => {
    const ctx = makeContext()
    const res = handleGetMessage(makeRequest(), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleGetMessageRaw', () => {
  test('returns raw .eml with correct content-type', () => {
    const ctx = makeContext()
    const res = handleGetMessageRaw(makeRequest(), { id: 'msg-1' }, ctx)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('message/rfc822')
    expect(res.body).toContain('Subject: Hello')
  })

  test('returns 404 for unknown message', () => {
    const ctx = makeContext()
    const res = handleGetMessageRaw(makeRequest(), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleDeleteMessage', () => {
  test('deletes and returns confirmation', () => {
    let deletedId = ''
    const ctx = makeContext({
      deleteMessage: (entry: InboxEntry) => { deletedId = entry.id }
    })
    const res = handleDeleteMessage(makeRequest(), { id: 'msg-1' }, ctx)
    const data = JSON.parse(res.body)
    expect(data.deleted).toBe(true)
    expect(data.id).toBe('msg-1')
    expect(deletedId).toBe('msg-1')
  })

  test('returns 404 for unknown message', () => {
    const ctx = makeContext()
    const res = handleDeleteMessage(makeRequest(), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

// --- Send ---

describe('handleSend', () => {
  test('sends message and returns id', async () => {
    const ctx = makeContext()
    const req = makeRequest({
      body: JSON.stringify({ to: `alice@${ALICE_PUBKEY}.quincemail.com`, subject: 'Hi', body: 'Hello' })
    })
    const res = await handleSend(req, {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.id).toBe('new-msg-1')
    expect(data.sent).toBe(true)
  })

  test('returns 400 for invalid JSON', async () => {
    const ctx = makeContext()
    const req = makeRequest({ body: 'not json' })
    const res = await handleSend(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('returns 400 for missing "to"', async () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({ subject: 'Hi', body: 'Hello' }) })
    const res = await handleSend(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('returns 202 when queued', async () => {
    const ctx = makeContext({
      sendMessage: async () => ({ id: 'q-1', queued: true })
    })
    const req = makeRequest({
      body: JSON.stringify({ to: `alice@${ALICE_PUBKEY}.quincemail.com`, subject: 'Hi', body: 'Hello' })
    })
    const res = await handleSend(req, {}, ctx)
    expect(res.status).toBe(202)
    const data = JSON.parse(res.body)
    expect(data.queued).toBe(true)
  })

  test('returns 422 for unknown peer', async () => {
    const ctx = makeContext({
      sendMessage: async () => { throw new Error('Unknown peer alias: nobody') }
    })
    const req = makeRequest({
      body: JSON.stringify({ to: 'x@nobody.quincemail.com', subject: 'Hi', body: 'Hello' })
    })
    const res = await handleSend(req, {}, ctx)
    expect(res.status).toBe(422)
  })
})

// --- Peers ---

describe('handleListPeers', () => {
  test('returns peer list with online status', () => {
    const ctx = makeContext()
    const res = handleListPeers(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.peers).toHaveLength(2)
    const alice = data.peers.find((p: any) => p.alias === 'alice')
    expect(alice.online).toBe(true)
    const bob = data.peers.find((p: any) => p.alias === 'bob')
    expect(bob.online).toBe(false)
  })
})

describe('handlePeerStatus', () => {
  test('returns status for known peer', () => {
    const ctx = makeContext()
    const res = handlePeerStatus(makeRequest(), { pubkey: ALICE_PUBKEY }, ctx)
    const data = JSON.parse(res.body)
    expect(data.alias).toBe('alice')
    expect(data.online).toBe(true)
  })

  test('returns 404 for unknown peer', () => {
    const ctx = makeContext()
    const res = handlePeerStatus(makeRequest(), { pubkey: 'c'.repeat(64) }, ctx)
    expect(res.status).toBe(404)
  })
})

// --- Identity ---

describe('handleIdentity', () => {
  test('returns pubkey, address, username', () => {
    const ctx = makeContext()
    const res = handleIdentity(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.publicKey).toBe(BOB_PUBKEY)
    expect(data.address).toContain('quincemail.com')
    expect(data.username).toBe('bob')
  })
})

// --- Transfers ---

describe('handleTransfers', () => {
  test('returns empty list when no transfers', () => {
    const ctx = makeContext()
    const res = handleTransfers(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.transfers).toEqual([])
  })

  test('returns transfer list', () => {
    const ctx = makeContext({
      getTransfers: () => [
        { id: 't-1', messageId: 'msg-1', peer: ALICE_PUBKEY, direction: 'receive', driveKey: 'xxx', files: [], state: 'complete', createdAt: 0, updatedAt: 0 }
      ] as any
    })
    const res = handleTransfers(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.transfers).toHaveLength(1)
  })
})

// --- Media ---

describe('handleMedia', () => {
  test('serves existing file', () => {
    fs.writeFileSync(path.join(testMediaDir, 'test.txt'), 'hello')
    const ctx = makeContext()
    const res = handleMedia(makeRequest(), { '*': 'test.txt' }, ctx)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain')
  })

  test('returns 404 for missing file', () => {
    const ctx = makeContext()
    const res = handleMedia(makeRequest(), { '*': 'missing.txt' }, ctx)
    expect(res.status).toBe(404)
  })

  test('returns 403 for path traversal', () => {
    const ctx = makeContext()
    const res = handleMedia(makeRequest(), { '*': '../etc/passwd' }, ctx)
    expect(res.status).toBe(403)
  })

  test('returns 403 for absolute path', () => {
    const ctx = makeContext()
    const res = handleMedia(makeRequest(), { '*': '/etc/passwd' }, ctx)
    expect(res.status).toBe(403)
  })

  test('serves file in subdirectory', () => {
    const subdir = path.join(testMediaDir, 'sub')
    fs.mkdirSync(subdir)
    fs.writeFileSync(path.join(subdir, 'photo.jpg'), 'jpegdata')
    const ctx = makeContext()
    const res = handleMedia(makeRequest(), { '*': 'sub/photo.jpg' }, ctx)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
  })
})
