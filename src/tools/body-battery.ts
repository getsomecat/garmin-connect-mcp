import type { GarminClient } from '../garmin/client.js'
import { asObject } from '../utils/format.js'
import { formatBodyBattery } from '../utils/training-format.js'
import { datesFromArgs, oneOrMany, optionalBoolean } from './common.js'
import type { GarminTool } from './types.js'

export function bodyBatteryTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_body_battery',
      description:
        'Get Garmin Body Battery level, daily charge and drain, and optional intraday samples.',
      inputSchema: {
        type: 'object',
        properties: {
          start_date: {
            type: 'string',
            description: 'First date in YYYY-MM-DD format. Defaults to today.',
          },
          end_date: {
            type: 'string',
            description: 'Last date in YYYY-MM-DD format. Defaults to start_date.',
          },
          include_samples: {
            type: 'boolean',
            description: 'Include the intraday level series. Only available for a single date.',
            default: false,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async run(args) {
      const dates = datesFromArgs(args)
      const includeSamples = optionalBoolean(args.include_samples, false, 'include_samples')
      if (includeSamples && dates.length !== 1) {
        throw new Error('include_samples can only be used for a single date.')
      }

      const startDate = dates[0] as string
      const endDate = dates.at(-1) as string
      const days = await client.getBodyBattery(startDate, endDate)
      const byDate = new Map(days.map((day) => {
        const value = asObject(day)
        return [String(value.date ?? value.calendarDate ?? ''), value] as const
      }))

      return oneOrMany(dates.map((date) =>
        formatBodyBattery(byDate.get(date), date, includeSamples)))
    },
  }
}
