import { test, describe } from 'node:test'
import assert from 'node:assert'
import crypto from 'hypercore-crypto'
import { signMessage, verifyMessage, signIntroduction, verifyIntroduction } from '../dist/crypto.js'

function makeKeyPair() {
  const kp = (crypto as any).keyPair()
  return {
    publicKey: kp.publicKey.toString('hex'),
    secretKey: kp.secretKey.toString('hex')
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

    assert.ok(signed.includes('X-Quince-Signature:'))
  })

  test('preserves the message body', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)

    const body = signed.split('\r\n\r\n').slice(1).join('\r\n\r\n')
    assert.strictEqual(body, 'Hello, Bob!')
  })

  test('passes through malformed MIME without separator', () => {
    const alice = makeKeyPair()
    const malformed = 'No separator here'
    const result = signMessage(malformed, alice.secretKey)

    // Should return unchanged — no crash, no signature
    assert.strictEqual(result, malformed)
    assert.ok(!result.includes('X-Quince-Signature'))
  })
})

describe('verifyMessage', () => {
  test('valid signature returns valid=true', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)
    const { mime, valid } = verifyMessage(signed, alice.publicKey)

    assert.strictEqual(valid, true)
    assert.strictEqual(mime, signed)
  })

  test('wrong pubkey returns valid=false', () => {
    const alice = makeKeyPair()
    const bob = makeKeyPair()

    const signed = signMessage(VALID_MIME, alice.secretKey)
    const { valid } = verifyMessage(signed, bob.publicKey)

    assert.strictEqual(valid, false)
  })

  test('tampered body returns valid=false', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)

    // Tamper with the body
    const tampered = signed.replace('Hello, Bob!', 'Hello, Eve!')
    const { valid } = verifyMessage(tampered, alice.publicKey)

    assert.strictEqual(valid, false)
  })

  test('missing signature header returns valid=false', () => {
    const alice = makeKeyPair()
    const { valid } = verifyMessage(VALID_MIME, alice.publicKey)

    assert.strictEqual(valid, false)
  })

  test('malformed signature hex returns valid=false', () => {
    const alice = makeKeyPair()
    const forged = VALID_MIME.replace(
      '\r\n\r\n',
      '\r\nX-Quince-Signature: not-valid-hex\r\n\r\n'
    )
    const { valid } = verifyMessage(forged, alice.publicKey)

    assert.strictEqual(valid, false)
  })

  test('preserves signature header in returned MIME', () => {
    const alice = makeKeyPair()
    const signed = signMessage(VALID_MIME, alice.secretKey)
    const { mime } = verifyMessage(signed, alice.publicKey)

    assert.ok(mime.includes('X-Quince-Signature'))
    assert.strictEqual(mime, signed)
  })
})

describe('signIntroduction', () => {
  test('produces 128-char hex signature', () => {
    const alice = makeKeyPair()
    const introduced = { pubkey: 'b'.repeat(64), alias: 'bob' }
    const sig = signIntroduction(introduced, alice.secretKey)
    assert.ok(/^[a-f0-9]{128}$/.test(sig))
  })
})

describe('verifyIntroduction', () => {
  test('valid signature returns true', () => {
    const alice = makeKeyPair()
    const introduced = { pubkey: 'b'.repeat(64), alias: 'bob' }
    const sig = signIntroduction(introduced, alice.secretKey)
    const valid = verifyIntroduction(introduced, sig, alice.publicKey)
    assert.strictEqual(valid, true)
  })

  test('wrong key returns false', () => {
    const alice = makeKeyPair()
    const bob = makeKeyPair()
    const introduced = { pubkey: 'c'.repeat(64), alias: 'carol' }
    const sig = signIntroduction(introduced, alice.secretKey)
    const valid = verifyIntroduction(introduced, sig, bob.publicKey)
    assert.strictEqual(valid, false)
  })

  test('tampered data returns false', () => {
    const alice = makeKeyPair()
    const introduced = { pubkey: 'b'.repeat(64), alias: 'bob' }
    const sig = signIntroduction(introduced, alice.secretKey)
    const tampered = { pubkey: 'c'.repeat(64), alias: 'bob' }
    const valid = verifyIntroduction(tampered, sig, alice.publicKey)
    assert.strictEqual(valid, false)
  })

  test('malformed signature returns false', () => {
    const alice = makeKeyPair()
    const introduced = { pubkey: 'b'.repeat(64) }
    const valid = verifyIntroduction(introduced, 'not-valid-hex', alice.publicKey)
    assert.strictEqual(valid, false)
  })
})
