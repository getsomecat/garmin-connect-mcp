import { config as loadDotenv } from 'dotenv'

loadDotenv({ quiet: true })

export type GarminRegion = 'global' | 'cn'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ActivityDetail = 'compact' | 'full'

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionToken = optional(env.GARMIN_SESSION_TOKEN)
  const username = optional(env.GARMIN_USERNAME)
  const password = optional(env.GARMIN_PASSWORD)

  if (!sessionToken && !(username && password)) {
    throw new Error(
      'Garmin credentials are missing. Set GARMIN_SESSION_TOKEN, or set both GARMIN_USERNAME and GARMIN_PASSWORD.',
    )
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
