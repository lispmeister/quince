import { test, describe } from 'node:test'
import assert from 'node:assert'
import { SmtpSession } from '../dist/smtp/session.js'

function createSession(onMessage: (from: string, to: string, data: string) => Promise<void>) {
  return new SmtpSession({
    hostname: 'test.local',
    localUser: 'testuser',
    onMessage
  })
}

function runSmtpTransaction(session: SmtpSession, from: string, to: string, bodyLines: string[]): void {
  session.processLine('EHLO client.test')
  session.processLine(`MAIL FROM:<${from}>`)
  session.processLine(`RCPT TO:<${to}>`)
  session.processLine('DATA')
  for (const line of bodyLines) {
    session.processLine(line)
  }
  session.processLine('.')
}

describe('SMTP DATA separator', () => {
  test('data lines are joined with CRLF', async () => {
    let captured = ''

    const session = createSession(async (_from, _to, data) => {
      captured = data
    })

    runSmtpTransaction(
      session,
      'alice@alice.quincemail.com',
      'bob@bob.quincemail.com',
      ['Subject: Hello', '', 'Body text']
    )

    // Wait for async onMessage
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.ok(captured.includes('\r\n'))
    assert.ok(!/[^\r]\n/.test(captured))  // no bare \n without preceding \r
  })

  test('full message has CRLF header/body separator', async () => {
    let captured = ''

    const session = createSession(async (from, to, data) => {
      // Reconstruct the same way index.ts does
      captured = `From: ${from}\r\nTo: ${to}\r\n${data}`
    })

    runSmtpTransaction(
      session,
      'alice@alice.quincemail.com',
      'bob@bob.quincemail.com',
      ['Subject: Hello', '', 'Body text']
    )

    await new Promise(resolve => setTimeout(resolve, 10))

    // The header/body separator must be \r\n\r\n
    assert.ok(captured.includes('\r\n\r\n'))

    const sepIndex = captured.indexOf('\r\n\r\n')
    const headers = captured.slice(0, sepIndex)
    const body = captured.slice(sepIndex + 4)

    assert.ok(headers.includes('From: alice@alice.quincemail.com'))
    assert.ok(headers.includes('Subject: Hello'))
    assert.strictEqual(body, 'Body text')
  })

  test('malformed message without blank line has no CRLF separator', async () => {
    let captured = ''

    const session = createSession(async (from, to, data) => {
      captured = `From: ${from}\r\nTo: ${to}\r\n${data}`
    })

    // No blank line between headers and body — data is just a body with no extra headers
    runSmtpTransaction(
      session,
      'alice@alice.quincemail.com',
      'bob@bob.quincemail.com',
      ['Just a body line with no header separator']
    )

    await new Promise(resolve => setTimeout(resolve, 10))

    // Without a blank line in the DATA section, the message has no \r\n\r\n separator
    // (From + To headers run straight into the data content)
    // This is a malformed MIME message — crypto.ts should handle it gracefully
    const hasSeparator = captured.includes('\r\n\r\n')
    assert.strictEqual(hasSeparator, false)
  })
})

describe('SMTP EHLO extensions', () => {
  test('EHLO advertises SIZE and 8BITMIME', () => {
    const session = createSession(async () => {})
    const resp = session.processLine('EHLO client.test')

    assert.ok(resp.includes('250-'))
    assert.ok(resp.includes('SIZE'))
    assert.ok(resp.includes('8BITMIME'))
  })

  test('HELO does not advertise extensions', () => {
    const session = createSession(async () => {})
    const resp = session.processLine('HELO client.test')

    assert.ok(!resp.includes('SIZE'))
    assert.ok(!resp.includes('8BITMIME'))
  })
})
