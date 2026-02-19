import crypto from 'hypercore-crypto'

export function generateId(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function encodeBase64(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64')
}

export function decodeBase64(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8')
}
