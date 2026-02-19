import { test, describe } from 'node:test'
import assert from 'node:assert'
import { Pop3Session, type Pop3SessionConfig } from '../dist/pop3/session.js'

const MESSAGES = [
  {
    id: 'msg-001',
    file: '1700000000000-msg-001.eml',
    from: 'alice@alice.quincemail.com',
    to: 'bob@bob.quincemail.com',
    subject: 'First message',
    senderPubkey: 'aaaa'.repeat(16),
    signatureValid: true,
    receivedAt: 1700000000000
  },
  {
    id: 'msg-002',
    file: '1700000001000-msg-002.eml',
    from: 'alice@alice.quincemail.com',
    to: 'bob@bob.quincemail.com',
    subject: 'Second message',
    senderPubkey: 'aaaa'.repeat(16),
    signatureValid: true,
    receivedAt: 1700000001000
  }
]

const CONTENT: Record<string, string> = {
  'msg-001': 'From: alice@alice.quincemail.com\r\nTo: bob@bob.quincemail.com\r\nSubject: First message\r\n\r\nHello!',
  'msg-002': 'From: alice@alice.quincemail.com\r\nTo: bob@bob.quincemail.com\r\nSubject: Second message\r\n\r\nWorld!'
}

const deleted: string[] = []

function createSession(username = 'bob'): Pop3Session {
  deleted.length = 0
  return new Pop3Session({
    hostname: 'test.local',
    username,
    getMessages: () => [...MESSAGES],
    getMessageContent: (entry) => CONTENT[entry.id] ?? null,
    deleteMessage: (entry) => { deleted.push(entry.id) }
  })
}

function login(session: Pop3Session): void {
  session.processLine('USER bob')
  session.processLine('PASS secret')
}

describe('POP3 greeting', () => {
  test('sends +OK greeting', () => {
    const session = createSession()
    assert.ok(/^\+OK.*POP3/.test(session.getGreeting()))
  })
})

describe('POP3 authentication', () => {
  test('USER then PASS with valid username succeeds', () => {
    const session = createSession()
    const userResp = session.processLine('USER bob')
    assert.strictEqual(userResp, '+OK\r\n')

    const passResp = session.processLine('PASS anything')
    assert.ok(/^\+OK 2 messages/.test(passResp))
  })

  test('wrong username is rejected', () => {
    const session = createSession()
    session.processLine('USER eve')
    const resp = session.processLine('PASS secret')
    assert.ok(/^-ERR/.test(resp))
  })

  test('PASS before USER is rejected', () => {
    const session = createSession()
    const resp = session.processLine('PASS secret')
    assert.ok(/^-ERR/.test(resp))
  })

  test('commands before auth are rejected', () => {
    const session = createSession()
    assert.ok(/^-ERR/.test(session.processLine('STAT')))
    assert.ok(/^-ERR/.test(session.processLine('LIST')))
    assert.ok(/^-ERR/.test(session.processLine('RETR 1')))
  })
})

describe('POP3 STAT', () => {
  test('returns message count and total size', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('STAT')
    assert.ok(/^\+OK 2 \d+/.test(resp))
  })
})

describe('POP3 LIST', () => {
  test('lists all messages', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('LIST')
    assert.ok(resp.includes('+OK 2 messages'))
    assert.ok(/^1 \d+$/m.test(resp))
    assert.ok(/^2 \d+$/m.test(resp))
    assert.ok(resp.endsWith('.\r\n'))
  })

  test('lists single message', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('LIST 1')
    assert.ok(/^\+OK 1 \d+/.test(resp))
  })

  test('rejects invalid message number', () => {
    const session = createSession()
    login(session)

    assert.ok(/^-ERR/.test(session.processLine('LIST 99')))
  })
})

describe('POP3 RETR', () => {
  test('retrieves message content', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('RETR 1')
    assert.ok(resp.includes('+OK'))
    assert.ok(resp.includes('Subject: First message'))
    assert.ok(resp.includes('Hello!'))
    assert.ok(resp.endsWith('\r\n.\r\n'))
  })

  test('rejects invalid message number', () => {
    const session = createSession()
    login(session)

    assert.ok(/^-ERR/.test(session.processLine('RETR 0')))
    assert.ok(/^-ERR/.test(session.processLine('RETR 99')))
  })
})

describe('POP3 DELE', () => {
  test('marks message as deleted', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('DELE 1')
    assert.ok(/^\+OK/.test(resp))

    // Deleted message no longer accessible
    assert.ok(/^-ERR/.test(session.processLine('RETR 1')))
    assert.ok(/^-ERR/.test(session.processLine('LIST 1')))

    // STAT reflects deletion
    const stat = session.processLine('STAT')
    assert.ok(/^\+OK 1 /.test(stat))
  })

  test('RSET undeletes messages', () => {
    const session = createSession()
    login(session)

    session.processLine('DELE 1')
    const resp = session.processLine('RSET')
    assert.ok(/^\+OK 2 messages/.test(resp))

    // Message is accessible again
    assert.ok(session.processLine('RETR 1').includes('Hello!'))
  })
})

describe('POP3 UIDL', () => {
  test('lists unique IDs for all messages', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('UIDL')
    assert.ok(resp.includes('msg-001'))
    assert.ok(resp.includes('msg-002'))
    assert.ok(resp.endsWith('.\r\n'))
  })

  test('returns unique ID for single message', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('UIDL 1')
    assert.ok(resp.includes('msg-001'))
  })
})

describe('POP3 QUIT', () => {
  test('commits deletions on QUIT', () => {
    const session = createSession()
    login(session)

    session.processLine('DELE 1')
    const resp = session.processLine('QUIT')
    assert.ok(/^\+OK/.test(resp))

    assert.deepStrictEqual(deleted, ['msg-001'])
  })

  test('QUIT without deletions deletes nothing', () => {
    const session = createSession()
    login(session)

    session.processLine('QUIT')
    assert.deepStrictEqual(deleted, [])
  })

  test('QUIT before auth is OK', () => {
    const session = createSession()
    const resp = session.processLine('QUIT')
    assert.ok(/^\+OK/.test(resp))
  })
})

describe('POP3 CAPA', () => {
  test('lists capabilities', () => {
    const session = createSession()
    const resp = session.processLine('CAPA')
    assert.ok(resp.includes('+OK'))
    assert.ok(resp.includes('USER'))
    assert.ok(resp.includes('UIDL'))
  })
})

describe('POP3 edge cases', () => {
  test('unknown command returns error', () => {
    const session = createSession()
    login(session)

    assert.ok(/^-ERR/.test(session.processLine('BOGUS')))
  })

  test('empty inbox works', () => {
    const session = new Pop3Session({
      hostname: 'test.local',
      username: 'bob',
      getMessages: () => [],
      getMessageContent: () => null,
      deleteMessage: () => {}
    })

    session.processLine('USER bob')
    session.processLine('PASS x')

    assert.strictEqual(session.processLine('STAT'), '+OK 0 0\r\n')
    assert.ok(session.processLine('LIST').includes('+OK 0 messages'))
  })
})
