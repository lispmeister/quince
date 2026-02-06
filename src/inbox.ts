import fs from 'bare-fs'
import path from 'bare-path'
import { getConfigDir, ensureConfigDir } from './config.js'

export interface InboxEntry {
  id: string
  file: string
  from: string
  to: string
  subject: string
  senderPubkey: string
  signatureValid: boolean
  receivedAt: number
}

const INBOX_DIR_NAME = 'inbox'
const INDEX_FILE = 'index.json'

function getInboxDir(): string {
  return path.join(getConfigDir(), INBOX_DIR_NAME)
}

function getIndexPath(): string {
  return path.join(getInboxDir(), INDEX_FILE)
}

function ensureInboxDir(): void {
  ensureConfigDir()
  const dir = getInboxDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function loadIndex(): InboxEntry[] {
  const indexPath = getIndexPath()
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf8') as string
      return JSON.parse(content)
    }
  } catch (err) {
    console.error('Failed to load inbox index:', err)
  }
  return []
}

function saveIndex(entries: InboxEntry[]): void {
  const indexPath = getIndexPath()
  try {
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2))
  } catch (err) {
    console.error('Failed to save inbox index:', err)
  }
}

export function storeMessage(
  id: string,
  mime: string,
  senderPubkey: string,
  signatureValid: boolean
): InboxEntry {
  ensureInboxDir()

  const receivedAt = Date.now()
  const filename = `${receivedAt}-${id}.eml`
  const filepath = path.join(getInboxDir(), filename)

  // Write .eml file
  fs.writeFileSync(filepath, mime)

  // Extract metadata from headers
  const entry: InboxEntry = {
    id,
    file: filename,
    from: extractHeader(mime, 'From'),
    to: extractHeader(mime, 'To'),
    subject: extractHeader(mime, 'Subject'),
    senderPubkey,
    signatureValid,
    receivedAt
  }

  // Append to index
  const index = loadIndex()
  index.push(entry)
  saveIndex(index)

  return entry
}

export function listMessages(): InboxEntry[] {
  return loadIndex()
}

export function getMessageContent(entry: InboxEntry): string | null {
  const filepath = path.join(getInboxDir(), entry.file)
  try {
    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath, 'utf8') as string
    }
  } catch (err) {
    console.error(`Failed to read message ${entry.file}:`, err)
  }
  return null
}

export function deleteMessage(entry: InboxEntry): void {
  const filepath = path.join(getInboxDir(), entry.file)

  // Remove .eml file
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
    }
  } catch (err) {
    console.error(`Failed to delete message file ${entry.file}:`, err)
  }

  // Remove from index
  const index = loadIndex()
  const filtered = index.filter(e => e.id !== entry.id)
  saveIndex(filtered)
}

export function getInboxPath(): string {
  return getInboxDir()
}
