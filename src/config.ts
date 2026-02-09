import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { validatePublicKey } from './identity.js'

export interface Config {
  username?: string
  smtpPort?: number
  pop3Port?: number
  httpPort?: number
  peers?: Record<string, string>  // alias -> pubkey
  trustIntroductions?: Record<string, boolean>  // alias -> whether to auto-accept their introductions
}

export interface ConfigValidationError {
  field: string
  message: string
}

const CONFIG_DIR = path.join(os.homedir(), '.quince')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function validateAlias(alias: string): string | null {
  if (!alias) return 'Alias is required'
  if (typeof alias !== 'string') return 'Alias must be a string'
  if (alias.length === 0) return 'Alias cannot be empty'
  if (alias.length > 32) return 'Alias must be 32 characters or less'
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    return 'Alias can only contain letters, numbers, dots, underscores, and hyphens'
  }
  // Alias must not look like a pubkey (64 hex chars)
  if (/^[a-f0-9]{64}$/i.test(alias)) {
    return 'Alias cannot be a 64-character hex string (looks like a pubkey)'
  }
  return null
}

export function validateConfig(config: unknown): ConfigValidationError[] {
  const errors: ConfigValidationError[] = []

  if (typeof config !== 'object' || config === null) {
    errors.push({ field: 'config', message: 'Config must be an object' })
    return errors
  }

  const c = config as Record<string, unknown>

  if (c.username !== undefined) {
    if (typeof c.username !== 'string') {
      errors.push({ field: 'username', message: 'Username must be a string' })
    } else if (c.username.length === 0) {
      errors.push({ field: 'username', message: 'Username cannot be empty' })
    } else if (!/^[a-zA-Z0-9._-]+$/.test(c.username)) {
      errors.push({ field: 'username', message: 'Username can only contain letters, numbers, dots, underscores, and hyphens' })
    }
  }

  if (c.smtpPort !== undefined) {
    if (typeof c.smtpPort !== 'number') {
      errors.push({ field: 'smtpPort', message: 'SMTP port must be a number' })
    } else if (!Number.isInteger(c.smtpPort) || c.smtpPort < 1 || c.smtpPort > 65535) {
      errors.push({ field: 'smtpPort', message: 'SMTP port must be an integer between 1 and 65535' })
    }
  }

  if (c.httpPort !== undefined) {
    if (typeof c.httpPort !== 'number') {
      errors.push({ field: 'httpPort', message: 'HTTP port must be a number' })
    } else if (!Number.isInteger(c.httpPort) || c.httpPort < 1 || c.httpPort > 65535) {
      errors.push({ field: 'httpPort', message: 'HTTP port must be an integer between 1 and 65535' })
    }
  }

  if (c.peers !== undefined) {
    if (typeof c.peers !== 'object' || c.peers === null || Array.isArray(c.peers)) {
      errors.push({ field: 'peers', message: 'Peers must be an object' })
    } else {
      const peers = c.peers as Record<string, unknown>
      for (const [alias, pubkey] of Object.entries(peers)) {
        const aliasError = validateAlias(alias)
        if (aliasError) {
          errors.push({ field: `peers.${alias}`, message: aliasError })
        }
        if (typeof pubkey !== 'string') {
          errors.push({ field: `peers.${alias}`, message: 'Pubkey must be a string' })
        } else {
          const pubkeyError = validatePublicKey(pubkey)
          if (pubkeyError) {
            errors.push({ field: `peers.${alias}`, message: pubkeyError })
          }
        }
      }
    }
  }

  if (c.trustIntroductions !== undefined) {
    if (typeof c.trustIntroductions !== 'object' || c.trustIntroductions === null || Array.isArray(c.trustIntroductions)) {
      errors.push({ field: 'trustIntroductions', message: 'trustIntroductions must be an object' })
    } else {
      const trust = c.trustIntroductions as Record<string, unknown>
      for (const [alias, value] of Object.entries(trust)) {
        if (typeof value !== 'boolean') {
          errors.push({ field: `trustIntroductions.${alias}`, message: 'Value must be a boolean' })
        }
      }
    }
  }

  return errors
}

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8') as string
      const parsed = JSON.parse(content)

      const errors = validateConfig(parsed)
      if (errors.length > 0) {
        console.error(`Config validation errors in ${CONFIG_FILE}:`)
        for (const err of errors) {
          console.error(`  - ${err.field}: ${err.message}`)
        }
        console.error('Using default values for invalid fields.')
        // Return only valid fields
        const config: Config = {}
        if (typeof parsed.username === 'string' && parsed.username.length > 0 &&
            /^[a-zA-Z0-9._-]+$/.test(parsed.username)) {
          config.username = parsed.username
        }
        if (typeof parsed.smtpPort === 'number' && Number.isInteger(parsed.smtpPort) &&
            parsed.smtpPort >= 1 && parsed.smtpPort <= 65535) {
          config.smtpPort = parsed.smtpPort
        }
        if (typeof parsed.pop3Port === 'number' && Number.isInteger(parsed.pop3Port) &&
            parsed.pop3Port >= 1 && parsed.pop3Port <= 65535) {
          config.pop3Port = parsed.pop3Port
        }
        if (typeof parsed.httpPort === 'number' && Number.isInteger(parsed.httpPort) &&
            parsed.httpPort >= 1 && parsed.httpPort <= 65535) {
          config.httpPort = parsed.httpPort
        }
        // Only keep individually-valid peers
        if (typeof parsed.peers === 'object' && parsed.peers !== null && !Array.isArray(parsed.peers)) {
          const validPeers: Record<string, string> = {}
          for (const [alias, pubkey] of Object.entries(parsed.peers as Record<string, unknown>)) {
            if (!validateAlias(alias) && typeof pubkey === 'string' && !validatePublicKey(pubkey)) {
              validPeers[alias] = (pubkey as string).toLowerCase()
            }
          }
          if (Object.keys(validPeers).length > 0) {
            config.peers = validPeers
          }
        }
        // Keep valid trustIntroductions entries
        if (typeof parsed.trustIntroductions === 'object' && parsed.trustIntroductions !== null && !Array.isArray(parsed.trustIntroductions)) {
          const validTrust: Record<string, boolean> = {}
          for (const [alias, value] of Object.entries(parsed.trustIntroductions as Record<string, unknown>)) {
            if (typeof value === 'boolean') {
              validTrust[alias] = value
            }
          }
          if (Object.keys(validTrust).length > 0) {
            config.trustIntroductions = validTrust
          }
        }
        return config
      }

      // Normalize peer pubkeys to lowercase
      if (parsed.peers) {
        for (const alias of Object.keys(parsed.peers)) {
          parsed.peers[alias] = parsed.peers[alias].toLowerCase()
        }
      }

      return parsed as Config
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`Invalid JSON in config file ${CONFIG_FILE}:`, err.message)
    } else {
      console.error('Failed to load config:', err)
    }
  }
  return {}
}

export function saveConfig(config: Config): boolean {
  const errors = validateConfig(config)
  if (errors.length > 0) {
    console.error('Cannot save invalid config:')
    for (const err of errors) {
      console.error(`  - ${err.field}: ${err.message}`)
    }
    return false
  }

  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    return true
  } catch (err) {
    console.error('Failed to save config:', err)
    return false
  }
}

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

// Peer management helpers
export function addPeer(config: Config, alias: string, pubkey: string): Config {
  const peers = { ...config.peers }
  peers[alias] = pubkey.toLowerCase()
  return { ...config, peers }
}

export function removePeer(config: Config, alias: string): Config {
  const peers = { ...config.peers }
  delete peers[alias]
  return { ...config, peers }
}

export function getPeerPubkey(config: Config, alias: string): string | undefined {
  return config.peers?.[alias]
}

export function getPeerAlias(config: Config, pubkey: string): string | undefined {
  if (!config.peers) return undefined
  const normalizedPubkey = pubkey.toLowerCase()
  for (const [alias, pk] of Object.entries(config.peers)) {
    if (pk === normalizedPubkey) return alias
  }
  return undefined
}
