import { test, expect, describe } from 'bun:test'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { signMessage, verifyMessage } from '../src/crypto.js'

function makeKeyPair() {
  const kp = (crypto as any).keyPair()
  return {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex')
  }
}

const VALID_MIME = [
  'From: alice@alice.quincemail.com',
  'To: bob@bob.quincemail.com',
  'Subject: Test',
  '',
  'Hello, Bob!'
].join('\r\n')

describe('signMessage', () => {
  test('injects X-Quince-Signature header', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)

    expect(signed).toContain('X-Quince-Signature:')
  })

  test('preserves the message body', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)

    const body = signed.split('\r\n\r\n').slice(1).join('\r\n\r\n')
    expect(body).toBe('Hello, Bob!')
  })

  test('passes through malformed MIME without separator', () => {
    const alice = makeKeyPair()
    const malformed = 'No separator here'
    const result = signMessage(malformed, alice.secretKey)

    // Should return unchanged — no crash, no signature
    expect(result).toBe(malformed)
    expect(result).not.toContain('X-Quince-Signature')
  })
})

describe('verifyMessage', () => {
  test('valid signature returns valid=true', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)
    const { mime, valid } = verifyMessage(signed, alice.publicKey)

    expect(valid).toBe(true)
    expect(mime).toBe(signed)
  })

  test('wrong pubkey returns valid=false', () => {
    const alice = makeKeyPair()
    const bob = makeKeyPair()

    const signed = signMessage(VALID_MIME, alice.secretKey)
    const { valid } = verifyMessage(signed, bob.publicKey)

    expect(valid).toBe(false)
  })

  test('tampered body returns valid=false', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)

    // Tamper with the body
    const tampered = signed.replace('Hello, Bob!', 'Hello, Eve!')
    const { valid } = verifyMessage(tampered, alice.publicKey)

    expect(valid).toBe(false)
  })

  test('missing signature header returns valid=false', () => {
    const alice = makeKeyPair()
    const { valid } = verifyMessage(VALID_MIME, alice.publicKey)

    expect(valid).toBe(false)
  })

  test('malformed signature hex returns valid=false', () => {
    const alice = makeKeyPair()
    const forged = VALID_MIME.replace(
      '\r\n\r\n',
      '\r\nX-Quince-Signature: not-valid-hex\r\n\r\n'
    )
    const { valid } = verifyMessage(forged, alice.publicKey)

    expect(valid).toBe(false)
  })

  test('preserves signature header in returned MIME', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)
    const { mime } = verifyMessage(signed, alice.publicKey)

    expect(mime).toContain('X-Quince-Signature')
    expect(mime).toBe(signed)
  })
})
