import type { ActivityDetail } from '../config.js'
import type { GarminClient } from '../garmin/client.js'
import { activitiesTool } from './activities.js'
import { bodyBatteryTool } from './body-battery.js'
import { heartRateTool } from './heart-rate.js'
import { hrvTool } from './hrv.js'
import { profileTool } from './profile.js'
import { runningAdviceTool } from './running-advice.js'
import { sleepTool } from './sleep.js'
import { stepsTool } from './steps.js'
import { trainingReadinessTool } from './training-readiness.js'
import { trainingStatusTool } from './training-status.js'
import type { GarminTool } from './types.js'
import { vo2MaxTool } from './vo2max.js'
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
    hrvTool(client),
    bodyBatteryTool(client),
    trainingReadinessTool(client),
    trainingStatusTool(client),
    vo2MaxTool(client),
    runningAdviceTool(client),
  ]
}

export type { GarminTool } from './types.js'
