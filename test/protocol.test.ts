import { test, expect, describe } from 'bun:test'
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
} from '../src/transport/types.js'

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
    expect(valid.type).toBe('MESSAGE')
  })

  test('valid MESSAGE has id, from, mime', () => {
    expect(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'id', 'from', 'mime'])).toBe(true)
  })

  test('JSON round-trip preserves all fields', () => {
    const rt = roundTrip(valid)
    expect(rt.type).toBe('MESSAGE')
    expect(rt.id).toBe(MSG_ID)
    expect(rt.from).toBe(PUBKEY)
    expect(rt.mime).toBe(MIME_B64)
  })

  test('missing id fails field check', () => {
    const bad = { type: 'MESSAGE', from: PUBKEY, mime: MIME_B64 }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id', 'from', 'mime'])).toBe(false)
  })

  test('missing from fails field check', () => {
    const bad = { type: 'MESSAGE', id: MSG_ID, mime: MIME_B64 }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id', 'from', 'mime'])).toBe(false)
  })

  test('missing mime fails field check', () => {
    const bad = { type: 'MESSAGE', id: MSG_ID, from: PUBKEY }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id', 'from', 'mime'])).toBe(false)
  })
})

// ── ACK ───────────────────────────────────────────────────────────────────────

describe('PeerAck', () => {
  const valid: PeerAck = { type: 'ACK', id: MSG_ID }

  test('valid ACK has correct type literal', () => {
    expect(valid.type).toBe('ACK')
  })

  test('valid ACK has id field', () => {
    expect(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'id'])).toBe(true)
  })

  test('JSON round-trip preserves all fields', () => {
    const rt = roundTrip(valid)
    expect(rt.type).toBe('ACK')
    expect(rt.id).toBe(MSG_ID)
  })

  test('missing id fails field check', () => {
    const bad = { type: 'ACK' }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'id'])).toBe(false)
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
    expect(minimal.type).toBe('IDENTIFY')
  })

  test('valid IDENTIFY has publicKey', () => {
    expect(hasRequiredFields(minimal as unknown as Record<string, unknown>, ['type', 'publicKey'])).toBe(true)
  })

  test('JSON round-trip (minimal)', () => {
    const rt = roundTrip(minimal)
    expect(rt.type).toBe('IDENTIFY')
    expect(rt.publicKey).toBe(PUBKEY)
    expect(rt.capabilities).toBeUndefined()
  })

  test('JSON round-trip with capabilities', () => {
    const rt = roundTrip(withCaps)
    expect(rt.capabilities!.name).toBe('quince')
    expect(rt.capabilities!.version).toBe('1.0.0')
    expect(rt.capabilities!.accepts).toEqual(['text/plain', 'text/html'])
    expect(rt.capabilities!.maxFileSize).toBe(10_000_000)
  })

  test('capabilities fields are all optional', () => {
    const minimal_caps: PeerCapabilities = {}
    const pkt: PeerIdentify = { type: 'IDENTIFY', publicKey: PUBKEY, capabilities: minimal_caps }
    const rt = roundTrip(pkt)
    expect(rt.capabilities).toEqual({})
  })

  test('missing publicKey fails field check', () => {
    const bad = { type: 'IDENTIFY' }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'publicKey'])).toBe(false)
  })
})

// ── STATUS ────────────────────────────────────────────────────────────────────

describe('PeerStatus', () => {
  const statuses: Array<'available' | 'busy' | 'away'> = ['available', 'busy', 'away']

  for (const status of statuses) {
    test(`valid STATUS with status="${status}"`, () => {
      const pkt: PeerStatus = { type: 'STATUS', status }
      expect(pkt.type).toBe('STATUS')
      expect(pkt.status).toBe(status)
    })

    test(`JSON round-trip for STATUS "${status}"`, () => {
      const pkt: PeerStatus = { type: 'STATUS', status, message: 'In a meeting' }
      const rt = roundTrip(pkt)
      expect(rt.type).toBe('STATUS')
      expect(rt.status).toBe(status)
      expect(rt.message).toBe('In a meeting')
    })
  }

  test('optional message field survives round-trip when absent', () => {
    const pkt: PeerStatus = { type: 'STATUS', status: 'available' }
    const rt = roundTrip(pkt)
    expect(rt.message).toBeUndefined()
  })

  test('status field rejects invalid value at runtime guard level', () => {
    // TypeScript won't allow other strings, but we test the value constraint
    const validStatuses = ['available', 'busy', 'away']
    const bad = { type: 'STATUS', status: 'online' }
    expect(validStatuses.includes((bad as Record<string, string>).status)).toBe(false)
  })

  test('missing status fails field check', () => {
    const bad = { type: 'STATUS' }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'status'])).toBe(false)
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
    expect(valid.type).toBe('INTRODUCTION')
  })

  test('valid INTRODUCTION has required fields', () => {
    expect(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'introduced', 'signature'])).toBe(true)
  })

  test('introduced sub-object has pubkey', () => {
    expect(hasRequiredFields(valid.introduced as unknown as Record<string, unknown>, ['pubkey'])).toBe(true)
  })

  test('JSON round-trip preserves all fields', () => {
    const rt = roundTrip(valid)
    expect(rt.type).toBe('INTRODUCTION')
    expect(rt.introduced.pubkey).toBe(PUBKEY_B)
    expect(rt.introduced.alias).toBe('bob')
    expect(rt.introduced.capabilities!.name).toBe('quince')
    expect(rt.introduced.message).toBe('You should talk to Bob')
    expect(rt.signature).toBe('aabb'.repeat(32))
  })

  test('missing signature fails field check', () => {
    const bad = { type: 'INTRODUCTION', introduced: { pubkey: PUBKEY_B } }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'introduced', 'signature'])).toBe(false)
  })

  test('missing introduced fails field check', () => {
    const bad = { type: 'INTRODUCTION', signature: 'aabb'.repeat(32) }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'introduced', 'signature'])).toBe(false)
  })

  test('introduced optional fields (alias, capabilities, message) survive omission', () => {
    const minimal: PeerIntroduction = {
      type: 'INTRODUCTION',
      introduced: { pubkey: PUBKEY_B },
      signature: 'cc'.repeat(64),
    }
    const rt = roundTrip(minimal)
    expect(rt.introduced.alias).toBeUndefined()
    expect(rt.introduced.capabilities).toBeUndefined()
    expect(rt.introduced.message).toBeUndefined()
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
    expect(valid.type).toBe('FILE_OFFER')
  })

  test('valid FILE_OFFER has required fields', () => {
    expect(hasRequiredFields(valid as unknown as Record<string, unknown>, ['type', 'messageId', 'driveKey', 'files'])).toBe(true)
  })

  test('JSON round-trip preserves files array', () => {
    const rt = roundTrip(valid)
    expect(rt.files).toHaveLength(1)
    expect(rt.files[0]!.name).toBe('photo.jpg')
    expect(rt.files[0]!.size).toBe(204800)
    expect(rt.files[0]!.hash).toBe('f'.repeat(64))
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
    expect(rt.files).toHaveLength(2)
  })

  test('missing driveKey fails field check', () => {
    const bad = { type: 'FILE_OFFER', messageId: MSG_ID, files: [] }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'messageId', 'driveKey', 'files'])).toBe(false)
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
    expect(valid.type).toBe('FILE_REQUEST')
  })

  test('JSON round-trip', () => {
    const rt = roundTrip(valid)
    expect(rt.type).toBe('FILE_REQUEST')
    expect(rt.messageId).toBe(MSG_ID)
    expect(rt.files[0]!.name).toBe('photo.jpg')
  })

  test('missing messageId fails field check', () => {
    const bad = { type: 'FILE_REQUEST', files: [] }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'messageId', 'files'])).toBe(false)
  })
})

// ── FILE_COMPLETE ─────────────────────────────────────────────────────────────

describe('PeerFileComplete', () => {
  const valid: PeerFileComplete = { type: 'FILE_COMPLETE', messageId: MSG_ID }

  test('valid FILE_COMPLETE has correct type literal', () => {
    expect(valid.type).toBe('FILE_COMPLETE')
  })

  test('JSON round-trip', () => {
    const rt = roundTrip(valid)
    expect(rt.type).toBe('FILE_COMPLETE')
    expect(rt.messageId).toBe(MSG_ID)
  })

  test('missing messageId fails field check', () => {
    const bad = { type: 'FILE_COMPLETE' }
    expect(hasRequiredFields(bad as Record<string, unknown>, ['type', 'messageId'])).toBe(false)
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
    expect(packets).toHaveLength(8)
  })

  test('every packet survives JSON round-trip with type preserved', () => {
    for (const pkt of packets) {
      const rt = roundTrip(pkt)
      expect(rt.type).toBe(pkt.type)
    }
  })

  test('type field is the discriminant for all union members', () => {
    const types = packets.map(p => p.type)
    const unique = new Set(types)
    expect(unique.size).toBe(packets.length)
  })
})
