import crypto from 'hypercore-crypto'
import b4a from 'b4a'

export function generateId(): string {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

export function encodeBase64(data: string): string {
  return b4a.toString(b4a.from(data, 'utf8'), 'base64')
}

export function decodeBase64(data: string): string {
  return b4a.toString(b4a.from(data, 'base64'), 'utf8')
}
