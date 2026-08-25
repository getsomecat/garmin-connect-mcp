import type { GarminClient } from '../garmin/client.js'
import { formatHrv } from '../utils/training-format.js'
import { dateRangeSchema, datesFromArgs, mapDates } from './common.js'
import type { GarminTool } from './types.js'

export function hrvTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_hrv',
      description:
        'Get nightly Garmin HRV averages, seven-day average, personal baseline, and HRV status.',
      inputSchema: dateRangeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(args) {
      return mapDates(datesFromArgs(args), async (date) =>
        formatHrv(await client.getHrv(date), date))
    },
  }
}
