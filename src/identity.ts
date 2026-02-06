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

const ID_FILE = 'id'
const ID_PUB_FILE = 'id_pub'

export function getIdentityPath(): string {
  return path.join(getConfigDir(), ID_FILE)
}

export function getPublicKeyPath(): string {
  return path.join(getConfigDir(), ID_PUB_FILE)
}

export function validatePublicKey(pubkey: string): string | null {
  if (!pubkey) return 'Public key is required'
  if (typeof pubkey !== 'string') return 'Public key must be a string'
  if (!/^[a-f0-9]{64}$/i.test(pubkey)) {
    return 'Public key must be 64 hexadecimal characters'
  }
  return null
}

function validateSecretKey(secretKey: string): boolean {
  return typeof secretKey === 'string' && /^[a-f0-9]{128}$/i.test(secretKey)
}

export function generateIdentity(): Identity {
  const keyPair: KeyPair = crypto.keyPair()
  return {
    publicKey: b4a.toString(keyPair.publicKey, 'hex'),
    secretKey: b4a.toString(keyPair.secretKey, 'hex')
  }
}

export function saveIdentity(identity: Identity): void {
  const pubkeyError = validatePublicKey(identity.publicKey)
  if (pubkeyError) {
    console.error(`Cannot save invalid identity: ${pubkeyError}`)
    return
  }

  ensureConfigDir()
  const idPath = getIdentityPath()
  const pubPath = getPublicKeyPath()

  try {
    fs.writeFileSync(idPath, identity.secretKey)
    fs.chmodSync(idPath, 0o600)
    fs.writeFileSync(pubPath, identity.publicKey)
  } catch (err) {
    console.error('Failed to save identity:', err)
  }
}

export function loadIdentity(): Identity {
  const idPath = getIdentityPath()
  const pubPath = getPublicKeyPath()

  // Load from key files
  try {
    if (fs.existsSync(idPath) && fs.existsSync(pubPath)) {
      const secretKey = (fs.readFileSync(idPath, 'utf8') as string).trim()
      const publicKey = (fs.readFileSync(pubPath, 'utf8') as string).trim()

      const pubErr = validatePublicKey(publicKey)
      if (pubErr) {
        console.error(`Invalid id_pub file: ${pubErr}`)
        console.error('Generating new identity...')
        const identity = generateIdentity()
        saveIdentity(identity)
        return identity
      }

      if (!validateSecretKey(secretKey)) {
        console.error('Invalid id file: malformed secret key')
        console.error('Generating new identity...')
        const identity = generateIdentity()
        saveIdentity(identity)
        return identity
      }

      return {
        publicKey: publicKey.toLowerCase(),
        secretKey: secretKey.toLowerCase()
      }
    }
  } catch (err) {
    console.error('Failed to load identity:', err)
    console.error('Generating new identity...')
  }

  // No identity files exist, generate new one
  const identity = generateIdentity()
  saveIdentity(identity)
  return identity
}

export function checkIdentityPermissions(): string | null {
  const idPath = getIdentityPath()

  try {
    if (!fs.existsSync(idPath)) return null

    const stat = fs.statSync(idPath)
    const perms = stat.mode & 0o777

    if (perms !== 0o600) {
      const octal = '0' + perms.toString(8)
      return `Private key file has permissions ${octal}, expected 0600.\n` +
        `Fix with: chmod 600 ${idPath}`
    }
  } catch (err) {
    return `Cannot check permissions on ${idPath}: ${err}`
  }

  return null
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
