import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'

export interface FileRef {
  name: string       // "photo.jpg"
  uri: string        // "quince:/media/photo.jpg"
}

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/

const URI_PATTERN = /quince:\/media\/([a-zA-Z0-9._-]+)/g

export function getMediaDir(): string {
  return path.join(os.homedir(), '.quince', 'media')
}

export function getReceivedMediaDir(senderAlias: string): string {
  return path.join(getMediaDir(), senderAlias)
}

export function ensureMediaDirs(senderAlias?: string): void {
  const mediaDir = getMediaDir()
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true })
  }
  if (senderAlias) {
    const receivedDir = getReceivedMediaDir(senderAlias)
    if (!fs.existsSync(receivedDir)) {
      fs.mkdirSync(receivedDir, { recursive: true })
    }
  }
}

export function parseFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  const seen = new Set<string>()

  // Reset lastIndex for global regex
  URI_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URI_PATTERN.exec(text)) !== null) {
    const name = match[1]!
    if (seen.has(name)) continue
    seen.add(name)

    // Reject path traversal
    if (name.includes('..') || name.startsWith('/') || !SAFE_FILENAME.test(name)) {
      continue
    }

    refs.push({ name, uri: match[0] })
  }

  return refs
}

export function validateFileRefs(refs: FileRef[]): { valid: FileRef[]; missing: FileRef[] } {
  const mediaDir = getMediaDir()
  const valid: FileRef[] = []
  const missing: FileRef[] = []

  for (const ref of refs) {
    const filePath = path.join(mediaDir, ref.name)
    if (fs.existsSync(filePath)) {
      valid.push(ref)
    } else {
      missing.push(ref)
    }
  }

  return { valid, missing }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function transformFileRefs(
  body: string,
  senderAlias: string,
  files: Array<{ name: string; size: number }>
): string {
  let result = body
  for (const file of files) {
    const uri = `quince:/media/${file.name}`
    const localPath = path.join(getReceivedMediaDir(senderAlias), file.name)
    const replacement = `[${file.name} — ${formatSize(file.size)}] → ${localPath}`
    result = result.split(uri).join(replacement)
  }
  return result
}
