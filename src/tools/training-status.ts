import type { GarminClient } from '../garmin/client.js'
import { formatTrainingStatus } from '../utils/training-format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function trainingStatusTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_training_status',
      description:
        'Get Garmin training status, acute and chronic load, workload ratio, load balance, and per-sport VO2 max.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) =>
        formatTrainingStatus(await client.getTrainingStatus(date), date))
    },
  }
}
