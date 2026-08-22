import crypto from 'node:crypto'
import OAuth from 'oauth-1.0a'
import type { GarminRegion } from '../config.js'

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
const IOS_SSO_CLIENT_ID = 'GCM_IOS_DARK'
const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const MOBILE_USER_AGENT = 'com.garmin.android.apps.connectmobile'
const NATIVE_API_USER_AGENT = 'GCM-Android-5.23'
const NATIVE_X_GARMIN_USER_AGENT =
  'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0'
const DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
] as const
const DI_GRANT_TYPE =
  'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket'
const TOKEN_REFRESH_BUFFER_SECONDS = 15 * 60

export interface OAuth1Token {
  oauth_token: string
  oauth_token_secret: string
  mfa_token?: string
  domain?: string
  [key: string]: unknown
}

export interface OAuth2Token {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  expires_at: number
  refresh_token_expires_in?: number
  refresh_token_expires_at?: number
  [key: string]: unknown
}

export interface GarminLegacySessionToken {
  auth_type?: 'oauth1'
  oauth1: OAuth1Token
  oauth2: OAuth2Token
}

export interface GarminDiSessionToken {
  auth_type: 'di'
  version: 2
  access_token: string
  refresh_token: string
  client_id: string
  expires_at: number
  token_type: 'Bearer'
}

export type GarminSessionToken = GarminLegacySessionToken | GarminDiSessionToken
export type MfaPrompt = (method: string) => Promise<string>

interface GarminEndpoints {
  sso: string
  iosIntegration: string
  connectApi: string
  diAuth: string
  diGrantType: string
}

interface OAuthConsumer {
  consumer_key: string
  consumer_secret: string
}

/**
 * Authenticate through Garmin's current iOS mobile SSO flow, then exchange the
 * service ticket for a refreshable DI bearer token accepted by Connect API.
 */
export async function loginForSession(
  username: string,
  password: string,
  region: GarminRegion,
  promptMfa: MfaPrompt,
): Promise<GarminDiSessionToken> {
  const endpoints = garminEndpoints(region)
  const ticket = await getMobileLoginTicket(username, password, endpoints, promptMfa)
  const session = await exchangeServiceTicket(ticket, endpoints)
  await validateSession(session, endpoints)
  return session
}

export async function refreshSessionToken(
  session: GarminSessionToken,
  region: GarminRegion,
  force = false,
): Promise<GarminSessionToken> {
  if (!force && !sessionNeedsRefresh(session)) return session

  const endpoints = garminEndpoints(region)
  if (isDiSessionToken(session)) {
    const refreshed = await refreshDiSession(session, endpoints)
    await validateSession(refreshed, endpoints)
    return refreshed
  }

  const consumer = await fetchOAuthConsumer()
  const oauth2 = await exchangeOAuth1ForOAuth2(session.oauth1, endpoints, consumer)
  const refreshed: GarminLegacySessionToken = { oauth1: session.oauth1, oauth2 }
  await validateSession(refreshed, endpoints)
  return refreshed
}

export function parseSessionToken(value: string): GarminSessionToken {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('GARMIN_SESSION_TOKEN must be valid JSON from scripts/export-session.ts.')
  }

  const token = object(parsed)
  if (!token) throw new Error('GARMIN_SESSION_TOKEN must contain a JSON object.')

  if (token.auth_type === 'di') {
    if (
      typeof token.access_token !== 'string'
      || typeof token.refresh_token !== 'string'
      || typeof token.client_id !== 'string'
    ) {
      throw new Error('GARMIN_SESSION_TOKEN contains an invalid DI session.')
    }
    return {
      auth_type: 'di',
      version: 2,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      client_id: token.client_id,
      expires_at: finiteTimestamp(token.expires_at) ?? jwtExpiry(token.access_token) ?? 0,
      token_type: 'Bearer',
    }
  }

  const oauth1 = object(token.oauth1)
  const oauth2 = object(token.oauth2)
  if (
    !oauth1
    || !oauth2
    || typeof oauth1.oauth_token !== 'string'
    || typeof oauth1.oauth_token_secret !== 'string'
    || typeof oauth2.access_token !== 'string'
  ) {
    throw new Error('GARMIN_SESSION_TOKEN contains neither a valid DI nor OAuth1/OAuth2 session.')
  }

  return {
    oauth1: oauth1 as OAuth1Token,
    oauth2: {
      ...(oauth2 as OAuth2Token),
      expires_at: finiteTimestamp(oauth2.expires_at) ?? 0,
    },
  }
}

export function isDiSessionToken(session: GarminSessionToken): session is GarminDiSessionToken {
  return session.auth_type === 'di'
}

export function sessionNeedsRefresh(session: GarminSessionToken): boolean {
  const expiresAt = isDiSessionToken(session) ? session.expires_at : session.oauth2.expires_at
  return expiresAt <= Math.floor(Date.now() / 1_000) + TOKEN_REFRESH_BUFFER_SECONDS
}

export function garminApiHeaders(): Record<string, string> {
  return {
    'User-Agent': NATIVE_API_USER_AGENT,
    'X-Garmin-User-Agent': NATIVE_X_GARMIN_USER_AGENT,
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'X-GCExperience': 'GC5',
    'Accept-Language': 'en-US,en;q=0.9',
  }
}

async function getMobileLoginTicket(
  username: string,
  password: string,
  endpoints: GarminEndpoints,
  promptMfa: MfaPrompt,
): Promise<string> {
  const jar = new CookieJar()
  const loginParams = new URLSearchParams({
    clientId: IOS_SSO_CLIENT_ID,
    locale: 'en-US',
    service: endpoints.iosIntegration,
  })
  const headers = {
    'User-Agent': IOS_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: endpoints.sso,
  }

  const response = await cookieFetch(`${endpoints.sso}/mobile/api/login?${loginParams}`, jar, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username,
      password,
      rememberMe: true,
      captchaToken: '',
    }),
  })
  const payload = await authResponseJson(response, 'Garmin mobile login')
  const status = responseStatus(payload)

  if (status.type === 'SUCCESSFUL') return serviceTicket(payload)
  if (status.type === 'INVALID_USERNAME_PASSWORD') {
    throw new GarminAuthenticationError('Garmin rejected the email or password.', 401)
  }
  if (status.type === 'CAPTCHA_REQUIRED') {
    throw new GarminAuthenticationError('Garmin requires a CAPTCHA; sign in on connect.garmin.com first.', 403)
  }
  if (status.type !== 'MFA_REQUIRED') {
    throw new GarminAuthenticationError(
      `Garmin mobile login failed (${status.type}, HTTP ${response.status}).`,
      response.status,
    )
  }

  const mfaInfo = object(object(payload)?.customerMfaInfo)
  const method = typeof mfaInfo?.mfaLastMethodUsed === 'string' ? mfaInfo.mfaLastMethodUsed : 'email'
  const code = (await promptMfa(method)).trim()
  if (!code) throw new GarminAuthenticationError('MFA code cannot be empty.')

  const mfaResponse = await cookieFetch(
    `${endpoints.sso}/mobile/api/mfa/verifyCode?${loginParams}`,
    jar,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mfaMethod: method,
        mfaVerificationCode: code,
        rememberMyBrowser: true,
        reconsentList: [],
        mfaSetup: false,
      }),
    },
  )
  const mfaPayload = await authResponseJson(mfaResponse, 'Garmin MFA verification')
  const mfaStatus = responseStatus(mfaPayload)
  if (mfaStatus.type !== 'SUCCESSFUL') {
    throw new GarminAuthenticationError(
      `Garmin MFA verification failed (${mfaStatus.type}, HTTP ${mfaResponse.status}).`,
      mfaResponse.status,
    )
  }
  return serviceTicket(mfaPayload)
}

async function exchangeServiceTicket(
  ticket: string,
  endpoints: GarminEndpoints,
): Promise<GarminDiSessionToken> {
  let lastStatus: number | undefined
  for (const clientId of DI_CLIENT_IDS) {
    const response = await fetch(endpoints.diAuth, {
      method: 'POST',
      headers: {
        ...garminApiHeaders(),
        Authorization: `Basic ${Buffer.from(`${clientId}:`, 'utf8').toString('base64')}`,
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        client_id: clientId,
        service_ticket: ticket,
        grant_type: endpoints.diGrantType,
        service_url: endpoints.iosIntegration,
      }),
    })
    lastStatus = response.status
    if (response.status === 429) {
      throw new GarminAuthenticationError('Garmin DI token exchange was rate limited.', 429)
    }
    if (!response.ok) continue

    const payload = object(await responseJson(response, 'Garmin DI token exchange'))
    if (!payload || typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') {
      continue
    }
    return diSessionFromPayload(payload, clientId)
  }
  throw new GarminAuthenticationError(
    'Garmin DI token exchange failed for all supported client IDs.',
    lastStatus,
  )
}

async function refreshDiSession(
  session: GarminDiSessionToken,
  endpoints: GarminEndpoints,
): Promise<GarminDiSessionToken> {
  const response = await fetch(endpoints.diAuth, {
    method: 'POST',
    headers: {
      ...garminApiHeaders(),
      Authorization: `Basic ${Buffer.from(`${session.client_id}:`, 'utf8').toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: session.client_id,
      refresh_token: session.refresh_token,
    }),
  })
  const payload = object(await responseJson(response, 'Garmin DI token refresh'))
  if (!payload || typeof payload.access_token !== 'string') {
    throw new GarminAuthenticationError('Garmin DI token refresh returned an invalid token.')
  }
  return diSessionFromPayload(
    { ...payload, refresh_token: payload.refresh_token ?? session.refresh_token },
    session.client_id,
  )
}

function diSessionFromPayload(
  payload: Record<string, unknown>,
  fallbackClientId: string,
): GarminDiSessionToken {
  const accessToken = String(payload.access_token)
  const refreshToken = String(payload.refresh_token)
  const clientId = jwtStringClaim(accessToken, 'client_id') ?? fallbackClientId
  const expiresIn = Number(payload.expires_in)
  const expiresAt = jwtExpiry(accessToken)
    ?? Math.floor(Date.now() / 1_000) + (Number.isFinite(expiresIn) ? expiresIn : 3_600)
  return {
    auth_type: 'di',
    version: 2,
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    expires_at: expiresAt,
    token_type: 'Bearer',
  }
}

async function validateSession(
  session: GarminSessionToken,
  endpoints: GarminEndpoints,
): Promise<void> {
  const accessToken = isDiSessionToken(session) ? session.access_token : session.oauth2.access_token
  const response = await fetch(`${endpoints.connectApi}/userprofile-service/socialProfile`, {
    headers: {
      ...garminApiHeaders(),
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  await ensureResponseOk(response, 'Garmin session validation')
}

async function exchangeOAuth1ForOAuth2(
  oauth1: OAuth1Token,
  endpoints: GarminEndpoints,
  consumer: OAuthConsumer,
): Promise<OAuth2Token> {
  const url = `${endpoints.connectApi}/oauth-service/oauth/exchange/user/2.0`
  const form: Record<string, string> = {}
  if (oauth1.mfa_token) form.mfa_token = oauth1.mfa_token

  const oauth = oauthClient(consumer)
  const authorization = oauth.authorize(
    { url, method: 'POST', data: form },
    { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret },
  )
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...oauth.toHeader(authorization),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': MOBILE_USER_AGENT,
    },
    body: new URLSearchParams(form),
  })
  const payload = object(await responseJson(response, 'Garmin OAuth2 refresh'))
  if (!payload || typeof payload.access_token !== 'string') {
    throw new GarminAuthenticationError('Garmin OAuth2 refresh returned an invalid token.')
  }

  const now = Math.floor(Date.now() / 1_000)
  const expiresIn = Number(payload.expires_in)
  const refreshExpiresIn = Number(payload.refresh_token_expires_in)
  return {
    ...(payload as OAuth2Token),
    access_token: payload.access_token,
    expires_at: now + (Number.isFinite(expiresIn) ? expiresIn : 0),
    ...(Number.isFinite(refreshExpiresIn)
      ? { refresh_token_expires_at: now + refreshExpiresIn }
      : {}),
  }
}

async function fetchOAuthConsumer(): Promise<OAuthConsumer> {
  const response = await fetch(OAUTH_CONSUMER_URL)
  const payload = object(await responseJson(response, 'Garmin OAuth consumer lookup'))
  if (
    !payload
    || typeof payload.consumer_key !== 'string'
    || typeof payload.consumer_secret !== 'string'
  ) {
    throw new GarminAuthenticationError('Garmin OAuth consumer lookup returned invalid data.')
  }
  return { consumer_key: payload.consumer_key, consumer_secret: payload.consumer_secret }
}

function oauthClient(consumer: OAuthConsumer): OAuth {
  return new OAuth({
    consumer: { key: consumer.consumer_key, secret: consumer.consumer_secret },
    signature_method: 'HMAC-SHA1',
    hash_function: (baseString, key) =>
      crypto.createHmac('sha1', key).update(baseString).digest('base64'),
  })
}

function garminEndpoints(region: GarminRegion): GarminEndpoints {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com'
  return {
    sso: `https://sso.${domain}`,
    iosIntegration: `https://mobile.integration.${domain}/gcm/ios`,
    connectApi: `https://connectapi.${domain}`,
    diAuth: `https://diauth.${domain}/di-oauth2-service/oauth/token`,
    diGrantType: DI_GRANT_TYPE,
  }
}

async function cookieFetch(url: string, jar: CookieJar, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('Cookie', cookie)
  const response = await fetch(url, { ...init, headers })
  jar.update(response.headers)
  return response
}

class CookieJar {
  private readonly values = new Map<string, string>()

  update(headers: Headers): void {
    const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] }
    const values = cookieHeaders.getSetCookie?.() ?? splitSetCookie(headers.get('set-cookie'))
    for (const value of values) {
      const pair = value.split(';', 1)[0]
      if (!pair) continue
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const content = pair.slice(separator + 1).trim()
      if (content) this.values.set(name, content)
      else this.values.delete(name)
    }
  }

  header(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

function splitSetCookie(value: string | null): string[] {
  return value ? value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/) : []
}

async function authResponseJson(response: Response, operation: string): Promise<unknown> {
  if (response.status === 429) {
    throw new GarminAuthenticationError(`${operation} was rate limited.`, 429)
  }
  if (response.status === 403) {
    throw new GarminAuthenticationError(`${operation} was blocked by Garmin.`, 403)
  }
  try {
    return await response.json()
  } catch {
    throw new GarminAuthenticationError(
      `${operation} returned an unexpected response (HTTP ${response.status}).`,
      response.status,
    )
  }
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  await ensureResponseOk(response, operation)
  try {
    return await response.json()
  } catch {
    throw new GarminAuthenticationError(`${operation} returned an unexpected response.`)
  }
}

async function ensureResponseOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return
  throw new GarminAuthenticationError(`${operation} failed with HTTP ${response.status}.`, response.status)
}

function responseStatus(value: unknown): { type: string } {
  const status = object(object(value)?.responseStatus)
  return { type: typeof status?.type === 'string' ? status.type : 'UNKNOWN' }
}

function serviceTicket(value: unknown): string {
  const ticket = object(value)?.serviceTicketId
  if (typeof ticket !== 'string' || !ticket) {
    throw new GarminAuthenticationError('Garmin login succeeded without returning a service ticket.')
  }
  return ticket
}

function jwtExpiry(token: string): number | undefined {
  const value = jwtClaim(token, 'exp')
  const expiry = Number(value)
  return Number.isFinite(expiry) && expiry > 0 ? Math.floor(expiry) : undefined
}

function jwtStringClaim(token: string, name: string): string | undefined {
  const value = jwtClaim(token, name)
  return typeof value === 'string' && value ? value : undefined
}

function jwtClaim(token: string, name: string): unknown {
  try {
    const parts = token.split('.')
    if (parts.length < 2 || !parts[0] || !parts[1]) return undefined
    const header = object(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')))
    if (!header || header.alg === 'none') return undefined
    const payload = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
    return payload?.[name]
  } catch {
    return undefined
  }
}

function finiteTimestamp(value: unknown): number | undefined {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp) : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

class GarminAuthenticationError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GarminAuthenticationError'
    this.status = status
  }
}
