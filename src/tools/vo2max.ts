import type { GarminClient } from '../garmin/client.js'
import { formatVo2Max } from '../utils/training-format.js'
import { datesFromArgs } from './common.js'
import type { GarminTool } from './types.js'

export function vo2MaxTool(client: GarminClient): GarminTool {
  return {
    definition: {
      name: 'garmin_vo2max',
      description:
        'Get Garmin running and cycling VO2 max history, with the current training-status estimate as fallback.',
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
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async run(args) {
      const dates = datesFromArgs(args)
      const startDate = dates[0] as string
      const endDate = dates.at(-1) as string
      const [maxMetrics, trainingStatus] = await Promise.all([
        client.getMaxMetrics(startDate, endDate),
        client.getTrainingStatus(endDate),
      ])
      return formatVo2Max(maxMetrics, trainingStatus, startDate, endDate)
    },
  }
}
