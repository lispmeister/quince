import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Reimplement introductions CRUD for testing (same as inbox.test.ts pattern — avoids bare-fs)

interface StoredIntroduction {
  pubkey: string
  alias?: string
  message?: string
  introducerPubkey: string
  introducerAlias?: string
  signature: string
  receivedAt: number
  status: 'pending' | 'accepted' | 'rejected'
}

function loadIntroductions(dir: string): StoredIntroduction[] {
  const filePath = path.join(dir, 'introductions.json')
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(content)
    }
  } catch {}
  return []
}

function saveIntroductions(dir: string, introductions: StoredIntroduction[]): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(dir, 'introductions.json'), JSON.stringify(introductions, null, 2))
}

function addIntroduction(dir: string, intro: StoredIntroduction): void {
  const introductions = loadIntroductions(dir)
  const idx = introductions.findIndex(i => i.pubkey === intro.pubkey && i.status === 'pending')
  if (idx !== -1) {
    introductions[idx] = intro
  } else {
    introductions.push(intro)
  }
  saveIntroductions(dir, introductions)
}

function getPendingIntroductions(dir: string): StoredIntroduction[] {
  return loadIntroductions(dir).filter(i => i.status === 'pending')
}

function getIntroduction(dir: string, pubkey: string): StoredIntroduction | null {
  const introductions = loadIntroductions(dir)
  return introductions.find(i => i.pubkey === pubkey && i.status === 'pending') ?? null
}

function acceptIntroduction(dir: string, pubkey: string): StoredIntroduction | null {
  const introductions = loadIntroductions(dir)
  const intro = introductions.find(i => i.pubkey === pubkey && i.status === 'pending')
  if (!intro) return null
  intro.status = 'accepted'
  saveIntroductions(dir, introductions)
  return intro
}

function rejectIntroduction(dir: string, pubkey: string): StoredIntroduction | null {
  const introductions = loadIntroductions(dir)
  const intro = introductions.find(i => i.pubkey === pubkey && i.status === 'pending')
  if (!intro) return null
  intro.status = 'rejected'
  saveIntroductions(dir, introductions)
  return intro
}

const ALICE_PUBKEY = 'a'.repeat(64)
const BOB_PUBKEY = 'b'.repeat(64)
const CAROL_PUBKEY = 'c'.repeat(64)

let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-intros-test-'))
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe('introductions CRUD', () => {
  test('empty file returns empty list', () => {
    expect(loadIntroductions(testDir)).toEqual([])
  })

  test('add and retrieve introduction', () => {
    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      alias: 'carol',
      introducerPubkey: ALICE_PUBKEY,
      introducerAlias: 'alice',
      signature: 'a'.repeat(128),
      receivedAt: Date.now(),
      status: 'pending'
    })

    const pending = getPendingIntroductions(testDir)
    expect(pending).toHaveLength(1)
    expect(pending[0].pubkey).toBe(CAROL_PUBKEY)
    expect(pending[0].alias).toBe('carol')
  })

  test('get specific introduction by pubkey', () => {
    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      alias: 'carol',
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: Date.now(),
      status: 'pending'
    })

    const intro = getIntroduction(testDir, CAROL_PUBKEY)
    expect(intro).not.toBeNull()
    expect(intro!.pubkey).toBe(CAROL_PUBKEY)
  })

  test('returns null for unknown pubkey', () => {
    expect(getIntroduction(testDir, 'd'.repeat(64))).toBeNull()
  })

  test('accept introduction changes status', () => {
    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: Date.now(),
      status: 'pending'
    })

    const accepted = acceptIntroduction(testDir, CAROL_PUBKEY)
    expect(accepted).not.toBeNull()
    expect(accepted!.status).toBe('accepted')

    // No longer in pending list
    expect(getPendingIntroductions(testDir)).toHaveLength(0)

    // Still in full list
    const all = loadIntroductions(testDir)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('accepted')
  })

  test('reject introduction changes status', () => {
    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: Date.now(),
      status: 'pending'
    })

    const rejected = rejectIntroduction(testDir, CAROL_PUBKEY)
    expect(rejected).not.toBeNull()
    expect(rejected!.status).toBe('rejected')

    expect(getPendingIntroductions(testDir)).toHaveLength(0)
  })

  test('accept returns null for unknown pubkey', () => {
    expect(acceptIntroduction(testDir, 'd'.repeat(64))).toBeNull()
  })

  test('reject returns null for unknown pubkey', () => {
    expect(rejectIntroduction(testDir, 'd'.repeat(64))).toBeNull()
  })

  test('duplicate pending intro replaces previous', () => {
    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      alias: 'carol-v1',
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: 1000,
      status: 'pending'
    })

    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      alias: 'carol-v2',
      introducerPubkey: BOB_PUBKEY,
      signature: 'b'.repeat(128),
      receivedAt: 2000,
      status: 'pending'
    })

    const pending = getPendingIntroductions(testDir)
    expect(pending).toHaveLength(1)
    expect(pending[0].alias).toBe('carol-v2')
    expect(pending[0].introducerPubkey).toBe(BOB_PUBKEY)
  })

  test('multiple pending introductions from different people', () => {
    addIntroduction(testDir, {
      pubkey: CAROL_PUBKEY,
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: 1000,
      status: 'pending'
    })

    addIntroduction(testDir, {
      pubkey: 'd'.repeat(64),
      alias: 'dave',
      introducerPubkey: ALICE_PUBKEY,
      signature: 'a'.repeat(128),
      receivedAt: 2000,
      status: 'pending'
    })

    expect(getPendingIntroductions(testDir)).toHaveLength(2)
  })
})
