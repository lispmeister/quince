import crypto from 'hypercore-crypto'

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
  return crypto.hash(Buffer.from(body, 'utf8'))
}

/**
 * Sign a MIME message by hashing its body and injecting an X-Quince-Signature header.
 * Returns the MIME string with the signature header added.
 */
export function signMessage(mime: string, secretKey: string): string {
  const parts = splitHeadersAndBody(mime)
  if (!parts) return mime  // malformed MIME, pass through unsigned

  const hash = hashBody(parts.body)
  const sig = crypto.sign(hash, Buffer.from(secretKey, 'hex'))
  const sigHex = sig.toString('hex')

  return `${parts.headers}\r\n${SIGNATURE_HEADER}: ${sigHex}\r\n\r\n${parts.body}`
}

/**
 * Verify a MIME message signature. Returns the original MIME (with
 * X-Quince-Signature header preserved) along with the verification result.
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

  const hash = hashBody(parts.body)
  const sig = Buffer.from(sigHex, 'hex')
  const pubkey = Buffer.from(senderPubkey, 'hex')
  const valid = crypto.verify(hash, sig, pubkey)

  return { mime, valid }
}

/**
 * Sign an introduction payload. The introduced object is JSON-stringified,
 * BLAKE2b-hashed, then Ed25519-signed — same pattern as message signing.
 */
export function signIntroduction(introduced: Record<string, unknown>, secretKey: string): string {
  const data = JSON.stringify(introduced)
  const hash = crypto.hash(Buffer.from(data, 'utf8'))
  const sig = crypto.sign(hash, Buffer.from(secretKey, 'hex'))
  return sig.toString('hex')
}

/**
 * Verify an introduction signature against the introducer's public key.
 */
export function verifyIntroduction(introduced: Record<string, unknown>, signature: string, introducerPubkey: string): boolean {
  if (!/^[a-f0-9]{128}$/i.test(signature)) return false
  const data = JSON.stringify(introduced)
  const hash = crypto.hash(Buffer.from(data, 'utf8'))
  const sig = Buffer.from(signature, 'hex')
  const pubkey = Buffer.from(introducerPubkey, 'hex')
  return crypto.verify(hash, sig, pubkey)
}
