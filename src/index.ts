import process from 'bare-process'
import env from 'bare-env'
import { SmtpServer } from './smtp/index.js'
import { Transport } from './transport/index.js'
import { parseAddress } from './smtp/parser.js'
import { generateId, encodeBase64, decodeBase64 } from './utils.js'

const PORT = parseInt(env.SMTP_PORT ?? '2525', 10)
const HOSTNAME = env.HOSTNAME ?? 'pear-mail.local'
const LOCAL_USER = env.LOCAL_USER ?? 'user'

function printUsage(): void {
  console.log(`
pear-mail - Decentralized SMTP over Pear network

Usage:
  bare dist/index.js [command] [options]

Commands:
  create-room          Create a new room and print the room ID
  start <room-id>      Start daemon and join the specified room

Environment Variables:
  SMTP_PORT           SMTP server port (default: 2525)
  HOSTNAME            Server hostname (default: pear-mail.local)
  LOCAL_USER          Local username for receiving mail (default: user)

Examples:
  # Create a new room
  bare dist/index.js create-room

  # Start daemon with a room
  LOCAL_USER=alice bare dist/index.js start abc123...
`)
}

async function createRoom(): Promise<void> {
  const transport = new Transport()
  const roomId = transport.createRoom()
  console.log('Created new room:')
  console.log(roomId)
  await transport.destroy()
}

async function startDaemon(roomId: string): Promise<void> {
  console.log(`Starting pear-mail daemon...`)
  console.log(`Local user: ${LOCAL_USER}`)
  console.log(`Room: ${roomId.slice(0, 8)}...`)

  const transport = new Transport()

  // Join the room
  const room = await transport.joinRoom(roomId)

  // Handle incoming messages from peers
  transport.on('message', async (incomingRoomId, msg) => {
    console.log(`\n--- Incoming message from room ${incomingRoomId.slice(0, 8)}... ---`)

    try {
      const mime = decodeBase64(msg.mime)
      console.log(mime)
      console.log('--- End ---\n')

      // Send ACK
      const incomingRoom = transport.getRoom(incomingRoomId)
      if (incomingRoom) {
        incomingRoom.sendAck(msg.id)
        console.log(`Sent ACK for message ${msg.id}`)
      }
    } catch (err) {
      console.error('Failed to decode message:', err)
    }
  })

  transport.on('room-connected', (connectedRoomId) => {
    console.log(`Room ${connectedRoomId.slice(0, 8)}... connected`)
  })

  transport.on('room-disconnected', (disconnectedRoomId) => {
    console.log(`Room ${disconnectedRoomId.slice(0, 8)}... disconnected`)
  })

  // SMTP message handler - send over Pear transport
  async function onMessage(from: string, to: string, data: string): Promise<void> {
    console.log(`\n--- Outgoing message ---`)
    console.log(`From: ${from}`)
    console.log(`To: ${to}`)

    // Parse recipient address to get room ID
    const parsed = parseAddress(to)
    if (!parsed) {
      console.error('Invalid recipient address format')
      return
    }

    const targetRoom = transport.getRoom(parsed.roomId)
    if (!targetRoom) {
      console.error(`Not connected to room ${parsed.roomId.slice(0, 8)}...`)
      return
    }

    if (!targetRoom.isConnected) {
      console.error(`No peers in room ${parsed.roomId.slice(0, 8)}...`)
      return
    }

    // Build full email with headers
    const fullMessage = `From: ${from}\r\nTo: ${to}\r\n${data}`
    const messageId = generateId()
    const encoded = encodeBase64(fullMessage)

    console.log(`Sending message ${messageId} to room ${parsed.roomId.slice(0, 8)}...`)

    try {
      await targetRoom.sendMessage(messageId, encoded)
      console.log(`Message ${messageId} delivered and acknowledged`)
    } catch (err) {
      console.error(`Failed to deliver message:`, err)
    }
  }

  const smtpServer = new SmtpServer({
    port: PORT,
    hostname: HOSTNAME,
    localUser: LOCAL_USER,
    onMessage
  })

  await smtpServer.start()

  // Handle shutdown
  const shutdown = async () => {
    console.log('\nShutting down...')
    await smtpServer.stop()
    await transport.destroy()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log(`\nYour email address: ${LOCAL_USER}@${roomId}`)
  console.log('Waiting for peer connections...\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2) // Skip 'bare' and script path

  if (args.length === 0) {
    printUsage()
    process.exit(0)
  }

  const command = args[0]

  switch (command) {
    case 'create-room':
      await createRoom()
      break

    case 'start':
      if (!args[1]) {
        console.error('Error: room-id is required')
        console.error('Usage: bare dist/index.js start <room-id>')
        process.exit(1)
      }
      await startDaemon(args[1])
      break

    case 'help':
    case '--help':
    case '-h':
      printUsage()
      break

    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
