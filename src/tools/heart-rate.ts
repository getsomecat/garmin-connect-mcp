import type { GarminClient } from '../garmin/client.js'
import { asObject, formatHeartRate } from '../utils/format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function heartRateTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_heart_rate',
      description: 'Get Garmin resting, minimum, and maximum heart-rate values for one date or a date range.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) =>
        formatHeartRate(asObject(await client.getHeartRate(date)), date))
    },
  }
}
