import assert from 'node:assert/strict'
import { asObject } from '../src/utils/format.js'
import {
  formatBodyBattery,
  formatHrv,
  formatTrainingReadiness,
  formatTrainingStatus,
  formatVo2Max,
} from '../src/utils/training-format.js'

const date = '2026-08-24'

const hrv = formatHrv({
  hrvSummary: {
    calendarDate: date,
    weeklyAvg: 48.5,
    lastNightAvg: 52,
    lastNight5MinHigh: 71,
    status: 'BALANCED',
    feedbackPhrase: 'BALANCED_1',
    baseline: { lowUpper: 42, balancedLow: 43, balancedUpper: 58 },
  },
}, date)
assert.equal(hrv.hasData, true)
assert.equal(hrv.lastNightAverageMs, 52)
assert.equal(asObject(hrv.baseline).balancedUpperMs, 58)

const bodyBattery = formatBodyBattery({
  date,
  charged: 58,
  drained: 32,
  bodyBatteryValuesArray: [
    [1_777_000_000_000, 65],
    [1_777_000_300_000, 66],
  ],
}, date, true)
assert.equal(bodyBattery.currentLevel, 66)
assert.equal(bodyBattery.minimumLevel, 65)
assert.equal(bodyBattery.sampleCount, 2)
assert.equal(Array.isArray(bodyBattery.samples), true)

const readiness = formatTrainingReadiness([
  {
    calendarDate: date,
    timestampLocal: `${date}T06:00:00`,
    inputContext: 'AFTER_WAKEUP_RESET',
    score: 80,
    recoveryTime: 123,
    recoveryTimeChangePhrase: 'REACHED_ZERO',
  },
  {
    calendarDate: date,
    timestampLocal: `${date}T12:00:00`,
    score: 70,
    recoveryTime: 120,
  },
], date)
assert.equal(asObject(readiness.current).score, 70)
assert.equal(asObject(readiness.current).recoveryTimeHours, 2)
assert.equal(asObject(readiness.morning).recoveryTimeMinutes, 0)
assert.equal(asObject(readiness.morning).fullyRecovered, true)

const trainingStatusPayload = {
  mostRecentTrainingStatus: {
    latestTrainingStatusData: {
      'private-device-a': {
        calendarDate: '2026-08-23',
        primaryTrainingDevice: true,
        trainingStatus: 'PRODUCTIVE',
        acuteTrainingLoadDTO: {
          dailyTrainingLoadAcute: 412,
          dailyTrainingLoadChronic: 388,
          dailyAcuteChronicWorkloadRatio: 1.06,
          acwrStatus: 'OPTIMAL',
        },
      },
      'private-device-b': {
        calendarDate: date,
        primaryTrainingDevice: false,
        trainingStatus: 'MAINTAINING',
      },
    },
  },
  mostRecentVO2Max: {
    generic: { vo2MaxValue: 52, vo2MaxPreciseValue: 52.4 },
    cycling: null,
  },
  mostRecentTrainingLoadBalance: {
    metricsTrainingLoadBalanceDTOMap: {
      'private-device-a': {
        monthlyLoadAerobicLow: 1200,
        monthlyLoadAerobicHigh: 540,
        monthlyLoadAnaerobic: 210,
      },
      'private-device-b': { monthlyLoadAerobicLow: 1 },
    },
  },
}
const trainingStatus = formatTrainingStatus(trainingStatusPayload, date)
assert.equal(trainingStatus.trainingStatus, 'PRODUCTIVE')
assert.equal(trainingStatus.acuteTrainingLoad, 412)
assert.equal(asObject(trainingStatus.monthlyLoadBalance).lowAerobic, 1200)
assert.equal(trainingStatus.runningVo2MaxPrecise, 52.4)
assert.equal(JSON.stringify(trainingStatus).includes('private-device'), false)

const vo2Max = formatVo2Max([
  {
    generic: { calendarDate: '2026-08-23', vo2MaxValue: 51, vo2MaxPreciseValue: 51.4 },
  },
  {
    generic: { calendarDate: date, vo2MaxValue: 52, vo2MaxPreciseValue: 52.4 },
  },
], {
  mostRecentVO2Max: {
    cycling: { vo2MaxValue: 49, vo2MaxPreciseValue: 49.2 },
  },
}, '2026-08-23', date)
assert.equal(vo2Max.history.length, 2)
assert.equal(vo2Max.latestRunning?.value, 52)
assert.equal(vo2Max.latestRunning?.source, 'max_metrics')
assert.equal(vo2Max.latestCycling?.value, 49)
assert.equal(vo2Max.latestCycling?.source, 'training_status')

console.log('Training metric formatter smoke test passed.')
