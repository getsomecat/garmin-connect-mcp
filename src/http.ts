import { timingSafeEqual } from 'node:crypto'
import {
  createServer as createNodeHttpServer,
  type Server as NodeHttpServer,
} from 'node:http'
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Auth0AccessTokenVerifier } from './auth/auth0.js'
import {
  GARMIN_READ_SCOPE,
  SingleUserOAuthProvider,
} from './auth/provider.js'
import type { Auth0Config, Config, OAuthConfig } from './config.js'
import { GarminClient } from './garmin/client.js'
import { createServer as createMcpServer } from './server.js'

const MAX_REQUEST_BYTES = 1_048_576

export interface HttpRuntime {
  host: string
  port: number
  path: string
  close(): Promise<void>
}

interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>
}

export async function startHttpServer(config: Config): Promise<HttpRuntime> {
  if (!config.bearerToken && !config.oauth && !config.auth0) {
    throw new Error('The HTTP transport requires bearer-token, built-in OAuth, or Auth0 authentication.')
  }

  const garminClient = new GarminClient(config)
  const oauthProvider = config.oauth
    ? await SingleUserOAuthProvider.create(config.oauth)
    : undefined
  const auth0Verifier = config.auth0
    ? new Auth0AccessTokenVerifier(config.auth0)
    : undefined
  const accessTokenVerifier: AccessTokenVerifier | undefined = oauthProvider ?? auth0Verifier
  const authorizationConfig = config.oauth ?? config.auth0
  const resourceMetadataUrl = authorizationConfig
    ? getOAuthProtectedResourceMetadataUrl(authorizationConfig.publicUrl)
    : undefined
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(createSecurityHeaders(config.oauth?.allowedRedirectUris ?? []))

  app.get('/healthz', (_request, response) => {
    response.status(200).json({ status: 'ok' })
  })

  if (authorizationConfig) {
    const metadata = protectedResourceMetadata(authorizationConfig, config.auth0)
    const pathSpecificMetadataPath = new URL(resourceMetadataUrl ?? '').pathname

    app.get(pathSpecificMetadataPath, (_request, response) => {
      response.status(200).json(metadata)
    })
    // Compatibility alias for clients that have not yet adopted path-specific RFC 9728 discovery.
    app.get('/.well-known/oauth-protected-resource', (_request, response) => {
      response.status(200).json(metadata)
    })
  }

  if (oauthProvider && config.oauth) {
    const oauthConfig = config.oauth

    app.post(
      '/oauth/approve',
      rateLimit({
        windowMs: 60 * 60_000,
        max: 12,
        standardHeaders: true,
        legacyHeaders: false,
      }),
      express.urlencoded({ extended: false, limit: '16kb' }),
      async (request, response) => {
        const requestId = formString(request.body, 'request_id')
        const password = formString(request.body, 'password')
        if (!requestId || !password) {
          response.status(400).type('html').send(
            '<!doctype html><title>Invalid request</title><p>Return to ChatGPT and start the connection again.</p>',
          )
          return
        }
        try {
          const result = await oauthProvider.approve(requestId, password)
          if (result.approved) response.redirect(302, result.redirectUrl)
          else response.status(result.status).type('html').send(result.html)
        } catch (error) {
          console.error('[garmin-connect-mcp] OAuth approval failed:', errorMessage(error))
          response.status(500).type('html').send(
            '<!doctype html><title>Authorization failed</title><p>Return to ChatGPT and try again.</p>',
          )
        }
      },
    )

    app.use('/token', logOAuthFailure)

    app.use(mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: oauthConfig.issuerUrl,
      baseUrl: oauthConfig.issuerUrl,
      resourceServerUrl: oauthConfig.publicUrl,
      serviceDocumentationUrl: new URL('https://github.com/getsomecat/garmin-connect-mcp'),
      scopesSupported: [GARMIN_READ_SCOPE],
      resourceName: 'Private Garmin Connect data',
    }))
  }

  app.all(config.httpPath, (request, response) => {
    void handleMcpRequest(
      config,
      garminClient,
      accessTokenVerifier,
      resourceMetadataUrl,
      request,
      response,
    )
  })

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  const nodeServer = createNodeHttpServer(app)
  nodeServer.maxHeadersCount = 64
  nodeServer.headersTimeout = 15_000
  nodeServer.requestTimeout = 130_000
  nodeServer.keepAliveTimeout = 5_000

  await listen(nodeServer, config.httpPort, config.httpHost)
  const address = nodeServer.address()
  if (!address || typeof address === 'string') {
    await closeNodeServer(nodeServer)
    throw new Error('Unable to determine the HTTP listener address.')
  }

  return {
    host: config.httpHost,
    port: address.port,
    path: config.httpPath,
    close: () => closeNodeServer(nodeServer),
  }
}

async function handleMcpRequest(
  config: Config,
  garminClient: GarminClient,
  accessTokenVerifier: AccessTokenVerifier | undefined,
  resourceMetadataUrl: string | undefined,
  request: Request,
  response: Response,
): Promise<void> {
  if (!(await isAuthorized(request, config, accessTokenVerifier))) {
    response.setHeader('WWW-Authenticate', resourceMetadataUrl
      ? `Bearer resource_metadata="${resourceMetadataUrl}", scope="${GARMIN_READ_SCOPE}"`
      : 'Bearer realm="garmin-connect-mcp"')
    sendRpcError(response, 401, -32_001, 'Unauthorized.')
    return
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    sendRpcError(response, 405, -32_000, 'Method not allowed.')
    return
  }

  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    sendRpcError(response, 413, -32_000, 'Request body is too large.')
    return
  }

  const mcpServer = createMcpServer(config, garminClient)
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
  let cleanupStarted = false
  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return
    cleanupStarted = true
    try {
      await mcpServer.close()
    } catch (error) {
      console.error('[garmin-connect-mcp] HTTP request cleanup failed:', errorMessage(error))
    }
  }
  response.once('close', () => void cleanup())

  try {
    // SDK 1.x transport declarations are not exactOptionalPropertyTypes-compatible.
    await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0])
    await transport.handleRequest(request, response)
  } catch (error) {
    console.error('[garmin-connect-mcp] HTTP request failed:', errorMessage(error))
    if (!response.headersSent) sendRpcError(response, 500, -32_603, 'Internal server error.')
  } finally {
    if (response.writableEnded) await cleanup()
  }
}

async function isAuthorized(
  request: Request,
  config: Config,
  accessTokenVerifier: AccessTokenVerifier | undefined,
): Promise<boolean> {
  const token = bearerToken(request)
  if (!token) return false
  if (config.bearerToken && tokenEquals(token, config.bearerToken)) return true
  if (!accessTokenVerifier) return false

  try {
    const auth = await accessTokenVerifier.verifyAccessToken(token)
    const publicUrl = config.oauth?.publicUrl ?? config.auth0?.publicUrl
    return auth.scopes.includes(GARMIN_READ_SCOPE)
      && (!publicUrl || auth.resource?.href === publicUrl.href)
  } catch {
    return false
  }
}

function protectedResourceMetadata(
  authorizationConfig: OAuthConfig | Auth0Config,
  auth0: Auth0Config | undefined,
): Record<string, unknown> {
  return {
    resource: authorizationConfig.publicUrl.href,
    authorization_servers: [authorizationConfig.issuerUrl.href],
    scopes_supported: [GARMIN_READ_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Private Garmin Connect data',
    resource_documentation: 'https://github.com/getsomecat/garmin-connect-mcp',
    ...(auth0
      ? {
          jwks_uri: new URL('/.well-known/jwks.json', auth0.issuerUrl).href,
          resource_signing_alg_values_supported: ['RS256'],
        }
      : {}),
  }
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string') return undefined
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]
}

function tokenEquals(actualToken: string, expectedToken: string): boolean {
  const actual = Buffer.from(actualToken, 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function formString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function logOAuthFailure(request: Request, response: Response, next: NextFunction): void {
  response.once('finish', () => {
    console.error(
      `[garmin-connect-mcp] OAuth token request completed (${request.method} ${response.statusCode}).`,
    )
  })
  const sendJson = response.json.bind(response)
  response.json = ((body: unknown) => {
    if (response.statusCode >= 400) {
      const error = isRecord(body) && typeof body.error === 'string'
        ? body.error
        : 'unknown_error'
      const description = isRecord(body) && typeof body.error_description === 'string'
        ? body.error_description
        : 'No OAuth error description was returned.'
      console.error(`[garmin-connect-mcp] OAuth token request failed (${response.statusCode} ${error}): ${description}`)
    }
    return sendJson(body)
  }) as Response['json']
  next()
}

function createSecurityHeaders(allowedRedirectUris: readonly string[]) {
  const formActionSources = [
    "'self'",
    ...new Set(allowedRedirectUris.map((uri) => new URL(uri).origin)),
  ].join(' ')

  return (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionSources}; base-uri 'none'; frame-ancestors 'none'`,
    )
    next()
  }
}

function sendRpcError(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function listen(server: NodeHttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeNodeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections?.()
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
