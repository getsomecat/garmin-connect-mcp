import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Auth0AccessTokenVerifier } from '../src/auth/auth0.js'
import { loadConfig } from '../src/config.js'
import { startHttpServer } from '../src/http.js'

const port = await availablePort()
const endpoint = new URL(`http://127.0.0.1:${port}/mcp`)
const auth0Domain = 'tenant.example.auth0.com'
const staticToken = randomBytes(32).toString('hex')
const config = loadConfig({
  GARMIN_USERNAME: 'smoke-test',
  GARMIN_PASSWORD: 'smoke-test',
  MCP_TRANSPORT: 'http',
  MCP_HTTP_PORT: String(port),
  MCP_PUBLIC_URL: endpoint.href,
  MCP_BEARER_TOKEN: staticToken,
  MCP_AUTH0_DOMAIN: auth0Domain,
  MCP_AUTH0_AUDIENCE: endpoint.href,
  MCP_AUTH0_ALLOWED_SUBJECTS: 'auth0|owner, auth0|owner',
})

assert(config.auth0?.allowedSubjects.length === 1, 'Auth0 subjects were not de-duplicated.')
await assertJwtVerification(config.auth0)
assertThrows(
  () => loadConfig({
    GARMIN_USERNAME: 'smoke-test',
    GARMIN_PASSWORD: 'smoke-test',
    MCP_PUBLIC_URL: endpoint.href,
    MCP_AUTH0_DOMAIN: auth0Domain,
    MCP_OAUTH_PASSWORD_HASH: 'scrypt$not-used',
    MCP_OAUTH_STATE_FILE: '/tmp/not-used',
  }),
  'Auth0 and the built-in OAuth provider cannot be configured together.',
)
assertThrows(
  () => loadConfig({
    GARMIN_USERNAME: 'smoke-test',
    GARMIN_PASSWORD: 'smoke-test',
    MCP_PUBLIC_URL: endpoint.href,
    MCP_AUTH0_DOMAIN: auth0Domain,
    MCP_AUTH0_AUDIENCE: 'https://wrong.example/mcp',
  }),
  'MCP_AUTH0_AUDIENCE must exactly match MCP_PUBLIC_URL',
)

const runtime = await startHttpServer(config)
try {
  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
  ]) {
    const discovery = await fetch(new URL(path, endpoint))
    assert(discovery.ok, `${path} returned ${discovery.status}.`)
    const metadata = await discovery.json() as Record<string, unknown>
    assert(metadata.resource === endpoint.href, `${path} returned the wrong resource.`)
    assert(
      arrayEquals(metadata.authorization_servers, [`https://${auth0Domain}/`]),
      `${path} returned the wrong authorization server.`,
    )
    assert(
      metadata.jwks_uri === `https://${auth0Domain}/.well-known/jwks.json`,
      `${path} returned the wrong JWKS URI.`,
    )
    assert(arrayEquals(metadata.scopes_supported, ['garmin:read']), `${path} returned wrong scopes.`)
  }

  const unauthorized = await rpcRequest(endpoint)
  assert(unauthorized.status === 401, `Unauthenticated MCP request returned ${unauthorized.status}.`)
  const challenge = unauthorized.headers.get('www-authenticate') ?? ''
  assert(
    challenge.includes(`resource_metadata="${endpoint.origin}/.well-known/oauth-protected-resource/mcp"`),
    'The OAuth resource discovery challenge is missing.',
  )
  assert(challenge.includes('scope="garmin:read"'), 'The OAuth scope challenge is missing.')

  const invalidToken = await rpcRequest(endpoint, 'not-a-jwt')
  assert(invalidToken.status === 401, `Invalid Auth0 token returned ${invalidToken.status}.`)

  const authorizationEndpoint = await fetch(new URL('/authorize', endpoint))
  assert(authorizationEndpoint.status === 404, 'Auth0 mode unexpectedly exposed local /authorize.')
  const localMetadata = await fetch(new URL('/.well-known/oauth-authorization-server', endpoint))
  assert(localMetadata.status === 404, 'Auth0 mode unexpectedly exposed local authorization metadata.')

  const client = new Client({ name: 'garmin-connect-mcp-auth0-smoke', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${staticToken}` } },
  })
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
  const listed = await client.listTools()
  assert(listed.tools.length === 12, `Expected 12 tools, received ${listed.tools.length}.`)
  const securitySchemes = (listed.tools[0]?._meta as { securitySchemes?: unknown } | undefined)
    ?.securitySchemes
  assert(Array.isArray(securitySchemes), 'Auth0 tool security metadata is missing.')
  await client.close()

  console.log('Auth0 smoke test passed: config, discovery, challenges, isolation, and MCP access.')
} finally {
  await runtime.close()
}

function rpcRequest(endpoint: URL, token?: string): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  })
}

async function assertJwtVerification(auth0: NonNullable<typeof config.auth0>): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 })
  const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'smoke-key',
    use: 'sig',
  }
  const customFetch: typeof fetch = async (input) => {
    const url = requestUrl(input)
    if (url.pathname === '/.well-known/jwks.json') {
      return jsonResponse({ keys: [publicJwk] })
    }
    if (url.pathname.includes('.well-known')) {
      return jsonResponse({
        issuer: auth0.issuerUrl.href,
        jwks_uri: new URL('/.well-known/jwks.json', auth0.issuerUrl).href,
      })
    }
    return new Response('Not found.', { status: 404 })
  }
  const verifier = new Auth0AccessTokenVerifier(auth0, customFetch)
  const now = Math.floor(Date.now() / 1_000)
  const token = signedJwt(privateKey, {
    iss: auth0.issuerUrl.href,
    aud: auth0.audience,
    sub: 'auth0|owner',
    azp: 'chatgpt-smoke-client',
    iat: now,
    exp: now + 300,
    scope: 'openid garmin:read',
  })
  const verified = await verifier.verifyAccessToken(token)
  assert(verified.clientId === 'chatgpt-smoke-client', 'The verified Auth0 client ID is wrong.')
  assert(verified.scopes.includes('garmin:read'), 'The verified Auth0 scope is missing.')
  assert(verified.resource?.href === auth0.publicUrl.href, 'The verified Auth0 resource is wrong.')

  const intruderToken = signedJwt(privateKey, {
    iss: auth0.issuerUrl.href,
    aud: auth0.audience,
    sub: 'auth0|intruder',
    azp: 'chatgpt-smoke-client',
    iat: now,
    exp: now + 300,
    scope: 'garmin:read',
  })
  await assertRejects(
    () => verifier.verifyAccessToken(intruderToken),
    'The Auth0 subject is not allowed',
  )
}

function signedJwt(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'smoke-key', typ: 'JWT' }))
    .toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local test port.'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function arrayEquals(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function assertThrows(action: () => unknown, expectedMessage: string): void {
  try {
    action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.includes(expectedMessage), `Unexpected configuration error: ${message}`)
    return
  }
  throw new Error(`Expected configuration error containing: ${expectedMessage}`)
}

async function assertRejects(action: () => Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.includes(expectedMessage), `Unexpected verification error: ${message}`)
    return
  }
  throw new Error(`Expected verification error containing: ${expectedMessage}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
