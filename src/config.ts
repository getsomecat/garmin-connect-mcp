import { config as loadDotenv } from 'dotenv'

loadDotenv({ quiet: true })

export type GarminRegion = 'global' | 'cn'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ActivityDetail = 'compact' | 'full'
export type McpTransport = 'stdio' | 'http'

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionToken = optional(env.GARMIN_SESSION_TOKEN)
  const username = optional(env.GARMIN_USERNAME)
  const password = optional(env.GARMIN_PASSWORD)
  const transport = oneOf(env.MCP_TRANSPORT, ['stdio', 'http'], 'stdio', 'MCP_TRANSPORT')
  const bearerToken = optional(env.MCP_BEARER_TOKEN)

  if (!sessionToken && !(username && password)) {
    throw new Error(
      'Garmin credentials are missing. Set GARMIN_SESSION_TOKEN, or set both GARMIN_USERNAME and GARMIN_PASSWORD.',
    )
  }
  if (transport === 'http' && (!bearerToken || Buffer.byteLength(bearerToken, 'utf8') < 32)) {
    throw new Error('MCP_BEARER_TOKEN must be at least 32 bytes when MCP_TRANSPORT=http.')
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
    httpPath: httpPath(env.MCP_HTTP_PATH),
    ...(bearerToken ? { bearerToken } : {}),
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
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
