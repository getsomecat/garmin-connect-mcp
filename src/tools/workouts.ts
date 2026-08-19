import type { GarminClient } from '../garmin/client.js'
import { asObject, formatWorkout } from '../utils/format.js'
import { boundedInteger } from './common.js'
import type { GarminTool } from './types.js'

export function workoutsTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_workouts',
      description: 'Get planned workouts saved in Garmin Connect.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of workouts.' },
          offset: { type: 'integer', minimum: 0, description: 'Pagination offset.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async run(args) {
      const limit = boundedInteger(args.limit, 10, 1, 100, 'limit')
      const offset = boundedInteger(args.offset, 0, 0, 100_000, 'offset')
      const workouts = await client.getWorkouts(offset, limit)
      return workouts.map((workout) => formatWorkout(asObject(workout)))
    },
  }
}
