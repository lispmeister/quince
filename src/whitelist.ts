import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { generateId } from './utils.js'

export interface WhitelistRule {
  id: string
  type: 'address' | 'domain' | 'listId'
  value: string
  createdAt: number
}

export interface LegacyWhitelist {
  rules: WhitelistRule[]
}

const GATE_DIR = path.join(os.homedir(), '.quince', 'gate')
const WHITELIST_FILE = path.join(GATE_DIR, 'whitelist.json')

function ensureGateDir(): void {
  if (!fs.existsSync(GATE_DIR)) {
    fs.mkdirSync(GATE_DIR, { recursive: true })
  }
}

export function loadWhitelist(): LegacyWhitelist {
  try {
    if (fs.existsSync(WHITELIST_FILE)) {
      const content = fs.readFileSync(WHITELIST_FILE, 'utf8') as string
      return JSON.parse(content)
    }
  } catch (err) {
    console.error('Failed to load whitelist:', err)
  }
  return { rules: [] }
}

export function saveWhitelist(whitelist: LegacyWhitelist): void {
  ensureGateDir()
  try {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2))
  } catch (err) {
    console.error('Failed to save whitelist:', err)
  }
}

export function addWhitelistRule(type: WhitelistRule['type'], value: string): WhitelistRule {
  const whitelist = loadWhitelist()
  const rule: WhitelistRule = {
    id: generateId(),
    type,
    value,
    createdAt: Date.now()
  }
  whitelist.rules.push(rule)
  saveWhitelist(whitelist)
  return rule
}

export function removeWhitelistRule(id: string): boolean {
  const whitelist = loadWhitelist()
  const before = whitelist.rules.length
  whitelist.rules = whitelist.rules.filter(r => r.id !== id)
  if (whitelist.rules.length < before) {
    saveWhitelist(whitelist)
    return true
  }
  return false
}

export function listWhitelistRules(): WhitelistRule[] {
  return loadWhitelist().rules
}

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function matchDomain(pattern: string, senderDomain: string): boolean {
  const p = pattern.toLowerCase()
  const d = senderDomain.toLowerCase()

  if (p.startsWith('*.')) {
    const base = p.slice(2) // e.g. "bank.com" from "*.bank.com"
    return d === base || d.endsWith('.' + base)
  }
  return d === p
}

export function matchesWhitelist(senderAddress: string, headers: string): boolean {
  const whitelist = loadWhitelist()
  const sender = senderAddress.toLowerCase()
  const senderDomain = sender.split('@')[1] || ''

  for (const rule of whitelist.rules) {
    switch (rule.type) {
      case 'address':
        if (sender === rule.value.toLowerCase()) return true
        break
      case 'domain':
        if (matchDomain(rule.value, senderDomain)) return true
        break
      case 'listId': {
        const listId = extractHeader(headers, 'List-ID') || extractHeader(headers, 'List-Id')
        if (listId.toLowerCase().includes(rule.value.toLowerCase())) return true
        break
      }
    }
  }
  return false
}
