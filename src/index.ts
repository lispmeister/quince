import process from 'bare-process'
import env from 'bare-env'
import { SmtpServer } from './smtp/index.js'
import { Transport } from './transport/index.js'
import { parseAddress } from './smtp/parser.js'
import { generateId, encodeBase64, decodeBase64 } from './utils.js'
import { loadConfig, saveConfig, getConfigPath, validateRoomId } from './config.js'
import { MessageQueue, type QueuedMessage } from './queue/index.js'

const config = loadConfig()

const PORT = parseInt(env.SMTP_PORT ?? String(config.smtpPort ?? 2525), 10)
const HOSTNAME = env.HOSTNAME ?? 'quince.local'
const LOCAL_USER = env.LOCAL_USER ?? config.username ?? 'user'

function printUsage(): void {
  const defaultRoom = config.defaultRoom
  console.log(`
quince - Decentralized SMTP over Pear network

Usage:
  quince <command> [options]

Commands:
  start [room-id]          Start daemon (uses default room if omitted)
  create-room              Create a new room and print the room ID
  set-default <room-id>    Set the default room ID
  config                   Show current configuration
  queue                    Show queued messages
  queue clear              Clear all queued messages
  help                     Show this help message

Environment Variables:
  SMTP_PORT    SMTP server port (default: 2525)
  HOSTNAME     Server hostname (default: quince.local)
  LOCAL_USER   Local username (default: user)

Config: ${getConfigPath()}
${defaultRoom ? `Default room: ${defaultRoom.slice(0, 8)}...` : 'No default room configured'}
`)
}

async function createRoom(): Promise<void> {
  const transport = new Transport()
  const roomId = transport.createRoom()
  console.log('Created new room:')
  console.log(roomId)
  console.log('')
  console.log('To set as default:')
  console.log(`  quince set-default ${roomId}`)
  await transport.destroy()
}

async function showConfig(): Promise<void> {
  console.log('Current configuration:')
  console.log(`  Config file: ${getConfigPath()}`)
  console.log(`  Default room: ${config.defaultRoom ?? '(not set)'}`)
  console.log(`  Username: ${config.username ?? '(not set, using env or default)'}`)
  console.log(`  SMTP port: ${config.smtpPort ?? '(not set, using env or default)'}`)
  console.log('')
  console.log('Effective settings:')
  console.log(`  LOCAL_USER: ${LOCAL_USER}`)
  console.log(`  SMTP_PORT: ${PORT}`)
  console.log(`  HOSTNAME: ${HOSTNAME}`)
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
    console.log(`  ${msg.id}`)
    console.log(`    To: ${msg.to}`)
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

async function startDaemon(roomId: string): Promise<void> {
  // Validate room ID
  const roomError = validateRoomId(roomId)
  if (roomError) {
    console.error(`Error: ${roomError}`)
    process.exit(1)
  }

  const normalizedRoomId = roomId.toLowerCase()

  console.log('Starting quince daemon...')
  console.log(`  User: ${LOCAL_USER}`)
  console.log(`  Room: ${normalizedRoomId.slice(0, 8)}...`)
  console.log(`  SMTP: localhost:${PORT}`)

  const transport = new Transport()
  const queue = new MessageQueue()

  let isShuttingDown = false

  // Join the room
  try {
    await transport.joinRoom(normalizedRoomId)
  } catch (err) {
    console.error('Failed to join room:', err)
    await transport.destroy()
    process.exit(1)
  }

  // Helper to attempt sending a message
  async function trySendMessage(
    id: string,
    from: string,
    to: string,
    targetRoomId: string,
    encoded: string
  ): Promise<boolean> {
    if (isShuttingDown) return false

    const targetRoom = transport.getRoom(targetRoomId)

    if (!targetRoom || !targetRoom.isConnected) {
      console.log(`Room ${targetRoomId.slice(0, 8)}... not connected`)
      return false
    }

    console.log(`Sending message ${id.slice(0, 8)}...`)

    try {
      await targetRoom.sendMessage(id, encoded)
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

    console.log(`Retrying ${msg.id.slice(0, 8)}... (attempt ${msg.retryCount + 1})`)

    const success = await trySendMessage(msg.id, msg.from, msg.to, msg.roomId, msg.mime)

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
  transport.on('message', async (incomingRoomId, msg) => {
    console.log('')
    console.log(`--- Incoming message ---`)

    try {
      const mime = decodeBase64(msg.mime)
      console.log(mime)
      console.log('------------------------')

      // Send ACK
      const incomingRoom = transport.getRoom(incomingRoomId)
      if (incomingRoom) {
        incomingRoom.sendAck(msg.id)
      }
    } catch (err) {
      console.error('Failed to process message:', err)
    }
  })

  transport.on('room-connected', (connectedRoomId) => {
    console.log(`Peer connected (room ${connectedRoomId.slice(0, 8)}...)`)

    // Retry queued messages
    const pending = queue.getByRoomId(connectedRoomId)
    if (pending.length > 0) {
      console.log(`Retrying ${pending.length} queued message(s)...`)
      queue.triggerRetryForRoom(connectedRoomId)
    }
  })

  transport.on('room-disconnected', (disconnectedRoomId) => {
    console.log(`Peer disconnected (room ${disconnectedRoomId.slice(0, 8)}...)`)
  })

  // SMTP message handler
  async function onMessage(from: string, to: string, data: string): Promise<void> {
    console.log('')
    console.log(`--- Outgoing message ---`)
    console.log(`From: ${from}`)
    console.log(`To: ${to}`)

    const parsed = parseAddress(to)
    if (!parsed) {
      console.error('Invalid recipient address')
      return
    }

    const fullMessage = `From: ${from}\r\nTo: ${to}\r\n${data}`
    const messageId = generateId()
    const encoded = encodeBase64(fullMessage)

    const success = await trySendMessage(messageId, from, to, parsed.roomId, encoded)

    if (!success) {
      queue.add({
        id: messageId,
        from,
        to,
        roomId: parsed.roomId,
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
  console.log(`Email address: ${LOCAL_USER}@${normalizedRoomId}`)
  const queueSize = queue.size()
  if (queueSize > 0) {
    console.log(`Queued messages: ${queueSize}`)
  }
  console.log('Ready. Waiting for connections...')
  console.log('')
}

async function setDefaultRoom(roomId: string): Promise<void> {
  const error = validateRoomId(roomId)
  if (error) {
    console.error(`Error: ${error}`)
    process.exit(1)
  }

  config.defaultRoom = roomId.toLowerCase()
  saveConfig(config)
  console.log(`Default room set to: ${roomId}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    printUsage()
    process.exit(0)
  }

  const command = args[0]

  switch (command) {
    case 'start': {
      const roomId = args[1] ?? config.defaultRoom
      if (!roomId) {
        console.error('Error: No room-id provided and no default room configured')
        console.error('')
        console.error('Usage:')
        console.error('  quince start <room-id>')
        console.error('  quince set-default <room-id>  # then: quince start')
        process.exit(1)
      }
      await startDaemon(roomId)
      break
    }

    case 'create-room':
      await createRoom()
      break

    case 'set-default':
      if (!args[1]) {
        console.error('Error: room-id is required')
        console.error('Usage: quince set-default <room-id>')
        process.exit(1)
      }
      await setDefaultRoom(args[1])
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
