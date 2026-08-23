import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createPasswordHash } from '../src/auth/provider.js'
import { loadConfig } from '../src/config.js'
import { startHttpServer } from '../src/http.js'

const password = 'oauth-smoke-test-password'
const workDirectory = await mkdtemp(join(tmpdir(), 'garmin-mcp-oauth-'))
const port = await availablePort()
const endpoint = new URL(`http://127.0.0.1:${port}/mcp`)
const callback = 'https://chatgpt.com/connector/oauth/smoke-test'
const config = loadConfig({
  GARMIN_USERNAME: 'smoke-test',
  GARMIN_PASSWORD: 'smoke-test',
  MCP_TRANSPORT: 'http',
  MCP_HTTP_PORT: String(port),
  MCP_PUBLIC_URL: endpoint.href,
  MCP_OAUTH_PASSWORD_HASH: await createPasswordHash(password),
  MCP_OAUTH_STATE_FILE: join(workDirectory, 'oauth-state.json'),
  MCP_OAUTH_ALLOWED_REDIRECT_URIS: callback,
})

const runtime = await startHttpServer(config)
try {
  const discovery = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', endpoint))
  assert(discovery.ok, `Protected-resource discovery returned ${discovery.status}.`)
  const metadata = await discovery.json() as { authorization_servers?: string[] }
  assert(metadata.authorization_servers?.[0] === `http://127.0.0.1:${port}/`, 'Wrong OAuth issuer.')

  const registration = await fetch(new URL('/register', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'OAuth smoke test',
    }),
  })
  assert(registration.status === 201, `Client registration returned ${registration.status}.`)
  const registered = await registration.json() as { client_id?: string }
  assert(Boolean(registered.client_id), 'Client registration did not return a client_id.')

  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URL('/authorize', endpoint)
  authorize.search = new URLSearchParams({
    client_id: registered.client_id ?? '',
    redirect_uri: callback,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'garmin:read',
    resource: endpoint.href,
    state: 'smoke-state',
  }).toString()
  const authorization = await fetch(authorize)
  assert(authorization.ok, `Authorization page returned ${authorization.status}.`)
  assert(
    authorization.headers.get('content-security-policy')?.includes(
      "form-action 'self' https://chatgpt.com",
    ),
    'Authorization page CSP does not allow the configured callback origin.',
  )
  const authorizationHtml = await authorization.text()
  const requestId = /name="request_id" value="([^"]+)"/.exec(authorizationHtml)?.[1]
  assert(Boolean(requestId), 'Authorization page did not contain a request identifier.')

  const denied = await approve(endpoint, requestId ?? '', 'wrong-password')
  assert(denied.status === 401, `Incorrect password returned ${denied.status}.`)
  const approval = await approve(endpoint, requestId ?? '', password)
  assert(approval.status === 302, `OAuth approval returned ${approval.status}.`)
  const callbackUrl = new URL(approval.headers.get('location') ?? '')
  assert(callbackUrl.searchParams.get('state') === 'smoke-state', 'OAuth state was not preserved.')
  const code = callbackUrl.searchParams.get('code')
  assert(Boolean(code), 'OAuth callback did not include an authorization code.')

  const tokens = await exchangeToken(endpoint, {
    grant_type: 'authorization_code',
    client_id: registered.client_id ?? '',
    code: code ?? '',
    code_verifier: verifier,
    redirect_uri: callback,
    resource: endpoint.href,
  })
  assert(Boolean(tokens.access_token), 'Token exchange did not return an access token.')
  assert(Boolean(tokens.refresh_token), 'Token exchange did not return a refresh token.')

  const client = new Client({ name: 'garmin-connect-mcp-oauth-smoke', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  })
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
  const listed = await client.listTools()
  assert(listed.tools.length === 7, `Expected 7 tools, received ${listed.tools.length}.`)
  const metadataSchemes = (listed.tools[0]?._meta as { securitySchemes?: unknown } | undefined)
    ?.securitySchemes
  assert(Array.isArray(metadataSchemes), 'OAuth tool security metadata is missing.')
  await client.close()

  const refreshed = await exchangeToken(endpoint, {
    grant_type: 'refresh_token',
    client_id: registered.client_id ?? '',
    refresh_token: tokens.refresh_token ?? '',
    resource: endpoint.href,
  })
  assert(Boolean(refreshed.access_token), 'Refresh did not return a new access token.')
  assert(refreshed.refresh_token !== tokens.refresh_token, 'Refresh token was not rotated.')

  const replay = await fetch(new URL('/token', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: registered.client_id ?? '',
      refresh_token: tokens.refresh_token ?? '',
      resource: endpoint.href,
    }),
  })
  assert(replay.status === 400, `Replayed refresh token returned ${replay.status}.`)

  console.log('OAuth smoke test passed: discovery, PKCE, approval, MCP access, and token rotation.')
} finally {
  await runtime.close()
  await rm(workDirectory, { recursive: true, force: true })
}

function approve(endpoint: URL, requestId: string, candidate: string): Promise<Response> {
  return fetch(new URL('/oauth/approve', endpoint), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, password: candidate }),
  })
}

async function exchangeToken(
  endpoint: URL,
  fields: Record<string, string>,
): Promise<{ access_token?: string; refresh_token?: string }> {
  const response = await fetch(new URL('/token', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
  if (!response.ok) {
    throw new Error(`Token endpoint returned ${response.status}: ${await response.text()}`)
  }
  return response.json() as Promise<{ access_token?: string; refresh_token?: string }>
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
