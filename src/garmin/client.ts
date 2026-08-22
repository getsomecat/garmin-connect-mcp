import garminConnectPackage from 'garmin-connect'
import type { Config, LogLevel } from '../config.js'
import { MemoryCache } from '../utils/cache.js'
import {
  loginForSession,
  parseSessionToken,
  refreshSessionToken,
  type GarminSessionToken,
} from './auth.js'

const { GarminConnect } = garminConnectPackage
type GarminConnectClient = InstanceType<typeof GarminConnect>

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export class GarminClient {
  private client: GarminConnectClient
  private readonly cache: MemoryCache
  private connected = false
  private connecting: Promise<void> | undefined
  private sessionToken: GarminSessionToken | undefined

  constructor(private readonly config: Config) {
    this.client = this.createClient()
    this.cache = new MemoryCache(config.cacheTtlSeconds * 1_000, config.cacheMaxEntries)
    this.sessionToken = config.sessionToken ? parseSessionToken(config.sessionToken) : undefined
  }

  async connect(forcePasswordLogin = false): Promise<void> {
    if (this.connected && !forcePasswordLogin) return
    if (!this.connecting) {
      this.connecting = this.login(forcePasswordLogin).finally(() => {
        this.connecting = undefined
      })
    }
    return this.connecting
  }

  async getActivities(offset = 0, limit = 10): Promise<unknown[]> {
    return this.cached(`activities:${offset}:${limit}`, () => this.client.getActivities(offset, limit))
  }

  async getSleep(date: string): Promise<unknown> {
    return this.cached(`sleep:${date}`, () => this.client.getSleepData(toLocalDate(date)))
  }

  async getSteps(date: string): Promise<unknown> {
    return this.cached(`steps:${date}`, () => this.client.getSteps(toLocalDate(date)))
  }

  async getHeartRate(date: string): Promise<unknown> {
    return this.cached(`heart-rate:${date}`, () => this.client.getHeartRate(toLocalDate(date)))
  }

  async getWeight(date: string): Promise<unknown> {
    return this.cached(`weight:${date}`, () => this.client.getDailyWeightData(toLocalDate(date)))
  }

  async getWorkouts(offset = 0, limit = 10): Promise<unknown[]> {
    return this.cached(`workouts:${offset}:${limit}`, () => this.client.getWorkouts(offset, limit))
  }

  async getProfile(): Promise<unknown> {
    return this.cached('profile', () => this.client.getUserProfile())
  }

  async exportSession(): Promise<string> {
    await this.connect()
    return JSON.stringify(this.sessionToken ?? this.client.exportToken())
  }

  private async cached<T>(key: string, request: () => Promise<T>): Promise<T> {
    return this.cache.getOrSet(key, () => this.withRetry(request))
  }

  private async login(forcePasswordLogin: boolean): Promise<void> {
    this.connected = false
    this.client = this.createClient()
    try {
      if (this.sessionToken) {
        try {
          const token = await refreshSessionToken(
            this.sessionToken,
            this.config.region,
            forcePasswordLogin,
          )
          this.sessionToken = token
          this.loadSessionToken(token)
          this.log(
            'info',
            forcePasswordLogin ? 'Refreshed Garmin session token.' : 'Loaded Garmin session token.',
          )
        } catch (error) {
          if (!forcePasswordLogin || !this.config.username || !this.config.password) throw error
          this.log('warn', 'Session refresh failed; reconnecting with username/password.')
          await this.loginWithPassword()
        }
      } else {
        await this.loginWithPassword()
      }
      this.connected = true
    } catch (error) {
      this.connected = false
      throw error
    }
  }

  private async loginWithPassword(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      throw new Error('The Garmin session expired and username/password fallback is not configured.')
    }

    this.log('info', 'Logging in to Garmin Connect with username/password.')
    const token = await loginForSession(
      this.config.username,
      this.config.password,
      this.config.region,
      async (method) => {
        throw new Error(
          `Garmin requires MFA (${method}). Run scripts/export-session.ts interactively and configure GARMIN_SESSION_TOKEN.`,
        )
      },
    )
    this.sessionToken = token
    this.loadSessionToken(token)
  }

  private loadSessionToken(token: GarminSessionToken): void {
    this.client.loadToken(
      token.oauth1 as unknown as Parameters<GarminConnectClient['loadToken']>[0],
      token.oauth2 as unknown as Parameters<GarminConnectClient['loadToken']>[1],
    )
  }

  private async withRetry<T>(request: () => Promise<T>): Promise<T> {
    await this.connect()

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request()
      } catch (error) {
        const status = httpStatus(error)
        if (attempt >= this.config.retryAttempts) throw error

        if (status === 401 || status === 403) {
          this.log('warn', `Garmin returned ${status}; reconnecting.`)
          this.connected = false
          this.cache.clear()
          await this.connect(true)
          continue
        }

        if (status === 429) {
          const retryAfter = retryAfterMs(error)
          const exponential = Math.min(
            this.config.retryBaseDelayMs * (2 ** attempt),
            this.config.retryMaxDelayMs,
          )
          const delay = Math.min(retryAfter ?? exponential, this.config.retryMaxDelayMs)
          this.log('warn', `Garmin rate limit reached; retrying in ${delay}ms.`)
          await sleep(delay)
          continue
        }

        throw error
      }
    }
  }

  private createClient(): GarminConnectClient {
    return new GarminConnect(
      {
        username: this.config.username ?? '',
        password: this.config.password ?? '',
      },
      this.config.region === 'cn' ? 'garmin.cn' : 'garmin.com',
    )
  }

  private log(level: LogLevel, message: string): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.logLevel]) return
    console.error(`[garmin-connect-mcp] ${level.toUpperCase()}: ${message}`)
  }
}

function toLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid date: ${value}. Expected YYYY-MM-DD.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return new Date(year, month - 1, day, 12)
}

function httpStatus(error: unknown): number | undefined {
  const object = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    message?: unknown
  }
  const candidate = object?.response?.status ?? object?.status ?? object?.statusCode
  const number = Number(candidate)
  if (Number.isInteger(number)) return number
  const match = typeof object?.message === 'string' ? /\b(401|403|429)\b/.exec(object.message) : null
  return match ? Number(match[1]) : undefined
}

function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers
  const raw = headers?.['retry-after']
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const timestamp = Date.parse(String(raw))
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now())
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
