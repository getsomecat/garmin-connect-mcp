import type { GarminClient } from '../garmin/client.js'
import { formatTrainingReadiness } from '../utils/training-format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function trainingReadinessTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_training_readiness',
      description:
        'Get Garmin training readiness, recovery time, and contributing sleep, load, HRV, and history factors.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) =>
        formatTrainingReadiness(await client.getTrainingReadiness(date), date))
    },
  }
}
