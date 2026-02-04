export interface SmtpTransaction {
  from: string | null
  to: string | null
  data: string | null
}

export interface SmtpCommand {
  command: string
  argument: string
}

export type SmtpState = 'GREETING' | 'READY' | 'MAIL' | 'RCPT' | 'DATA'
