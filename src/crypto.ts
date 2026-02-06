import crypto from 'hypercore-crypto'
import b4a from 'b4a'

const SIGNATURE_HEADER = 'X-Quince-Signature'

function splitHeadersAndBody(mime: string): { headers: string; body: string } | null {
  // MIME separates headers from body with a blank line (\r\n\r\n)
  const sep = mime.indexOf('\r\n\r\n')
  if (sep === -1) return null
  return {
    headers: mime.slice(0, sep),
    body: mime.slice(sep + 4)
  }
}

function hashBody(body: string): Buffer {
  return crypto.hash(b4a.from(body, 'utf8'))
}

/**
 * Sign a MIME message by hashing its body and injecting an X-Quince-Signature header.
 * Returns the MIME string with the signature header added.
 */
export function signMessage(mime: string, secretKey: string): string {
  const parts = splitHeadersAndBody(mime)
  if (!parts) return mime  // malformed MIME, pass through unsigned

  const hash = hashBody(parts.body)
  const sig = crypto.sign(hash, b4a.from(secretKey, 'hex'))
  const sigHex = b4a.toString(sig, 'hex')

  return `${parts.headers}\r\n${SIGNATURE_HEADER}: ${sigHex}\r\n\r\n${parts.body}`
}

/**
 * Verify a MIME message signature. Strips the X-Quince-Signature header and
 * returns the clean MIME along with the verification result.
 */
export function verifyMessage(mime: string, senderPubkey: string): { mime: string; valid: boolean } {
  const parts = splitHeadersAndBody(mime)
  if (!parts) return { mime, valid: false }

  // Extract signature header
  const headerLines = parts.headers.split('\r\n')
  const sigLine = headerLines.find(l => l.startsWith(`${SIGNATURE_HEADER}:`))

  if (!sigLine) return { mime, valid: false }

  const sigHex = sigLine.slice(SIGNATURE_HEADER.length + 1).trim()
  if (!/^[a-f0-9]{128}$/i.test(sigHex)) return { mime, valid: false }

  // Rebuild headers without the signature line
  const cleanHeaders = headerLines.filter(l => !l.startsWith(`${SIGNATURE_HEADER}:`)).join('\r\n')
  const cleanMime = `${cleanHeaders}\r\n\r\n${parts.body}`

  const hash = hashBody(parts.body)
  const sig = b4a.from(sigHex, 'hex')
  const pubkey = b4a.from(senderPubkey, 'hex')
  const valid = crypto.verify(hash, sig, pubkey)

  return { mime: cleanMime, valid }
}
