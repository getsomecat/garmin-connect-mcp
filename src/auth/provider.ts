import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Response } from 'express'
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthConfig } from '../config.js'

export const GARMIN_READ_SCOPE = 'garmin:read'

interface StoredToken {
  clientId: string
  scopes: string[]
  resource: string
  expiresAt: number
}

interface PersistedState {
  version: 1
  clients: Record<string, OAuthClientInformationFull>
  accessTokens: Record<string, StoredToken>
  refreshTokens: Record<string, StoredToken>
}

interface AuthorizationCode {
  clientId: string
  codeChallenge: string
  redirectUri: string
  scopes: string[]
  resource: string
  expiresAt: number
}

interface PendingAuthorization extends AuthorizationCode {
  requestId: string
  state?: string
  clientName: string
  attempts: number
}

export type ApprovalResult =
  | { approved: true; redirectUrl: string }
  | { approved: false; status: number; html: string }

export class PersistentClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly state: OAuthStateStore,
    private readonly allowedRedirectUris: ReadonlySet<string>,
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.state.getClient(clientId)
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const incoming = client as typeof client & {
      client_id?: string
      client_id_issued_at?: number
    }
    if (incoming.token_endpoint_auth_method !== 'none') {
      throw new InvalidClientMetadataError('Only public PKCE clients are supported.')
    }
    if (
      incoming.redirect_uris.length === 0
      || incoming.redirect_uris.some((uri) => !this.allowedRedirectUris.has(uri))
    ) {
      throw new InvalidClientMetadataError('The requested OAuth redirect URI is not allowed.')
    }
    if (incoming.grant_types?.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))) {
      throw new InvalidClientMetadataError('Only authorization_code and refresh_token grants are supported.')
    }
    if (incoming.response_types?.some((response) => response !== 'code')) {
      throw new InvalidClientMetadataError('Only the code response type is supported.')
    }

    const registered = {
      ...incoming,
      token_endpoint_auth_method: 'none',
      client_id: incoming.client_id ?? randomUUID(),
      client_id_issued_at: incoming.client_id_issued_at ?? Math.floor(Date.now() / 1_000),
    } as OAuthClientInformationFull
    delete registered.client_secret
    delete registered.client_secret_expires_at
    await this.state.putClient(registered)
    return registered
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore
  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly codes = new Map<string, AuthorizationCode>()

  private constructor(
    private readonly config: OAuthConfig,
    private readonly state: OAuthStateStore,
  ) {
    this.clientsStore = new PersistentClientsStore(
      state,
      new Set(config.allowedRedirectUris),
    )
  }

  static async create(config: OAuthConfig): Promise<SingleUserOAuthProvider> {
    return new SingleUserOAuthProvider(config, await OAuthStateStore.open(config.stateFile))
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    this.pruneTransientState()
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError('Unregistered redirect_uri.')
    }

    const scopes = params.scopes?.length ? params.scopes : [GARMIN_READ_SCOPE]
    if (scopes.some((scope) => scope !== GARMIN_READ_SCOPE)) {
      throw new InvalidScopeError('Only garmin:read can be granted.')
    }
    const resource = params.resource?.href ?? this.config.publicUrl.href
    if (resource !== this.config.publicUrl.href) {
      throw new InvalidRequestError('The requested resource is not this MCP server.')
    }

    const requestId = secret(32)
    const pending: PendingAuthorization = {
      requestId,
      clientId: client.client_id,
      clientName: client.client_name ?? 'ChatGPT',
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes,
      resource,
      expiresAt: Date.now() + 5 * 60_000,
      attempts: 0,
      ...(params.state ? { state: params.state } : {}),
    }
    this.pending.set(requestId, pending)
    response
      .status(200)
      .type('html')
      .send(authorizationPage(pending))
  }

  async approve(requestId: string, password: string): Promise<ApprovalResult> {
    this.pruneTransientState()
    const pending = this.pending.get(requestId)
    if (!pending) {
      return {
        approved: false,
        status: 400,
        html: messagePage('Authorization expired', 'Return to ChatGPT and start the connection again.'),
      }
    }

    if (!(await verifyPassword(password, this.config.passwordHash))) {
      pending.attempts += 1
      if (pending.attempts >= 5) this.pending.delete(requestId)
      return {
        approved: false,
        status: 401,
        html: pending.attempts >= 5
          ? messagePage('Too many attempts', 'Return to ChatGPT and start the connection again.')
          : authorizationPage(pending, 'The access password was incorrect.'),
      }
    }

    this.pending.delete(requestId)
    const code = secret(32)
    this.codes.set(code, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: Date.now() + 5 * 60_000,
    })

    const redirect = new URL(pending.redirectUri)
    redirect.searchParams.set('code', code)
    if (pending.state) redirect.searchParams.set('state', pending.state)
    return { approved: true, redirectUrl: redirect.href }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.pruneTransientState()
    const code = this.codes.get(authorizationCode)
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code.')
    }
    return code.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.pruneTransientState()
    const code = this.codes.get(authorizationCode)
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code.')
    }
    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.')
    }
    if (resource && resource.href !== code.resource) {
      throw new InvalidGrantError('resource does not match the authorization request.')
    }

    this.codes.delete(authorizationCode)
    return this.issueTokens(client.client_id, code.scopes, code.resource)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const digest = tokenDigest(refreshToken)
    const stored = await this.state.consumeRefreshToken(
      digest,
      client.client_id,
      scopes,
      resource?.href,
    )
    const requestedScopes = scopes?.length ? scopes : stored.scopes
    return this.issueTokens(client.client_id, requestedScopes, stored.resource)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = await this.state.getToken('access', tokenDigest(token))
    if (!stored || stored.expiresAt <= Date.now()) {
      throw new AccessDeniedError('Invalid or expired access token.')
    }
    if (stored.resource !== this.config.publicUrl.href) {
      throw new AccessDeniedError('Access token audience does not match this resource.')
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1_000),
      resource: new URL(stored.resource),
    }
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const digest = tokenDigest(request.token)
    const access = await this.state.getToken('access', digest)
    if (access?.clientId === client.client_id) await this.state.deleteToken('access', digest)
    const refresh = await this.state.getToken('refresh', digest)
    if (refresh?.clientId === client.client_id) await this.state.deleteToken('refresh', digest)
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const accessToken = secret(32)
    const refreshToken = secret(48)
    await this.state.putToken('access', tokenDigest(accessToken), {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.config.accessTokenTtlSeconds * 1_000,
    })
    await this.state.putToken('refresh', tokenDigest(refreshToken), {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.config.refreshTokenTtlSeconds * 1_000,
    })
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    }
  }

  private pruneTransientState(): void {
    const now = Date.now()
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(id)
    }
    for (const [code, data] of this.codes) {
      if (data.expiresAt <= now) this.codes.delete(code)
    }
  }
}

class OAuthStateStore {
  private writeTail: Promise<void> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly state: PersistedState,
  ) {}

  static async open(path: string): Promise<OAuthStateStore> {
    let state: PersistedState = emptyState()
    try {
      state = parseState(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    const store = new OAuthStateStore(path, state)
    await store.mutate(() => undefined)
    return store
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.writeTail
    return this.state.clients[clientId]
  }

  async putClient(client: OAuthClientInformationFull): Promise<void> {
    await this.mutate(() => {
      if (!this.state.clients[client.client_id] && Object.keys(this.state.clients).length >= 250) {
        throw new InvalidClientMetadataError('OAuth client registration capacity has been reached.')
      }
      this.state.clients[client.client_id] = client
    })
  }

  async getToken(kind: 'access' | 'refresh', digest: string): Promise<StoredToken | undefined> {
    await this.writeTail
    const collection = kind === 'access' ? this.state.accessTokens : this.state.refreshTokens
    return collection[digest]
  }

  async putToken(kind: 'access' | 'refresh', digest: string, token: StoredToken): Promise<void> {
    await this.mutate(() => {
      const collection = kind === 'access' ? this.state.accessTokens : this.state.refreshTokens
      collection[digest] = token
    })
  }

  async deleteToken(kind: 'access' | 'refresh', digest: string): Promise<void> {
    await this.mutate(() => {
      const collection = kind === 'access' ? this.state.accessTokens : this.state.refreshTokens
      delete collection[digest]
    })
  }

  async consumeRefreshToken(
    digest: string,
    clientId: string,
    scopes: string[] | undefined,
    resource: string | undefined,
  ): Promise<StoredToken> {
    let consumed: StoredToken | undefined
    await this.mutate(() => {
      const stored = this.state.refreshTokens[digest]
      if (!stored || stored.clientId !== clientId || stored.expiresAt <= Date.now()) {
        throw new InvalidGrantError('Invalid or expired refresh token.')
      }
      if (resource && resource !== stored.resource) {
        throw new InvalidGrantError('Refresh token cannot be used for that resource.')
      }
      if (scopes?.some((scope) => !stored.scopes.includes(scope))) {
        throw new InvalidScopeError('Refresh scope exceeds the original grant.')
      }
      consumed = stored
      delete this.state.refreshTokens[digest]
    })
    if (!consumed) throw new InvalidGrantError('Invalid or expired refresh token.')
    return consumed
  }

  private async mutate(mutator: () => void): Promise<void> {
    const operation = this.writeTail.then(async () => {
      mutator()
      pruneTokens(this.state)
      await persistState(this.path, this.state)
    })
    this.writeTail = operation.catch(() => undefined)
    return operation
  }
}

export async function createPasswordHash(password: string): Promise<string> {
  if (password.length < 16) throw new Error('The OAuth access password must be at least 16 characters.')
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [nValue, rValue, pValue] = parts.slice(1, 4).map(Number)
  const saltValue = parts[4]
  const digestValue = parts[5]
  if (
    !saltValue
    || !digestValue
    || !nValue
    || !rValue
    || !pValue
    || nValue < 16_384
    || nValue > 1_048_576
    || (nValue & (nValue - 1)) !== 0
    || rValue < 1
    || rValue > 32
    || pValue < 1
    || pValue > 8
  ) return false

  const expected = Buffer.from(digestValue, 'base64url')
  if (expected.length < 16 || expected.length > 64) return false
  const actual = await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length, {
    N: nValue,
    r: rValue,
    p: pValue,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, { ...options, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

function emptyState(): PersistedState {
  return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {} }
}

function parseState(value: unknown): PersistedState {
  if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported OAuth state file.')
  if (!isRecord(value.clients) || !isRecord(value.accessTokens) || !isRecord(value.refreshTokens)) {
    throw new Error('Invalid OAuth state file.')
  }
  return value as unknown as PersistedState
}

function pruneTokens(state: PersistedState): void {
  const now = Date.now()
  for (const [digest, token] of Object.entries(state.accessTokens)) {
    if (token.expiresAt <= now) delete state.accessTokens[digest]
  }
  for (const [digest, token] of Object.entries(state.refreshTokens)) {
    if (token.expiresAt <= now) delete state.refreshTokens[digest]
  }
}

async function persistState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

function secret(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function authorizationPage(pending: PendingAuthorization, error?: string): string {
  return page(
    'Connect Garmin data',
    `<main>
      <p class="eyebrow">GARMIN CONNECT MCP</p>
      <h1>Allow ${escapeHtml(pending.clientName)} to read your Garmin data?</h1>
      <p>This private connection grants read-only access to activities, sleep, steps, heart rate, weight, workouts, and profile data.</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/oauth/approve">
        <input type="hidden" name="request_id" value="${escapeHtml(pending.requestId)}">
        <label for="password">Private access password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">Allow read-only access</button>
      </form>
      <p class="fineprint">The password is checked only by your server and is never sent to Garmin or ChatGPT.</p>
    </main>`,
  )
}

function messagePage(title: string, message: string): string {
  return page(title, `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`)
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1511; color: #ecf7f0; }
    main { width: min(34rem, calc(100% - 3rem)); padding: 2.5rem; border: 1px solid #315443; border-radius: 1rem; background: #12251b; box-shadow: 0 1rem 4rem #0008; }
    h1 { font-size: clamp(1.55rem, 5vw, 2.25rem); line-height: 1.15; margin: .5rem 0 1rem; }
    p { color: #bad1c4; line-height: 1.55; }
    .eyebrow { color: #57d695; font-size: .75rem; font-weight: 800; letter-spacing: .14em; }
    label { display: block; margin: 1.5rem 0 .45rem; font-weight: 700; }
    input { box-sizing: border-box; width: 100%; padding: .85rem 1rem; border: 1px solid #547363; border-radius: .55rem; background: #08130e; color: inherit; font: inherit; }
    button { width: 100%; margin-top: 1rem; padding: .9rem 1rem; border: 0; border-radius: .55rem; background: #52d18e; color: #06150d; font: inherit; font-weight: 800; cursor: pointer; }
    .fineprint { font-size: .8rem; }
    .error { padding: .7rem .85rem; border-radius: .45rem; background: #5b1d24; color: #ffdce0; }
  </style>
</head>
<body>${body}</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}
