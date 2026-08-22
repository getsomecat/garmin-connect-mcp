import type { ActivityDetail } from '../config.js'

export type JsonObject = Record<string, unknown>

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

export function formatActivity(raw: JsonObject, detail: ActivityDetail): JsonObject {
  const distance = finiteNumber(raw.distance) ?? 0
  const duration = finiteNumber(raw.duration) ?? 0
  const normalized = {
    id: raw.activityId ?? '',
    name: stringValue(raw.activityName, 'Unnamed'),
    type: stringValue(asObject(raw.activityType).typeKey, 'unknown'),
    startTime: stringValue(raw.startTimeLocal),
    distanceMeters: round2(distance),
    durationSeconds: Math.round(duration),
    averagePaceMinPerKm: distance > 0 ? round2((duration / 60) / (distance / 1_000)) : null,
    averageHeartRate: finiteNumber(raw.averageHR),
    maxHeartRate: finiteNumber(raw.maxHR),
    calories: finiteNumber(raw.calories),
    elevationGainMeters: finiteNumber(raw.elevationGain),
    averageCadence:
      finiteNumber(raw.averageRunningCadenceInStepsPerMinute)
      ?? finiteNumber(raw.averageBikingCadenceInRevPerMinute)
      ?? finiteNumber(raw.averageSwimCadenceInStrokesPerMinute)
      ?? finiteNumber(raw.avgDoubleCadence),
  }
  return detail === 'full' ? { ...raw, ...normalized } : normalized
}

export function formatSleep(raw: JsonObject, requestedDate: string): JsonObject {
  const dto = asObject(raw.dailySleepDTO ?? raw)
  const overallScore = asObject(asObject(dto.sleepScores).overall).value
  return {
    date: stringValue(dto.calendarDate, requestedDate),
    sleepScore: finiteNumber(overallScore),
    sleepDurationHours: secondsToHours(dto.sleepTimeSeconds),
    deepSleepHours: secondsToHours(dto.deepSleepSeconds),
    lightSleepHours: secondsToHours(dto.lightSleepSeconds),
    remSleepHours: secondsToHours(dto.remSleepSeconds),
    awakeDurationHours: secondsToHours(dto.awakeSleepSeconds),
  }
}

export function formatSteps(raw: unknown, requestedDate: string): JsonObject {
  if (typeof raw === 'number') {
    return { date: requestedDate, totalSteps: raw }
  }
  const value = asObject(raw)
  return {
    date: stringValue(value.calendarDate, requestedDate),
    totalSteps: finiteNumber(value.totalSteps) ?? 0,
    goal: finiteNumber(value.stepGoal),
    distanceMeters: finiteNumber(value.totalDistance),
    highlyActiveSeconds: finiteNumber(value.highlyActiveSeconds),
  }
}

export function formatHeartRate(raw: JsonObject, requestedDate: string): JsonObject {
  return {
    date: stringValue(raw.calendarDate, requestedDate),
    restingHeartRate: finiteNumber(raw.restingHeartRate),
    maxHeartRate: finiteNumber(raw.maxHeartRate),
    minHeartRate: finiteNumber(raw.minHeartRate),
  }
}

export function formatWeight(raw: JsonObject, requestedDate: string): JsonObject {
  const entries = Array.isArray(raw.dateWeightList) ? raw.dateWeightList : []
  const latest = entries.length > 0 ? asObject(entries.at(-1)) : {}
  const average = asObject(raw.totalAverage)
  const value = Object.keys(latest).length > 0
    ? latest
    : Object.keys(average).length > 0 ? average : raw
  return {
    date: timestampDate(value.date) ?? stringValue(value.calendarDate, requestedDate),
    weightKg: gramsToKg(value.weight),
    bmi: finiteNumber(value.bmi),
    bodyFatPercentage: finiteNumber(value.bodyFat),
    muscleMassKg: gramsToKg(value.muscleMass),
    waterPercentage: finiteNumber(value.bodyWater),
    boneMassKg: gramsToKg(value.boneMass),
  }
}

export function formatWorkout(raw: JsonObject): JsonObject {
  return {
    id: raw.workoutId ?? '',
    name: stringValue(raw.workoutName, 'Unnamed'),
    description: stringValue(raw.description),
    sportType: stringValue(asObject(raw.sportType).sportTypeKey, 'unknown'),
    createdDate: stringValue(raw.createdDate),
    estimatedDurationMinutes: secondsToMinutes(raw.estimatedDurationInSecs),
    estimatedDistanceMeters: finiteNumber(raw.estimatedDistanceInMeters),
  }
}

export function formatProfile(raw: JsonObject): JsonObject {
  return {
    displayName: stringValue(raw.displayName),
    fullName: stringValue(raw.fullName),
    userName: stringValue(raw.userName),
    location: stringValue(raw.location),
    bio: raw.bio ?? null,
    primaryActivity: raw.primaryActivity ?? null,
    profileImageUrl: raw.profileImageUrlLarge ?? raw.profileImageUrlMedium ?? null,
    profileVisibility: raw.profileVisibility ?? null,
    userLevel: finiteNumber(raw.userLevel),
  }
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function secondsToHours(value: unknown): number | null {
  const seconds = finiteNumber(value)
  return seconds === null ? null : round2(seconds / 3_600)
}

function secondsToMinutes(value: unknown): number | null {
  const seconds = finiteNumber(value)
  return seconds === null ? null : round2(seconds / 60)
}

function gramsToKg(value: unknown): number | null {
  const grams = finiteNumber(value)
  return grams === null ? null : round2(grams / 1_000)
}

function timestampDate(value: unknown): string | null {
  const timestamp = finiteNumber(value)
  if (timestamp === null) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return localDateString(date)
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
