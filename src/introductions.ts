import fs from 'bare-fs'
import path from 'bare-path'
import { getConfigDir, ensureConfigDir } from './config.js'
import type { PeerCapabilities } from './transport/types.js'

export interface StoredIntroduction {
  pubkey: string
  alias?: string
  capabilities?: PeerCapabilities
  message?: string
  introducerPubkey: string
  introducerAlias?: string
  signature: string
  receivedAt: number
  status: 'pending' | 'accepted' | 'rejected'
}

const INTRODUCTIONS_FILE = 'introductions.json'

function getIntroductionsPath(): string {
  return path.join(getConfigDir(), INTRODUCTIONS_FILE)
}

export function loadIntroductions(): StoredIntroduction[] {
  const filePath = getIntroductionsPath()
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8') as string
      return JSON.parse(content)
    }
  } catch (err) {
    console.error('Failed to load introductions:', err)
  }
  return []
}

export function saveIntroductions(introductions: StoredIntroduction[]): void {
  ensureConfigDir()
  const filePath = getIntroductionsPath()
  try {
    fs.writeFileSync(filePath, JSON.stringify(introductions, null, 2))
  } catch (err) {
    console.error('Failed to save introductions:', err)
  }
}

export function addIntroduction(intro: StoredIntroduction): void {
  const introductions = loadIntroductions()
  // Replace if same pubkey already pending
  const idx = introductions.findIndex(i => i.pubkey === intro.pubkey && i.status === 'pending')
  if (idx !== -1) {
    introductions[idx] = intro
  } else {
    introductions.push(intro)
  }
  saveIntroductions(introductions)
}

export function getPendingIntroductions(): StoredIntroduction[] {
  return loadIntroductions().filter(i => i.status === 'pending')
}

export function getIntroduction(pubkey: string): StoredIntroduction | null {
  const introductions = loadIntroductions()
  return introductions.find(i => i.pubkey === pubkey && i.status === 'pending') ?? null
}

export function acceptIntroduction(pubkey: string): StoredIntroduction | null {
  const introductions = loadIntroductions()
  const intro = introductions.find(i => i.pubkey === pubkey && i.status === 'pending')
  if (!intro) return null
  intro.status = 'accepted'
  saveIntroductions(introductions)
  return intro
}

export function rejectIntroduction(pubkey: string): StoredIntroduction | null {
  const introductions = loadIntroductions()
  const intro = introductions.find(i => i.pubkey === pubkey && i.status === 'pending')
  if (!intro) return null
  intro.status = 'rejected'
  saveIntroductions(introductions)
  return intro
}
