import { test, describe } from 'node:test'
import assert from 'node:assert'
import type {
  PeerPacket,
  PeerMessage,
  PeerAck,
  PeerIdentify,
  PeerStatus,
  PeerIntroduction,
  PeerFileOffer,
  PeerFileRequest,
  PeerFileComplete,
  PeerCapabilities,
} from '../dist/transport/types.js'

// These tests validate packet construction, required-field presence, and
// JSON round-trip behaviour.  No network or Hyperswarm code is involved.

const PUBKEY = 'c'.repeat(64)
const PUBKEY_B = 'd'.repeat(64)
const MSG_ID = 'deadbeef-1234-5678-abcd-000000000001'
const MIME_B64 = Buffer.from('From: alice\r\n\r\nHello').toString('base64')

// ── Helpers ───────────────────────────────────────────────────────────────────

function roundTrip<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T
}

// Simple runtime field validator — mirrors what a real parser would assert.
function hasRequiredFields(obj: Record<string, unknown>, fields: string[]): boolean {
  return fields.every(f => f in obj && obj[f] !== undefined && obj[f] !== null)
}

// ── MESSAGE ───────────────────────────────────────────────────────────────────

describe('PeerMessage', () => {
  const valid: PeerMessage = { type: 'MESSAGE', id: MSG_ID, from: PUBKEY, mime: MIME_B64 }

  test('valid MESSAGE has correct type literal', () => {
    assert.strictEqual(valid.type, 'MESSAGE')
  })

  test('valid MESSAGE has id, from, mime', () => {
    assert.strictEqual(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'id', 'from', 'mime']), true)
  })

  test('JSON round-trip preserves all fields', () => {
    const rt = roundTrip(valid)
    assert.strictEqual(rt.type, 'MESSAGE')
    assert.strictEqual(rt.id, MSG_ID)
    assert.strictEqual(rt.from, PUBKEY)
    assert.strictEqual(rt.mime, MIME_B64)
  })

  test('missing id fails field check', () => {
    const bad = { type: 'MESSAGE', from: PUBKEY, mime: MIME_B64 }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id', 'from', 'mime']), false)
  })

  test('missing from fails field check', () => {
    const bad = { type: 'MESSAGE', id: MSG_ID, mime: MIME_B64 }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id', 'from', 'mime']), false)
  })

  test('missing mime fails field check', () => {
    const bad = { type: 'MESSAGE', id: MSG_ID, from: PUBKEY }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id', 'from', 'mime']), false)
  })
})

// ── ACK ───────────────────────────────────────────────────────────────────────

describe('PeerAck', () => {
  const valid: PeerAck = { type: 'ACK', id: MSG_ID }

  test('valid ACK has correct type literal', () => {
    assert.strictEqual(valid.type, 'ACK')
  })

  test('valid ACK has id field', () => {
    assert.strictEqual(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'id']), true)
  })

  test('JSON round-trip preserves all fields', () => {
    const rt = roundTrip(valid)
    assert.strictEqual(rt.type, 'ACK')
    assert.strictEqual(rt.id, MSG_ID)
  })

  test('missing id fails field check', () => {
    const bad = { type: 'ACK' }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id']), false)
  })
})

// ── IDENTIFY ──────────────────────────────────────────────────────────────────

describe('PeerIdentify', () => {
  const minimal: PeerIdentify = { type: 'IDENTIFY', publicKey: PUBKEY }

  const withCaps: PeerIdentify = {
    type: 'IDENTIFY',
    publicKey: PUBKEY,
    capabilities: {
      name: 'quince',
      version: '1.0.0',
      accepts: ['text/plain', 'text/html'],
      maxFileSize: 10_000_000,
    },
  }

  test('valid IDENTIFY has correct type literal', () => {
    assert.strictEqual(minimal.type, 'IDENTIFY')
  })

  test('valid IDENTIFY has publicKey', () => {
    assert.strictEqual(hasRequiredFields(minimal as unknown as Record<string, unknown>, ['type', 'publicKey']), true)
  })

  test('JSON round-trip (minimal)', () => {
    const rt = roundTrip(minimal)
    assert.strictEqual(rt.type, 'IDENTIFY')
    assert.strictEqual(rt.publicKey, PUBKEY)
    assert.strictEqual(rt.capabilities, undefined)
  })

  test('JSON round-trip with capabilities', () => {
    const rt = roundTrip(withCaps)
    assert.strictEqual(rt.capabilities!.name, 'quince')
    assert.strictEqual(rt.capabilities!.version, '1.0.0')
    assert.deepStrictEqual(rt.capabilities!.accepts, ['text/plain', 'text/html'])
    assert.strictEqual(rt.capabilities!.maxFileSize, 10_000_000)
  })

  test('capabilities fields are all optional', () => {
    const minimal_caps: PeerCapabilities = {}
    const pkt: PeerIdentify = { type: 'IDENTIFY', publicKey: PUBKEY, capabilities: minimal_caps }
    const rt = roundTrip(pkt)
    assert.deepStrictEqual(rt.capabilities, {})
  })

  test('missing publicKey fails field check', () => {
    const bad = { type: 'IDENTIFY' }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'publicKey']), false)
  })
})

// ── STATUS ────────────────────────────────────────────────────────────────────

describe('PeerStatus', () => {
  const statuses: Array<'available' | 'busy' | 'away'> = ['available', 'busy', 'away']

  for (const status of statuses) {
    test(`valid STATUS with status="${status}"`, () => {
      const pkt: PeerStatus = { type: 'STATUS', status }
      assert.strictEqual(pkt.type, 'STATUS')
      assert.strictEqual(pkt.status, status)
    })

    test(`JSON round-trip for STATUS "${status}"`, () => {
      const pkt: PeerStatus = { type: 'STATUS', status, message: 'In a meeting' }
      const rt = roundTrip(pkt)
      assert.strictEqual(rt.type, 'STATUS')
      assert.strictEqual(rt.status, status)
      assert.strictEqual(rt.message, 'In a meeting')
    })
  }

  test('optional message field survives round-trip when absent', () => {
    const pkt: PeerStatus = { type: 'STATUS', status: 'available' }
    const rt = roundTrip(pkt)
    assert.strictEqual(rt.message, undefined)
  })

  test('status field rejects invalid value at runtime guard level', () => {
    // TypeScript won't allow other strings, but we test the value constraint
    const validStatuses = ['available', 'busy', 'away']
    const bad = { type: 'STATUS', status: 'online' }
    assert.strictEqual(validStatuses.includes((bad as Record<string, string>).status), false)
  })

  test('missing status fails field check', () => {
    const bad = { type: 'STATUS' }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'status']), false)
  })
})

// ── INTRODUCTION ──────────────────────────────────────────────────────────────

describe('PeerIntroduction', () => {
  const valid: PeerIntroduction = {
    type: 'INTRODUCTION',
    introduced: {
      pubkey: PUBKEY_B,
      alias: 'bob',
      capabilities: { name: 'quince' },
      message: 'You should talk to Bob',
    },
    signature: 'aabb'.repeat(32),  // fake 128-char hex signature
  }

  test('valid INTRODUCTION has correct type literal', () => {
    assert.strictEqual(valid.type, 'INTRODUCTION')
  })

  test('valid INTRODUCTION has required fields', () => {
    assert.strictEqual(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'introduced', 'signature']), true)
  })

  test('introduced sub-object has pubkey', () => {
    assert.strictEqual(hasRequiredFields(valid.introduced as unknown as Record<string, unknown>, ['pubkey']), true)
  })

  test('JSON round-trip preserves all fields', () => {
    const rt = roundTrip(valid)
    assert.strictEqual(rt.type, 'INTRODUCTION')
    assert.strictEqual(rt.introduced.pubkey, PUBKEY_B)
    assert.strictEqual(rt.introduced.alias, 'bob')
    assert.strictEqual(rt.introduced.capabilities!.name, 'quince')
    assert.strictEqual(rt.introduced.message, 'You should talk to Bob')
    assert.strictEqual(rt.signature, 'aabb'.repeat(32))
  })

  test('missing signature fails field check', () => {
    const bad = { type: 'INTRODUCTION', introduced: { pubkey: PUBKEY_B } }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'introduced', 'signature']), false)
  })

  test('missing introduced fails field check', () => {
    const bad = { type: 'INTRODUCTION', signature: 'aabb'.repeat(32) }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'introduced', 'signature']), false)
  })

  test('introduced optional fields (alias, capabilities, message) survive omission', () => {
    const minimal: PeerIntroduction = {
      type: 'INTRODUCTION',
      introduced: { pubkey: PUBKEY_B },
      signature: 'cc'.repeat(64),
    }
    const rt = roundTrip(minimal)
    assert.strictEqual(rt.introduced.alias, undefined)
    assert.strictEqual(rt.introduced.capabilities, undefined)
    assert.strictEqual(rt.introduced.message, undefined)
  })
})

// ── FILE_OFFER ────────────────────────────────────────────────────────────────

describe('PeerFileOffer', () => {
  const valid: PeerFileOffer = {
    type: 'FILE_OFFER',
    messageId: MSG_ID,
    driveKey: 'e'.repeat(64),
    files: [
      { name: 'photo.jpg', path: `${MSG_ID}/photo.jpg`, size: 204800, hash: 'f'.repeat(64) },
    ],
  }

  test('valid FILE_OFFER has correct type literal', () => {
    assert.strictEqual(valid.type, 'FILE_OFFER')
  })

  test('valid FILE_OFFER has required fields', () => {
    assert.strictEqual(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'messageId', 'driveKey', 'files']), true)
  })

  test('JSON round-trip preserves files array', () => {
    const rt = roundTrip(valid)
    assert.strictEqual(rt.files.length, 1)
    assert.strictEqual(rt.files[0]!.name, 'photo.jpg')
    assert.strictEqual(rt.files[0]!.size, 204800)
    assert.strictEqual(rt.files[0]!.hash, 'f'.repeat(64))
  })

  test('files array can contain multiple entries', () => {
    const multi: PeerFileOffer = {
      ...valid,
      files: [
        { name: 'a.jpg', path: `${MSG_ID}/a.jpg`, size: 1000, hash: '1'.repeat(64) },
        { name: 'b.png', path: `${MSG_ID}/b.png`, size: 2000, hash: '2'.repeat(64) },
      ],
    }
    const rt = roundTrip(multi)
    assert.strictEqual(rt.files.length, 2)
  })

  test('missing driveKey fails field check', () => {
    const bad = { type: 'FILE_OFFER', messageId: MSG_ID, files: [] }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'messageId', 'driveKey', 'files']), false)
  })
})

// ── FILE_REQUEST ──────────────────────────────────────────────────────────────

describe('PeerFileRequest', () => {
  const valid: PeerFileRequest = {
    type: 'FILE_REQUEST',
    messageId: MSG_ID,
    files: [{ name: 'photo.jpg' }],
  }

  test('valid FILE_REQUEST has correct type literal', () => {
    assert.strictEqual(valid.type, 'FILE_REQUEST')
  })

  test('JSON round-trip', () => {
    const rt = roundTrip(valid)
    assert.strictEqual(rt.type, 'FILE_REQUEST')
    assert.strictEqual(rt.messageId, MSG_ID)
    assert.strictEqual(rt.files[0]!.name, 'photo.jpg')
  })

  test('missing messageId fails field check', () => {
    const bad = { type: 'FILE_REQUEST', files: [] }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'messageId', 'files']), false)
  })
})

// ── FILE_COMPLETE ─────────────────────────────────────────────────────────────

describe('PeerFileComplete', () => {
  const valid: PeerFileComplete = { type: 'FILE_COMPLETE', messageId: MSG_ID }

  test('valid FILE_COMPLETE has correct type literal', () => {
    assert.strictEqual(valid.type, 'FILE_COMPLETE')
  })

  test('JSON round-trip', () => {
    const rt = roundTrip(valid)
    assert.strictEqual(rt.type, 'FILE_COMPLETE')
    assert.strictEqual(rt.messageId, MSG_ID)
  })

  test('missing messageId fails field check', () => {
    const bad = { type: 'FILE_COMPLETE' }
    assert.strictEqual(hasRequiredFields(bad as Record<string, unknown>, ['type', 'messageId']), false)
  })
})

// ── PeerPacket union ──────────────────────────────────────────────────────────

describe('PeerPacket union', () => {
  const packets: PeerPacket[] = [
    { type: 'MESSAGE', id: MSG_ID, from: PUBKEY, mime: MIME_B64 },
    { type: 'ACK', id: MSG_ID },
    { type: 'IDENTIFY', publicKey: PUBKEY },
    { type: 'STATUS', status: 'available' },
    { type: 'INTRODUCTION', introduced: { pubkey: PUBKEY_B }, signature: 'aa'.repeat(64) },
    { type: 'FILE_OFFER', messageId: MSG_ID, driveKey: 'e'.repeat(64), files: [] },
    { type: 'FILE_REQUEST', messageId: MSG_ID, files: [{ name: 'x.jpg' }] },
    { type: 'FILE_COMPLETE', messageId: MSG_ID },
  ]

  test('all 8 packet types are representable in the union', () => {
    assert.strictEqual(packets.length, 8)
  })

  test('every packet survives JSON round-trip with type preserved', () => {
    for (const pkt of packets) {
      const rt = roundTrip(pkt)
      assert.strictEqual(rt.type, pkt.type)
    }
  })

  test('type field is the discriminant for all union members', () => {
    const types = packets.map(p => p.type)
    const unique = new Set(types)
    assert.strictEqual(unique.size, packets.length)
  })
})
