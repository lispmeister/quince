import tcp from 'bare-tcp'
import { Pop3Session, type Pop3SessionConfig } from './session.js'

export interface Pop3ServerConfig {
  port: number
  hostname: string
  username: string
  getMessages: Pop3SessionConfig['getMessages']
  getMessageContent: Pop3SessionConfig['getMessageContent']
  deleteMessage: Pop3SessionConfig['deleteMessage']
}

export class Pop3Server {
  private server: ReturnType<typeof tcp.createServer> | null = null
  private config: Pop3ServerConfig

  constructor(config: Pop3ServerConfig) {
    this.config = config
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = tcp.createServer()

      this.server.on('connection', (socket: any) => {
        this.handleConnection(socket)
      })

      this.server.on('error', (err: Error) => {
        reject(err)
      })

      this.server.listen(this.config.port, () => {
        const addr = this.server!.address()
        const port = (addr && typeof addr === 'object') ? addr.port : this.config.port
        console.log(`POP3 server listening on port ${port}`)
        resolve(port)
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  private handleConnection(socket: any): void {
    const remoteAddr = socket.remoteAddress ?? 'unknown'
    console.log(`POP3 connection from ${remoteAddr}`)

    const session = new Pop3Session({
      hostname: this.config.hostname,
      username: this.config.username,
      getMessages: this.config.getMessages,
      getMessageContent: this.config.getMessageContent,
      deleteMessage: this.config.deleteMessage
    })

    socket.write(session.getGreeting())

    let buffer = ''

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()

      let lineEnd: number
      while ((lineEnd = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '')
        buffer = buffer.slice(lineEnd + 1)

        const response = session.processLine(line)
        if (response) {
          socket.write(response)
        }

        if (session.isQuit(line)) {
          socket.end()
          return
        }
      }
    })

    socket.on('error', (err: Error) => {
      console.error(`POP3 socket error: ${err.message}`)
    })

    socket.on('close', () => {
      console.log(`POP3 connection closed from ${remoteAddr}`)
    })
  }
}
