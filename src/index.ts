import process from 'process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { SmtpServer } from './smtp/index.js'
import { Transport } from './transport/index.js'
import type { PeerMessage } from './transport/index.js'
import { generateId, encodeBase64, decodeBase64 } from './utils.js'
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  addPeer,
  removePeer,
  getPeerPubkey,
  getPeerAlias,
  validateAlias
} from './config.js'
import { MessageQueue, type QueuedMessage } from './queue/index.js'
import {
  loadIdentity,
  getIdentityPath,
  getPublicKeyPath,
  getEmailAddress,
  parseEmailDomain,
  validatePublicKey,
  checkIdentityPermissions,
  EMAIL_DOMAIN
} from './identity.js'
import { signMessage, verifyMessage, signIntroduction, verifyIntroduction } from './crypto.js'
import { storeMessage, listMessages, getMessage, getMessageContent, deleteMessage, getInboxPath } from './inbox.js'
import { listGateMessages, getGateMessage, getGateMessageContent, deleteGateMessage, updateGateMessageStatus } from './gate.js'
import { loadRules, addRule, updateRule, removeRule, reorderRules } from './gate-rules.js'
import { addWhitelistRule } from './whitelist.js'
import { Pop3Server } from './pop3/index.js'
import { HttpServer } from './http/index.js'
import type { HttpContext } from './http/index.js'
import { FileTransferManager } from './transfer/index.js'
import type { PeerFileOffer, PeerFileRequest, PeerFileComplete } from './transport/index.js'
import type { PendingMessage } from './transfer/index.js'
import { parseFileRefs, validateFileRefs, transformFileRefs, transformFileRefsFailed, ensureMediaDirs, getMediaDir } from './media.js'
import {
  loadIntroductions,
  addIntroduction,
  getPendingIntroductions,
  getIntroduction,
  acceptIntroduction as acceptIntro,
  rejectIntroduction as rejectIntro,
  type StoredIntroduction
} from './introductions.js'
import type { PeerIntroduction, PeerStatus } from './transport/index.js'
import { guessContentType } from './http/handlers.js'
import { lookupUsername } from './directory.js'

let config = loadConfig()
const identity = loadIdentity()

const PORT = parseInt(process.env.SMTP_PORT ?? String(config.smtpPort ?? 2525), 10)
const POP3_PORT = parseInt(process.env.POP3_PORT ?? String(config.pop3Port ?? 1110), 10)
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? String(config.httpPort ?? 2580), 10)
const BIND_ADDR = process.env.BIND_ADDR ?? '127.0.0.1'
const HOSTNAME = process.env.HOSTNAME ?? 'quince.local'
const LOCAL_USER = process.env.LOCAL_USER ?? config.username ?? 'user'

function printUsage(): void {
  const emailAddr = getEmailAddress(LOCAL_USER, identity.publicKey)
  console.log(`
quince - Decentralized SMTP over Pear network

Usage:
  quince <command> [options]

Commands:
  start                         Start the daemon
  init                          Initialize identity and config (no daemon)
  identity                      Show your identity and email address
  peers                         List configured peers
  add-peer <alias> <pubkey>     Add a peer with friendly alias
  remove-peer <alias>           Remove a peer
  config                        Show current configuration
  inbox                         List received messages
  queue                         Show queued messages
  queue clear                   Clear all queued messages
  transfers                     Show file transfers
  transfers --all               Show all transfers (including completed)
  introductions                 List pending introductions
  accept-introduction <pubkey>  Accept a pending introduction
  help                          Show this help message

Environment Variables:
  SMTP_PORT    SMTP server port (default: 2525)
  POP3_PORT    POP3 server port (default: 1110)
  HTTP_PORT    HTTP API port (default: 2580)
  BIND_ADDR    Bind address (default: 127.0.0.1)
  HOSTNAME     Server hostname (default: quince.local)
  LOCAL_USER   Local username (default: user)

Your email: ${emailAddr}
Config: ${getConfigPath()}
`)
}

async function showIdentity(): Promise<void> {
  const emailAddr = getEmailAddress(LOCAL_USER, identity.publicKey)
  console.log('Your quince identity:')
  console.log('')
  console.log(`  Email address: ${emailAddr}`)
  console.log('')
  console.log(`  Public key: ${identity.publicKey}`)
  console.log(`  Private key: ${getIdentityPath()}`)
  console.log(`  Public key file: ${getPublicKeyPath()}`)
  console.log('')
  console.log('Share your email address with correspondents.')
  console.log(`They can send mail to: ${emailAddr}`)
}

async function handleInit(): Promise<void> {
  // ensureConfigDir + loadIdentity already ran at module top-level (lines 52-53)
  // Just make sure a config.json exists on disk
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    if (!saveConfig(config)) {
      console.error('Error: Failed to create default config')
      process.exit(1)
    }
  }

  const emailAddr = getEmailAddress(LOCAL_USER, identity.publicKey)
  console.log('Quince initialized.')
  console.log('')
  console.log(`  Public key:    ${identity.publicKey}`)
  console.log(`  Email address: ${emailAddr}`)
  console.log(`  Config:        ${configPath}`)
  console.log(`  Private key:   ${getIdentityPath()}`)
  console.log('')
  console.log('Run "quince start" to start the daemon.')
}

async function showPeers(): Promise<void> {
  const peers = config.peers ?? {}
  const peerCount = Object.keys(peers).length

  if (peerCount === 0) {
    console.log('No peers configured.')
    console.log('')
    console.log('Add a peer with:')
    console.log('  quince add-peer <alias> <pubkey>')
    return
  }

  console.log(`Configured peers: ${peerCount}`)
  console.log('')

  for (const [alias, pubkey] of Object.entries(peers)) {
    console.log(`  ${alias}`)
    console.log(`    Pubkey: ${pubkey}`)
    console.log(`    Email:  <user>@${alias}.${EMAIL_DOMAIN}`)
    console.log('')
  }
}

async function handleAddPeer(alias: string, pubkey: string): Promise<void> {
  // Validate alias
  const aliasError = validateAlias(alias)
  if (aliasError) {
    console.error(`Error: ${aliasError}`)
    process.exit(1)
  }

  // Validate pubkey
  const pubkeyError = validatePublicKey(pubkey)
  if (pubkeyError) {
    console.error(`Error: ${pubkeyError}`)
    process.exit(1)
  }

  // Check if alias already exists
  if (getPeerPubkey(config, alias)) {
    console.error(`Error: Peer '${alias}' already exists`)
    console.error('Use "quince remove-peer" first to update it')
    process.exit(1)
  }

  config = addPeer(config, alias, pubkey)

  if (!saveConfig(config)) {
    console.error('Error: Failed to save config')
    process.exit(1)
  }

  console.log(`Added peer '${alias}'`)
  console.log(`  Pubkey: ${pubkey.toLowerCase()}`)
  console.log(`  Email:  <user>@${alias}.${EMAIL_DOMAIN}`)
}

async function handleRemovePeer(alias: string): Promise<void> {
  if (!getPeerPubkey(config, alias)) {
    console.error(`Error: Peer '${alias}' not found`)
    process.exit(1)
  }

  config = removePeer(config, alias)

  if (!saveConfig(config)) {
    console.error('Error: Failed to save config')
    process.exit(1)
  }

  console.log(`Removed peer '${alias}'`)
}

async function showConfig(): Promise<void> {
  const peerCount = Object.keys(config.peers ?? {}).length
  console.log('Current configuration:')
  console.log(`  Config file: ${getConfigPath()}`)
  console.log(`  Private key: ${getIdentityPath()}`)
  console.log(`  Public key: ${getPublicKeyPath()}`)
  console.log(`  Username: ${config.username ?? '(not set, using env or default)'}`)
  console.log(`  SMTP port: ${config.smtpPort ?? '(not set, using env or default)'}`)
  console.log(`  Peers: ${peerCount}`)
  console.log('')
  console.log('Effective settings:')
  console.log(`  LOCAL_USER: ${LOCAL_USER}`)
  console.log(`  SMTP_PORT: ${PORT}`)
  console.log(`  POP3_PORT: ${POP3_PORT}`)
  console.log(`  HTTP_PORT: ${HTTP_PORT}`)
  console.log(`  BIND_ADDR: ${BIND_ADDR}`)
  console.log(`  HOSTNAME: ${HOSTNAME}`)
  console.log(`  Public key: ${identity.publicKey.slice(0, 16)}...`)
}

async function showQueue(): Promise<void> {
  const queue = new MessageQueue()
  const messages = queue.getAll()

  if (messages.length === 0) {
    console.log('No messages in queue.')
    return
  }

  console.log(`Queued messages: ${messages.length}`)
  console.log('')

  for (const msg of messages) {
    const age = Math.round((Date.now() - msg.createdAt) / 1000)
    const nextRetry = Math.max(0, Math.round((msg.nextRetryAt - Date.now()) / 1000))
    const alias = getPeerAlias(config, msg.recipientPubkey)
    console.log(`  ${msg.id}`)
    console.log(`    To: ${msg.to}`)
    console.log(`    Peer: ${alias ?? msg.recipientPubkey.slice(0, 16) + '...'}`)
    console.log(`    Age: ${age}s, Retries: ${msg.retryCount}, Next retry: ${nextRetry}s`)
    console.log('')
  }

  queue.destroy()
}

async function clearQueue(): Promise<void> {
  const queue = new MessageQueue()
  const messages = queue.getAll()

  if (messages.length === 0) {
    console.log('Queue is already empty.')
    queue.destroy()
    return
  }

  for (const msg of messages) {
    queue.remove(msg.id)
  }

  console.log(`Cleared ${messages.length} message(s) from queue.`)
  queue.destroy()
}

async function showInbox(): Promise<void> {
  const messages = listMessages()

  if (messages.length === 0) {
    console.log('Inbox is empty.')
    console.log(`  Inbox path: ${getInboxPath()}`)
    return
  }

  console.log(`Inbox: ${messages.length} message(s)`)
  console.log(`  Path: ${getInboxPath()}`)
  console.log('')

  for (const msg of messages) {
    const date = new Date(msg.receivedAt).toISOString()
    const sigStatus = msg.signatureValid ? 'OK' : 'FAILED'
    const alias = getPeerAlias(config, msg.senderPubkey)
    const sender = alias ?? msg.senderPubkey.slice(0, 16) + '...'

    console.log(`  ${msg.file}`)
    console.log(`    From: ${msg.from}`)
    console.log(`    Subject: ${msg.subject || '(none)'}`)
    console.log(`    Sender: ${sender}  Signature: ${sigStatus}`)
    console.log(`    Received: ${date}`)
    console.log('')
  }
}

async function showTransfers(showAll: boolean): Promise<void> {
  const stateFile = path.join(os.homedir(), '.quince', 'transfers.json')
  if (!fs.existsSync(stateFile)) {
    console.log('No transfers found.')
    return
  }

  let state: { transfers: Record<string, any> }
  try {
    const raw = fs.readFileSync(stateFile, 'utf8') as string
    state = JSON.parse(raw)
  } catch (err) {
    console.error('Failed to read transfers.json:', err)
    return
  }

  const transfers = Object.values(state.transfers)
  const active = transfers.filter((t: any) => t.state !== 'complete')
  const completed = transfers.filter((t: any) => t.state === 'complete')

  if (transfers.length === 0) {
    console.log('No transfers found.')
    return
  }

  if (active.length > 0) {
    console.log('Active transfers:')
    for (const t of active as any[]) {
      const arrow = t.direction === 'send' ? '↑' : '↓'
      const alias = getPeerAlias(config, t.peer) ?? t.peer.slice(0, 16) + '...'
      const dir = t.direction === 'send' ? '→' : '←'
      for (const f of t.files) {
        const size = formatBytes(f.size)
        console.log(`  ${arrow} ${f.name} ${dir} ${alias}  ${size}  ${t.state}`)
      }
    }
    console.log('')
  }

  if (showAll && completed.length > 0) {
    console.log('Completed transfers:')
    for (const t of completed as any[]) {
      const arrow = t.direction === 'send' ? '↑' : '↓'
      const alias = getPeerAlias(config, t.peer) ?? t.peer.slice(0, 16) + '...'
      const dir = t.direction === 'send' ? '→' : '←'
      for (const f of t.files) {
        const size = formatBytes(f.size)
        console.log(`  ${arrow} ${f.name} ${dir} ${alias}  ${size}  complete`)
      }
    }
    console.log('')
  }

  if (!showAll && completed.length > 0) {
    console.log(`${completed.length} completed transfer(s) hidden. Use --all to show.`)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Resolve recipient address to pubkey, with optional directory auto-lookup
async function resolveRecipient(to: string, whitelist?: Set<string>): Promise<{ pubkey: string; display: string } | null> {
  const parsed = parseEmailDomain(to)
  if (!parsed) {
    console.error(`Invalid recipient address format: ${to}`)
    console.error(`Expected: user@<pubkey>.${EMAIL_DOMAIN} or user@<alias>.${EMAIL_DOMAIN}`)
    return null
  }

  // Direct pubkey in address
  if (parsed.publicKey) {
    const alias = getPeerAlias(config, parsed.publicKey)
    return {
      pubkey: parsed.publicKey,
      display: alias ?? parsed.publicKey.slice(0, 16) + '...'
    }
  }

  // Alias lookup
  if (parsed.alias) {
    const pubkey = getPeerPubkey(config, parsed.alias)
    if (pubkey) {
      return {
        pubkey,
        display: parsed.alias
      }
    }

    // Not a known alias — try directory auto-lookup if enabled
    if (config.directory?.autoLookup !== false) {
      console.log(`Unknown alias '${parsed.alias}', querying directory...`)
      const entry = await lookupUsername(parsed.alias, config.directory?.url)
      if (entry) {
        console.log(`Directory resolved '${parsed.alias}' -> ${entry.pubkey.slice(0, 16)}...`)
        config = addPeer(config, parsed.alias, entry.pubkey)
        saveConfig(config)
        whitelist?.add(entry.pubkey.toLowerCase())
        return {
          pubkey: entry.pubkey,
          display: parsed.alias
        }
      }
    }

    console.error(`Unknown peer alias: ${parsed.alias}`)
    console.error('Add peer with: quince add-peer <alias> <pubkey>')
    return null
  }

  return null
}

async function showIntroductions(): Promise<void> {
  const pending = getPendingIntroductions()

  if (pending.length === 0) {
    console.log('No pending introductions.')
    return
  }

  console.log(`Pending introductions: ${pending.length}`)
  console.log('')

  for (const intro of pending) {
    const display = intro.alias ?? intro.pubkey.slice(0, 16) + '...'
    const introducer = intro.introducerAlias ?? intro.introducerPubkey.slice(0, 16) + '...'
    const date = new Date(intro.receivedAt).toISOString()

    console.log(`  ${display}`)
    console.log(`    Pubkey: ${intro.pubkey}`)
    console.log(`    Introduced by: ${introducer}`)
    if (intro.message) console.log(`    Message: ${intro.message}`)
    console.log(`    Received: ${date}`)
    console.log('')
  }

  console.log('Accept with: quince accept-introduction <pubkey>')
}

async function handleAcceptIntroduction(pubkey: string): Promise<void> {
  const intro = getIntroduction(pubkey.toLowerCase())
  if (!intro) {
    console.error(`No pending introduction for pubkey: ${pubkey}`)
    process.exit(1)
  }

  const accepted = acceptIntro(pubkey.toLowerCase())
  if (!accepted) {
    console.error('Failed to accept introduction')
    process.exit(1)
  }

  const alias = accepted.alias ?? accepted.pubkey.slice(0, 16)
  config = addPeer(config, alias, accepted.pubkey)
  if (!saveConfig(config)) {
    console.error('Failed to save config')
    process.exit(1)
  }

  console.log(`Accepted introduction: '${alias}'`)
  console.log(`  Pubkey: ${accepted.pubkey}`)
  console.log(`  Introduced by: ${accepted.introducerAlias ?? accepted.introducerPubkey.slice(0, 16) + '...'}`)
}

async function startDaemon(): Promise<void> {
  const permError = checkIdentityPermissions()
  if (permError) {
    console.error('ERROR: ' + permError)
    process.exit(1)
  }

  const emailAddr = getEmailAddress(LOCAL_USER, identity.publicKey)
  const peers = config.peers ?? {}
  const peerCount = Object.keys(peers).length

  // Build whitelist from configured peers
  const whitelist = new Set(Object.values(peers).map(pk => pk.toLowerCase()))

  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  console.log(`\n  ┌──┐`)
  console.log(`  │🍐│  q u i n c e  v${pkg.version}`)
  console.log(`  └──┘  ───────────────────────────────────────────`)
  console.log(`        ${emailAddr}`)
  console.log(`        HTTP :${HTTP_PORT}  SMTP :${PORT}  POP3 :${POP3_PORT}`)
  console.log(`        ${peerCount} peer${peerCount !== 1 ? 's' : ''} (whitelist mode)`)
  console.log()

  const transport = new Transport(identity, { whitelist })
  const queue = new MessageQueue()
  const transferManager = new FileTransferManager()

  let isShuttingDown = false

  // Start the swarm
  try {
    await transport.start()
  } catch (err) {
    console.error('Failed to start transport:', err)
    await transport.destroy()
    process.exit(1)
  }

  // Start file transfer manager
  try {
    await transferManager.start()
  } catch (err) {
    console.error('Failed to start file transfer manager:', err)
    await transport.destroy()
    process.exit(1)
  }

  // Helper to attempt sending a message
  async function trySendMessage(
    id: string,
    recipientPubkey: string,
    display: string,
    encoded: string
  ): Promise<boolean> {
    if (isShuttingDown) return false

    if (!transport.isPeerConnected(recipientPubkey)) {
      console.log(`Peer ${display} not connected, attempting discovery...`)
      try {
        await transport.connectToPeer(recipientPubkey)
        // Give it a moment to establish connection
        await new Promise(resolve => setTimeout(resolve, 2000))
      } catch (err) {
        console.log(`Discovery failed for ${display}`)
      }
    }

    if (!transport.isPeerConnected(recipientPubkey)) {
      console.log(`Peer ${display} still not connected`)
      return false
    }

    console.log(`Sending message ${id.slice(0, 8)}... to ${display}`)

    try {
      await transport.sendMessage(recipientPubkey, id, encoded)
      console.log(`Message ${id.slice(0, 8)}... delivered`)
      return true
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`Delivery failed: ${errMsg}`)
      return false
    }
  }

  // Handle queued message retry
  queue.on('message-due', async (msg: QueuedMessage) => {
    if (isShuttingDown) return

    const alias = getPeerAlias(config, msg.recipientPubkey)
    const display = alias ?? msg.recipientPubkey.slice(0, 16) + '...'

    console.log(`Retrying ${msg.id.slice(0, 8)}... (attempt ${msg.retryCount + 1})`)

    const success = await trySendMessage(msg.id, msg.recipientPubkey, display, msg.mime)

    if (success) {
      queue.remove(msg.id)
    } else {
      queue.markRetry(msg.id)
    }
  })

  queue.on('message-expired', (msg: QueuedMessage) => {
    console.error(`Message ${msg.id.slice(0, 8)}... expired after ${msg.retryCount} retries`)
  })

  // Handle incoming messages from peers
  transport.on('message', async (msg: PeerMessage, senderPubkey: string) => {
    const alias = getPeerAlias(config, senderPubkey)
    const display = alias ?? senderPubkey.slice(0, 16) + '...'

    console.log('')
    console.log(`--- Incoming message from ${display} ---`)

    try {
      const raw = decodeBase64(msg.mime)
      const { mime, valid } = verifyMessage(raw, senderPubkey)

      if (!valid) {
        console.log('WARNING: Signature verification failed')
      }

      // Send ACK back to sender (transport-level receipt)
      transport.sendAck(senderPubkey, msg.id)

      // Check for file refs — if present, hold the message until files arrive
      const refs = parseFileRefs(mime)
      if (refs.length > 0 && alias) {
        console.log(`Message has ${refs.length} file ref(s), holding for transfer...`)
        transferManager.addPendingMessage({
          messageId: msg.id,
          mime,
          senderPubkey,
          senderAlias: alias,
          signatureValid: valid,
          refs,
          receivedAt: Date.now()
        })
        transport.sendFileRequest(senderPubkey, {
          type: 'FILE_REQUEST',
          messageId: msg.id,
          files: refs.map(r => ({ name: r.name }))
        })
        console.log(`Sent FILE_REQUEST for ${refs.length} file(s) to ${display}`)
        return
      }

      // No file refs — deliver immediately
      const entry = storeMessage(msg.id, mime, senderPubkey, valid)
      console.log(`Stored: ${entry.file}${valid ? '' : ' (UNVERIFIED)'}`)

      console.log(mime)
      console.log('------------------------')
    } catch (err) {
      console.error('Failed to process message:', err)
    }
  })

  transport.on('peer-connected', (pubkey: string) => {
    const alias = getPeerAlias(config, pubkey)
    const display = alias ?? pubkey.slice(0, 16) + '...'
    console.log(`Peer connected: ${display}`)

    // Retry queued messages for this peer
    const pending = queue.getByRecipient(pubkey)
    if (pending.length > 0) {
      console.log(`Retrying ${pending.length} queued message(s) for ${display}...`)
      queue.triggerRetryForRecipient(pubkey)
    }
  })

  transport.on('peer-disconnected', (pubkey: string) => {
    const alias = getPeerAlias(config, pubkey)
    const display = alias ?? pubkey.slice(0, 16) + '...'
    console.log(`Peer disconnected: ${display}`)
  })

  transport.on('peer-rejected', (pubkey: string) => {
    console.log(`Message rejected from unknown sender: ${pubkey.slice(0, 16)}...`)
    console.log(`  To allow messages from this sender, run: quince add-peer <alias> ${pubkey}`)
  })

  transport.on('peer-status', (pubkey: string, status: PeerStatus) => {
    const alias = getPeerAlias(config, pubkey)
    const display = alias ?? pubkey.slice(0, 16) + '...'
    console.log(`Peer ${display} status: ${status.status}${status.message ? ` (${status.message})` : ''}`)
  })

  // Introduction handling
  transport.on('introduction', (intro: PeerIntroduction, senderPubkey: string) => {
    const senderAlias = getPeerAlias(config, senderPubkey)
    const display = senderAlias ?? senderPubkey.slice(0, 16) + '...'

    console.log(`Received INTRODUCTION from ${display} for ${intro.introduced.pubkey.slice(0, 16)}...`)

    // Verify signature
    const valid = verifyIntroduction(intro.introduced as unknown as Record<string, unknown>, intro.signature, senderPubkey)
    if (!valid) {
      console.log('  Introduction signature verification FAILED, ignoring')
      return
    }

    // Check if auto-accept is configured for this introducer
    const trustConfig = config.trustIntroductions ?? {}
    const shouldAutoAccept = senderAlias ? trustConfig[senderAlias] === true : false

    if (shouldAutoAccept) {
      const alias = intro.introduced.alias ?? intro.introduced.pubkey.slice(0, 16)
      console.log(`  Auto-accepting introduction from trusted ${display}: adding '${alias}'`)

      // Add to config
      config = addPeer(config, alias, intro.introduced.pubkey)
      saveConfig(config)

      // Live-update whitelist
      whitelist.add(intro.introduced.pubkey.toLowerCase())

      // Connect to the new peer
      transport.connectToPeer(intro.introduced.pubkey).catch(err => {
        console.error(`  Failed to connect to introduced peer: ${err}`)
      })
    } else {
      console.log(`  Queuing introduction as pending (${display} not in trustIntroductions)`)
      addIntroduction({
        pubkey: intro.introduced.pubkey.toLowerCase(),
        alias: intro.introduced.alias,
        capabilities: intro.introduced.capabilities,
        message: intro.introduced.message,
        introducerPubkey: senderPubkey,
        introducerAlias: senderAlias,
        signature: intro.signature,
        receivedAt: Date.now(),
        status: 'pending'
      })
    }
  })

  // File transfer events

  // Sender: receiver is requesting files
  transport.on('file-request', async (request: PeerFileRequest, senderPubkey: string) => {
    const alias = getPeerAlias(config, senderPubkey) ?? senderPubkey.slice(0, 16)
    console.log(`Received FILE_REQUEST from ${alias} for ${request.files.length} file(s)`)

    try {
      const offer = await transferManager.handleFileRequest(request.messageId, senderPubkey, request.files)
      transport.sendFileOffer(senderPubkey, offer)
      console.log(`Sent FILE_OFFER to ${alias} for ${offer.files.length} file(s)`)
    } catch (err) {
      console.error('Failed to handle file request:', err)
    }
  })

  // Receiver: sender is offering files (after our FILE_REQUEST)
  transport.on('file-offer', async (offer: PeerFileOffer, senderPubkey: string) => {
    const alias = getPeerAlias(config, senderPubkey) ?? senderPubkey.slice(0, 16)
    console.log(`Received FILE_OFFER from ${alias} for ${offer.files.length} file(s)`)
    await transferManager.handleFileOffer(offer, senderPubkey)
  })

  // Sender: receiver confirms transfer complete, clean up
  transport.on('file-complete', async (complete: PeerFileComplete, senderPubkey: string) => {
    const alias = getPeerAlias(config, senderPubkey) ?? senderPubkey.slice(0, 16)
    console.log(`Received FILE_COMPLETE from ${alias} for message ${complete.messageId.slice(0, 8)}...`)
    await transferManager.cleanup(complete.messageId, 'send')
  })

  // Receiver: files downloaded — deliver pending message to inbox
  transferManager.on('transfer-complete', async (event: { messageId: string; senderPubkey: string; files: Array<{ name: string; localName: string; size: number }> }) => {
    const pending = transferManager.getPendingMessage(event.messageId)
    if (!pending) {
      console.error(`No pending message for completed transfer ${event.messageId.slice(0, 8)}...`)
      return
    }

    const display = pending.senderAlias
    console.log(`File transfer complete from ${display}, delivering message to inbox`)

    // Transform file refs with real sizes
    const storedMime = transformFileRefs(pending.mime, pending.senderPubkey, event.files)
    const entry = storeMessage(pending.messageId, storedMime, pending.senderPubkey, pending.signatureValid)
    console.log(`Stored: ${entry.file}${pending.signatureValid ? '' : ' (UNVERIFIED)'}`)

    transferManager.removePendingMessage(event.messageId)
    transport.sendFileComplete(pending.senderPubkey, { type: 'FILE_COMPLETE', messageId: event.messageId })

    await transferManager.cleanup(event.messageId, 'receive')
  })

  // Receiver: file transfer timed out — deliver message with failure markers
  transferManager.on('transfer-timeout', (pending: PendingMessage) => {
    const display = pending.senderAlias
    console.log(`File transfer timeout from ${display}, delivering with failure markers`)

    const fileNames = pending.refs.map(r => r.name)
    const storedMime = transformFileRefsFailed(pending.mime, fileNames)
    storeMessage(pending.messageId, storedMime, pending.senderPubkey, pending.signatureValid)
  })

  // Shared send logic for SMTP and HTTP API
  async function sendOutgoing(
    to: string,
    subject: string,
    body: string,
    extraHeaders?: Record<string, string>
  ): Promise<{ id: string; queued: boolean; messageId: string }> {
    const fromAddr = getEmailAddress(LOCAL_USER, identity.publicKey)

    const recipient = await resolveRecipient(to, whitelist)
    if (!recipient) {
      throw new Error(`Invalid recipient address: ${to}`)
    }

    const id = generateId()
    const mimeMessageId = `<${id}@quincemail.com>`

    // Build MIME
    let headerLines = `Subject: ${subject}\r\nMessage-ID: ${mimeMessageId}`
    if (extraHeaders) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        headerLines += `\r\n${name}: ${value}`
      }
    }
    const fullMessage = `From: ${fromAddr}\r\nTo: ${to}\r\n${headerLines}\r\n\r\n${body}`
    const signed = signMessage(fullMessage, identity.secretKey)
    const encoded = encodeBase64(signed)

    console.log('')
    console.log(`--- Outgoing message ---`)
    console.log(`From: ${fromAddr}`)
    console.log(`To: ${to}`)

    const success = await trySendMessage(id, recipient.pubkey, recipient.display, encoded)

    if (!success) {
      queue.add({
        id,
        from: fromAddr,
        to,
        recipientPubkey: recipient.pubkey,
        mime: encoded
      })
      console.log(`Queued for retry`)
    }

    return { id, queued: !success, messageId: mimeMessageId }
  }

  // SMTP message handler
  async function onMessage(from: string, to: string, data: string): Promise<void> {
    console.log('')
    console.log(`--- Outgoing message ---`)
    console.log(`From: ${from}`)
    console.log(`To: ${to}`)

    const recipient = await resolveRecipient(to, whitelist)
    if (!recipient) {
      return
    }

    const id = generateId()

    // Inject Message-ID if the SMTP client didn't include one
    let messageData = data
    if (!/^Message-ID:/mi.test(data)) {
      const mimeMessageId = `<${id}@quincemail.com>`
      // Insert after the first line of headers (Subject typically)
      const firstNewline = data.indexOf('\r\n')
      if (firstNewline !== -1) {
        messageData = data.slice(0, firstNewline) + `\r\nMessage-ID: ${mimeMessageId}` + data.slice(firstNewline)
      } else {
        messageData = `Message-ID: ${mimeMessageId}\r\n${data}`
      }
    }

    const fullMessage = `From: ${from}\r\nTo: ${to}\r\n${messageData}`
    const signed = signMessage(fullMessage, identity.secretKey)
    const encoded = encodeBase64(signed)

    const success = await trySendMessage(id, recipient.pubkey, recipient.display, encoded)

    if (!success) {
      queue.add({
        id,
        from,
        to,
        recipientPubkey: recipient.pubkey,
        mime: encoded
      })
      console.log(`Queued for retry`)
    }
  }

  const smtpServer = new SmtpServer({
    port: PORT,
    host: BIND_ADDR,
    hostname: HOSTNAME,
    localUser: LOCAL_USER,
    onMessage,
    validateData(from: string, to: string, data: string): string | null {
      const refs = parseFileRefs(data)
      if (refs.length === 0) return null

      const { missing } = validateFileRefs(refs)
      if (missing.length > 0) {
        const names = missing.map(r => r.name).join(', ')
        return `550 File not found: ${names}\r\n`
      }
      return null
    }
  })

  try {
    await smtpServer.start()
  } catch (err) {
    console.error('Failed to start SMTP server:', err)
    await transport.destroy()
    process.exit(1)
  }

  const pop3Server = new Pop3Server({
    port: POP3_PORT,
    host: BIND_ADDR,
    hostname: HOSTNAME,
    username: LOCAL_USER,
    getMessages: listMessages,
    getMessageContent,
    deleteMessage
  })

  try {
    await pop3Server.start()
  } catch (err) {
    console.error('Failed to start POP3 server:', err)
    await smtpServer.stop()
    await transport.destroy()
    process.exit(1)
  }

  // HTTP API server
  const httpContext: HttpContext = {
    identity,
    get config() { return config },
    username: LOCAL_USER,
    listMessages,
    getMessage,
    getMessageContent,
    deleteMessage,
    sendMessage: sendOutgoing,
    transport,
    transferManager,
    getTransfers: () => {
      const stateFile = path.join(os.homedir(), '.quince', 'transfers.json')
      try {
        if (fs.existsSync(stateFile)) {
          const raw = fs.readFileSync(stateFile, 'utf8') as string
          const state = JSON.parse(raw)
          return Object.values(state.transfers ?? {})
        }
      } catch {}
      return []
    },
    readMediaFile: (relativePath: string) => {
      const mediaDir = getMediaDir()
      const fullPath = path.join(mediaDir, relativePath)
      const resolved = path.resolve(fullPath)
      const resolvedMedia = path.resolve(mediaDir)
      if (!resolved.startsWith(resolvedMedia + '/') && resolved !== resolvedMedia) {
        return null
      }
      try {
        if (!fs.existsSync(fullPath)) return null
        const content = fs.readFileSync(fullPath) as Buffer
        return { content, contentType: guessContentType(relativePath) }
      } catch {
        return null
      }
    },
    getIntroductions: () => getPendingIntroductions(),
    acceptIntroduction: (pubkey: string) => {
      const intro = acceptIntro(pubkey)
      if (!intro) return null

      // Add peer to config + whitelist
      const alias = intro.alias ?? intro.pubkey.slice(0, 16)
      config = addPeer(config, alias, intro.pubkey)
      saveConfig(config)
      whitelist.add(intro.pubkey.toLowerCase())

      // Connect to the new peer
      transport.connectToPeer(intro.pubkey).catch(err => {
        console.error(`Failed to connect to accepted peer: ${err}`)
      })

      return intro
    },
    rejectIntroduction: (pubkey: string) => rejectIntro(pubkey),
    signIntroduction: (introduced: Record<string, unknown>) => signIntroduction(introduced, identity.secretKey),
    addPeerToConfig: (alias: string, pubkey: string) => {
      config = addPeer(config, alias, pubkey)
      if (!saveConfig(config)) {
        return { success: false, error: 'Failed to save config' }
      }
      whitelist.add(pubkey.toLowerCase())
      transport.connectToPeer(pubkey).catch(err => {
        console.error(`Failed to connect to new peer: ${err}`)
      })
      return { success: true }
    },
    listGateMessages,
    getGateMessage,
    getGateMessageContent,
    deleteGateMessage,
    updateGateMessageStatus,
    storeMessage,
    addWhitelistRule,
    listGateRules: loadRules,
    addGateRule: addRule,
    getGateRule: (id: string) => loadRules().find(r => r.id === id),
    updateGateRule: updateRule,
    removeGateRule: removeRule,
    reorderGateRules: reorderRules,
  }

  const httpServer = new HttpServer({
    port: HTTP_PORT,
    host: BIND_ADDR,
    context: httpContext
  })

  try {
    await httpServer.start()
  } catch (err) {
    console.error('Failed to start HTTP server:', err)
    await pop3Server.stop()
    await smtpServer.stop()
    await transport.destroy()
    process.exit(1)
  }

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) return
    isShuttingDown = true

    console.log('')
    console.log('Shutting down...')

    // Stop accepting new messages
    queue.destroy()

    // Close SMTP server
    try {
      await smtpServer.stop()
      console.log('  SMTP server stopped')
    } catch (err) {
      console.error('  Error stopping SMTP server:', err)
    }

    // Close POP3 server
    try {
      await pop3Server.stop()
      console.log('  POP3 server stopped')
    } catch (err) {
      console.error('  Error stopping POP3 server:', err)
    }

    // Close HTTP server
    try {
      await httpServer.stop()
      console.log('  HTTP server stopped')
    } catch (err) {
      console.error('  Error stopping HTTP server:', err)
    }

    // Close file transfer manager
    try {
      await transferManager.destroy()
      console.log('  File transfer manager stopped')
    } catch (err) {
      console.error('  Error stopping file transfer manager:', err)
    }

    // Close transport
    try {
      await transport.destroy()
      console.log('  Transport closed')
    } catch (err) {
      console.error('  Error closing transport:', err)
    }

    const remaining = queue.size()
    if (remaining > 0) {
      console.log(`  ${remaining} message(s) still queued (will retry on restart)`)
    }

    console.log('Goodbye!')
    // Allow native handles to fully release before exiting
    setTimeout(() => process.exit(0), 100)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Ready message
  console.log('')
  console.log(`Public key: ${identity.publicKey.slice(0, 16)}...`)
  const queueSize = queue.size()
  if (queueSize > 0) {
    console.log(`Queued messages: ${queueSize}`)
  }
  console.log('Ready. Waiting for connections...')
  console.log('')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    printUsage()
    process.exit(0)
  }

  const command = args[0]

  switch (command) {
    case 'start':
      await startDaemon()
      break

    case 'identity':
      await showIdentity()
      break

    case 'peers':
      await showPeers()
      break

    case 'add-peer':
      if (!args[1] || !args[2]) {
        console.error('Usage: quince add-peer <alias> <pubkey>')
        process.exit(1)
      }
      await handleAddPeer(args[1], args[2])
      break

    case 'remove-peer':
      if (!args[1]) {
        console.error('Usage: quince remove-peer <alias>')
        process.exit(1)
      }
      await handleRemovePeer(args[1])
      break

    case 'config':
      await showConfig()
      break

    case 'queue':
      if (args[1] === 'clear') {
        await clearQueue()
      } else {
        await showQueue()
      }
      break

    case 'inbox':
      await showInbox()
      break

    case 'transfers':
      await showTransfers(args[1] === '--all')
      break

    case 'introductions':
      await showIntroductions()
      break

    case 'accept-introduction':
      if (!args[1]) {
        console.error('Usage: quince accept-introduction <pubkey>')
        process.exit(1)
      }
      await handleAcceptIntroduction(args[1])
      break

    case 'init':
      await handleInit()
      break

    case 'help':
    case '--help':
    case '-h':
      printUsage()
      break

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "quince help" for usage.')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
