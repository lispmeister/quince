import type { SmtpState, SmtpTransaction } from './types.js'
import { parseCommand, parseMailFrom, parseRcptTo, parseAddress } from './parser.js'

export interface SmtpSessionConfig {
  hostname: string
  localUser: string
  onMessage: (from: string, to: string, data: string) => Promise<void>
}

export class SmtpSession {
  private state: SmtpState = 'GREETING'
  private transaction: SmtpTransaction = { from: null, to: null, data: null }
  private dataBuffer: string[] = []
  private config: SmtpSessionConfig

  constructor(config: SmtpSessionConfig) {
    this.config = config
  }

  getGreeting(): string {
    return `220 ${this.config.hostname} ESMTP quince\r\n`
  }

  processLine(line: string): string {
    // In DATA state, collect message body
    if (this.state === 'DATA') {
      return this.processDataLine(line)
    }

    const cmd = parseCommand(line)
    if (!cmd) {
      return '500 Command unrecognized\r\n'
    }

    switch (cmd.command) {
      case 'HELO':
        return this.handleHelo(cmd.argument)
      case 'EHLO':
        return this.handleEhlo(cmd.argument)
      case 'MAIL':
        return this.handleMail(cmd.argument)
      case 'RCPT':
        return this.handleRcpt(cmd.argument)
      case 'DATA':
        return this.handleData()
      case 'RSET':
        return this.handleRset()
      case 'NOOP':
        return '250 OK\r\n'
      case 'QUIT':
        return `221 ${this.config.hostname} closing connection\r\n`
      default:
        return '500 Command unrecognized\r\n'
    }
  }

  private handleHelo(arg: string): string {
    if (!arg) {
      return '501 Syntax: HELO hostname\r\n'
    }
    this.state = 'READY'
    this.resetTransaction()
    return `250 ${this.config.hostname}\r\n`
  }

  private handleEhlo(arg: string): string {
    if (!arg) {
      return '501 Syntax: EHLO hostname\r\n'
    }
    this.state = 'READY'
    this.resetTransaction()
    // No extensions for MVP
    return `250 ${this.config.hostname}\r\n`
  }

  private handleMail(arg: string): string {
    if (this.state === 'GREETING') {
      return '503 Error: send HELO/EHLO first\r\n'
    }

    const from = parseMailFrom(arg)
    if (from === null) {
      return '501 Syntax: MAIL FROM:<address>\r\n'
    }

    this.resetTransaction()
    this.transaction.from = from
    this.state = 'MAIL'
    return '250 OK\r\n'
  }

  private handleRcpt(arg: string): string {
    if (this.state !== 'MAIL' && this.state !== 'RCPT') {
      return '503 Error: need MAIL command first\r\n'
    }

    const to = parseRcptTo(arg)
    if (to === null) {
      return '501 Syntax: RCPT TO:<address>\r\n'
    }

    // Parse and validate the address format
    const parsed = parseAddress(to)
    if (!parsed) {
      return '550 Invalid address format (expected user@<subdomain>.quincemail.com)\r\n'
    }

    // For outbound mail, we accept any valid quincemail.com address
    // The pubkey/alias in the subdomain determines where to route the message

    this.transaction.to = to
    this.state = 'RCPT'
    return '250 OK\r\n'
  }

  private handleData(): string {
    if (this.state !== 'RCPT') {
      return '503 Error: need RCPT command first\r\n'
    }
    this.state = 'DATA'
    this.dataBuffer = []
    return '354 Start mail input; end with <CRLF>.<CRLF>\r\n'
  }

  private processDataLine(line: string): string {
    // Check for end of data marker
    if (line === '.' || line === '.\r' || line === '.\n' || line === '.\r\n') {
      return this.finishData()
    }

    // Handle dot-stuffing (lines starting with . have the dot removed)
    const content = line.startsWith('..') ? line.slice(1) : line
    this.dataBuffer.push(content)
    return '' // No response until data is complete
  }

  private finishData(): string {
    const data = this.dataBuffer.join('\r\n')
    this.transaction.data = data

    // Trigger message delivery (async, but we respond immediately for MVP)
    const from = this.transaction.from ?? ''
    const to = this.transaction.to ?? ''

    this.config.onMessage(from, to, data).catch((err) => {
      console.error('Message delivery failed:', err)
    })

    this.state = 'READY'
    this.resetTransaction()
    return '250 OK: message queued\r\n'
  }

  private handleRset(): string {
    this.resetTransaction()
    if (this.state !== 'GREETING') {
      this.state = 'READY'
    }
    return '250 OK\r\n'
  }

  private resetTransaction(): void {
    this.transaction = { from: null, to: null, data: null }
    this.dataBuffer = []
  }

  isQuit(line: string): boolean {
    const cmd = parseCommand(line)
    return cmd?.command === 'QUIT'
  }
}
