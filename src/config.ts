import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'

export interface Config {
  defaultRoom?: string
  username?: string
  smtpPort?: number
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

export function validateRoomId(roomId: string): string | null {
  if (!roomId) return 'Room ID is required'
  if (typeof roomId !== 'string') return 'Room ID must be a string'
  if (!/^[a-f0-9]{64}$/i.test(roomId)) {
    return 'Room ID must be 64 hexadecimal characters'
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

  if (c.defaultRoom !== undefined) {
    const roomError = validateRoomId(c.defaultRoom as string)
    if (roomError) {
      errors.push({ field: 'defaultRoom', message: roomError })
    }
  }

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
        if (parsed.defaultRoom && !validateRoomId(parsed.defaultRoom)) {
          config.defaultRoom = parsed.defaultRoom.toLowerCase()
        }
        if (typeof parsed.username === 'string' && parsed.username.length > 0) {
          config.username = parsed.username
        }
        if (typeof parsed.smtpPort === 'number' && parsed.smtpPort >= 1 && parsed.smtpPort <= 65535) {
          config.smtpPort = parsed.smtpPort
        }
        return config
      }

      // Normalize room ID to lowercase
      if (parsed.defaultRoom) {
        parsed.defaultRoom = parsed.defaultRoom.toLowerCase()
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

export function saveConfig(config: Config): void {
  const errors = validateConfig(config)
  if (errors.length > 0) {
    console.error('Cannot save invalid config:')
    for (const err of errors) {
      console.error(`  - ${err.field}: ${err.message}`)
    }
    return
  }

  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}
