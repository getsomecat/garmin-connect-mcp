import type { GarminClient } from '../garmin/client.js'
import { asObject, formatSleep } from '../utils/format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function sleepTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_sleep',
      description: 'Get Garmin sleep score, duration, and sleep stages for one date or a date range.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) =>
        formatSleep(asObject(await client.getSleep(date)), date))
    },
  }
}
