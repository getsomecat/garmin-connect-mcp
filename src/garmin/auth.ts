import crypto from 'node:crypto'
import OAuth from 'oauth-1.0a'
import type { GarminRegion } from '../config.js'

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
const MOBILE_CLIENT_ID = 'GCM_ANDROID_DARK'
const MOBILE_AUDIENCE = 'GARMIN_CONNECT_MOBILE_ANDROID_DI'
const MOBILE_USER_AGENT = 'com.garmin.android.apps.connectmobile'
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const TOKEN_REFRESH_BUFFER_SECONDS = 60

const SSO_PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'User-Agent': BROWSER_USER_AGENT,
}

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

export interface GarminSessionToken {
  oauth1: OAuth1Token
  oauth2: OAuth2Token
}

export type MfaPrompt = (method: string) => Promise<string>

interface GarminEndpoints {
  sso: string
  integration: string
  connectApi: string
}

interface OAuthConsumer {
  consumer_key: string
  consumer_secret: string
}

/**
 * Perform Garmin's mobile SSO flow and return tokens compatible with
 * `garmin-connect.loadToken()`. The flow follows the public protocol behavior
 * documented by the MIT-licensed garth and garmin-connect projects.
 */
export async function loginForSession(
  username: string,
  password: string,
  region: GarminRegion,
  promptMfa: MfaPrompt,
): Promise<GarminSessionToken> {
  const endpoints = garminEndpoints(region)
  const ticket = await getLoginTicket(username, password, endpoints, promptMfa)
  const consumer = await fetchOAuthConsumer()
  const oauth1 = await exchangeTicketForOAuth1(ticket, endpoints, consumer)
  const oauth2 = await exchangeOAuth1ForOAuth2(oauth1, endpoints, consumer, true)
  const session = { oauth1, oauth2 }
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
  const consumer = await fetchOAuthConsumer()
  const oauth2 = await exchangeOAuth1ForOAuth2(session.oauth1, endpoints, consumer, false)
  const refreshed = { oauth1: session.oauth1, oauth2 }
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

  const session = object(parsed)
  const oauth1 = object(session?.oauth1)
  const oauth2 = object(session?.oauth2)
  if (
    !session ||
    !oauth1 ||
    !oauth2 ||
    typeof oauth1.oauth_token !== 'string' ||
    typeof oauth1.oauth_token_secret !== 'string' ||
    typeof oauth2.access_token !== 'string'
  ) {
    throw new Error('GARMIN_SESSION_TOKEN must contain valid oauth1 and oauth2 token objects.')
  }

  const expiresAt = Number(oauth2.expires_at)
  return {
    oauth1: oauth1 as OAuth1Token,
    oauth2: {
      ...(oauth2 as OAuth2Token),
      expires_at: Number.isFinite(expiresAt) ? expiresAt : 0,
    },
  }
}

function sessionNeedsRefresh(session: GarminSessionToken): boolean {
  return session.oauth2.expires_at <= Math.floor(Date.now() / 1_000) + TOKEN_REFRESH_BUFFER_SECONDS
}

async function getLoginTicket(
  username: string,
  password: string,
  endpoints: GarminEndpoints,
  promptMfa: MfaPrompt,
): Promise<string> {
  const jar = new CookieJar()
  const loginParams = new URLSearchParams({
    clientId: MOBILE_CLIENT_ID,
    locale: 'en-US',
    service: endpoints.integration,
  })

  await cookieFetch(
    `${endpoints.sso}/mobile/sso/en/sign-in?${new URLSearchParams({ clientId: MOBILE_CLIENT_ID })}`,
    jar,
    { headers: { ...SSO_PAGE_HEADERS, 'Sec-Fetch-Site': 'none' } },
  )

  const loginResponse = await cookieFetch(
    `${endpoints.sso}/mobile/api/login?${loginParams}`,
    jar,
    {
      method: 'POST',
      headers: { ...SSO_PAGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        rememberMe: false,
        captchaToken: '',
      }),
    },
  )
  const loginPayload = await responseJson(loginResponse, 'Garmin login')
  const loginStatus = responseStatus(loginPayload)

  if (loginStatus.type === 'SUCCESSFUL') return serviceTicket(loginPayload)
  if (loginStatus.type !== 'MFA_REQUIRED') {
    const detail = loginStatus.message ? `: ${loginStatus.message}` : ''
    throw new GarminAuthenticationError(`Garmin rejected the login (${loginStatus.type}${detail}).`)
  }

  const mfaInfo = object(object(loginPayload)?.customerMfaInfo)
  const method = typeof mfaInfo?.mfaLastMethodUsed === 'string' ? mfaInfo.mfaLastMethodUsed : 'email'
  const code = (await promptMfa(method)).trim()
  if (!code) throw new GarminAuthenticationError('MFA code cannot be empty.')

  const mfaResponse = await cookieFetch(
    `${endpoints.sso}/mobile/api/mfa/verifyCode?${loginParams}`,
    jar,
    {
      method: 'POST',
      headers: { ...SSO_PAGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mfaMethod: method,
        mfaVerificationCode: code,
        rememberMyBrowser: false,
        reconsentList: [],
        mfaSetup: false,
      }),
    },
  )
  const mfaPayload = await responseJson(mfaResponse, 'Garmin MFA verification')
  const mfaStatus = responseStatus(mfaPayload)
  if (mfaStatus.type !== 'SUCCESSFUL') {
    throw new GarminAuthenticationError(`Garmin MFA verification failed (${mfaStatus.type}).`)
  }
  return serviceTicket(mfaPayload)
}

async function exchangeTicketForOAuth1(
  ticket: string,
  endpoints: GarminEndpoints,
  consumer: OAuthConsumer,
): Promise<OAuth1Token> {
  const url = `${endpoints.connectApi}/oauth-service/oauth/preauthorized?${new URLSearchParams({
    ticket,
    'login-url': endpoints.integration,
    'accepts-mfa-tokens': 'true',
  })}`
  const oauth = oauthClient(consumer)
  const authorization = oauth.toHeader(oauth.authorize({ url, method: 'GET' }))
  const response = await fetch(url, {
    headers: { ...authorization, 'User-Agent': MOBILE_USER_AGENT },
  })
  await ensureResponseOk(response, 'Garmin OAuth1 exchange')

  const values = Object.fromEntries(new URLSearchParams(await response.text()))
  if (!values.oauth_token || !values.oauth_token_secret) {
    throw new GarminAuthenticationError('Garmin OAuth1 exchange returned an invalid token.')
  }
  return { ...values, oauth_token: values.oauth_token, oauth_token_secret: values.oauth_token_secret }
}

async function exchangeOAuth1ForOAuth2(
  oauth1: OAuth1Token,
  endpoints: GarminEndpoints,
  consumer: OAuthConsumer,
  initialLogin: boolean,
): Promise<OAuth2Token> {
  const url = `${endpoints.connectApi}/oauth-service/oauth/exchange/user/2.0`
  const form: Record<string, string> = {}
  if (initialLogin) form.audience = MOBILE_AUDIENCE
  if (oauth1.mfa_token) form.mfa_token = oauth1.mfa_token

  const oauth = oauthClient(consumer)
  const authorization = oauth.authorize(
    { url, method: 'POST', data: form },
    { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret },
  )
  const authorizationHeader = oauth.toHeader(authorization)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...authorizationHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': MOBILE_USER_AGENT,
    },
    body: new URLSearchParams(form),
  })
  const payload = object(await responseJson(response, 'Garmin OAuth2 exchange'))
  if (!payload || typeof payload.access_token !== 'string') {
    throw new GarminAuthenticationError('Garmin OAuth2 exchange returned an invalid token.')
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

async function validateSession(session: GarminSessionToken, endpoints: GarminEndpoints): Promise<void> {
  const response = await fetch(`${endpoints.connectApi}/userprofile-service/socialProfile`, {
    headers: {
      Authorization: `Bearer ${session.oauth2.access_token}`,
      'User-Agent': MOBILE_USER_AGENT,
    },
  })
  await ensureResponseOk(response, 'Garmin session validation')
}

async function fetchOAuthConsumer(): Promise<OAuthConsumer> {
  const response = await fetch(OAUTH_CONSUMER_URL)
  const payload = object(await responseJson(response, 'Garmin OAuth consumer lookup'))
  if (
    !payload ||
    typeof payload.consumer_key !== 'string' ||
    typeof payload.consumer_secret !== 'string'
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
    integration: `https://mobile.integration.${domain}/gcm/android`,
    connectApi: `https://connectapi.${domain}`,
  }
}

async function cookieFetch(url: string, jar: CookieJar, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('Cookie', cookie)
  const response = await fetch(url, { ...init, headers })
  jar.update(response.headers)
  await ensureResponseOk(response, 'Garmin SSO')
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

function responseStatus(value: unknown): { type: string; message: string } {
  const status = object(object(value)?.responseStatus)
  return {
    type: typeof status?.type === 'string' ? status.type : 'UNKNOWN',
    message: typeof status?.message === 'string' ? status.message : '',
  }
}

function serviceTicket(value: unknown): string {
  const ticket = object(value)?.serviceTicketId
  if (typeof ticket !== 'string' || !ticket) {
    throw new GarminAuthenticationError('Garmin login succeeded without returning a service ticket.')
  }
  return ticket
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

class GarminAuthenticationError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GarminAuthenticationError'
    this.status = status
  }
}
