import type { GarminClient } from '../garmin/client.js'
import { formatSteps } from '../utils/format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function stepsTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_steps',
      description: 'Get Garmin daily step counts for one date or a date range.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) => formatSteps(await client.getSteps(date), date))
    },
  }
}
