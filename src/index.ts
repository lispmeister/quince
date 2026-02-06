import process from 'bare-process'
import env from 'bare-env'
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
  getEmailAddress,
  parseEmailDomain,
  validatePublicKey,
  EMAIL_DOMAIN
} from './identity.js'
import { signMessage, verifyMessage } from './crypto.js'

let config = loadConfig()
const identity = loadIdentity()

const PORT = parseInt(env.SMTP_PORT ?? String(config.smtpPort ?? 2525), 10)
const HOSTNAME = env.HOSTNAME ?? 'quince.local'
const LOCAL_USER = env.LOCAL_USER ?? config.username ?? 'user'

function printUsage(): void {
  const emailAddr = getEmailAddress(LOCAL_USER, identity.publicKey)
  console.log(`
quince - Decentralized SMTP over Pear network

Usage:
  quince <command> [options]

Commands:
  start                         Start the daemon
  identity                      Show your identity and email address
  peers                         List configured peers
  add-peer <alias> <pubkey>     Add a peer with friendly alias
  remove-peer <alias>           Remove a peer
  config                        Show current configuration
  queue                         Show queued messages
  queue clear                   Clear all queued messages
  help                          Show this help message

Environment Variables:
  SMTP_PORT    SMTP server port (default: 2525)
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
  console.log(`  Identity file: ${getIdentityPath()}`)
  console.log('')
  console.log('Share your email address with correspondents.')
  console.log(`They can send mail to: ${emailAddr}`)
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
  saveConfig(config)

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
  saveConfig(config)

  console.log(`Removed peer '${alias}'`)
}

async function showConfig(): Promise<void> {
  const peerCount = Object.keys(config.peers ?? {}).length
  console.log('Current configuration:')
  console.log(`  Config file: ${getConfigPath()}`)
  console.log(`  Identity file: ${getIdentityPath()}`)
  console.log(`  Username: ${config.username ?? '(not set, using env or default)'}`)
  console.log(`  SMTP port: ${config.smtpPort ?? '(not set, using env or default)'}`)
  console.log(`  Peers: ${peerCount}`)
  console.log('')
  console.log('Effective settings:')
  console.log(`  LOCAL_USER: ${LOCAL_USER}`)
  console.log(`  SMTP_PORT: ${PORT}`)
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

// Resolve recipient address to pubkey
function resolveRecipient(to: string): { pubkey: string; display: string } | null {
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
    if (!pubkey) {
      console.error(`Unknown peer alias: ${parsed.alias}`)
      console.error('Add peer with: quince add-peer <alias> <pubkey>')
      return null
    }
    return {
      pubkey,
      display: parsed.alias
    }
  }

  return null
}

async function startDaemon(): Promise<void> {
  const emailAddr = getEmailAddress(LOCAL_USER, identity.publicKey)
  const peers = config.peers ?? {}
  const peerCount = Object.keys(peers).length

  // Build whitelist from configured peers
  const whitelist = new Set(Object.values(peers).map(pk => pk.toLowerCase()))

  console.log('Starting quince daemon...')
  console.log(`  User: ${LOCAL_USER}`)
  console.log(`  Email: ${emailAddr}`)
  console.log(`  SMTP: localhost:${PORT}`)
  console.log(`  Peers: ${peerCount} (whitelist mode)`)

  const transport = new Transport(identity, { whitelist })
  const queue = new MessageQueue()

  let isShuttingDown = false

  // Start the swarm
  try {
    await transport.start()
  } catch (err) {
    console.error('Failed to start transport:', err)
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

      console.log(mime)
      console.log('------------------------')

      // Send ACK back to sender
      transport.sendAck(senderPubkey, msg.id)
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

  // SMTP message handler
  async function onMessage(from: string, to: string, data: string): Promise<void> {
    console.log('')
    console.log(`--- Outgoing message ---`)
    console.log(`From: ${from}`)
    console.log(`To: ${to}`)

    const recipient = resolveRecipient(to)
    if (!recipient) {
      return
    }

    const fullMessage = `From: ${from}\r\nTo: ${to}\r\n${data}`
    const signed = signMessage(fullMessage, identity.secretKey)
    const messageId = generateId()
    const encoded = encodeBase64(signed)

    const success = await trySendMessage(messageId, recipient.pubkey, recipient.display, encoded)

    if (!success) {
      queue.add({
        id: messageId,
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
    hostname: HOSTNAME,
    localUser: LOCAL_USER,
    onMessage
  })

  try {
    await smtpServer.start()
  } catch (err) {
    console.error('Failed to start SMTP server:', err)
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
    process.exit(0)
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
