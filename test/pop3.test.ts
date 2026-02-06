import { test, expect, describe } from 'bun:test'
import { Pop3Session, type Pop3SessionConfig } from '../src/pop3/session.js'

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
    expect(session.getGreeting()).toMatch(/^\+OK.*POP3/)
  })
})

describe('POP3 authentication', () => {
  test('USER then PASS with valid username succeeds', () => {
    const session = createSession()
    const userResp = session.processLine('USER bob')
    expect(userResp).toBe('+OK\r\n')

    const passResp = session.processLine('PASS anything')
    expect(passResp).toMatch(/^\+OK 2 messages/)
  })

  test('wrong username is rejected', () => {
    const session = createSession()
    session.processLine('USER eve')
    const resp = session.processLine('PASS secret')
    expect(resp).toMatch(/^-ERR/)
  })

  test('PASS before USER is rejected', () => {
    const session = createSession()
    const resp = session.processLine('PASS secret')
    expect(resp).toMatch(/^-ERR/)
  })

  test('commands before auth are rejected', () => {
    const session = createSession()
    expect(session.processLine('STAT')).toMatch(/^-ERR/)
    expect(session.processLine('LIST')).toMatch(/^-ERR/)
    expect(session.processLine('RETR 1')).toMatch(/^-ERR/)
  })
})

describe('POP3 STAT', () => {
  test('returns message count and total size', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('STAT')
    expect(resp).toMatch(/^\+OK 2 \d+/)
  })
})

describe('POP3 LIST', () => {
  test('lists all messages', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('LIST')
    expect(resp).toContain('+OK 2 messages')
    expect(resp).toMatch(/^1 \d+$/m)
    expect(resp).toMatch(/^2 \d+$/m)
    expect(resp).toEndWith('.\r\n')
  })

  test('lists single message', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('LIST 1')
    expect(resp).toMatch(/^\+OK 1 \d+/)
  })

  test('rejects invalid message number', () => {
    const session = createSession()
    login(session)

    expect(session.processLine('LIST 99')).toMatch(/^-ERR/)
  })
})

describe('POP3 RETR', () => {
  test('retrieves message content', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('RETR 1')
    expect(resp).toContain('+OK')
    expect(resp).toContain('Subject: First message')
    expect(resp).toContain('Hello!')
    expect(resp).toEndWith('\r\n.\r\n')
  })

  test('rejects invalid message number', () => {
    const session = createSession()
    login(session)

    expect(session.processLine('RETR 0')).toMatch(/^-ERR/)
    expect(session.processLine('RETR 99')).toMatch(/^-ERR/)
  })
})

describe('POP3 DELE', () => {
  test('marks message as deleted', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('DELE 1')
    expect(resp).toMatch(/^\+OK/)

    // Deleted message no longer accessible
    expect(session.processLine('RETR 1')).toMatch(/^-ERR/)
    expect(session.processLine('LIST 1')).toMatch(/^-ERR/)

    // STAT reflects deletion
    const stat = session.processLine('STAT')
    expect(stat).toMatch(/^\+OK 1 /)
  })

  test('RSET undeletes messages', () => {
    const session = createSession()
    login(session)

    session.processLine('DELE 1')
    const resp = session.processLine('RSET')
    expect(resp).toMatch(/^\+OK 2 messages/)

    // Message is accessible again
    expect(session.processLine('RETR 1')).toContain('Hello!')
  })
})

describe('POP3 UIDL', () => {
  test('lists unique IDs for all messages', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('UIDL')
    expect(resp).toContain('msg-001')
    expect(resp).toContain('msg-002')
    expect(resp).toEndWith('.\r\n')
  })

  test('returns unique ID for single message', () => {
    const session = createSession()
    login(session)

    const resp = session.processLine('UIDL 1')
    expect(resp).toContain('msg-001')
  })
})

describe('POP3 QUIT', () => {
  test('commits deletions on QUIT', () => {
    const session = createSession()
    login(session)

    session.processLine('DELE 1')
    const resp = session.processLine('QUIT')
    expect(resp).toMatch(/^\+OK/)

    expect(deleted).toEqual(['msg-001'])
  })

  test('QUIT without deletions deletes nothing', () => {
    const session = createSession()
    login(session)

    session.processLine('QUIT')
    expect(deleted).toEqual([])
  })

  test('QUIT before auth is OK', () => {
    const session = createSession()
    const resp = session.processLine('QUIT')
    expect(resp).toMatch(/^\+OK/)
  })
})

describe('POP3 CAPA', () => {
  test('lists capabilities', () => {
    const session = createSession()
    const resp = session.processLine('CAPA')
    expect(resp).toContain('+OK')
    expect(resp).toContain('USER')
    expect(resp).toContain('UIDL')
  })
})

describe('POP3 edge cases', () => {
  test('unknown command returns error', () => {
    const session = createSession()
    login(session)

    expect(session.processLine('BOGUS')).toMatch(/^-ERR/)
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

    expect(session.processLine('STAT')).toBe('+OK 0 0\r\n')
    expect(session.processLine('LIST')).toContain('+OK 0 messages')
  })
})
