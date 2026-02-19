import fs from 'bare-fs'
import path from 'bare-path'
import { getConfigDir, ensureConfigDir } from './config.js'

export interface GatePayment {
  method: string       // 'lightning' | 'stripe'
  amount: number
  currency: string     // 'sats' | 'usd'
  invoiceId: string
}

export interface GateEntry {
  id: string
  file: string
  from: string
  to: string
  subject: string
  receivedAt: number
  contentType?: string
  messageId?: string
  senderEmail: string
  payment: GatePayment
  status: 'pending' | 'accepted' | 'rejected'
}

const GATE_DIR_NAME = 'gate'
const INDEX_FILE = 'index.json'

function getGateDir(): string {
  return path.join(getConfigDir(), GATE_DIR_NAME)
}

function getIndexPath(): string {
  return path.join(getGateDir(), INDEX_FILE)
}

function ensureGateDir(): void {
  ensureConfigDir()
  const dir = getGateDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function loadIndex(): GateEntry[] {
  const indexPath = getIndexPath()
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf8') as string
      return JSON.parse(content)
    }
  } catch (err) {
    console.error('Failed to load gate index:', err)
  }
  return []
}

function saveIndex(entries: GateEntry[]): void {
  const indexPath = getIndexPath()
  try {
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2))
  } catch (err) {
    console.error('Failed to save gate index:', err)
  }
}

export function storeGateMessage(
  id: string,
  mime: string,
  senderEmail: string,
  payment: GatePayment
): GateEntry {
  ensureGateDir()

  const receivedAt = Date.now()
  const filename = `${receivedAt}-${id}.eml`
  const filepath = path.join(getGateDir(), filename)

  // Write .eml file
  fs.writeFileSync(filepath, mime)

  // Extract metadata from headers
  const entry: GateEntry = {
    id,
    file: filename,
    from: extractHeader(mime, 'From'),
    to: extractHeader(mime, 'To'),
    subject: extractHeader(mime, 'Subject'),
    receivedAt,
    senderEmail,
    payment,
    status: 'pending'
  }

  // Extract optional headers (only set if present)
  const contentType = extractHeader(mime, 'Content-Type')
  if (contentType) entry.contentType = contentType
  const messageId = extractHeader(mime, 'Message-ID')
  if (messageId) entry.messageId = messageId

  // Append to index
  const index = loadIndex()
  index.push(entry)
  saveIndex(index)

  return entry
}

export function listGateMessages(): GateEntry[] {
  return loadIndex()
}

export function getGateMessage(id: string): GateEntry | null {
  const index = loadIndex()
  return index.find(e => e.id === id) ?? null
}

export function getGateMessageContent(entry: GateEntry): string | null {
  const filepath = path.join(getGateDir(), entry.file)
  try {
    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath, 'utf8') as string
    }
  } catch (err) {
    console.error(`Failed to read gate message ${entry.file}:`, err)
  }
  return null
}

export function deleteGateMessage(entry: GateEntry): void {
  const filepath = path.join(getGateDir(), entry.file)

  // Remove .eml file
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
    }
  } catch (err) {
    console.error(`Failed to delete gate message file ${entry.file}:`, err)
  }

  // Remove from index
  const index = loadIndex()
  const filtered = index.filter(e => e.id !== entry.id)
  saveIndex(filtered)
}

export function updateGateMessageStatus(id: string, status: 'pending' | 'accepted' | 'rejected'): GateEntry | null {
  const index = loadIndex()
  const entry = index.find(e => e.id === id)
  if (!entry) return null
  entry.status = status
  saveIndex(index)
  return entry
}

export function getGatePath(): string {
  return getGateDir()
}
