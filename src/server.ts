import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { Config } from './config.js'
import { GarminClient } from './garmin/client.js'
import { createTools } from './tools/index.js'

export function createServer(config: Config): Server {
  const client = new GarminClient(config)
  const tools = createTools(client, config.activityDetail)
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]))

  const server = new Server(
    { name: 'garmin-connect-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Use Garmin tools only for the connected user\'s fitness and health questions. '
        + 'Date ranges are inclusive and limited to 31 days. All tools are read-only.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => tool.definition),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = toolsByName.get(request.params.name)
    if (!tool) return errorResult(`Unknown tool: ${request.params.name}`)

    try {
      const args = asArguments(request.params.arguments)
      const value = await tool.run(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  })

  return server
}

function asArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.')
  }
  return value as Record<string, unknown>
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  }
}
