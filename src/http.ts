import { timingSafeEqual } from 'node:crypto'
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from './config.js'
import { GarminClient } from './garmin/client.js'
import { createServer as createMcpServer } from './server.js'

const MAX_REQUEST_BYTES = 1_048_576

export interface HttpRuntime {
  host: string
  port: number
  path: string
  close(): Promise<void>
}

export async function startHttpServer(config: Config): Promise<HttpRuntime> {
  if (!config.bearerToken) {
    throw new Error('MCP_BEARER_TOKEN is required for the HTTP transport.')
  }

  const garminClient = new GarminClient(config)
  const nodeServer = createNodeHttpServer((request, response) => {
    void handleHttpRequest(config, garminClient, request, response)
  })
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

async function handleHttpRequest(
  config: Config,
  garminClient: GarminClient,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  setSecurityHeaders(response)
  const pathname = requestPath(request)

  if (pathname === '/healthz' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok' })
    return
  }

  if (pathname !== config.httpPath) {
    sendJson(response, 404, { error: 'Not found.' })
    return
  }

  if (!isAuthorized(request, config.bearerToken ?? '')) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="garmin-connect-mcp"')
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
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
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
    if (!response.headersSent) {
      sendRpcError(response, 500, -32_603, 'Internal server error.')
    }
  } finally {
    if (response.writableEnded) await cleanup()
  }
}

function isAuthorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match?.[1]) return false

  const actual = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname.replace(/\/$/, '') || '/'
  } catch {
    return '/'
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
}

function sendRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  sendJson(response, status, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
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
