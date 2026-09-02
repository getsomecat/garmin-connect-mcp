import garminConnectPackage from 'garmin-connect'
import type { Config, LogLevel } from '../config.js'
import { MemoryCache } from '../utils/cache.js'
import {
  garminApiHeaders,
  getSessionProfileIdentity,
  isDiSessionToken,
  loginForSession,
  parseSessionToken,
  refreshSessionToken,
  sessionNeedsRefresh,
  type GarminSessionToken,
} from './auth.js'
import {
  acquireSessionLease,
  assertBoundSessionAccount,
  assertBoundSessionProfile,
  createBoundDiSession,
  readPrivateSessionFile,
  SessionFileMissingError,
  updateBoundDiSession,
  writePrivateSessionFile,
  type BoundDiSessionFile,
  type SessionLease,
} from './session-store.js'

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
  private boundSessionFile: BoundDiSessionFile | undefined
  private sessionLease: SessionLease | undefined
  private sessionFileChecked = false

  constructor(private readonly config: Config) {
    this.client = this.createClient()
    this.cache = new MemoryCache(config.cacheTtlSeconds * 1_000, config.cacheMaxEntries)
    this.sessionToken = config.sessionToken ? parseSessionToken(config.sessionToken) : undefined
  }

  async connect(forcePasswordLogin = false): Promise<void> {
    if (
      this.connected
      && !forcePasswordLogin
      && (!this.sessionToken || !sessionNeedsRefresh(this.sessionToken))
    ) return
    if (!this.connecting) {
      this.connecting = this.login(forcePasswordLogin).finally(() => {
        this.connecting = undefined
      })
    }
    return this.connecting
  }

  async getActivities(offset = 0, limit = 10): Promise<unknown[]> {
    return this.cached(`activities:${offset}:${limit}`, async () => {
      if (!this.isDiSession()) return this.client.getActivities(offset, limit)
      return asArray(await this.apiGet('/activitylist-service/activities/search/activities', {
        start: offset,
        limit,
      }))
    })
  }

  async getSleep(date: string): Promise<unknown> {
    return this.cached(`sleep:${date}`, () => this.isDiSession()
      ? this.apiGet('/sleep-service/sleep/dailySleepData', { date })
      : this.client.getSleepData(toLocalDate(date)))
  }

  async getSteps(date: string): Promise<unknown> {
    return this.cached(`steps:${date}`, async () => {
      if (!this.isDiSession()) return this.client.getSteps(toLocalDate(date))
      const days = asArray(await this.apiGet(`/usersummary-service/stats/steps/daily/${date}/${date}`))
      return days.find((day) => asRecord(day).calendarDate === date)
        ?? { calendarDate: date, totalSteps: 0 }
    })
  }

  async getHeartRate(date: string): Promise<unknown> {
    return this.cached(`heart-rate:${date}`, () => this.isDiSession()
      ? this.apiGet('/wellness-service/wellness/dailyHeartRate', { date })
      : this.client.getHeartRate(toLocalDate(date)))
  }

  async getHrv(date: string): Promise<unknown> {
    return this.cached(`hrv:${date}`, () => this.apiGet(`/hrv-service/hrv/${date}`))
  }

  async getBodyBattery(startDate: string, endDate: string): Promise<unknown[]> {
    return this.cached(`body-battery:${startDate}:${endDate}`, async () => asArray(await this.apiGet(
      '/wellness-service/wellness/bodyBattery/reports/daily',
      { startDate, endDate },
    )))
  }

  async getTrainingReadiness(date: string): Promise<unknown> {
    return this.cached(`training-readiness:${date}`, () =>
      this.apiGet(`/metrics-service/metrics/trainingreadiness/${date}`))
  }

  async getTrainingStatus(date: string): Promise<unknown> {
    return this.cached(`training-status:${date}`, () =>
      this.apiGet(`/metrics-service/metrics/trainingstatus/aggregated/${date}`))
  }

  async getMaxMetrics(startDate: string, endDate: string): Promise<unknown> {
    return this.cached(`max-metrics:${startDate}:${endDate}`, () =>
      this.apiGet(`/metrics-service/metrics/maxmet/daily/${startDate}/${endDate}`))
  }

  async getWeight(date: string): Promise<unknown> {
    return this.cached(`weight:${date}`, () => this.isDiSession()
      ? this.apiGet(`/weight-service/weight/dayview/${date}`)
      : this.client.getDailyWeightData(toLocalDate(date)))
  }

  async getWorkouts(offset = 0, limit = 10): Promise<unknown[]> {
    return this.cached(`workouts:${offset}:${limit}`, async () => {
      if (!this.isDiSession()) return this.client.getWorkouts(offset, limit)
      return asArray(await this.apiGet('/workout-service/workouts', { start: offset, limit }))
    })
  }

  async getProfile(): Promise<unknown> {
    return this.cached('profile', () => this.isDiSession()
      ? this.apiGet('/userprofile-service/socialProfile')
      : this.client.getUserProfile())
  }

  async exportSession(): Promise<string> {
    await this.connect()
    return JSON.stringify(this.sessionToken ?? this.client.exportToken())
  }

  async close(): Promise<void> {
    await this.sessionLease?.release()
    this.sessionLease = undefined
  }

  private async cached<T>(key: string, request: () => Promise<T>): Promise<T> {
    return this.cache.getOrSet(key, () => this.withRetry(request))
  }

  private async login(forcePasswordLogin: boolean): Promise<void> {
    this.connected = false
    this.client = this.createClient()
    try {
      await this.loadSessionFileIfNeeded()
      if (this.sessionToken) {
        try {
          const token = await refreshSessionToken(
            this.sessionToken,
            this.config.region,
            forcePasswordLogin,
          )
          const profile = await getSessionProfileIdentity(token, this.config.region)
          if (this.boundSessionFile) {
            assertBoundSessionAccount(
              this.boundSessionFile,
              this.requiredUsername(),
              this.config.region,
            )
            assertBoundSessionProfile(this.boundSessionFile, profile.profileId)
          }
          await this.persistDiSession(token, profile.profileId)
          this.sessionToken = token
          this.loadSessionToken(token)
          this.log(
            'info',
            forcePasswordLogin ? 'Refreshed Garmin session token.' : 'Loaded Garmin session token.',
          )
        } catch (error) {
          if (!forcePasswordLogin || !this.config.username || !this.config.password) throw error
          this.log('warn', 'Session refresh failed; reconnecting with username/password.')
          const token = await this.loginWithPassword()
          const profile = await getSessionProfileIdentity(token, this.config.region)
          await this.persistDiSession(token, profile.profileId)
          this.sessionToken = token
          this.loadSessionToken(token)
        }
      } else {
        const token = await this.loginWithPassword()
        const profile = await getSessionProfileIdentity(token, this.config.region)
        await this.persistDiSession(token, profile.profileId)
        this.sessionToken = token
        this.loadSessionToken(token)
      }
      this.connected = true
    } catch (error) {
      this.connected = false
      throw error
    }
  }

  private async loginWithPassword(): Promise<GarminSessionToken> {
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
    return token
  }

  private async loadSessionFileIfNeeded(): Promise<void> {
    if (this.sessionToken || this.sessionFileChecked || !this.config.sessionTokenFile) return
    this.sessionFileChecked = true
    await this.ensureSessionLease()
    try {
      const loaded = await readPrivateSessionFile(this.config.sessionTokenFile)
      if (loaded.boundFile) {
        assertBoundSessionAccount(
          loaded.boundFile,
          this.requiredUsername(),
          this.config.region,
        )
      } else {
        this.log('warn', 'Loaded an unbound legacy session file; migrate it with npm run export-session.')
      }
      this.boundSessionFile = loaded.boundFile
      this.sessionToken = loaded.token
    } catch (error) {
      if (error instanceof SessionFileMissingError && this.config.password) return
      if (error instanceof SessionFileMissingError) {
        throw new Error(
          'Garmin DI session file is missing. Run npm run export-session, or configure GARMIN_PASSWORD for one-time bootstrap.',
        )
      }
      throw error
    }
  }

  private async persistDiSession(token: GarminSessionToken, profileId: number): Promise<void> {
    if (!this.config.sessionTokenFile || !isDiSessionToken(token)) return
    const username = this.requiredUsername()
    await this.ensureSessionLease()
    const candidate = this.boundSessionFile
      ? updateBoundDiSession(this.boundSessionFile, token)
      : createBoundDiSession(
          token,
          username,
          this.config.region,
          profileId,
        )
    assertBoundSessionAccount(
      candidate,
      username,
      this.config.region,
    )
    assertBoundSessionProfile(candidate, profileId)
    if (JSON.stringify(candidate) !== JSON.stringify(this.boundSessionFile)) {
      await writePrivateSessionFile(this.config.sessionTokenFile, candidate)
    }
    this.boundSessionFile = candidate
  }

  private async ensureSessionLease(): Promise<void> {
    if (this.sessionLease || !this.config.sessionTokenFile) return
    this.sessionLease = await acquireSessionLease(
      this.config.sessionTokenFile,
      this.requiredUsername(),
      this.config.region,
    )
  }

  private requiredUsername(): string {
    if (!this.config.username) {
      throw new Error('GARMIN_USERNAME is required for a private bound DI session file.')
    }
    return this.config.username
  }

  private loadSessionToken(token: GarminSessionToken): void {
    if (isDiSessionToken(token)) return
    this.client.loadToken(
      token.oauth1 as unknown as Parameters<GarminConnectClient['loadToken']>[0],
      token.oauth2 as unknown as Parameters<GarminConnectClient['loadToken']>[1],
    )
  }

  private isDiSession(): boolean {
    return Boolean(this.sessionToken && isDiSessionToken(this.sessionToken))
  }

  private async apiGet(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<unknown> {
    const session = this.sessionToken
    if (!session) throw new Error('A Garmin session is required for this API request.')

    const domain = this.config.region === 'cn' ? 'garmin.cn' : 'garmin.com'
    const url = new URL(`https://connectapi.${domain}${path}`)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value))

    if (!isDiSessionToken(session)) return this.client.get(url.toString())

    const response = await fetch(url, {
      headers: {
        ...garminApiHeaders(),
        Authorization: `Bearer ${session.access_token}`,
        Accept: 'application/json',
      },
    })
    if (!response.ok) throw new GarminHttpError(response)
    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      throw new Error(`Garmin API returned invalid JSON for ${path}.`)
    }
  }

  private async withRetry<T>(request: () => Promise<T>): Promise<T> {
    await this.connect()

    let authenticationRetried = false
    let rateLimitAttempts = 0
    for (;;) {
      try {
        return await request()
      } catch (error) {
        const status = httpStatus(error)

        if (status === 401 || status === 403) {
          if (authenticationRetried) throw error
          authenticationRetried = true
          this.log('warn', `Garmin returned ${status}; reconnecting.`)
          this.connected = false
          this.cache.clear()
          await this.connect(true)
          continue
        }

        if (status === 429) {
          if (rateLimitAttempts >= this.config.retryAttempts) throw error
          const retryAfter = retryAfterMs(error)
          const exponential = Math.min(
            this.config.retryBaseDelayMs * (2 ** rateLimitAttempts),
            this.config.retryMaxDelayMs,
          )
          rateLimitAttempts += 1
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

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Garmin API returned an unexpected non-array response.')
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

class GarminHttpError extends Error {
  readonly status: number
  readonly response: { status: number; headers: Record<string, string> }

  constructor(response: Response) {
    super(`Garmin API request failed with HTTP ${response.status}.`)
    this.name = 'GarminHttpError'
    this.status = response.status
    const headers: Record<string, string> = {}
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) headers['retry-after'] = retryAfter
    this.response = { status: response.status, headers }
  }
}
