#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, type Config } from './config.js'
import { startHttpServer, type HttpRuntime } from './http.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.transport === 'http') {
    await runHttp(config)
  } else {
    await runStdio(config)
  }
}

async function runStdio(config: Config): Promise<void> {
  const server = createServer(config)
  const transport = new StdioServerTransport()

  const shutdown = async (): Promise<void> => {
    await server.close()
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  await server.connect(transport)
  console.error('[garmin-connect-mcp] MCP server is running on stdio.')
}

async function runHttp(config: Config): Promise<void> {
  const runtime = await startHttpServer(config)
  installHttpShutdown(runtime)
  console.error(
    `[garmin-connect-mcp] MCP server is listening on http://${runtime.host}:${runtime.port}${runtime.path}.`,
  )
}

function installHttpShutdown(runtime: HttpRuntime): void {
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await runtime.close()
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
  console.error('[garmin-connect-mcp] Fatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
