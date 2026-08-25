import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export interface GarminTool {
  definition: Tool
  run(args: Record<string, unknown>): Promise<unknown>
}
