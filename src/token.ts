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

export function decodeTokenClaims(token: string): { workspaceKey: string; configEnd: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    return {
      workspaceKey: payload.workspaceKey ?? '',
      configEnd: payload.configEnd ?? ''
    }
  } catch {
    return null
  }
}
