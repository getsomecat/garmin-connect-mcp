#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const server = createServer(loadConfig())
  const transport = new StdioServerTransport()

  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  await server.connect(transport)
  console.error('[garmin-connect-mcp] MCP server is running on stdio.')
}

main().catch((error: unknown) => {
  console.error('[garmin-connect-mcp] Fatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
