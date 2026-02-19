const DEFAULT_DIRECTORY_URL = 'https://quincemail.com'

export interface DirectoryEntry {
  pubkey: string
  username: string
}

/**
 * Look up a username in the quincemail.com directory.
 * Returns the entry if found, or null on 404, network error, or any non-200.
 */
export async function lookupUsername(
  username: string,
  directoryUrl?: string
): Promise<DirectoryEntry | null> {
  const base = directoryUrl ?? DEFAULT_DIRECTORY_URL
  const url = `${base}/api/directory/lookup?username=${encodeURIComponent(username)}`

  try {
    const response = await fetch(url)

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      console.error(`Directory lookup failed: HTTP ${response.status}`)
      return null
    }

    const data = await response.json() as unknown
    if (
      typeof data !== 'object' || data === null ||
      typeof (data as Record<string, unknown>).pubkey !== 'string' ||
      typeof (data as Record<string, unknown>).username !== 'string'
    ) {
      console.error('Directory lookup returned unexpected response shape')
      return null
    }

    const entry = data as { pubkey: string; username: string }
    return {
      pubkey: entry.pubkey.toLowerCase(),
      username: entry.username
    }
  } catch (err) {
    console.error(`Directory lookup error for '${username}': ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Register this daemon's identity in the directory.
 * Returns true on success, false on any error.
 */
export async function registerIdentity(
  username: string,
  pubkey: string,
  signature: string,
  directoryUrl?: string
): Promise<boolean> {
  const base = directoryUrl ?? DEFAULT_DIRECTORY_URL
  const url = `${base}/api/directory/register`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pubkey, signature })
    })

    if (!response.ok) {
      console.error(`Directory registration failed: HTTP ${response.status}`)
      return false
    }

    return true
  } catch (err) {
    console.error(`Directory registration error: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
