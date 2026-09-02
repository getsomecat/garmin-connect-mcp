import assert from 'node:assert/strict'
import test from 'node:test'
import type { GarminClient } from '../src/garmin/client.js'
import { runningAdviceTool } from '../src/tools/running-advice.js'

const client = {
  async getActivities() {
    return []
  },
} as unknown as GarminClient

const tool = runningAdviceTool(client)

test('explain mode exposes the four training philosophies without requiring intake', async () => {
  const result = record(await tool.run({ mode: 'explain', query: '挪威', language: 'zh-CN' }))
  assert.equal(result.requiresUserInput, false)
  assert.equal(result.totalPhilosophiesInKnowledgeBase, 4)
  const philosophies = result.trainingPhilosophies as Array<Record<string, unknown>>
  assert.deepEqual(philosophies.map((item) => item.id), ['norwegian_threshold'])
})

test('personalized mode stops before Garmin access when warning symptoms are present', async () => {
  let activityCalls = 0
  const guardedTool = runningAdviceTool({
    async getActivities() {
      activityCalls += 1
      return []
    },
  } as unknown as GarminClient)

  const result = record(await guardedTool.run({
    mode: 'personalized',
    language: 'zh-CN',
    include_recent_activities: true,
    has_warning_symptoms: true,
  }))
  assert.equal(result.safetyStop, true)
  assert.equal(activityCalls, 0)
  assert.equal('matchedSkills' in result, false)
})

test('warning symptoms written in health text trigger the safety stop despite a false flag', async () => {
  const result = record(await tool.run({
    mode: 'personalized',
    language: 'zh-CN',
    health_constraints: '今天轻微活动时出现异常气短，睡眠一般。',
    has_warning_symptoms: false,
  }))
  assert.equal(result.safetyStop, true)
  assert.equal('planningInstructions' in result, false)
})

test('personalized mode asks only for missing intake instead of inventing a plan', async () => {
  const result = record(await tool.run({
    mode: 'personalized',
    goal: `10 公里比赛 ${futureDate()}，目标完赛`,
    language: 'zh-CN',
  }))
  assert.equal(result.requiresUserInput, true)
  const missing = result.missingFields as string[]
  assert.equal(missing.includes('goal'), false)
  assert.equal(missing.includes('health_constraints'), true)
  assert.equal('planningInstructions' in result, false)
})

test('complete intake returns conservative planning constraints and all four philosophies', async () => {
  const result = record(await tool.run(completeIntake()))
  assert.equal(result.requiresUserInput, false)
  assert.equal(result.mode, 'personalized')
  assert.equal((result.trainingPhilosophies as unknown[]).length, 4)
  const instructions = result.planningInstructions as string[]
  assert.equal(instructions.some((value) => value.includes('默认不安排双阈值')), true)
})

function completeIntake(): Record<string, unknown> {
  return {
    mode: 'personalized',
    language: 'zh-CN',
    goal: `10 公里比赛 ${futureDate()}，目标 50 分钟内完赛`,
    current_performance: `5 km 计时测试 ${pastDate()}，成绩 25:00，全力，平路天气正常`,
    performance_basis: 'time_trial',
    training_background: '跑龄 2 年，最近 8 周每周 30 公里、跑 4 天，最长跑 12 公里，每周一次阈值训练，近期无中断或突增。',
    availability: '每周可跑 4 天、每次 60 分钟，周一和周五休息，周日长跑，无双练条件。',
    health_constraints: '当前无疼痛或伤病，过去一年无主要跑伤，无相关疾病或药物；睡眠 7 小时，压力和恢复正常。',
    has_warning_symptoms: false,
    training_preference: 'mixed',
    max_quality_sessions_per_week: 2,
    intensity_guidance_preference: 'mixed',
  }
}

function futureDate(): string {
  const value = new Date()
  value.setFullYear(value.getFullYear() + 1)
  return isoDate(value)
}

function pastDate(): string {
  const value = new Date()
  value.setDate(value.getDate() - 30)
  return isoDate(value)
}

function isoDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
