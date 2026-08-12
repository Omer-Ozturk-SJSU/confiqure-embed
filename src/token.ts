export async function fetchToken(tokenUrl: string, endUserHandle: string, configEnd: string): Promise<string> {
  const params = new URLSearchParams({ endUserHandle, configEnd })
  const res = await fetch(`${tokenUrl}?${params}`, { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`Token fetch failed: ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  if (!data.token || typeof data.token !== 'string') {
    throw new Error('Token endpoint must return { token: "..." }')
  }
  return data.token
}

export interface TokenClaims {
  workspaceKey: string
  configEnd: string
  /**
   * #322 — standard JWT expiry, epoch SECONDS, or null when the token carries none.
   * Reading it host-side is not a trust decision (the server re-verifies the signed token on
   * every call); it is only how the SDK knows when to quietly re-mint before the chat dies.
   */
  exp: number | null
}

export function decodeTokenClaims(token: string): TokenClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    return {
      workspaceKey: payload.workspaceKey ?? '',
      configEnd: payload.configEnd ?? '',
      exp: typeof payload.exp === 'number' ? payload.exp : null
    }
  } catch {
    return null
  }
}
