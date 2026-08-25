import { asObject, type JsonObject } from './format.js'

export function formatHrv(raw: unknown, requestedDate: string): JsonObject {
  const root = asObject(raw)
  const summary = asObject(root.hrvSummary ?? root)
  const baseline = asObject(summary.baseline)

  const lastNightAverageMs = finiteNumber(summary.lastNightAvg ?? summary.lastNight)
  const lastNight5MinHighMs = finiteNumber(summary.lastNight5MinHigh)
  const weeklyAverageMs = finiteNumber(summary.weeklyAvg)
  const status = textValue(summary.status)
  const feedback = textValue(summary.feedbackPhrase)
  const balancedLowMs = finiteNumber(baseline.balancedLow)
  const balancedUpperMs = finiteNumber(baseline.balancedUpper)
  const lowUpperMs = finiteNumber(baseline.lowUpper)
  const sleepStartLocal = textValue(root.sleepStartTimestampLocal)
  const sleepEndLocal = textValue(root.sleepEndTimestampLocal)

  return {
    date: textValue(summary.calendarDate) ?? requestedDate,
    hasData: [
      lastNightAverageMs,
      lastNight5MinHighMs,
      weeklyAverageMs,
      status,
      feedback,
      balancedLowMs,
      balancedUpperMs,
      lowUpperMs,
      sleepStartLocal,
      sleepEndLocal,
    ].some((value) => value !== null),
    lastNightAverageMs,
    lastNight5MinHighMs,
    weeklyAverageMs,
    status,
    feedback,
    baseline: {
      lowUpperMs,
      balancedLowMs,
      balancedUpperMs,
      markerValue: finiteNumber(baseline.markerValue),
    },
    sleepWindow: {
      startLocal: sleepStartLocal,
      endLocal: sleepEndLocal,
    },
  }
}

export function formatBodyBattery(
  raw: unknown,
  requestedDate: string,
  includeSamples: boolean,
): JsonObject {
  const value = asObject(raw)
  const samples = bodyBatterySamples(value.bodyBatteryValuesArray)
  const levels = samples.map((sample) => sample.level)
  const feedback = asObject(value.bodyBatteryDynamicFeedbackEvent)
  const currentLevel = levels.at(-1)
    ?? finiteNumber(feedback.bodyBatteryLevel)
    ?? finiteNumber(value.bodyBatteryMostRecentValue)

  return {
    date: textValue(value.date ?? value.calendarDate) ?? requestedDate,
    hasData: samples.length > 0
      || finiteNumber(value.charged) !== null
      || finiteNumber(value.drained) !== null
      || currentLevel !== null,
    currentLevel,
    startLevel: levels[0] ?? null,
    endLevel: levels.at(-1) ?? null,
    minimumLevel: levels.length > 0 ? Math.min(...levels) : null,
    maximumLevel: levels.length > 0 ? Math.max(...levels) : null,
    charged: finiteNumber(value.charged),
    drained: finiteNumber(value.drained),
    currentFeedback: textValue(feedback.feedbackShortType),
    sampleCount: samples.length,
    ...(includeSamples ? { samples } : {}),
  }
}

export function formatTrainingReadiness(raw: unknown, requestedDate: string): JsonObject {
  const entries = readinessEntries(raw)
  const current = selectLatestSnapshot(entries)
  const morning = entries.find((entry) => entry.inputContext === 'AFTER_WAKEUP_RESET')
    ?? entries[0]

  return {
    date: requestedDate,
    hasData: entries.length > 0,
    snapshotCount: entries.length,
    current: current ? formatReadinessSnapshot(current, requestedDate) : null,
    morning: morning ? formatReadinessSnapshot(morning, requestedDate) : null,
  }
}

export function formatTrainingStatus(raw: unknown, requestedDate: string): JsonObject {
  const root = asObject(raw)
  const statusMap = asObject(asObject(root.mostRecentTrainingStatus).latestTrainingStatusData)
  const statusEntries = objectEntries(statusMap)
  const selected = selectDevice(statusEntries)
  const status = selected?.value ?? {}
  const load = asObject(status.acuteTrainingLoadDTO)

  const balanceMap = asObject(
    asObject(root.mostRecentTrainingLoadBalance).metricsTrainingLoadBalanceDTOMap,
  )
  const balanceEntries = objectEntries(balanceMap)
  const balance = selected ? asObject(balanceMap[selected.key]) : {}
  const running = vo2Entry(asObject(root.mostRecentVO2Max).generic)
  const cycling = vo2Entry(asObject(root.mostRecentVO2Max).cycling)

  const hasVo2Max = running.value !== null
    || running.preciseValue !== null
    || cycling.value !== null
    || cycling.preciseValue !== null

  return {
    date: requestedDate,
    hasData: Boolean(selected) || hasVo2Max || balanceEntries.length > 0,
    reportedDate: textValue(status.calendarDate),
    trainingStatus: textValue(status.trainingStatus),
    trainingStatusFeedback: textValue(status.trainingStatusFeedbackPhrase),
    sport: textValue(status.sport),
    fitnessTrend: textValue(status.fitnessTrend),
    acuteTrainingLoad: finiteNumber(load.dailyTrainingLoadAcute),
    chronicTrainingLoad: finiteNumber(load.dailyTrainingLoadChronic),
    acuteChronicWorkloadRatio: finiteNumber(load.dailyAcuteChronicWorkloadRatio),
    acwrStatus: textValue(load.acwrStatus),
    acwrPercent: finiteNumber(load.acwrPercent),
    optimalChronicLoadRange: {
      minimum: finiteNumber(load.minTrainingLoadChronic),
      maximum: finiteNumber(load.maxTrainingLoadChronic),
    },
    runningVo2Max: running.value,
    runningVo2MaxPrecise: running.preciseValue,
    cyclingVo2Max: cycling.value,
    cyclingVo2MaxPrecise: cycling.preciseValue,
    monthlyLoadBalance: {
      lowAerobic: finiteNumber(balance.monthlyLoadAerobicLow),
      lowAerobicTargetMinimum: finiteNumber(balance.monthlyLoadAerobicLowTargetMin),
      lowAerobicTargetMaximum: finiteNumber(balance.monthlyLoadAerobicLowTargetMax),
      highAerobic: finiteNumber(balance.monthlyLoadAerobicHigh),
      highAerobicTargetMinimum: finiteNumber(balance.monthlyLoadAerobicHighTargetMin),
      highAerobicTargetMaximum: finiteNumber(balance.monthlyLoadAerobicHighTargetMax),
      anaerobic: finiteNumber(balance.monthlyLoadAnaerobic),
      anaerobicTargetMinimum: finiteNumber(balance.monthlyLoadAnaerobicTargetMin),
      anaerobicTargetMaximum: finiteNumber(balance.monthlyLoadAnaerobicTargetMax),
      feedback: textValue(balance.trainingBalanceFeedbackPhrase),
    },
    statusDeviceCount: statusEntries.length,
    loadBalanceDeviceCount: balanceEntries.length,
  }
}

export interface Vo2MaxReading {
  date: string | null
  value: number | null
  preciseValue: number | null
  source: 'max_metrics' | 'training_status'
}

export interface Vo2MaxResult {
  startDate: string
  endDate: string
  hasData: boolean
  latestRunning: Vo2MaxReading | null
  latestCycling: Vo2MaxReading | null
  history: JsonObject[]
}

export function formatVo2Max(
  maxMetricsRaw: unknown,
  trainingStatusRaw: unknown,
  startDate: string,
  endDate: string,
): Vo2MaxResult {
  const points = new Map<string, JsonObject>()

  for (const day of maxMetricDays(maxMetricsRaw)) {
    const generic = vo2Entry(day.generic)
    const cycling = vo2Entry(day.cycling)
    const date = generic.date ?? cycling.date ?? textValue(day.calendarDate)
    if (!date || !hasVo2Value(generic) && !hasVo2Value(cycling)) continue

    points.set(date, {
      date,
      runningVo2Max: generic.value,
      runningVo2MaxPrecise: generic.preciseValue,
      cyclingVo2Max: cycling.value,
      cyclingVo2MaxPrecise: cycling.preciseValue,
      source: 'max_metrics',
    })
  }

  const history = [...points.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)))
  let latestRunning = latestHistoryReading(history, 'running')
  let latestCycling = latestHistoryReading(history, 'cycling')

  const statusRoot = asObject(trainingStatusRaw)
  const statusVo2 = asObject(statusRoot.mostRecentVO2Max)
  if (!latestRunning) {
    latestRunning = fallbackVo2Reading(statusVo2.generic, endDate)
  }
  if (!latestCycling) {
    latestCycling = fallbackVo2Reading(statusVo2.cycling, endDate)
  }

  return {
    startDate,
    endDate,
    hasData: Boolean(latestRunning || latestCycling),
    latestRunning,
    latestCycling,
    history,
  }
}

function formatReadinessSnapshot(raw: JsonObject, requestedDate: string): JsonObject {
  const recoveryPhrase = textValue(raw.recoveryTimeChangePhrase)
  const reportedRecoveryMinutes = finiteNumber(raw.recoveryTime)
  const recoveryTimeMinutes = recoveryPhrase === 'REACHED_ZERO' ? 0 : reportedRecoveryMinutes
  const fullyRecovered = recoveryPhrase === 'REACHED_ZERO'
    || recoveryTimeMinutes === 0
      ? true
      : recoveryTimeMinutes === null ? null : false

  return {
    date: textValue(raw.calendarDate) ?? requestedDate,
    timestamp: textValue(raw.timestampLocal ?? raw.timestamp),
    inputContext: textValue(raw.inputContext),
    score: finiteNumber(raw.score),
    level: textValue(raw.level),
    feedbackShort: textValue(raw.feedbackShort),
    feedbackLong: textValue(raw.feedbackLong),
    sleepScore: finiteNumber(raw.sleepScore),
    sleepFactorPercent: finiteNumber(raw.sleepScoreFactorPercent),
    sleepFactorFeedback: textValue(raw.sleepScoreFactorFeedback),
    recoveryTimeMinutes,
    recoveryTimeHours: recoveryTimeMinutes === null ? null : round2(recoveryTimeMinutes / 60),
    fullyRecovered,
    recoveryFactorPercent: finiteNumber(raw.recoveryTimeFactorPercent),
    recoveryFactorFeedback: textValue(raw.recoveryTimeFactorFeedback),
    trainingLoadFactorPercent: finiteNumber(raw.acwrFactorPercent),
    trainingLoadFactorFeedback: textValue(raw.acwrFactorFeedback),
    acuteLoad: finiteNumber(raw.acuteLoad),
    hrvFactorPercent: finiteNumber(raw.hrvFactorPercent),
    hrvFactorFeedback: textValue(raw.hrvFactorFeedback),
    hrvWeeklyAverageMs: finiteNumber(raw.hrvWeeklyAverage),
    stressHistoryFactorPercent: finiteNumber(raw.stressHistoryFactorPercent),
    stressHistoryFactorFeedback: textValue(raw.stressHistoryFactorFeedback),
    sleepHistoryFactorPercent: finiteNumber(raw.sleepHistoryFactorPercent),
    sleepHistoryFactorFeedback: textValue(raw.sleepHistoryFactorFeedback),
  }
}

function readinessEntries(raw: unknown): JsonObject[] {
  if (Array.isArray(raw)) return raw.map(asObject).filter(hasKeys)
  const value = asObject(raw)
  if (Array.isArray(value.trainingReadiness)) {
    return value.trainingReadiness.map(asObject).filter(hasKeys)
  }
  return hasKeys(value) ? [value] : []
}

function selectLatestSnapshot(entries: JsonObject[]): JsonObject | undefined {
  if (entries.length === 0) return undefined
  let selected = entries.at(-1) as JsonObject
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    const raw = textValue(entry.timestampLocal ?? entry.timestamp)
    if (!raw) continue
    const time = Date.parse(raw)
    if (!Number.isNaN(time) && time >= selectedTime) {
      selected = entry
      selectedTime = time
    }
  }
  return selected
}

interface DeviceEntry {
  key: string
  value: JsonObject
}

function objectEntries(value: JsonObject): DeviceEntry[] {
  return Object.entries(value)
    .map(([key, raw]) => ({ key, value: asObject(raw) }))
    .filter((entry) => hasKeys(entry.value))
}

function selectDevice(entries: DeviceEntry[]): DeviceEntry | undefined {
  return [...entries].sort((a, b) => {
    const primaryDifference = Number(b.value.primaryTrainingDevice === true)
      - Number(a.value.primaryTrainingDevice === true)
    if (primaryDifference !== 0) return primaryDifference
    const dateDifference = (textValue(b.value.calendarDate) ?? '')
      .localeCompare(textValue(a.value.calendarDate) ?? '')
    return dateDifference !== 0 ? dateDifference : a.key.localeCompare(b.key)
  })[0]
}

interface Vo2Entry {
  date: string | null
  value: number | null
  preciseValue: number | null
}

function vo2Entry(raw: unknown): Vo2Entry {
  const value = asObject(raw)
  return {
    date: textValue(value.calendarDate),
    value: finiteNumber(value.vo2MaxValue),
    preciseValue: finiteNumber(value.vo2MaxPreciseValue),
  }
}

function hasVo2Value(value: Vo2Entry): boolean {
  return value.value !== null || value.preciseValue !== null
}

function maxMetricDays(raw: unknown): JsonObject[] {
  if (Array.isArray(raw)) return raw.map(asObject).filter(hasKeys)
  const value = asObject(raw)
  for (const key of ['data', 'values', 'maxMetrics']) {
    if (Array.isArray(value[key])) return value[key].map(asObject).filter(hasKeys)
  }
  if ('generic' in value || 'cycling' in value || 'calendarDate' in value) return [value]
  const nested = Object.values(value).map(asObject).filter((entry) =>
    'generic' in entry || 'cycling' in entry || 'calendarDate' in entry)
  return nested.length > 0 ? nested : []
}

function latestHistoryReading(
  history: JsonObject[],
  sport: 'running' | 'cycling',
): Vo2MaxReading | null {
  const valueKey = sport === 'running' ? 'runningVo2Max' : 'cyclingVo2Max'
  const preciseKey = sport === 'running' ? 'runningVo2MaxPrecise' : 'cyclingVo2MaxPrecise'
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index] as JsonObject
    const value = finiteNumber(point[valueKey])
    const preciseValue = finiteNumber(point[preciseKey])
    if (value !== null || preciseValue !== null) {
      return {
        date: textValue(point.date),
        value,
        preciseValue,
        source: 'max_metrics',
      }
    }
  }
  return null
}

function fallbackVo2Reading(raw: unknown, fallbackDate: string): Vo2MaxReading | null {
  const value = vo2Entry(raw)
  if (!hasVo2Value(value)) return null
  return {
    date: value.date ?? fallbackDate,
    value: value.value,
    preciseValue: value.preciseValue,
    source: 'training_status',
  }
}

interface BodyBatterySample {
  timestamp: string | number
  level: number
}

function bodyBatterySamples(raw: unknown): BodyBatterySample[] {
  if (!Array.isArray(raw)) return []
  const samples: BodyBatterySample[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue
    const level = finiteNumber(item[1])
    const timestamp = timestampValue(item[0])
    if (level === null || timestamp === null) continue
    samples.push({ timestamp, level })
  }
  return samples
}

function timestampValue(value: unknown): string | number | null {
  if (typeof value === 'string' && value !== '') return value
  const timestamp = finiteNumber(value)
  if (timestamp === null) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString()
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function hasKeys(value: JsonObject): boolean {
  return Object.keys(value).length > 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
