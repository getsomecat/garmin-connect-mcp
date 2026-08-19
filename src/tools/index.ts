import type { ActivityDetail } from '../config.js'
import type { GarminClient } from '../garmin/client.js'
import { activitiesTool } from './activities.js'
import { heartRateTool } from './heart-rate.js'
import { profileTool } from './profile.js'
import { sleepTool } from './sleep.js'
import { stepsTool } from './steps.js'
import type { GarminTool } from './types.js'
import { weightTool } from './weight.js'
import { workoutsTool } from './workouts.js'

export function createTools(client: GarminClient, activityDetail: ActivityDetail): GarminTool[] {
  return [
    activitiesTool(client, activityDetail),
    sleepTool(client),
    stepsTool(client),
    heartRateTool(client),
    weightTool(client),
    workoutsTool(client),
    profileTool(client),
  ]
}

export type { GarminTool } from './types.js'
