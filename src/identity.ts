import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { getConfigDir, ensureConfigDir } from './config.js'

export const EMAIL_DOMAIN = 'quincemail.com'

export interface Identity {
  publicKey: string  // 64 hex chars (32 bytes)
  secretKey: string  // 128 hex chars (64 bytes)
}

interface KeyPair {
  publicKey: Buffer
  secretKey: Buffer
}

const IDENTITY_FILE = 'identity.json'

export function getIdentityPath(): string {
  return path.join(getConfigDir(), IDENTITY_FILE)
}

export function validatePublicKey(pubkey: string): string | null {
  if (!pubkey) return 'Public key is required'
  if (typeof pubkey !== 'string') return 'Public key must be a string'
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) {
    return 'Public key must be 64 hexadecimal characters'
  }
  return null
}

export function generateIdentity(): Identity {
  const keyPair: KeyPair = crypto.keyPair()
  return {
    publicKey: b4a.toString(keyPair.publicKey, 'hex'),
    secretKey: b4a.toString(keyPair.secretKey, 'hex')
  }
}

export function loadIdentity(): Identity {
  const identityPath = getIdentityPath()

  try {
    if (fs.existsSync(identityPath)) {
      const content = fs.readFileSync(identityPath, 'utf8') as string
      const parsed = JSON.parse(content)

      // Validate loaded identity
      const pubkeyError = validatePublicKey(parsed.publicKey)
      if (pubkeyError) {
        console.error(`Invalid identity file: ${pubkeyError}`)
        console.error('Generating new identity...')
        const identity = generateIdentity()
        saveIdentity(identity)
        return identity
      }

      if (!parsed.secretKey || typeof parsed.secretKey !== 'string' || !/^[a-f0-9]{128}$/i.test(parsed.secretKey)) {
        console.error('Invalid identity file: malformed secret key')
        console.error('Generating new identity...')
        const identity = generateIdentity()
        saveIdentity(identity)
        return identity
      }

      return {
        publicKey: parsed.publicKey.toLowerCase(),
        secretKey: parsed.secretKey.toLowerCase()
      }
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`Invalid JSON in identity file ${identityPath}:`, err.message)
    } else {
      console.error('Failed to load identity:', err)
    }
    console.error('Generating new identity...')
  }

  // No identity file exists, generate new one
  const identity = generateIdentity()
  saveIdentity(identity)
  return identity
}

export function saveIdentity(identity: Identity): void {
  const pubkeyError = validatePublicKey(identity.publicKey)
  if (pubkeyError) {
    console.error(`Cannot save invalid identity: ${pubkeyError}`)
    return
  }

  ensureConfigDir()
  const identityPath = getIdentityPath()

  try {
    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2))
  } catch (err) {
    console.error('Failed to save identity:', err)
  }
}

export function getEmailAddress(username: string, publicKey: string): string {
  return `${username}@${publicKey.toLowerCase()}.${EMAIL_DOMAIN}`
}

export interface ParsedAddress {
  username: string
  publicKey?: string  // 64 hex chars if direct pubkey
  alias?: string      // friendly alias if not a pubkey
}

export function parseEmailDomain(address: string): ParsedAddress | null {
  // Parse: user@<subdomain>.quincemail.com
  const match = address.match(/^([^@]+)@([^.]+)\.quincemail\.com$/i)
  if (!match || !match[1] || !match[2]) return null

  const subdomain = match[2]

  // Check if subdomain is a 64-char hex pubkey
  if (/^[a-f0-9]{64}$/i.test(subdomain)) {
    return {
      username: match[1],
      publicKey: subdomain.toLowerCase()
    }
  }

  // Otherwise treat as alias
  return {
    username: match[1],
    alias: subdomain.toLowerCase()
  }
}

export function getSwarmTopic(publicKey: string): Buffer {
  // Use the public key directly as the swarm topic
  return b4a.from(publicKey, 'hex')
}
