import type { GarminClient } from '../garmin/client.js'
import { asObject, formatProfile } from '../utils/format.js'
import type { GarminTool } from './types.js'

export function profileTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_profile',
      description: 'Get a compact Garmin Connect user profile summary.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async run() {
      return formatProfile(asObject(await client.getProfile()))
    },
  }
}
