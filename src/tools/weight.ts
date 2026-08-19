import type { GarminClient } from '../garmin/client.js'
import { asObject, formatWeight } from '../utils/format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function weightTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_weight',
      description: 'Get Garmin weight and body-composition data for one date or a date range.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) =>
        formatWeight(asObject(await client.getWeight(date)), date))
    },
  }
}
