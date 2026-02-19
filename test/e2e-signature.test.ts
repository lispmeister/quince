import { test, describe } from 'node:test'
import assert from 'node:assert'
import crypto from 'hypercore-crypto'
import { signMessage, verifyMessage } from '../dist/crypto.js'
import { SmtpSession } from '../dist/smtp/session.js'

function makeKeyPair() {
  const kp = (crypto as any).keyPair()
  return {
    publicKey: kp.publicKey.toString('hex'),
    secretKey: kp.secretKey.toString('hex')
  }
}

const ALICE = makeKeyPair()
const BOB = makeKeyPair()

/**
 * Simulate the full send path: MUA → SMTP session → sign → encode → decode → verify
 * This mirrors the flow in index.ts without requiring Hyperswarm.
 */
function simulateSend(
  from: string,
  to: string,
  dataLines: string[],
  senderSecretKey: string
): Promise<{ signedMime: string; encodedMime: string }> {
  return new Promise((resolve) => {
    const session = new SmtpSession({
      hostname: 'test.local',
      localUser: 'alice',
      onMessage: async (smtpFrom, smtpTo, data) => {
        // Same construction as index.ts
        const fullMessage = `From: ${smtpFrom}\r\nTo: ${smtpTo}\r\n${data}`
        const signed = signMessage(fullMessage, senderSecretKey)
        const encoded = Buffer.from(signed, 'utf8').toString('base64')
        resolve({ signedMime: signed, encodedMime: encoded })
      }
    })

    session.processLine('EHLO client.test')
    session.processLine(`MAIL FROM:<${from}>`)
    session.processLine(`RCPT TO:<${to}>`)
    session.processLine('DATA')
    for (const line of dataLines) {
      session.processLine(line)
    }
    session.processLine('.')
  })
}

function simulateReceive(encodedMime: string, senderPubkey: string): { mime: string; valid: boolean } {
  const raw = Buffer.from(encodedMime, 'base64').toString('utf8')
  return verifyMessage(raw, senderPubkey)
}

describe('end-to-end: Alice sends to Bob', () => {
  const fromAddr = `alice@${ALICE.publicKey}.quincemail.com`
  const toAddr = `bob@${BOB.publicKey}.quincemail.com`
  const bodyLines = ['Subject: Hello Bob', '', 'This is a secret message.']

  test('valid signature: Bob verifies message signed by Alice', async () => {
    const { encodedMime } = await simulateSend(fromAddr, toAddr, bodyLines, ALICE.secretKey)

    // Bob receives and verifies using Alice's public key
    const { mime, valid } = simulateReceive(encodedMime, ALICE.publicKey)

    assert.strictEqual(valid, true)
    assert.ok(mime.includes('From: ' + fromAddr))
    assert.ok(mime.includes('Subject: Hello Bob'))
    assert.ok(mime.includes('This is a secret message.'))
    assert.ok(mime.includes('X-Quince-Signature'))
  })

  test('invalid signature: Bob rejects message verified against wrong key', async () => {
    const { encodedMime } = await simulateSend(fromAddr, toAddr, bodyLines, ALICE.secretKey)

    // Bob mistakenly verifies against his own key (or an impersonator scenario)
    const { valid } = simulateReceive(encodedMime, BOB.publicKey)

    assert.strictEqual(valid, false)
  })

  test('invalid signature: tampered message detected', async () => {
    const { signedMime } = await simulateSend(fromAddr, toAddr, bodyLines, ALICE.secretKey)

    // Attacker modifies the body after signing
    const tampered = signedMime.replace('secret message', 'tampered message')
    const encoded = Buffer.from(tampered, 'utf8').toString('base64')

    const { valid } = simulateReceive(encoded, ALICE.publicKey)

    assert.strictEqual(valid, false)
  })

  test('round-trip preserves original message content', async () => {
    const { encodedMime } = await simulateSend(fromAddr, toAddr, bodyLines, ALICE.secretKey)
    const { mime } = simulateReceive(encodedMime, ALICE.publicKey)

    // The verified MIME should have the signature preserved and content intact
    const sepIndex = mime.indexOf('\r\n\r\n')
    assert.ok(sepIndex > 0)

    const headers = mime.slice(0, sepIndex)
    const body = mime.slice(sepIndex + 4)

    assert.ok(headers.includes('From: ' + fromAddr))
    assert.ok(headers.includes('To: ' + toAddr))
    assert.ok(headers.includes('Subject: Hello Bob'))
    assert.strictEqual(body, 'This is a secret message.')
  })
})
