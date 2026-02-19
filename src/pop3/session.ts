import fs from 'fs'
import path from 'path'
import type { InboxEntry } from '../inbox.js'

export interface Pop3SessionConfig {
  hostname: string
  username: string
  getMessages: () => InboxEntry[]
  getMessageContent: (entry: InboxEntry) => string | null
  deleteMessage: (entry: InboxEntry) => void
}

type Pop3State = 'AUTHORIZATION' | 'TRANSACTION' | 'UPDATE'

interface MessageSlot {
  entry: InboxEntry
  size: number
  deleted: boolean
}

export class Pop3Session {
  private state: Pop3State = 'AUTHORIZATION'
  private config: Pop3SessionConfig
  private userProvided: string | null = null
  private messages: MessageSlot[] = []

  constructor(config: Pop3SessionConfig) {
    this.config = config
  }

  getGreeting(): string {
    return `+OK ${this.config.hostname} quince POP3 server ready\r\n`
  }

  processLine(line: string): string {
    const trimmed = line.trim()
    if (!trimmed) return ''

    const spaceIdx = trimmed.indexOf(' ')
    const command = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toUpperCase()
    const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

    switch (command) {
      case 'USER': return this.handleUser(arg)
      case 'PASS': return this.handlePass(arg)
      case 'STAT': return this.handleStat()
      case 'LIST': return this.handleList(arg)
      case 'RETR': return this.handleRetr(arg)
      case 'DELE': return this.handleDele(arg)
      case 'NOOP': return this.handleNoop()
      case 'RSET': return this.handleRset()
      case 'UIDL': return this.handleUidl(arg)
      case 'QUIT': return this.handleQuit()
      case 'CAPA': return this.handleCapa()
      default:
        return '-ERR unknown command\r\n'
    }
  }

  private handleUser(arg: string): string {
    if (this.state !== 'AUTHORIZATION') {
      return '-ERR already authenticated\r\n'
    }
    if (!arg) {
      return '-ERR missing username\r\n'
    }
    this.userProvided = arg
    return '+OK\r\n'
  }

  private handlePass(arg: string): string {
    if (this.state !== 'AUTHORIZATION') {
      return '-ERR already authenticated\r\n'
    }
    if (!this.userProvided) {
      return '-ERR send USER first\r\n'
    }
    if (this.userProvided !== this.config.username) {
      this.userProvided = null
      return '-ERR invalid credentials\r\n'
    }

    // Accept any password for localhost
    this.state = 'TRANSACTION'
    this.loadMaildrop()
    return `+OK ${this.messages.length} messages\r\n`
  }

  private handleStat(): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }
    const { count, size } = this.getStats()
    return `+OK ${count} ${size}\r\n`
  }

  private handleList(arg: string): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }

    if (arg) {
      const num = parseInt(arg, 10)
      const slot = this.getSlot(num)
      if (!slot) return `-ERR no such message\r\n`
      return `+OK ${num} ${slot.size}\r\n`
    }

    const { count, size } = this.getStats()
    let response = `+OK ${count} messages (${size} octets)\r\n`
    for (let i = 0; i < this.messages.length; i++) {
      const slot = this.messages[i]!
      if (!slot.deleted) {
        response += `${i + 1} ${slot.size}\r\n`
      }
    }
    response += '.\r\n'
    return response
  }

  private handleRetr(arg: string): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }
    const num = parseInt(arg, 10)
    const slot = this.getSlot(num)
    if (!slot) return '-ERR no such message\r\n'

    const content = this.config.getMessageContent(slot.entry)
    if (!content) return '-ERR message not found on disk\r\n'

    // Byte-stuff lines starting with '.'
    const stuffed = content.replace(/^\.(.)/gm, '..$1')
    return `+OK ${slot.size} octets\r\n${stuffed}\r\n.\r\n`
  }

  private handleDele(arg: string): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }
    const num = parseInt(arg, 10)
    const slot = this.getSlot(num)
    if (!slot) return '-ERR no such message\r\n'

    slot.deleted = true
    return `+OK message ${num} deleted\r\n`
  }

  private handleNoop(): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }
    return '+OK\r\n'
  }

  private handleRset(): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }
    for (const slot of this.messages) {
      slot.deleted = false
    }
    const { count, size } = this.getStats()
    return `+OK ${count} messages (${size} octets)\r\n`
  }

  private handleUidl(arg: string): string {
    if (this.state !== 'TRANSACTION') {
      return '-ERR not authenticated\r\n'
    }

    if (arg) {
      const num = parseInt(arg, 10)
      const slot = this.getSlot(num)
      if (!slot) return '-ERR no such message\r\n'
      return `+OK ${num} ${slot.entry.id}\r\n`
    }

    let response = '+OK\r\n'
    for (let i = 0; i < this.messages.length; i++) {
      const slot = this.messages[i]!
      if (!slot.deleted) {
        response += `${i + 1} ${slot.entry.id}\r\n`
      }
    }
    response += '.\r\n'
    return response
  }

  private handleQuit(): string {
    if (this.state === 'TRANSACTION') {
      // Commit deletions
      this.state = 'UPDATE'
      for (const slot of this.messages) {
        if (slot.deleted) {
          this.config.deleteMessage(slot.entry)
        }
      }
    }
    return `+OK ${this.config.hostname} signing off\r\n`
  }

  private handleCapa(): string {
    let response = '+OK capability list follows\r\n'
    response += 'USER\r\n'
    response += 'UIDL\r\n'
    response += '.\r\n'
    return response
  }

  isQuit(line: string): boolean {
    return line.trim().toUpperCase() === 'QUIT'
  }

  private loadMaildrop(): void {
    const entries = this.config.getMessages()
    this.messages = entries.map(entry => {
      const content = this.config.getMessageContent(entry)
      return {
        entry,
        size: content ? Buffer.byteLength(content, 'utf8') : 0,
        deleted: false
      }
    })
  }

  private getSlot(num: number): MessageSlot | null {
    if (num < 1 || num > this.messages.length) return null
    const slot = this.messages[num - 1]!
    if (slot.deleted) return null
    return slot
  }

  private getStats(): { count: number; size: number } {
    let count = 0
    let size = 0
    for (const slot of this.messages) {
      if (!slot.deleted) {
        count++
        size += slot.size
      }
    }
    return { count, size }
  }
}
