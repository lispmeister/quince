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
  handleSetStatus,
  handleIdentity,
  handleTransfers,
  handleMedia,
  handleListIntroductions,
  handleAcceptIntroduction,
  handleRejectIntroduction,
  handleSendIntroduction,
  handleAddPeer,
  handleListGateMessages,
  handleGetGateMessage,
  handleGetGateRawMessage,
  handleDeleteGateMessage,
  handleAcceptGateMessage,
  handleRejectGateMessage,
  guessContentType
} from '../src/http/handlers.js'

// Local types to avoid importing bare-fs modules
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

function makeGateEntry(id: string, overrides: Partial<GateEntry> = {}): GateEntry {
  return {
    id,
    file: `123-${id}.eml`,
    from: 'sender@example.com',
    to: 'recipient@quincemail.com',
    subject: 'Gate Test',
    receivedAt: 1700000000000,
    senderEmail: 'sender@example.com',
    payment: { method: 'lightning', amount: 100, currency: 'sats', invoiceId: `inv-${id}` },
    status: 'pending',
    ...overrides
  }
}

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
    sendMessage: async (_to, _subject, _body) => ({ id: 'new-msg-1', queued: false, messageId: '<new-msg-1@quincemail.com>' }),
    transport: {
      isPeerConnected: (pk: string) => pk === ALICE_PUBKEY,
      getConnectedPeers: () => [ALICE_PUBKEY],
      getPeerConnectionInfo: (pk: string) => pk === ALICE_PUBKEY ? {
        pubkey: ALICE_PUBKEY,
        connectedAt: 1700000000000,
        capabilities: { name: 'test-agent', version: '1.0' },
        lastMessageAt: 1700000001000,
        status: 'available' as const,
        statusMessage: undefined
      } : null,
      setStatus: () => {},
      sendIntroduction: () => {}
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
    getIntroductions: () => [],
    acceptIntroduction: (_pubkey: string) => null,
    rejectIntroduction: (_pubkey: string) => null,
    signIntroduction: (_introduced: Record<string, unknown>) => 'a'.repeat(128),
    addPeerToConfig: (_alias: string, _pubkey: string) => ({ success: true }),
    listGateMessages: () => [
      makeGateEntry('gate-1', { subject: 'Promo', status: 'pending' }),
      makeGateEntry('gate-2', { subject: 'Invoice', status: 'accepted', senderEmail: 'bank@example.com' }),
      makeGateEntry('gate-3', { subject: 'Spam', status: 'rejected' })
    ],
    getGateMessage: (id: string) => {
      const all = [
        makeGateEntry('gate-1', { subject: 'Promo', status: 'pending' }),
        makeGateEntry('gate-2', { subject: 'Invoice', status: 'accepted', senderEmail: 'bank@example.com' }),
        makeGateEntry('gate-3', { subject: 'Spam', status: 'rejected' })
      ]
      return all.find(e => e.id === id) ?? null
    },
    getGateMessageContent: (entry: GateEntry) => `From: ${entry.from}\r\nSubject: ${entry.subject}\r\n\r\nBody of ${entry.id}`,
    deleteGateMessage: (_entry: GateEntry) => {},
    updateGateMessageStatus: (_id: string, _status: string) => null,
    storeMessage: (_id: string, _mime: string, _senderPubkey: string, _signatureValid: boolean) => makeEntry(_id),
    addWhitelistRule: (_type: string, _value: string) => ({ id: 'wl-1', type: _type as any, value: _value, createdAt: Date.now() }),
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

// --- M12: in-reply-to filter ---

describe('handleListInbox in-reply-to filter', () => {
  test('filters by in-reply-to', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { 'in-reply-to': '<thread-1>' } }), {}, ctx)
    const data = JSON.parse(res.body)
    // Only msg-4 has inReplyTo=<thread-1>
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('msg-4')
  })

  test('returns empty when no matches', () => {
    const ctx = makeContext()
    const res = handleListInbox(makeRequest({ query: { 'in-reply-to': '<nonexistent>' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(0)
  })
})

// --- M12: handleSend returns messageId ---

describe('handleSend messageId', () => {
  test('returns messageId in response', async () => {
    const ctx = makeContext()
    const req = makeRequest({
      body: JSON.stringify({ to: `alice@${ALICE_PUBKEY}.quincemail.com`, subject: 'Hi', body: 'Hello' })
    })
    const res = await handleSend(req, {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messageId).toBe('<new-msg-1@quincemail.com>')
  })
})

// --- M13: Capabilities in peers response ---

describe('handleListPeers with capabilities', () => {
  test('includes capabilities for connected peers', () => {
    const ctx = makeContext()
    const res = handleListPeers(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    const alice = data.peers.find((p: any) => p.alias === 'alice')
    expect(alice.capabilities).toEqual({ name: 'test-agent', version: '1.0' })
    expect(alice.status).toBe('available')
  })

  test('returns null capabilities for offline peers', () => {
    const ctx = makeContext()
    const res = handleListPeers(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    const bob = data.peers.find((p: any) => p.alias === 'bob')
    expect(bob.capabilities).toBeNull()
    expect(bob.status).toBeNull()
  })
})

// --- M13: Peer status endpoint ---

describe('handlePeerStatus with extended info', () => {
  test('includes connectedSince, capabilities, status for connected peer', () => {
    const ctx = makeContext()
    const res = handlePeerStatus(makeRequest(), { pubkey: ALICE_PUBKEY }, ctx)
    const data = JSON.parse(res.body)
    expect(data.connectedSince).toBe(1700000000000)
    expect(data.lastMessageAt).toBe(1700000001000)
    expect(data.capabilities).toEqual({ name: 'test-agent', version: '1.0' })
    expect(data.status).toBe('available')
  })
})

// --- M13: Set status ---

describe('handleSetStatus', () => {
  test('accepts valid status', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({ status: 'busy', message: 'In a meeting' }) })
    const res = handleSetStatus(req, {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.status).toBe('busy')
    expect(data.message).toBe('In a meeting')
  })

  test('rejects invalid status', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({ status: 'invalid' }) })
    const res = handleSetStatus(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('rejects missing status', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({}) })
    const res = handleSetStatus(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('rejects invalid JSON', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: 'not json' })
    const res = handleSetStatus(req, {}, ctx)
    expect(res.status).toBe(400)
  })
})

// --- M13: Introductions ---

describe('handleListIntroductions', () => {
  test('returns empty list by default', () => {
    const ctx = makeContext()
    const res = handleListIntroductions(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.introductions).toEqual([])
  })

  test('returns introductions from context', () => {
    const ctx = makeContext({
      getIntroductions: () => [{
        pubkey: 'c'.repeat(64),
        alias: 'carol',
        introducerPubkey: ALICE_PUBKEY,
        introducerAlias: 'alice',
        signature: 'a'.repeat(128),
        receivedAt: 1700000000000,
        status: 'pending'
      }]
    })
    const res = handleListIntroductions(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.introductions).toHaveLength(1)
    expect(data.introductions[0].alias).toBe('carol')
  })
})

describe('handleAcceptIntroduction', () => {
  test('returns 404 when no pending introduction', () => {
    const ctx = makeContext()
    const res = handleAcceptIntroduction(makeRequest(), { pubkey: 'c'.repeat(64) }, ctx)
    expect(res.status).toBe(404)
  })

  test('returns accepted intro', () => {
    const intro = {
      pubkey: 'c'.repeat(64),
      alias: 'carol',
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: 1700000000000,
      status: 'accepted'
    }
    const ctx = makeContext({
      acceptIntroduction: (pk: string) => pk === 'c'.repeat(64) ? intro : null
    })
    const res = handleAcceptIntroduction(makeRequest(), { pubkey: 'c'.repeat(64) }, ctx)
    const data = JSON.parse(res.body)
    expect(data.accepted).toBe(true)
    expect(data.alias).toBe('carol')
  })
})

describe('handleRejectIntroduction', () => {
  test('returns 404 when no pending introduction', () => {
    const ctx = makeContext()
    const res = handleRejectIntroduction(makeRequest(), { pubkey: 'c'.repeat(64) }, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleSendIntroduction', () => {
  test('rejects invalid JSON', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: 'not json' })
    const res = handleSendIntroduction(req, { pubkey: ALICE_PUBKEY }, ctx)
    expect(res.status).toBe(400)
  })

  test('rejects missing pubkey', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({ alias: 'carol' }) })
    const res = handleSendIntroduction(req, { pubkey: ALICE_PUBKEY }, ctx)
    expect(res.status).toBe(400)
  })

  test('rejects invalid pubkey format', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({ pubkey: 'not-valid' }) })
    const res = handleSendIntroduction(req, { pubkey: ALICE_PUBKEY }, ctx)
    expect(res.status).toBe(400)
  })

  test('rejects when recipient not connected', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({ pubkey: 'c'.repeat(64) }) })
    // BOB_PUBKEY is not connected in mock
    const res = handleSendIntroduction(req, { pubkey: BOB_PUBKEY }, ctx)
    expect(res.status).toBe(422)
  })

  test('sends introduction to connected peer', () => {
    let sentIntro: any = null
    const ctx = makeContext({
      transport: {
        isPeerConnected: (pk: string) => pk === ALICE_PUBKEY,
        getConnectedPeers: () => [ALICE_PUBKEY],
        getPeerConnectionInfo: () => null,
        setStatus: () => {},
        sendIntroduction: (_pk: string, intro: any) => { sentIntro = intro }
      } as any
    })
    const req = makeRequest({
      body: JSON.stringify({ pubkey: 'c'.repeat(64), alias: 'carol', message: 'Meet Carol' })
    })
    const res = handleSendIntroduction(req, { pubkey: ALICE_PUBKEY }, ctx)
    const data = JSON.parse(res.body)
    expect(data.sent).toBe(true)
    expect(data.introduced.pubkey).toBe('c'.repeat(64))
    expect(data.introduced.alias).toBe('carol')
    expect(sentIntro).not.toBeNull()
    expect(sentIntro.type).toBe('INTRODUCTION')
  })
})

// --- M15: Add Peer ---

describe('handleAddPeer', () => {
  test('adds peer successfully', () => {
    let addedAlias = ''
    let addedPubkey = ''
    const ctx = makeContext({
      addPeerToConfig: (alias: string, pubkey: string) => {
        addedAlias = alias
        addedPubkey = pubkey
        return { success: true }
      }
    })
    const req = makeRequest({
      body: JSON.stringify({ alias: 'carol', pubkey: 'c'.repeat(64) })
    })
    const res = handleAddPeer(req, {}, ctx)
    const data = JSON.parse(res.body)
    expect(res.status).toBe(200)
    expect(data.added).toBe(true)
    expect(data.alias).toBe('carol')
    expect(data.pubkey).toBe('c'.repeat(64))
    expect(addedAlias).toBe('carol')
    expect(addedPubkey).toBe('c'.repeat(64))
  })

  test('returns 409 for duplicate alias', () => {
    const ctx = makeContext()
    const req = makeRequest({
      body: JSON.stringify({ alias: 'alice', pubkey: 'c'.repeat(64) })
    })
    const res = handleAddPeer(req, {}, ctx)
    expect(res.status).toBe(409)
  })

  test('returns 400 for invalid pubkey', () => {
    const ctx = makeContext()
    const req = makeRequest({
      body: JSON.stringify({ alias: 'carol', pubkey: 'not-valid' })
    })
    const res = handleAddPeer(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('returns 400 for missing fields', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: JSON.stringify({}) })
    const res = handleAddPeer(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid JSON', () => {
    const ctx = makeContext()
    const req = makeRequest({ body: 'not json' })
    const res = handleAddPeer(req, {}, ctx)
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid alias', () => {
    const ctx = makeContext()
    const req = makeRequest({
      body: JSON.stringify({ alias: 'bad alias!', pubkey: 'c'.repeat(64) })
    })
    const res = handleAddPeer(req, {}, ctx)
    expect(res.status).toBe(400)
  })
})

// --- Gate inbox ---

describe('handleListGateMessages', () => {
  test('returns all gate messages', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(3)
    expect(data.total).toBe(3)
  })

  test('filters by status=pending', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest({ query: { status: 'pending' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('gate-1')
  })

  test('filters by status=accepted', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest({ query: { status: 'accepted' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('gate-2')
  })

  test('filters by from (senderEmail)', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest({ query: { from: 'bank@example.com' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('gate-2')
  })

  test('filters by subject', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest({ query: { subject: 'promo' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('gate-1')
  })

  test('filters by q (full-text)', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest({ query: { q: 'invoice' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('gate-2')
  })

  test('pagination with offset and limit', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest({ query: { offset: '1', limit: '1' } }), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].id).toBe('gate-2')
    expect(data.total).toBe(3)
    expect(data.offset).toBe(1)
    expect(data.limit).toBe(1)
  })

  test('includes payment field in list response', () => {
    const ctx = makeContext()
    const res = handleListGateMessages(makeRequest(), {}, ctx)
    const data = JSON.parse(res.body)
    expect(data.messages[0].payment).toBeDefined()
    expect(data.messages[0].payment.method).toBe('lightning')
  })
})

describe('handleGetGateMessage', () => {
  test('returns gate message with body', () => {
    const ctx = makeContext()
    const res = handleGetGateMessage(makeRequest(), { id: 'gate-1' }, ctx)
    const data = JSON.parse(res.body)
    expect(data.id).toBe('gate-1')
    expect(data.body).toContain('Body of gate-1')
    expect(data.payment).toBeDefined()
    expect(data.status).toBe('pending')
  })

  test('returns 404 for unknown id', () => {
    const ctx = makeContext()
    const res = handleGetGateMessage(makeRequest(), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleGetGateRawMessage', () => {
  test('returns raw .eml with correct content-type', () => {
    const ctx = makeContext()
    const res = handleGetGateRawMessage(makeRequest(), { id: 'gate-1' }, ctx)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('message/rfc822')
    expect(res.body).toContain('Subject: Promo')
  })

  test('returns 404 for unknown id', () => {
    const ctx = makeContext()
    const res = handleGetGateRawMessage(makeRequest(), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleDeleteGateMessage', () => {
  test('deletes and returns confirmation', () => {
    let deletedId = ''
    const ctx = makeContext({
      deleteGateMessage: (entry: GateEntry) => { deletedId = entry.id }
    })
    const res = handleDeleteGateMessage(makeRequest(), { id: 'gate-1' }, ctx)
    const data = JSON.parse(res.body)
    expect(data.deleted).toBe(true)
    expect(data.id).toBe('gate-1')
    expect(deletedId).toBe('gate-1')
  })

  test('returns 404 for unknown id', () => {
    const ctx = makeContext()
    const res = handleDeleteGateMessage(makeRequest(), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

// --- Gate accept/reject ---

describe('handleAcceptGateMessage', () => {
  test('accepts pending message: status updated, sender whitelisted, message stored', () => {
    let updatedId = ''
    let updatedStatus = ''
    let storedId = ''
    let storedPubkey = ''
    let whitelistedValue = ''
    const ctx = makeContext({
      updateGateMessageStatus: (id: string, status: any) => {
        updatedId = id
        updatedStatus = status
        return makeGateEntry(id, { status })
      },
      storeMessage: (id: string, _mime: string, senderPubkey: string, _valid: boolean) => {
        storedId = id
        storedPubkey = senderPubkey
        return makeEntry(id)
      },
      addWhitelistRule: (_type: string, value: string) => {
        whitelistedValue = value
        return { id: 'wl-1', type: _type as any, value, createdAt: Date.now() }
      }
    })
    const res = handleAcceptGateMessage(makeRequest({ method: 'POST' }), { id: 'gate-1' }, ctx)
    const data = JSON.parse(res.body)
    expect(res.status).toBe(200)
    expect(data.accepted).toBe(true)
    expect(data.id).toBe('gate-1')
    expect(data.senderWhitelisted).toBe(true)
    expect(updatedId).toBe('gate-1')
    expect(updatedStatus).toBe('accepted')
    expect(storedId).toBe('gate-1')
    expect(storedPubkey).toBe('legacy-gateway')
    expect(whitelistedValue).toBe('sender@example.com')
  })

  test('returns 404 for unknown id', () => {
    const ctx = makeContext()
    const res = handleAcceptGateMessage(makeRequest({ method: 'POST' }), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})

describe('handleRejectGateMessage', () => {
  test('rejects message: status updated, sender NOT whitelisted', () => {
    let updatedId = ''
    let updatedStatus = ''
    let whitelistCalled = false
    const ctx = makeContext({
      updateGateMessageStatus: (id: string, status: any) => {
        updatedId = id
        updatedStatus = status
        return makeGateEntry(id, { status })
      },
      addWhitelistRule: (_type: string, _value: string) => {
        whitelistCalled = true
        return { id: 'wl-1', type: _type as any, value: _value, createdAt: Date.now() }
      }
    })
    const res = handleRejectGateMessage(makeRequest({ method: 'POST' }), { id: 'gate-1' }, ctx)
    const data = JSON.parse(res.body)
    expect(res.status).toBe(200)
    expect(data.rejected).toBe(true)
    expect(data.id).toBe('gate-1')
    expect(updatedId).toBe('gate-1')
    expect(updatedStatus).toBe('rejected')
    expect(whitelistCalled).toBe(false)
  })

  test('returns 404 for unknown id', () => {
    const ctx = makeContext()
    const res = handleRejectGateMessage(makeRequest({ method: 'POST' }), { id: 'nonexistent' }, ctx)
    expect(res.status).toBe(404)
  })
})
