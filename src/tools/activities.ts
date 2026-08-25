import type { ActivityDetail } from '../config.js'
import type { GarminClient } from '../garmin/client.js'
import { asObject, formatActivity } from '../utils/format.js'
import { boundedInteger } from './common.js'
import type { GarminTool } from './types.js'

export function activitiesTool(client: GarminClient, defaultDetail: ActivityDetail): GarminTool {
  return {
    definition: {
      name: 'garmin_activities',
      description: 'Get recent Garmin activities such as runs, rides, swims, and hikes.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of activities.' },
          offset: { type: 'integer', minimum: 0, description: 'Pagination offset.' },
          detail: {
            type: 'string',
            enum: ['compact', 'full'],
            description: 'compact returns normalized key metrics; full also includes raw Garmin fields.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async run(args) {
      const limit = boundedInteger(args.limit, 10, 1, 100, 'limit')
      const offset = boundedInteger(args.offset, 0, 0, 100_000, 'offset')
      const detail = args.detail === undefined ? defaultDetail : args.detail
      if (detail !== 'compact' && detail !== 'full') {
        throw new Error('detail must be compact or full.')
      }
      const activities = await client.getActivities(offset, limit)
      return activities.map((activity) => formatActivity(asObject(activity), detail))
    },
  }
}
