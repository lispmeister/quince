import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'

export interface Config {
  defaultRoom?: string
  username?: string
  smtpPort?: number
}

const CONFIG_DIR = path.join(os.homedir(), '.pear-mail')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8') as string
      return JSON.parse(content) as Config
    }
  } catch (err) {
    console.error('Failed to load config:', err)
  }
  return {}
}

export function saveConfig(config: Config): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}
