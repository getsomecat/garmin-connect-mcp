import { config as loadDotenv } from 'dotenv'

loadDotenv({ quiet: true })

export type GarminRegion = 'global' | 'cn'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ActivityDetail = 'compact' | 'full'
export type McpTransport = 'stdio' | 'http'

export interface OAuthConfig {
  publicUrl: URL
  issuerUrl: URL
  passwordHash: string
  stateFile: string
  allowedRedirectUris: string[]
  accessTokenTtlSeconds: number
  refreshTokenTtlSeconds: number
}

export interface Config {
  username?: string
  password?: string
  sessionToken?: string
  region: GarminRegion
  cacheTtlSeconds: number
  cacheMaxEntries: number
  retryAttempts: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  activityDetail: ActivityDetail
  logLevel: LogLevel
  transport: McpTransport
  httpHost: string
  httpPort: number
  httpPath: string
  bearerToken?: string
  oauth?: OAuthConfig
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionToken = optional(env.GARMIN_SESSION_TOKEN)
    ?? base64Secret(env.GARMIN_SESSION_TOKEN_B64, 'GARMIN_SESSION_TOKEN_B64')
  const username = optional(env.GARMIN_USERNAME)
  const password = optional(env.GARMIN_PASSWORD)
  const transport = oneOf(env.MCP_TRANSPORT, ['stdio', 'http'], 'stdio', 'MCP_TRANSPORT')
  const bearerToken = optional(env.MCP_BEARER_TOKEN)
  const oauth = oauthConfig(env)
  const configuredHttpPath = httpPath(env.MCP_HTTP_PATH)

  if (!sessionToken && !(username && password)) {
    throw new Error(
      'Garmin credentials are missing. Set GARMIN_SESSION_TOKEN, or set both GARMIN_USERNAME and GARMIN_PASSWORD.',
    )
  }
  if (bearerToken && Buffer.byteLength(bearerToken, 'utf8') < 32) {
    throw new Error('MCP_BEARER_TOKEN must be at least 32 bytes when set.')
  }
  if (transport === 'http' && !bearerToken && !oauth) {
    throw new Error(
      'HTTP transport requires MCP_BEARER_TOKEN, or the complete MCP OAuth configuration.',
    )
  }
  if (oauth && oauth.publicUrl.pathname !== configuredHttpPath) {
    throw new Error('The path in MCP_PUBLIC_URL must match MCP_HTTP_PATH.')
  }

  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    region: oneOf(env.GARMIN_REGION, ['global', 'cn'], 'global', 'GARMIN_REGION'),
    cacheTtlSeconds: integer(env.GARMIN_CACHE_TTL, 300, 0, 86_400, 'GARMIN_CACHE_TTL'),
    cacheMaxEntries: integer(env.GARMIN_CACHE_MAX_ENTRIES, 100, 1, 10_000, 'GARMIN_CACHE_MAX_ENTRIES'),
    retryAttempts: integer(env.GARMIN_RETRY_ATTEMPTS, 3, 0, 10, 'GARMIN_RETRY_ATTEMPTS'),
    retryBaseDelayMs: integer(env.GARMIN_RETRY_BASE_DELAY_MS, 1_000, 100, 60_000, 'GARMIN_RETRY_BASE_DELAY_MS'),
    retryMaxDelayMs: integer(env.GARMIN_RETRY_MAX_DELAY_MS, 30_000, 100, 300_000, 'GARMIN_RETRY_MAX_DELAY_MS'),
    activityDetail: oneOf(
      env.GARMIN_ACTIVITY_DETAIL,
      ['compact', 'full'],
      'compact',
      'GARMIN_ACTIVITY_DETAIL',
    ),
    logLevel: oneOf(env.GARMIN_LOG_LEVEL, ['debug', 'info', 'warn', 'error'], 'info', 'GARMIN_LOG_LEVEL'),
    transport,
    httpHost: optional(env.MCP_HTTP_HOST) ?? '127.0.0.1',
    httpPort: integer(env.MCP_HTTP_PORT, 3_100, 1, 65_535, 'MCP_HTTP_PORT'),
    httpPath: configuredHttpPath,
    ...(bearerToken ? { bearerToken } : {}),
    ...(oauth ? { oauth } : {}),
  }
}

function oauthConfig(env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  const publicUrlValue = optional(env.MCP_PUBLIC_URL)
  const passwordHash = optional(env.MCP_OAUTH_PASSWORD_HASH)
  const stateFile = optional(env.MCP_OAUTH_STATE_FILE)
  const configured = [publicUrlValue, passwordHash, stateFile].filter(Boolean).length

  if (configured === 0) return undefined
  if (!publicUrlValue || !passwordHash || !stateFile) {
    throw new Error(
      'OAuth requires MCP_PUBLIC_URL, MCP_OAUTH_PASSWORD_HASH, and MCP_OAUTH_STATE_FILE together.',
    )
  }

  const publicUrl = absoluteUrl(publicUrlValue, 'MCP_PUBLIC_URL')
  if (publicUrl.hash || publicUrl.search || publicUrl.username || publicUrl.password) {
    throw new Error('MCP_PUBLIC_URL cannot contain credentials, a query string, or a fragment.')
  }
  const normalizedPath = publicUrl.pathname.replace(/\/$/, '') || '/'
  publicUrl.pathname = normalizedPath

  const insecureLocalhost = publicUrl.protocol === 'http:'
    && (publicUrl.hostname === '127.0.0.1' || publicUrl.hostname === 'localhost')
  if (publicUrl.protocol !== 'https:' && !insecureLocalhost) {
    throw new Error('MCP_PUBLIC_URL must use HTTPS (HTTP is allowed only for localhost tests).')
  }

  const issuerValue = optional(env.MCP_OAUTH_ISSUER)
  const issuerUrl = issuerValue
    ? absoluteUrl(issuerValue, 'MCP_OAUTH_ISSUER')
    : new URL('/', publicUrl)
  if (issuerUrl.hash || issuerUrl.search || issuerUrl.username || issuerUrl.password) {
    throw new Error('MCP_OAUTH_ISSUER cannot contain credentials, a query string, or a fragment.')
  }
  if (issuerUrl.protocol !== publicUrl.protocol || issuerUrl.host !== publicUrl.host) {
    throw new Error('MCP_OAUTH_ISSUER must use the same origin as MCP_PUBLIC_URL.')
  }

  const allowedRedirectUris = csv(env.MCP_OAUTH_ALLOWED_REDIRECT_URIS)
  const redirects = allowedRedirectUris.length > 0
    ? allowedRedirectUris
    : ['https://chatgpt.com/connector_platform_oauth_redirect']
  for (const redirect of redirects) absoluteUrl(redirect, 'MCP_OAUTH_ALLOWED_REDIRECT_URIS')

  if (!passwordHash.startsWith('scrypt$')) {
    throw new Error('MCP_OAUTH_PASSWORD_HASH must be generated by npm run hash-oauth-password.')
  }

  return {
    publicUrl,
    issuerUrl,
    passwordHash,
    stateFile,
    allowedRedirectUris: redirects,
    accessTokenTtlSeconds: integer(
      env.MCP_OAUTH_ACCESS_TOKEN_TTL,
      3_600,
      300,
      86_400,
      'MCP_OAUTH_ACCESS_TOKEN_TTL',
    ),
    refreshTokenTtlSeconds: integer(
      env.MCP_OAUTH_REFRESH_TOKEN_TTL,
      7_776_000,
      3_600,
      31_536_000,
      'MCP_OAUTH_REFRESH_TOKEN_TTL',
    ),
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function base64Secret(value: string | undefined, name: string): string | undefined {
  const encoded = optional(value)
  if (!encoded) return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim()
    if (!decoded) throw new Error('empty value')
    return decoded
  } catch {
    throw new Error(`${name} must contain a valid non-empty base64 value.`)
  }
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function absoluteUrl(value: string, name: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new Error(`${name} must contain an absolute URL.`)
  }
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return parsed
}

function oneOf<const T extends readonly string[]>(
  value: string | undefined,
  choices: T,
  fallback: T[number],
  name: string,
): T[number] {
  if (value === undefined || value.trim() === '') return fallback
  if (!choices.includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(', ')}.`)
  }
  return value as T[number]
}

function httpPath(value: string | undefined): string {
  const path = optional(value) ?? '/mcp'
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes(' ')) {
    throw new Error('MCP_HTTP_PATH must be an absolute URL path without a query string or fragment.')
  }
  if (path === '/healthz') {
    throw new Error('MCP_HTTP_PATH cannot use the reserved /healthz path.')
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
